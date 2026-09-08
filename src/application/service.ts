import type { z } from "zod";
import { SafeError, type SafeResult } from "../errors.js";
import type { AccountProjection, ForwardedAttachment } from "../domain/types.js";
import type { ImapAdapter, SmtpAdapter, MailFolder, MailMessage, MailSummary, MailboxMutation } from "../mail/adapters.js";
import { executeOnce } from "../mail/execute.js";
import { prepareMessage } from "../mail/prepare.js";
import { AccountRepository } from "../outbox/accounts.js";
import { OutboxRepository } from "../outbox/repository.js";
import { mailAccountsSchema, mailExecuteSchema, mailPrepareSchema, mailQuerySchema } from "../mcp/schemas.js";

export type MailAccountsInput = z.infer<typeof mailAccountsSchema>;
export type MailQueryInput = z.infer<typeof mailQuerySchema>;
export type MailPrepareInput = z.input<typeof mailPrepareSchema>;
export type MailExecuteInput = z.input<typeof mailExecuteSchema>;

export interface ApplicationCallContext {
  readonly caller: "Hermes main";
  readonly correlationId: string;
}

/** Provider-independent application seam used by the MCP boundary. */
export interface MailApplicationService {
  mailAccounts(input: MailAccountsInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailQuery(input: MailQueryInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailPrepare(input: MailPrepareInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailExecute(input: MailExecuteInput, context: ApplicationCallContext): Promise<unknown> | unknown;
}

export type ApplicationServiceResult = SafeResult<unknown>;

export type MailAdapterRegistry = ReadonlyMap<string, { readonly imap: ImapAdapter; readonly smtp: SmtpAdapter }>;

export interface AccountHealth { readonly status: "ok" | "failed"; }

export interface SafeAccountProjection {
  readonly accountId: string;
  readonly displayName: string;
  readonly providerKind: AccountProjection["providerKind"];
  readonly allowedSender: string;
  readonly enabled: boolean;
  readonly health?: AccountHealth;
}

function safeAccount(account: AccountProjection): SafeAccountProjection {
  return { accountId: account.accountId, displayName: account.displayName, providerKind: account.providerKind, allowedSender: account.allowedSender, enabled: account.enabled };
}

type QueryCursor = { readonly accountId: string; readonly folder: string; readonly operation: "list" | "search"; readonly lastUid: number; readonly uidValidity: number };
function encodeCursor(cursor: QueryCursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeCursor(value: string, accountId: string, folder: string, operation: "list" | "search"): QueryCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<QueryCursor>;
    if (decoded.accountId !== accountId || decoded.folder !== folder || decoded.operation !== operation || !Number.isSafeInteger(decoded.lastUid) || (decoded.lastUid as number) < 1 || !Number.isSafeInteger(decoded.uidValidity) || (decoded.uidValidity as number) < 1) throw new Error();
    return decoded as QueryCursor;
  } catch { throw new SafeError("INVALID_INPUT", "The query cursor is invalid for this account, folder, or operation."); }
}

function safeFolders(folders: readonly MailFolder[]): readonly MailFolder[] {
  return folders.map((folder) => {
    if (!folder || typeof folder.path !== "string" || typeof folder.name !== "string" || typeof folder.delimiter !== "string" || folder.path.length === 0 || folder.path.length > 1000 || folder.name.length > 1000 || folder.delimiter.length > 16 || /[\r\n\u0000]/.test(folder.path) || /[\r\n\u0000]/.test(folder.name) || /[\r\n\u0000]/.test(folder.delimiter) || (folder.specialUse !== undefined && (typeof folder.specialUse !== "string" || folder.specialUse.length > 128 || /[\r\n\u0000]/.test(folder.specialUse)))) throw new SafeError("PROVIDER_UNAVAILABLE", "The mail account provider returned invalid folder metadata.");
    return { path: folder.path, name: folder.name, delimiter: folder.delimiter, ...(folder.specialUse === undefined ? {} : { specialUse: folder.specialUse }) };
  });
}

function accountOrThrow(accounts: AccountRepository, accountId: string): AccountProjection {
  const account = accounts.get(accountId);
  if (!account) throw new SafeError("ACCOUNT_NOT_FOUND", "Account was not found.");
  if (!account.enabled) throw new SafeError("ACCOUNT_DISABLED", "Account is disabled.");
  return account;
}

function adapterOrThrow(registry: MailAdapterRegistry, accountId: string): { readonly imap: ImapAdapter; readonly smtp: SmtpAdapter } {
  const adapter = registry.get(accountId);
  if (!adapter) throw new SafeError("PROVIDER_UNAVAILABLE", "The mail account provider is unavailable.");
  return adapter;
}

async function safeProviderCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("PROVIDER_UNAVAILABLE", "The mail provider is unavailable.");
  }
}

