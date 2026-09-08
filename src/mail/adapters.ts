import nodemailer from "nodemailer";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse, type MessageEnvelopeObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountProjection, ForwardedAttachment } from "../domain/types.js";
import { SafeError } from "../errors.js";
import type { CredentialResolver } from "./credentials.js";

export interface ImapAdapter {
  verifySent(messageIdHeader: string): Promise<boolean>;
  list?(folder: string, limit?: number): Promise<readonly MailSummary[]>;
  search?(folder: string, query: string, limit?: number): Promise<readonly MailSummary[]>;
  read?(reference: string): Promise<MailMessage>;
}
export type SmtpOutcome = "ACKNOWLEDGED" | "REJECTED" | "PRE_SUBMISSION_FAILURE" | "UNKNOWN";
export interface SmtpEnvelope { readonly from: string; readonly to: readonly string[]; readonly cc: readonly string[]; readonly bcc: readonly string[]; }
export interface SmtpSubmissionResult { readonly outcome: SmtpOutcome; /** Bounded operator evidence; never a provider transcript or message data. */ readonly evidence: string; }
export interface SmtpAdapter { submit(messageIdHeader: string, mime: Buffer, envelope: SmtpEnvelope): Promise<SmtpOutcome | SmtpSubmissionResult>; }

export interface NodemailerSmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly credentialRef: string;
  readonly credentials: CredentialResolver;
  readonly transport?: Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail">;
  readonly transportFactory?: (options: Parameters<typeof nodemailer.createTransport>[0]) => Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail">;
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
  private readonly transport: Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail"> | undefined;
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
}

export class FakeSmtpAdapter implements SmtpAdapter { readonly submissions: Array<{ messageIdHeader: string; mime: Buffer; envelope: SmtpEnvelope }> = []; constructor(private readonly outcome: SmtpOutcome = "ACKNOWLEDGED") {} async submit(messageIdHeader: string, mime: Buffer, envelope: SmtpEnvelope): Promise<SmtpSubmissionResult> { this.submissions.push({ messageIdHeader, mime, envelope: { from: envelope.from, to: [...envelope.to], cc: [...envelope.cc], bcc: [...envelope.bcc] } }); return { outcome: this.outcome, evidence: `fake:${this.outcome.toLowerCase()}` }; } }
export class FakeImapAdapter implements ImapAdapter { constructor(private readonly verified = new Set<string>()) {} async verifySent(messageIdHeader: string): Promise<boolean> { return this.verified.has(messageIdHeader); } }

export interface MailFolder { readonly path: string; readonly name: string; readonly delimiter: string; readonly specialUse?: string; }
export interface MailAddress { readonly name?: string | undefined; readonly address?: string | undefined; }
export interface MailForwardMetadata { readonly originalMessageReference?: string | undefined; readonly originalMessageId?: string | undefined; readonly originalSubject?: string | undefined; }
export interface MailSummary { readonly reference: string; readonly folder: string; readonly uid: number; readonly subject?: string | undefined; readonly messageId?: string | undefined; readonly date?: string | undefined; readonly from: readonly MailAddress[]; readonly to: readonly MailAddress[]; readonly cc: readonly MailAddress[]; readonly replyTo?: readonly MailAddress[] | undefined; readonly inReplyTo?: string | undefined; readonly references?: readonly string[] | undefined; readonly forwarding?: MailForwardMetadata | undefined; readonly size?: number | undefined; readonly flags: readonly string[]; }
export interface MailAttachment { readonly filename?: string; readonly contentType?: string; readonly size?: number; readonly content?: Buffer; }
export interface MailMessage extends MailSummary { readonly text?: string | undefined; readonly html?: string | undefined; readonly attachments: readonly MailAttachment[]; }
export interface ImapFlowClient { connect(): Promise<void>; logout(): Promise<void>; close(): void; list(): Promise<ListResponse[]>; getMailboxLock(path: string): Promise<{ release(): void }>; search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>; fetch(range: string | number[], query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; source?: { maxLength: number } }, options?: { uid?: boolean }): AsyncGenerator<FetchMessageObject, false | void, undefined>; fetchOne(seq: string | number, query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; source?: { maxLength: number } }, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined>; }
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

