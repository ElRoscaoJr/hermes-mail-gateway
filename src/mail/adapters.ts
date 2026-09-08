import nodemailer from "nodemailer";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse, type MessageEnvelopeObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountProjection, ForwardedAttachment } from "../domain/types.js";
import { SafeError } from "../errors.js";
import type { CredentialResolver } from "./credentials.js";

export interface ImapAdapter {
  verifySent(messageIdHeader: string): Promise<boolean>;
  appendDraft?(rawMime: Buffer, folder: string, context: DraftAppendContext): Promise<DraftAppendResult>;
  listFolders?(): Promise<readonly MailFolder[]>;
  checkConnectivity?(): Promise<void>;
  list?(folder: string, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  search?(folder: string, query: string, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  searchWithFilters?(folder: string, query: string | undefined, filters: MailSearchFilters, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  read?(reference: string): Promise<MailMessage>;
  downloadAttachment?(reference: string, attachmentIndex: number): Promise<DownloadedAttachment>;
  thread?(folder: string, anchorReference: string, limit?: number): Promise<readonly MailSummary[]>;
  mutate?(action: MailboxMutation): Promise<MailboxMutationResult>;
}
export interface DraftAppendContext { readonly accountId: string; readonly messageIdHeader: string; }
export interface DraftAppendResult { readonly reference: string; readonly folder: string; readonly uid: number; readonly uidValidity: number; }
export interface MailSearchFilters { readonly from?: string | undefined; readonly to?: string | undefined; readonly cc?: string | undefined; readonly subject?: string | undefined; readonly since?: string | undefined; readonly before?: string | undefined; readonly hasAttachment?: boolean | undefined; readonly isRead?: boolean | undefined; readonly isFlagged?: boolean | undefined; readonly messageId?: string | undefined; }
export interface DownloadedAttachment { readonly filename: string; readonly contentType: string; readonly size: number; readonly sha256: string; readonly content: Buffer; }
export type MailboxMutationType = "markRead" | "markUnread" | "addFlag" | "removeFlag" | "move" | "copy" | "trash" | "restore";
export interface MailboxMutation { readonly type: MailboxMutationType; readonly messageReference: string; readonly flag?: "\\Flagged" | "\\Answered"; readonly destinationFolder?: string; }
export interface MailboxMutationResult { readonly action: MailboxMutationType; readonly reference: string; readonly folder: string; readonly uid: number; readonly flags: readonly string[]; }
export type SmtpOutcome = "ACKNOWLEDGED" | "REJECTED" | "PRE_SUBMISSION_FAILURE" | "UNKNOWN";
export interface SmtpEnvelope { readonly from: string; readonly to: readonly string[]; readonly cc: readonly string[]; readonly bcc: readonly string[]; }
export interface SmtpSubmissionResult { readonly outcome: SmtpOutcome; /** Bounded operator evidence; never a provider transcript or message data. */ readonly evidence: string; }
export interface SmtpAdapter { submit(messageIdHeader: string, mime: Buffer, envelope: SmtpEnvelope): Promise<SmtpOutcome | SmtpSubmissionResult>; verify?(): Promise<void>; }

export interface NodemailerSmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly credentialRef: string;
  readonly credentials: CredentialResolver;
  readonly transport?: Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail"> & { verify?: () => Promise<unknown> };
  readonly transportFactory?: (options: Parameters<typeof nodemailer.createTransport>[0]) => Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail"> & { verify?: () => Promise<unknown> };
}

type MailError = { code?: string; command?: string; responseCode?: number; response?: string; rejected?: unknown[] };

export function parseSmtpEndpoint(endpoint: string): { host: string; port: number; secure: boolean } {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new SafeError("REFERENCE_INVALID", "SMTP endpoint is invalid."); }
  if ((url.protocol !== "smtp:" && url.protocol !== "smtps:") || url.username || url.password || url.search || url.hash || !url.hostname) throw new SafeError("REFERENCE_INVALID", "SMTP endpoint is invalid.");
  const port = url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SafeError("REFERENCE_INVALID", "SMTP endpoint is invalid.");
  return { host: url.hostname, port, secure: url.protocol === "smtps:" };
}

function isProviderRejection(error: MailError): boolean {
  return typeof error.responseCode === "number" || Array.isArray(error.rejected);
}

function isPreSubmissionConnectionFailure(error: MailError): boolean {
  return error.command === "CONN";
}

function safeErrorCode(code: unknown): string {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNCLASSIFIED";
}

function errorEvidence(error: MailError): string {
  const phase = error.command === "CONN" ? "connection" : error.command === undefined ? "unknown" : "smtp_command";
  const code = safeErrorCode(error.code);
  return `smtp_error:${phase}:${code}`;
}

/** Nodemailer SMTP adapter. It never retries and never emits message content. */
export class NodemailerSmtpAdapter implements SmtpAdapter {
  private readonly transport: (Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail"> & { verify?: () => Promise<unknown> }) | undefined;
  constructor(private readonly options: NodemailerSmtpOptions) { this.transport = options.transport; }

  async submit(_messageIdHeader: string, mime: Buffer, envelope: SmtpEnvelope): Promise<SmtpSubmissionResult> {
    let credential;
    try {
      credential = await this.options.credentials.get(this.options.credentialRef);
    } catch {
      return { outcome: "PRE_SUBMISSION_FAILURE", evidence: "credential_unavailable" };
    }
    if (!credential) return { outcome: "PRE_SUBMISSION_FAILURE", evidence: "credential_unavailable" };
    try {
      const transportOptions = { host: this.options.host, port: this.options.port, secure: this.options.secure, auth: { user: credential.username, pass: credential.password } };
      const transport = this.transport ?? (this.options.transportFactory ? this.options.transportFactory(transportOptions) : nodemailer.createTransport(transportOptions));
      const info = await transport.sendMail({ raw: Buffer.from(mime), envelope: { from: envelope.from, to: [...envelope.to], cc: [...envelope.cc], bcc: [...envelope.bcc] } });
      if (Array.isArray(info.rejected) && info.rejected.length > 0) return { outcome: "REJECTED", evidence: "provider_rejected" };
      return { outcome: "ACKNOWLEDGED", evidence: "smtp_acknowledged" };
    } catch (error) {
      const mailError = error as MailError;
      if (isProviderRejection(mailError)) return { outcome: "REJECTED", evidence: typeof mailError.responseCode === "number" && Number.isInteger(mailError.responseCode) && mailError.responseCode >= 400 && mailError.responseCode <= 599 ? `provider_rejected:${mailError.responseCode}` : "provider_rejected" };
      if (isPreSubmissionConnectionFailure(mailError)) return { outcome: "PRE_SUBMISSION_FAILURE", evidence: errorEvidence(mailError) };
      return { outcome: "UNKNOWN", evidence: errorEvidence(mailError) };
    }
  }

  async verify(): Promise<void> {
    const credential = await this.options.credentials.get(this.options.credentialRef);
    if (!credential) throw new SafeError("PROVIDER_UNAVAILABLE", "The SMTP provider is unavailable.");
    const transportOptions = { host: this.options.host, port: this.options.port, secure: this.options.secure, auth: { user: credential.username, pass: credential.password } };
    const transport = this.transport ?? (this.options.transportFactory ? this.options.transportFactory(transportOptions) : nodemailer.createTransport(transportOptions));
    const verifiedTransport = transport as typeof transport & { verify?: () => Promise<unknown> };
    if (!verifiedTransport.verify) throw new SafeError("PROVIDER_UNAVAILABLE", "The SMTP provider is unavailable.");
    await verifiedTransport.verify();
  }
}

export class FakeSmtpAdapter implements SmtpAdapter { readonly submissions: Array<{ messageIdHeader: string; mime: Buffer; envelope: SmtpEnvelope }> = []; constructor(private readonly outcome: SmtpOutcome = "ACKNOWLEDGED") {} async submit(messageIdHeader: string, mime: Buffer, envelope: SmtpEnvelope): Promise<SmtpSubmissionResult> { this.submissions.push({ messageIdHeader, mime, envelope: { from: envelope.from, to: [...envelope.to], cc: [...envelope.cc], bcc: [...envelope.bcc] } }); return { outcome: this.outcome, evidence: `fake:${this.outcome.toLowerCase()}` }; } async verify(): Promise<void> {} }
export class FakeImapAdapter implements ImapAdapter { constructor(private readonly verified = new Set<string>()) {} async verifySent(messageIdHeader: string): Promise<boolean> { return this.verified.has(messageIdHeader); } }

export interface MailFolder { readonly path: string; readonly name: string; readonly delimiter: string; readonly specialUse?: string; }
export interface MailAddress { readonly name?: string | undefined; readonly address?: string | undefined; }
export interface MailForwardMetadata { readonly originalMessageReference?: string | undefined; readonly originalMessageId?: string | undefined; readonly originalSubject?: string | undefined; }
export interface MailSummary { readonly reference: string; readonly folder: string; readonly uid: number; /** Internal cursor/reference binding; removed at the MCP boundary. */ readonly uidValidity?: number; readonly subject?: string | undefined; readonly messageId?: string | undefined; readonly date?: string | undefined; readonly from: readonly MailAddress[]; readonly to: readonly MailAddress[]; readonly cc: readonly MailAddress[]; readonly replyTo?: readonly MailAddress[] | undefined; readonly inReplyTo?: string | undefined; readonly references?: readonly string[] | undefined; readonly forwarding?: MailForwardMetadata | undefined; readonly size?: number | undefined; readonly flags: readonly string[]; }
export interface MailAttachment { readonly filename?: string; readonly contentType?: string; readonly size?: number; readonly content?: Buffer; readonly disposition?: string; readonly contentId?: string; }
export interface MailMessage extends MailSummary { readonly text?: string | undefined; readonly html?: string | undefined; readonly attachments: readonly MailAttachment[]; }
export interface ImapFlowClient { connect(): Promise<void>; logout(): Promise<void>; close(): void; list(): Promise<ListResponse[]>; getMailboxLock(path: string): Promise<{ release(): void }>; append?(path: string | string[], content: string | Buffer, flags?: string[], idate?: Date | string): Promise<{ destination: string; uidValidity?: bigint | number | undefined; uid?: number | undefined; seq?: number | undefined } | false>; search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>; fetch(range: string | number[], query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; source?: { maxLength: number } }, options?: { uid?: boolean }): AsyncGenerator<FetchMessageObject, false | void, undefined>; fetchOne(seq: string | number, query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; source?: { maxLength: number } }, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined>; messageFlagsAdd?(uid: number, flags: string[], options?: { uid?: boolean }): Promise<unknown>; messageFlagsRemove?(uid: number, flags: string[], options?: { uid?: boolean }): Promise<unknown>; messageMove?(uid: number, destination: string, options?: { uid?: boolean }): Promise<number[] | { uidMap?: Map<number, number> | undefined; uidValidity?: bigint | number | undefined } | false | undefined>; messageCopy?(uid: number, destination: string, options?: { uid?: boolean }): Promise<number[] | { uidMap?: Map<number, number> | undefined; uidValidity?: bigint | number | undefined } | false | undefined>; }
export type ImapFlowClientFactory = (options: ImapFlowOptions) => ImapFlowClient;

export interface ImapFlowMailAdapterOptions {
  readonly account: AccountProjection;
  readonly credentials: CredentialResolver;
  readonly clientFactory?: ImapFlowClientFactory;
  readonly maxResults?: number;
  readonly maxReadBytes?: number;
}

function parseEndpoint(endpoint: string): { host: string; port: number; secure: boolean } {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new SafeError("REFERENCE_INVALID", "IMAP endpoint is invalid."); }
  if ((url.protocol !== "imap:" && url.protocol !== "imaps:") || url.username || url.password || url.search || url.hash || !url.hostname) throw new SafeError("REFERENCE_INVALID", "IMAP endpoint is invalid.");
  const port = url.port ? Number(url.port) : url.protocol === "imaps:" ? 993 : 143;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SafeError("REFERENCE_INVALID", "IMAP endpoint is invalid.");
  return { host: url.hostname, port, secure: url.protocol === "imaps:" };
}