const MAX_FORWARDED_TEXT = 1_000_000;
const MAX_FORWARDED_HEADER = 2_000;
function boundedBody(value: string | undefined): string { return (value ?? "").replace(/\r\n?/g, "\n").slice(0, MAX_FORWARDED_HEADER); }
function addressText(values: MailMessage["from"]): string { return values.map((value) => value.name && value.address ? `${value.name} <${value.address}>` : value.address ?? value.name ?? "").filter(Boolean).join(", "); }
function forwardedBlock(source: MailMessage): string {
  const headers = [
    ["From", addressText(source.from)], ["To", addressText(source.to)], ["Date", source.date],
    ["Subject", source.subject], ["Message-ID", source.messageId],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([name, value]) => `${name}: ${boundedBody(value)}`).join("\n");
  return `---------- Forwarded message ----------\n${headers}\n\n${boundedBody(source.text)}`.slice(0, MAX_FORWARDED_TEXT);
}
function sourceAttachments(source: MailMessage, maxBytes: number): ForwardedAttachment[] {
  let total = 0;
  return source.attachments.map((item) => {
    if (item.content === undefined) throw new SafeError("UNSUPPORTED_OPERATION", "Forwarding source attachments is unavailable safely.");
    const filename = item.filename;
    const contentType = item.contentType;
    if (!filename || filename.length > 255 || /[\r\n\\/]/.test(filename) || !contentType || contentType.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(contentType)) throw new SafeError("INVALID_INPUT", "The source attachment metadata is invalid.");
    if (item.size !== undefined && item.size !== item.content.length) throw new SafeError("ATTACHMENT_CHANGED", "The source attachment changed while it was being read.");
    total += item.content.length;
    if (item.content.length > maxBytes || total > maxBytes) throw new SafeError("INVALID_INPUT", "Forwarded attachments exceed the configured message size policy.");
    return { filename, contentType, size: item.content.length, content: Buffer.from(item.content) };
  });
}
function publicSummary(summary: MailSummary): MailSummary {
  const { uidValidity: _uidValidity, ...publicValue } = summary;
  return publicValue;
}

/** Composes the repositories, account-scoped adapters, and credential-free domain use cases. */
export class MailGatewayService implements MailApplicationService {
  constructor(private readonly accounts: AccountRepository, private readonly outbox: OutboxRepository, private readonly adapters: MailAdapterRegistry, private readonly maxRecipients = 100, private readonly maxAttachmentBytes = 25_000_000, private readonly maxQueryLimit = 100) {}

  async mailAccounts(input: MailAccountsInput): Promise<{ readonly accounts: readonly SafeAccountProjection[] }> {
    const configured = this.accounts.list();
    if (!input.includeHealth) return { accounts: configured.map(safeAccount) };
    const accounts = await Promise.all(configured.map(async (account) => {
      const projection = safeAccount(account);
      if (!account.enabled) return projection;
      const adapter = this.adapters.get(account.accountId);
      let status: AccountHealth["status"] = "failed";
      try {
        if (!adapter?.imap.checkConnectivity || !adapter.smtp.verify) throw new Error();
        await adapter.imap.checkConnectivity();
        await adapter.smtp.verify();
        status = "ok";
      } catch { /* Provider details are deliberately not exposed. */ }
      return { ...projection, health: { status } };
    }));
    return { accounts };
  }