function encodeReference(accountId: string, folder: string, uid: number): string { return Buffer.from(JSON.stringify({ accountId, folder, uid }), "utf8").toString("base64url"); }
function decodeReference(reference: string, accountId: string): { folder: string; uid: number } {
  try { const value = JSON.parse(Buffer.from(reference, "base64url").toString("utf8")) as { accountId?: unknown; folder?: unknown; uid?: unknown }; if (value.accountId !== accountId || typeof value.folder !== "string" || !value.folder || !Number.isSafeInteger(value.uid) || (value.uid as number) < 1) throw new Error(); return { folder: value.folder, uid: value.uid as number }; } catch { throw new SafeError("REFERENCE_INVALID", "Message reference is invalid for this account."); }
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
  constructor(private readonly options: ImapFlowMailAdapterOptions) { this.endpoint = parseEndpoint(options.account.imapEndpoint); this.factory = options.clientFactory ?? ((clientOptions) => new ImapFlow(clientOptions)); this.maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 100); this.maxReadBytes = Math.min(Math.max(options.maxReadBytes ?? 1_000_000, 1), 10_000_000); }

  private async withClient<T>(operation: (client: ImapFlowClient) => Promise<T>): Promise<T> {
    let client: ImapFlowClient | undefined;
    try { const credential = await this.options.credentials.get(this.options.account.credentialRef); if (!credential) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider is unavailable."); client = this.factory({ ...this.endpoint, auth: { user: credential.username, pass: credential.password }, logger: false }); await client.connect(); return await operation(client); } catch (error) { return mapError(error); } finally { if (client) { try { await client.logout(); } catch { /* close below */ } client.close(); } }
  }

  async listFolders(): Promise<readonly MailFolder[]> { return this.withClient(async (client) => (await client.list()).map((folder) => ({ path: folder.path, name: folder.name, delimiter: folder.delimiter, ...(folder.specialUse === undefined ? {} : { specialUse: folder.specialUse }) }))); }

  async listMessages(folder: string, query?: string, limit = this.maxResults): Promise<readonly MailSummary[]> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    return this.withClient(async (client) => { const lock = await client.getMailboxLock(folder); try { const search: SearchObject = query ? { or: [{ text: query }, { subject: query }, { header: { Subject: query } }] } : { all: true }; const found = await client.search(search, { uid: true }); const uids = (Array.isArray(found) ? found : []).slice(0, bounded); const result: MailSummary[] = []; for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) result.push(this.summary(folder, message)); return result.slice(0, bounded); } finally { lock.release(); } });
  }

  async list(folder: string, limit = this.maxResults): Promise<readonly MailSummary[]> { return this.listMessages(folder, undefined, limit); }
  async search(folder: string, query: string, limit = this.maxResults): Promise<readonly MailSummary[]> { return this.listMessages(folder, query, limit); }

  async read(reference: string): Promise<MailMessage> { const target = decodeReference(reference, this.options.account.accountId); return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try { const message = await client.fetchOne(target.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: this.maxReadBytes } }, { uid: true }); if (!message || !message.source) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found."); const parsed = await simpleParser(message.source); const summary = this.summary(target.folder, message); const references = messageIdHeaders(headerValue(parsed.headers, "references")); const forwarding = safeForwarding(parsed.headers); return { ...summary, ...(references.length === 0 ? {} : { references }), ...(forwarding === undefined ? {} : { forwarding }), ...(parsed.text === undefined ? {} : { text: parsed.text }), ...(typeof parsed.html === "string" ? { html: parsed.html } : {}), attachments: parsed.attachments.map((item) => ({ ...(item.filename === undefined ? {} : { filename: item.filename }), ...(item.contentType === undefined ? {} : { contentType: item.contentType }), ...(item.size === undefined ? {} : { size: item.size }), content: Buffer.from(item.content) })) }; } finally { lock.release(); } }); }

  async verifySent(messageIdHeader: string): Promise<boolean> { if (!/^<[^<>\r\n]+>$/.test(messageIdHeader)) throw new SafeError("REFERENCE_INVALID", "Message-ID header is invalid."); return this.withClient(async (client) => { const lock = await client.getMailboxLock(this.options.account.sentFolder); try { const found = await client.search({ header: { "Message-ID": messageIdHeader } }, { uid: true }); for (const uid of (Array.isArray(found) ? found : []).slice(0, this.maxResults)) { const message = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true }); if (message && message.envelope?.messageId === messageIdHeader) return true; } return false; } finally { lock.release(); } }); }

  private summary(folder: string, message: FetchMessageObject): MailSummary { const envelope = message.envelope; return { reference: encodeReference(this.options.account.accountId, folder, message.uid), folder, uid: message.uid, ...(envelope?.subject === undefined ? {} : { subject: envelope.subject }), ...(envelope?.messageId === undefined ? {} : { messageId: envelope.messageId }), ...(envelope?.date === undefined ? {} : { date: new Date(envelope.date).toISOString() }), from: addresses(envelope?.from), to: addresses(envelope?.to), cc: addresses(envelope?.cc), ...(envelope?.replyTo === undefined ? {} : { replyTo: addresses(envelope.replyTo) }), ...(envelope?.inReplyTo === undefined ? {} : { inReplyTo: safeHeader(envelope.inReplyTo) }), ...(message.size === undefined ? {} : { size: message.size }), flags: [...(message.flags ?? [])] }; }
}