function encodeReference(accountId: string, folder: string, uid: number, uidValidity: number): string { return Buffer.from(JSON.stringify({ accountId, folder, uid, uidValidity }), "utf8").toString("base64url"); }
function decodeReference(reference: string, accountId: string): { folder: string; uid: number; uidValidity: number } {
  try { const value = JSON.parse(Buffer.from(reference, "base64url").toString("utf8")) as { accountId?: unknown; folder?: unknown; uid?: unknown; uidValidity?: unknown }; if (value.accountId !== accountId || typeof value.folder !== "string" || !value.folder || !Number.isSafeInteger(value.uid) || (value.uid as number) < 1 || !Number.isSafeInteger(value.uidValidity) || (value.uidValidity as number) < 1) throw new Error(); return { folder: value.folder, uid: value.uid as number, uidValidity: value.uidValidity as number }; } catch { throw new SafeError("REFERENCE_INVALID", "Message reference is invalid for this account."); }
}
function address(value: { name?: string | undefined; address?: string | undefined } | undefined): MailAddress | undefined { if (!value) return undefined; return { ...(value.name === undefined ? {} : { name: value.name }), ...(value.address === undefined ? {} : { address: value.address }) }; }
function addresses(values: readonly { name?: string | undefined; address?: string | undefined }[] | undefined): MailAddress[] { return (values ?? []).map(address).filter((item): item is MailAddress => item !== undefined); }
function safeHeader(value: unknown, max = 998): string | undefined { return typeof value === "string" && value.length <= max && !/[\r\n]/.test(value) ? value : undefined; }
function messageIdHeaders(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => typeof item === "string" ? item.match(/<[^<>\r\n]+>/g) ?? [] : []).filter((item) => item.length <= 998).slice(0, 100);
}
function headerValue(headers: Map<string, unknown> | undefined, name: string): unknown { return headers?.get(name) ?? headers?.get(name.toLowerCase()); }
function safeForwarding(headers: Map<string, unknown> | undefined): MailForwardMetadata | undefined {
  const originalMessageReference = safeHeader(headerValue(headers, "x-hermes-forwarded-message-reference"), 512);
  const originalMessageId = safeHeader(headerValue(headers, "x-hermes-forwarded-message-id"), 998);
  const originalSubject = safeHeader(headerValue(headers, "x-hermes-forwarded-subject"), 998);
  if (originalMessageReference === undefined && originalMessageId === undefined && originalSubject === undefined) return undefined;
  return { ...(originalMessageReference === undefined ? {} : { originalMessageReference }), ...(originalMessageId === undefined ? {} : { originalMessageId }), ...(originalSubject === undefined ? {} : { originalSubject }) };
}
function mapError(error: unknown): never { if (error instanceof SafeError) throw error; throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider is unavailable."); }

/** Provider-independent, bounded IMAP operations. No reconnect or retry is performed. */
export class ImapFlowMailAdapter implements ImapAdapter {
  private readonly endpoint: { host: string; port: number; secure: boolean };
  private readonly factory: ImapFlowClientFactory;
  private readonly maxResults: number;
  private readonly maxReadBytes: number;
  constructor(private readonly options: ImapFlowMailAdapterOptions) { this.endpoint = parseEndpoint(options.account.imapEndpoint); this.factory = options.clientFactory ?? ((clientOptions) => new ImapFlow(clientOptions)); this.maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 101); this.maxReadBytes = Math.min(Math.max(options.maxReadBytes ?? 1_000_000, 1), 10_000_000); }

  private selectedUidValidity(client: ImapFlowClient): number {
    const raw = (client as ImapFlowClient & { mailbox?: { uidValidity?: bigint | number } }).mailbox?.uidValidity;
    const value = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider returned no valid mailbox generation.");
    return value;
  }
  private validateUidValidity(client: ImapFlowClient, expected: number | undefined): number {
    const actual = this.selectedUidValidity(client);
    if (expected !== undefined && actual !== expected) throw new SafeError("REFERENCE_STALE", "The mailbox changed; query again for a current reference or cursor.");
    return actual;
  }

  private async withClient<T>(operation: (client: ImapFlowClient) => Promise<T>): Promise<T> {
    let client: ImapFlowClient | undefined;
    try { const credential = await this.options.credentials.get(this.options.account.credentialRef); if (!credential) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider is unavailable."); client = this.factory({ ...this.endpoint, auth: { user: credential.username, pass: credential.password }, logger: false }); await client.connect(); return await operation(client); } catch (error) { return mapError(error); } finally { if (client) { try { await client.logout(); } catch { /* close below */ } client.close(); } }
  }

  async listFolders(): Promise<readonly MailFolder[]> { return this.withClient(async (client) => (await client.list()).filter((folder) => !folder.flags?.has("\\Noselect") && !folder.flags?.has("\\NOSELECT")).map((folder) => ({ path: folder.path, name: folder.name, delimiter: folder.delimiter, ...(folder.specialUse === undefined ? {} : { specialUse: folder.specialUse }) }))); }

  async appendDraft(rawMime: Buffer, folder: string, context: DraftAppendContext): Promise<DraftAppendResult> {
    if (context.accountId !== this.options.account.accountId || !/^<[^<>\r\n]+>$/.test(context.messageIdHeader)) throw new SafeError("REFERENCE_INVALID", "Draft append context is invalid for this account.");
    return this.withClient(async (client) => {
      if (!client.append) throw new SafeError("UNSUPPORTED_OPERATION", "The configured IMAP provider does not support draft APPEND.");
      const lock = await client.getMailboxLock(folder);
      try {
        const appended = await client.append(folder, rawMime, ["\\Draft"]);
        if (!appended) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the draft append.");
        const uidValidity = this.selectedUidValidity(client);
        const returnedUid = typeof appended.uid === "number" && Number.isSafeInteger(appended.uid) && appended.uid > 0 ? appended.uid : undefined;
        let uid: number;
        if (returnedUid === undefined) {
          const found = await client.search({ header: { "Message-ID": context.messageIdHeader } }, { uid: true });
          const candidates = (Array.isArray(found) ? found : []).filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, 2);
          if (candidates.length !== 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return an unambiguous draft UID.");
          uid = candidates[0]!;
        } else uid = returnedUid;
        const confirmed = await client.fetchOne(uid, { uid: true, envelope: true, flags: true }, { uid: true });
        if (!confirmed || confirmed.uid !== uid || confirmed.envelope?.messageId !== context.messageIdHeader || ![...(confirmed.flags ?? [])].some((flag) => flag.toLowerCase() === "\\draft")) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the exact draft Message-ID and flag.");
        return { reference: encodeReference(this.options.account.accountId, folder, uid, uidValidity), folder, uid, uidValidity };
      } finally { lock.release(); }
    });
  }

  async checkConnectivity(): Promise<void> { await this.withClient(async () => undefined); }

  async listMessages(folder: string, query?: string, limit = this.maxResults, afterUid?: number, expectedUidValidity?: number, filters?: MailSearchFilters): Promise<readonly MailSummary[]> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    return this.withClient(async (client) => { const lock = await client.getMailboxLock(folder); try { const uidValidity = this.validateUidValidity(client, expectedUidValidity); const criteria: SearchObject[] = []; if (query) criteria.push({ or: [{ text: query }, { subject: query }, { header: { Subject: query } }] }); if (filters) criteria.push(...this.searchCriteria(filters)); const base: SearchObject = criteria.length === 0 ? { all: true } : Object.assign({}, ...criteria) as SearchObject; const search: SearchObject = afterUid === undefined ? base : { ...base, uid: `${afterUid + 1}:*` }; const found = await client.search(search, { uid: true }); const uids = (Array.isArray(found) ? found : []).slice(0, bounded); const result: MailSummary[] = []; for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) result.push(this.summary(folder, message, uidValidity)); return result.slice(0, bounded); } finally { lock.release(); } });
  }

  async list(folder: string, limit = this.maxResults, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]> { return this.listMessages(folder, undefined, limit, afterUid, expectedUidValidity); }
  async search(folder: string, query: string, limit = this.maxResults, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]> { return this.listMessages(folder, query, limit, afterUid, expectedUidValidity); }
  async searchWithFilters(folder: string, query: string | undefined, filters: MailSearchFilters, limit = this.maxResults, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]> { return this.listMessages(folder, query, limit, afterUid, expectedUidValidity, filters); }

  private searchCriteria(filters: MailSearchFilters): SearchObject[] {
    if (filters.hasAttachment !== undefined) throw new SafeError("UNSUPPORTED_OPERATION", "The provider cannot safely represent hasAttachment without scanning message content.");
    const criteria: SearchObject[] = [];
    if (filters.from) criteria.push({ from: filters.from });
    if (filters.to) criteria.push({ to: filters.to });
    if (filters.cc) criteria.push({ cc: filters.cc });
    if (filters.subject) criteria.push({ subject: filters.subject });
    if (filters.since) criteria.push({ since: new Date(filters.since.includes("T") ? filters.since : `${filters.since}T00:00:00.000Z`) });
    if (filters.before) criteria.push({ before: new Date(filters.before.includes("T") ? filters.before : `${filters.before}T00:00:00.000Z`) });
    if (filters.isRead !== undefined) criteria.push({ seen: filters.isRead });
    if (filters.isFlagged !== undefined) criteria.push({ flagged: filters.isFlagged });
    if (filters.messageId) criteria.push({ header: { "Message-ID": filters.messageId } });
    return criteria;
  }

  async read(reference: string): Promise<MailMessage> { const target = decodeReference(reference, this.options.account.accountId); return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try { const uidValidity = this.validateUidValidity(client, target.uidValidity); const message = await client.fetchOne(target.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: this.maxReadBytes } }, { uid: true }); if (!message || !message.source) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found."); const parsed = await simpleParser(message.source); const summary = this.summary(target.folder, message, uidValidity); const references = messageIdHeaders(headerValue(parsed.headers, "references")); const forwarding = safeForwarding(parsed.headers); return { ...summary, ...(references.length === 0 ? {} : { references }), ...(forwarding === undefined ? {} : { forwarding }), ...(parsed.text === undefined ? {} : { text: parsed.text }), ...(typeof parsed.html === "string" ? { html: parsed.html } : {}), attachments: parsed.attachments.map((item) => ({ ...(item.filename === undefined ? {} : { filename: item.filename }), ...(item.contentType === undefined ? {} : { contentType: item.contentType }), ...(item.size === undefined ? {} : { size: item.size }), ...(item.contentDisposition === undefined ? {} : { disposition: item.contentDisposition }), ...(item.contentId === undefined ? {} : { contentId: item.contentId }), content: Buffer.from(item.content) })) }; } finally { lock.release(); } }); }

  async downloadAttachment(reference: string, attachmentIndex: number): Promise<DownloadedAttachment> {
    if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 31) throw new SafeError("INVALID_INPUT", "Attachment index is out of range.");
    const target = decodeReference(reference, this.options.account.accountId);
    return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try {
      this.validateUidValidity(client, target.uidValidity);
      const message = await client.fetchOne(target.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: this.maxReadBytes } }, { uid: true });
      if (!message || !message.source) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found.");
      const parsed = await simpleParser(message.source); const item = parsed.attachments[attachmentIndex];
      if (!item) throw new SafeError("INVALID_INPUT", "Attachment index is out of range.");
      const filename = item.filename; const contentType = item.contentType; const content = Buffer.from(item.content);
      if (!filename || filename.length > 255 || /[\r\n\\/\u0000]/.test(filename) || !contentType || contentType.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(contentType) || item.contentDisposition?.toLowerCase() === "inline" || item.contentId) throw new SafeError("UNSUPPORTED_OPERATION", "This attachment is inline or has unsafe metadata.");
      if (item.size !== undefined && item.size !== content.length) throw new SafeError("ATTACHMENT_CHANGED", "The attachment changed while it was being read.");
      if (content.length > Math.min(this.maxReadBytes, 5_000_000)) throw new SafeError("INVALID_INPUT", "The attachment exceeds the bounded download size.");
      const { createHash } = await import("node:crypto");
      return { filename, contentType, size: content.length, sha256: createHash("sha256").update(content).digest("hex"), content };
    } finally { lock.release(); } });
  }

  async mutate(action: MailboxMutation): Promise<MailboxMutationResult> {
    const target = decodeReference(action.messageReference, this.options.account.accountId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(target.folder);
      try {
        const uidValidity = this.validateUidValidity(client, target.uidValidity);
        let resultUid = target.uid;
        let resultUidValidity = uidValidity;
        if (action.type === "markRead" || action.type === "markUnread" || action.type === "addFlag" || action.type === "removeFlag") {
          const method = action.type === "markRead" || action.type === "addFlag" ? client.messageFlagsAdd : client.messageFlagsRemove;
          const flags = action.type === "markRead" || action.type === "markUnread" ? ["\\Seen"] : [action.flag!];
          if (!method) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support this mailbox mutation.");
          await method.call(client, target.uid, flags, { uid: true });
        } else {
          let destination = action.destinationFolder;
          if (action.type === "trash" || action.type === "restore") {
            const folders = await client.list();
            const special = action.type === "trash" ? "\\Trash" : undefined;
            destination = special === undefined ? this.options.account.inboxFolder : folders.find((folder) => folder.specialUse?.toLowerCase() === special.toLowerCase() && !folder.flags?.has("\\Noselect") && !folder.flags?.has("\\NOSELECT"))?.path;
            if (!destination) throw new SafeError("UNSUPPORTED_OPERATION", "The provider did not expose the required special-use mailbox.");
          }
          if (!destination) throw new SafeError("INVALID_INPUT", "A destination folder is required.");
          if (action.type === "restore" && target.folder !== (await client.list()).find((folder) => folder.specialUse?.toLowerCase() === "\\trash".toLowerCase() && !folder.flags?.has("\\Noselect") && !folder.flags?.has("\\NOSELECT"))?.path) throw new SafeError("INVALID_INPUT", "Only messages in the provider Trash mailbox can be restored.");
          const method = action.type === "copy" ? client.messageCopy : client.messageMove;
          if (!method) throw new SafeError("UNSUPPORTED_OPERATION", "The configured mailbox adapter does not support this mailbox mutation.");
          const moved = await method.call(client, target.uid, destination, { uid: true });
          const movedMeta = moved && !Array.isArray(moved) && typeof moved === "object" ? moved : undefined;
          const mappedUid = Array.isArray(moved) ? moved[0] : movedMeta?.uidMap instanceof Map ? movedMeta.uidMap.get(target.uid) : undefined;
          if (typeof mappedUid !== "number" || !Number.isSafeInteger(mappedUid) || mappedUid < 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the mutation.");
          resultUid = mappedUid;
          if (typeof movedMeta?.uidValidity === "bigint") resultUidValidity = Number(movedMeta.uidValidity);
          else if (typeof movedMeta?.uidValidity === "number" && Number.isSafeInteger(movedMeta.uidValidity)) resultUidValidity = movedMeta.uidValidity;
        }
        const confirmationFolder = action.type === "move" || action.type === "trash" || action.type === "restore" ? (action.type === "restore" ? this.options.account.inboxFolder : action.type === "trash" ? (await client.list()).find((folder) => folder.specialUse?.toLowerCase() === "\\trash".toLowerCase() && !folder.flags?.has("\\Noselect") && !folder.flags?.has("\\NOSELECT"))?.path : action.destinationFolder!) : target.folder;
        if (!confirmationFolder) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the destination mailbox.");
        if (action.type === "move" || action.type === "copy" || action.type === "trash" || action.type === "restore") return { action: action.type, reference: encodeReference(this.options.account.accountId, confirmationFolder, resultUid, resultUidValidity), folder: confirmationFolder, uid: resultUid, flags: [] };
        const confirmed = await client.fetchOne(resultUid, { uid: true, flags: true }, { uid: true });
        if (!confirmed || confirmed.uid !== resultUid) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the mutation.");
        const flags = [...(confirmed.flags ?? [])];
        const hasFlag = (flag: string) => flags.includes(flag);
        if (action.type === "markRead" && !hasFlag("\\Seen")) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the read state.");
        if (action.type === "markUnread" && hasFlag("\\Seen")) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the unread state.");
        if (action.type === "addFlag" && !hasFlag(action.flag!)) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the flag.");
        if (action.type === "removeFlag" && hasFlag(action.flag!)) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the flag removal.");
        return { action: action.type, reference: encodeReference(this.options.account.accountId, confirmationFolder, resultUid, resultUidValidity), folder: confirmationFolder, uid: resultUid, flags };
      } finally { lock.release(); }
    });
  }

  async thread(folder: string, anchorReference: string, limit = this.maxResults): Promise<readonly MailSummary[]> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    const target = decodeReference(anchorReference, this.options.account.accountId);
    if (target.folder !== folder) throw new SafeError("INVALID_INPUT", "Thread folder does not match message reference folder.");
    const anchor = await this.read(anchorReference);
    const ids = [...new Set([anchor.messageId, anchor.inReplyTo, ...(anchor.references ?? [])].filter((value): value is string => typeof value === "string" && /^<[^<>\r\n]+>$/.test(value)))].slice(0, 100);
    if (ids.length === 0) return [anchor].slice(0, bounded);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uidValidity = this.validateUidValidity(client, target.uidValidity);
        const criteria: SearchObject[] = ids.flatMap((id) => [
          { header: { "Message-ID": id } },
          { header: { "In-Reply-To": id } },
          { header: { References: id } },
        ]);
        const uidSet = new Set<number>();
        for (const criterion of criteria) {
          const found = await client.search(criterion, { uid: true });
          for (const uid of (Array.isArray(found) ? found : [])) {
            if (!Number.isSafeInteger(uid) || uid < 1) continue;
            uidSet.add(uid);
            if (uidSet.size >= bounded) break;
          }
        }
        const uids = [...uidSet];
        const messages: MailSummary[] = [anchor];
        const seen = new Set([`${anchor.folder}\u0000${anchor.uid}`]);
        for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
          const key = `${folder}\u0000${message.uid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push(this.summary(folder, message, uidValidity));
          if (messages.length >= bounded) break;
        }
        return messages.slice(0, bounded);
      } finally { lock.release(); }
    });
  }

  async verifySent(messageIdHeader: string): Promise<boolean> { if (!/^<[^<>\r\n]+>$/.test(messageIdHeader)) throw new SafeError("REFERENCE_INVALID", "Message-ID header is invalid."); return this.withClient(async (client) => { const lock = await client.getMailboxLock(this.options.account.sentFolder); try { const found = await client.search({ header: { "Message-ID": messageIdHeader } }, { uid: true }); for (const uid of (Array.isArray(found) ? found : []).slice(0, this.maxResults)) { const message = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true }); if (message && message.envelope?.messageId === messageIdHeader) return true; } return false; } finally { lock.release(); } }); }

  private summary(folder: string, message: FetchMessageObject, uidValidity: number): MailSummary { const envelope = message.envelope; return { reference: encodeReference(this.options.account.accountId, folder, message.uid, uidValidity), folder, uid: message.uid, uidValidity, ...(envelope?.subject === undefined ? {} : { subject: envelope.subject }), ...(envelope?.messageId === undefined ? {} : { messageId: envelope.messageId }), ...(envelope?.date === undefined ? {} : { date: new Date(envelope.date).toISOString() }), from: addresses(envelope?.from), to: addresses(envelope?.to), cc: addresses(envelope?.cc), ...(envelope?.replyTo === undefined ? {} : { replyTo: addresses(envelope.replyTo) }), ...(envelope?.inReplyTo === undefined ? {} : { inReplyTo: safeHeader(envelope.inReplyTo) }), ...(message.size === undefined ? {} : { size: message.size }), flags: [...(message.flags ?? [])] }; }
}