  async mailQuery(input: MailQueryInput, context: ApplicationCallContext): Promise<unknown> {
    const account = accountOrThrow(this.accounts, input.accountId);
    const limit = Math.min(input.limit, Math.min(100, Math.max(1, this.maxQueryLimit)));
    const folder = input.folder ?? account.inboxFolder;
    const paged = input.operation === "list" || input.operation === "search";
    const cursor = input.cursor === undefined || !paged ? undefined : decodeCursor(input.cursor, account.accountId, folder, input.operation as "list" | "search");
    let value: unknown;
    const { imap } = adapterOrThrow(this.adapters, account.accountId);
    if (input.operation === "folders") {
      if (!imap.listFolders) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support folder discovery.");
      value = { folders: safeFolders(await safeProviderCall(() => imap.listFolders!())) };
    } else if (input.operation === "list") {
      if (!imap.list) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support listing.");
      const messages = await safeProviderCall(() => imap.list!(folder, Math.min(limit + 1, 101), cursor?.lastUid, cursor?.uidValidity));
      const hasMore = messages.length > limit;
      const page = messages.slice(0, limit);
      if (hasMore && page.length > 0 && page[page.length - 1]!.uidValidity === undefined) throw new SafeError("PROVIDER_UNAVAILABLE", "The mail provider returned no mailbox generation.");
      value = { messages: page.map(publicSummary), hasMore, ...(hasMore && page.length > 0 ? { nextCursor: encodeCursor({ accountId: account.accountId, folder, operation: "list", lastUid: page[page.length - 1]!.uid, uidValidity: page[page.length - 1]!.uidValidity! }) } : {}) };
    } else if (input.operation === "search") {
      if (!input.query) throw new SafeError("INVALID_INPUT", "A search query is required.");
      if (!imap.search) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support search.");
      const messages = await safeProviderCall(() => imap.search!(folder, input.query!, Math.min(limit + 1, 101), cursor?.lastUid, cursor?.uidValidity));
      const hasMore = messages.length > limit;
      const page = messages.slice(0, limit);
      if (hasMore && page.length > 0 && page[page.length - 1]!.uidValidity === undefined) throw new SafeError("PROVIDER_UNAVAILABLE", "The mail provider returned no mailbox generation.");
      value = { messages: page.map(publicSummary), hasMore, ...(hasMore && page.length > 0 ? { nextCursor: encodeCursor({ accountId: account.accountId, folder, operation: "search", lastUid: page[page.length - 1]!.uid, uidValidity: page[page.length - 1]!.uidValidity! }) } : {}) };
    } else if (input.operation === "read") {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A message reference is required.");
      if (!imap.read) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support reading.");
      value = { message: await safeProviderCall(() => imap.read!(input.messageReference!)) as MailMessage };
    } else if (input.operation === "attachments") {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A message reference is required.");
      if (!imap.read) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support reading.");
      const message = await safeProviderCall(() => imap.read!(input.messageReference!));
      value = { attachments: message.attachments.slice(0, 32).map(({ filename, contentType, size }) => ({ ...(filename === undefined ? {} : { filename }), ...(contentType === undefined ? {} : { contentType }), ...(size === undefined ? {} : { size }) })) };
    } else if (input.operation === "thread") {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A message reference is required.");
      if (!imap.thread) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support thread lookup.");
      value = { messages: (await safeProviderCall(() => imap.thread!(folder, input.messageReference!, limit))).map(publicSummary) };
    } else {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A Message-ID reference is required.");
      value = { messageIdHeader: input.messageReference, verified: await safeProviderCall(() => imap.verifySent(input.messageReference!)) };
    }
    this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_query", accountId: account.accountId, outcomeCode: "OK", metadata: { operation: input.operation, limit } });
    return value;
  }

