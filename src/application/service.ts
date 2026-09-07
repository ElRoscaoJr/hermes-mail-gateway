import type { z } from "zod";
import { SafeError, type SafeResult } from "../errors.js";
import type { AccountProjection } from "../domain/types.js";
import type { ImapAdapter, SmtpAdapter, MailMessage, MailSummary } from "../mail/adapters.js";
import { executeOnce } from "../mail/execute.js";
import { prepareMessage } from "../mail/prepare.js";
import { AccountRepository } from "../outbox/accounts.js";
import { OutboxRepository } from "../outbox/repository.js";
import { mailAccountsSchema, mailExecuteSchema, mailPrepareSchema, mailQuerySchema } from "../mcp/schemas.js";

export type MailAccountsInput = z.infer<typeof mailAccountsSchema>;
export type MailQueryInput = z.infer<typeof mailQuerySchema>;
export type MailPrepareInput = z.infer<typeof mailPrepareSchema>;
export type MailExecuteInput = z.infer<typeof mailExecuteSchema>;

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

export interface AccountHealth { readonly status: "unavailable" | "unknown"; }

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

/** Composes the repositories, account-scoped adapters, and credential-free domain use cases. */
export class MailGatewayService implements MailApplicationService {
  constructor(private readonly accounts: AccountRepository, private readonly outbox: OutboxRepository, private readonly adapters: MailAdapterRegistry, private readonly maxRecipients = 100, private readonly maxAttachmentBytes = 25_000_000, private readonly maxQueryLimit = 100) {}

  mailAccounts(input: MailAccountsInput): { readonly accounts: readonly SafeAccountProjection[] } {
    const accounts = this.accounts.list().map(safeAccount);
    // Health is intentionally omitted unless a future adapter exposes a safe capability check.
    void input;
    return { accounts };
  }

  async mailQuery(input: MailQueryInput, context: ApplicationCallContext): Promise<unknown> {
    const account = accountOrThrow(this.accounts, input.accountId);
    const limit = Math.min(input.limit, Math.min(100, Math.max(1, this.maxQueryLimit)));
    const folder = input.folder ?? account.inboxFolder;
    let value: unknown;
    if (input.operation === "thread" || input.operation === "attachments") throw new SafeError("UNSUPPORTED_OPERATION", `Mail operation '${input.operation}' is not supported.`);
    const { imap } = adapterOrThrow(this.adapters, account.accountId);
    if (input.operation === "list") {
      if (!imap.list) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support listing.");
      value = { messages: await imap.list(folder, limit) };
    } else if (input.operation === "search") {
      if (!input.query) throw new SafeError("INVALID_INPUT", "A search query is required.");
      if (!imap.search) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support search.");
      value = { messages: await imap.search(folder, input.query, limit) };
    } else if (input.operation === "read") {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A message reference is required.");
      if (!imap.read) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support reading.");
      value = { message: await imap.read(input.messageReference) as MailMessage };
    } else {
      if (!input.messageReference) throw new SafeError("INVALID_INPUT", "A Message-ID reference is required.");
      value = { messageIdHeader: input.messageReference, verified: await imap.verifySent(input.messageReference) };
    }
    this.outbox.appendAudit({ correlationId: context.correlationId, caller: context.caller, tool: "mail_query", accountId: account.accountId, outcomeCode: "OK", metadata: { operation: input.operation, limit } });
    return value;
  }

  async mailPrepare(input: MailPrepareInput, context: ApplicationCallContext): Promise<unknown> {
    if (input.recipients.length > this.maxRecipients) throw new SafeError("INVALID_INPUT", "Too many recipients for the configured account policy.");
    const attachmentBytes = input.attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (attachmentBytes > this.maxAttachmentBytes) throw new SafeError("INVALID_INPUT", "Attachments exceed the configured message size policy.");
    const prepared = await prepareMessage(this.outbox, this.accounts, {
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      recipients: input.recipients,
      subject: input.subject,
      ...(input.textBody === undefined ? {} : { textBody: input.textBody }),
      ...(input.htmlBody === undefined ? {} : { htmlBody: input.htmlBody }),
      attachments: input.attachments,
      audit: { correlationId: context.correlationId, caller: context.caller, tool: "mail_prepare", metadata: { recipientCount: input.recipients.length, attachmentCount: input.attachments.length } },
    });
    return prepared;
  }

  async mailExecute(input: MailExecuteInput, context: ApplicationCallContext): Promise<unknown> {
    const account = accountOrThrow(this.accounts, input.accountId);
    const message = this.outbox.get(input.messageId);
    if (message.accountId !== account.accountId) throw new SafeError("ACCOUNT_NOT_FOUND", "Message was not found for this account.");
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
}