  async mailPrepare(input: MailPrepareInput, context: ApplicationCallContext): Promise<unknown> {
    const cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    const attachments = input.attachments ?? [];
    const recipientCount = input.recipients.length + cc.length + bcc.length;
    if (recipientCount > this.maxRecipients) throw new SafeError("INVALID_INPUT", "Too many recipients for the configured account policy.");
    const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (attachmentBytes > this.maxAttachmentBytes) throw new SafeError("INVALID_INPUT", "Attachments exceed the configured message size policy.");
    const existing = this.outbox.findByIdempotencyKey(input.accountId, input.idempotencyKey);
    let source: MailMessage | undefined;
    let forwardedAttachments: ForwardedAttachment[] = [];
    let forwarding = input.forwarding;
    if (input.forwarding !== undefined && !existing) {
      const account = accountOrThrow(this.accounts, input.accountId);
      const { imap } = adapterOrThrow(this.adapters, account.accountId);
      if (!imap.read) throw new SafeError("UNSUPPORTED_OPERATION", "Forwarding source reading is unavailable safely.");
      source = await safeProviderCall(() => imap.read!(input.forwarding!.originalMessageReference));
      forwardedAttachments = sourceAttachments(source, Math.max(0, this.maxAttachmentBytes - attachmentBytes));
      forwarding = {
        originalMessageReference: input.forwarding.originalMessageReference,
        ...((source.messageId ?? input.forwarding.originalMessageId) === undefined ? {} : { originalMessageId: source.messageId ?? input.forwarding.originalMessageId as string }),
        ...((source.subject ?? input.forwarding.originalSubject) === undefined ? {} : { originalSubject: source.subject ?? input.forwarding.originalSubject as string }),
      };
    }
    const forwardingForPrepare = forwarding === undefined ? undefined : {
      originalMessageReference: forwarding.originalMessageReference,
      ...(forwarding.originalMessageId === undefined ? {} : { originalMessageId: forwarding.originalMessageId }),
      ...(forwarding.originalSubject === undefined ? {} : { originalSubject: forwarding.originalSubject }),
    };
    const preparedTextBody = input.forwarding === undefined ? input.textBody : source === undefined ? input.textBody : input.textBody === undefined ? forwardedBlock(source) : `${input.textBody}\n\n${forwardedBlock(source)}`;
    const prepared = await prepareMessage(this.outbox, this.accounts, {
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      intent: input.intent ?? "send",
      recipients: input.recipients,
      cc,
      bcc,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      references: input.references ?? [],
      ...(forwardingForPrepare === undefined ? {} : { forwarding: forwardingForPrepare }),
      subject: input.subject,
      ...(preparedTextBody === undefined ? {} : { textBody: preparedTextBody }),
      ...(input.htmlBody === undefined ? {} : { htmlBody: input.htmlBody }),
      attachments,
      audit: { correlationId: context.correlationId, caller: context.caller, tool: "mail_prepare", metadata: { recipientCount, attachmentCount: attachments.length } },
    }, forwardedAttachments, input);
    return prepared;
  }

  async mailExecute(input: MailExecuteInput, context: ApplicationCallContext): Promise<unknown> {
    const account = accountOrThrow(this.accounts, input.accountId);
    if (input.action !== undefined) {
      const { imap } = adapterOrThrow(this.adapters, account.accountId);
      if (input.action.type === "cancelPrepared") {
        const message = this.outbox.get(input.action.messageId);
        if (message.accountId !== account.accountId) throw new SafeError("ACCOUNT_NOT_FOUND", "Message was not found for this account.");
        const cancelled = this.outbox.transition(message.messageId, "CANCELLED", "prepared message cancelled before provider submission");
        this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_execute", accountId: account.accountId, messageId: message.messageId, oldState: message.state, newState: cancelled.state, outcomeCode: "CANCELLED", metadata: { action: input.action.type } });
        return { messageId: cancelled.messageId, accountId: cancelled.accountId, intent: cancelled.intent, state: cancelled.state, action: input.action.type };
      }
      if (!imap.mutate) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support mailbox mutations.");
      let destinationFolder: string | undefined;
      const action = input.action;
      if (action.type === "move" || action.type === "copy") destinationFolder = action.destinationFolder;
      if (action.type === "trash") destinationFolder = await this.specialFolder(imap, "\\Trash");
      if (action.type === "restore") destinationFolder = account.inboxFolder;
      if (destinationFolder !== undefined) await this.requireSelectableFolder(imap, destinationFolder);
      const mutation: MailboxMutation = { type: action.type, messageReference: action.messageReference, ...(action.type === "addFlag" || action.type === "removeFlag" ? { flag: action.flag } : {}), ...(destinationFolder === undefined ? {} : { destinationFolder }) };
      const result = await safeProviderCall(() => imap.mutate!(mutation));
      this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_execute", accountId: account.accountId, outcomeCode: "MAILBOX_MUTATION_CONFIRMED", metadata: { action: action.type, folder: result.folder, uid: result.uid } });
      return { action: result.action, messageReference: result.reference, folder: result.folder, uid: result.uid, flags: result.flags };
    }
    if (input.messageId === undefined) throw new SafeError("INVALID_INPUT", "An execution messageId is required.");
    const message = this.outbox.get(input.messageId);
    if (message.accountId !== account.accountId) throw new SafeError("ACCOUNT_NOT_FOUND", "Message was not found for this account.");
    if (message.intent === "draft") throw new SafeError("UNSUPPORTED_OPERATION", "Provider draft saving is not implemented for this prepared draft.");
    const { imap, smtp } = adapterOrThrow(this.adapters, account.accountId);
    if (input.verifyOnly) {
      const verified = await imap.verifySent(message.messageIdHeader);
      const updated = verified ? this.outbox.confirmSent(message.messageId) : message;
      this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_execute", accountId: account.accountId, messageId: message.messageId, outcomeCode: verified ? "SENT_VERIFIED" : "SENT_UNVERIFIED", metadata: { verifyOnly: true } });
      return { messageId: updated.messageId, accountId: updated.accountId, messageIdHeader: updated.messageIdHeader, state: updated.state, verifyOnly: true, verified };
    }
    try {
      const executed = await executeOnce(this.outbox, smtp, imap, message.messageId, context.correlationId);
      this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_execute", accountId: account.accountId, messageId: message.messageId, oldState: message.state, newState: executed.state, outcomeCode: executed.state, metadata: { verifyOnly: false } });
      return executed;
    } catch (error) {
      this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_execute", accountId: account.accountId, messageId: message.messageId, outcomeCode: error instanceof SafeError ? error.code : "INTERNAL_SAFE_FAILURE", metadata: { verifyOnly: false } });
      throw error;
    }
  }

  private async requireSelectableFolder(imap: ImapAdapter, path: string): Promise<void> {
    if (!imap.listFolders) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support folder discovery.");
    const folders = safeFolders(await safeProviderCall(() => imap.listFolders!()));
    if (!folders.some((folder) => folder.path === path)) throw new SafeError("INVALID_INPUT", "The destination folder is not a discovered selectable mailbox.");
  }

  private async specialFolder(imap: ImapAdapter, specialUse: string): Promise<string> {
    if (!imap.listFolders) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support folder discovery.");
    const folders = safeFolders(await safeProviderCall(() => imap.listFolders!()));
    const folder = folders.find((item) => item.specialUse?.toLowerCase() === specialUse.toLowerCase());
    if (!folder) throw new SafeError("UNSUPPORTED_OPERATION", "The provider did not expose the required special-use mailbox.");
    return folder.path;
  }
}
