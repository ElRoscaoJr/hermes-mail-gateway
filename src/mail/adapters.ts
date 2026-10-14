import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow, type DownloadObject, type FetchMessageObject, type ImapFlowOptions, type ListResponse, type MessageEnvelopeObject, type MessageStructureObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountProjection, ForwardedAttachment } from "../domain/types.js";
import { SafeError } from "../errors.js";
import type { CredentialResolver } from "./credentials.js";

export interface ImapAdapter {
  verifySent(messageIdHeader: string): Promise<boolean>;
  appendSent?(rawMime: Buffer, context: DraftAppendContext): Promise<void>;
  appendDraft?(rawMime: Buffer, folder: string, context: DraftAppendContext): Promise<DraftAppendResult>;
  listFolders?(): Promise<readonly MailFolder[]>;
  checkConnectivity?(): Promise<void>;
  list?(folder: string, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  listAttachments?(reference: string): Promise<readonly MailAttachment[]>;
  search?(folder: string, query: string, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  searchWithFilters?(folder: string, query: string | undefined, filters: MailSearchFilters, limit?: number, afterUid?: number, expectedUidValidity?: number): Promise<readonly MailSummary[]>;
  searchAllFolders?(query: string | undefined, filters: MailSearchFilters | undefined, limit?: number, cursor?: string): Promise<MailSearchPage>;
  read?(reference: string): Promise<MailMessage>;
  downloadAttachment?(reference: string, attachmentIndex: number): Promise<DownloadedAttachment>;
  thread?(folder: string, anchorReference: string, limit?: number, scope?: "currentFolder" | "allFolders"): Promise<readonly MailSummary[]>;
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
      const transportOptions = { host: this.options.host, port: this.options.port, secure: this.options.secure, requireTLS: !this.options.secure, auth: { user: credential.username, pass: credential.password } };
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
    const transportOptions = { host: this.options.host, port: this.options.port, secure: this.options.secure, requireTLS: !this.options.secure, auth: { user: credential.username, pass: credential.password } };
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
export interface MailSearchPage { readonly messages: readonly MailSummary[]; readonly truncated: boolean; readonly foldersSearched: number; readonly nextCursor?: string; }
export interface ImapFlowClient { connect(): Promise<void>; logout(): Promise<void>; close(): void; list(): Promise<ListResponse[]>; getMailboxLock(path: string): Promise<{ release(): void }>; append?(path: string | string[], content: string | Buffer, flags?: string[], idate?: Date | string): Promise<{ destination: string; uidValidity?: bigint | number | undefined; uid?: number | undefined; seq?: number | undefined } | false>; search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>; download?(range: string | number, part?: string, options?: { uid?: boolean; maxBytes?: number; chunkSize?: number }): Promise<DownloadObject>; fetch(range: string | number[], query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; bodyStructure?: boolean; source?: { maxLength: number } }, options?: { uid?: boolean }): AsyncGenerator<FetchMessageObject, false | void, undefined>; fetchOne(seq: string | number, query: { uid?: boolean; envelope?: boolean; flags?: boolean; internalDate?: boolean; size?: boolean; bodyStructure?: boolean; headers?: boolean | string[]; bodyParts?: Array<string | { key: string; start?: number; maxLength?: number }>; source?: { maxLength: number } }, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined>; messageFlagsAdd?(uid: number, flags: string[], options?: { uid?: boolean }): Promise<unknown>; messageFlagsRemove?(uid: number, flags: string[], options?: { uid?: boolean }): Promise<unknown>; messageMove?(uid: number, destination: string, options?: { uid?: boolean }): Promise<number[] | { uidMap?: Map<number, number> | undefined; uidValidity?: bigint | number | undefined } | false | undefined>; messageCopy?(uid: number, destination: string, options?: { uid?: boolean }): Promise<number[] | { uidMap?: Map<number, number> | undefined; uidValidity?: bigint | number | undefined } | false | undefined>; }
export type ImapFlowClientFactory = (options: ImapFlowOptions) => ImapFlowClient;

export interface ImapFlowMailAdapterOptions {
  readonly account: AccountProjection;
  readonly credentials: CredentialResolver;
  readonly clientFactory?: ImapFlowClientFactory;
  readonly maxResults?: number;
  readonly maxReadBytes?: number;
  readonly maxAttachmentDownloadBytes?: number;
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
  try { const value = JSON.parse(Buffer.from(reference, "base64url").toString("utf8")) as { accountId?: unknown; folder?: unknown; uid?: unknown; uidValidity?: unknown }; if (value.accountId !== accountId || typeof value.folder !== "string" || !value.folder || !Number.isSafeInteger(value.uid) || (value.uid as number) < 1 || (value.uid as number) > IMAP_UID_MAX || !Number.isSafeInteger(value.uidValidity) || (value.uidValidity as number) < 1 || (value.uidValidity as number) > IMAP_UID_MAX) throw new Error(); return { folder: value.folder, uid: value.uid as number, uidValidity: value.uidValidity as number }; } catch { throw new SafeError("REFERENCE_INVALID", "Message reference is invalid for this account."); }
}
function address(value: { name?: string | undefined; address?: string | undefined } | undefined): MailAddress | undefined { if (!value) return undefined; return { ...(value.name === undefined ? {} : { name: value.name }), ...(value.address === undefined ? {} : { address: value.address }) }; }
function addresses(values: readonly { name?: string | undefined; address?: string | undefined }[] | undefined): MailAddress[] { return (values ?? []).map(address).filter((item): item is MailAddress => item !== undefined); }
function safeHeader(value: unknown, max = 998): string | undefined { return typeof value === "string" && value.length <= max && !/[\r\n]/.test(value) ? value : undefined; }
function messageIdHeaders(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => typeof item === "string" ? item.match(/<[^<>\r\n]+>/g) ?? [] : []).filter((item) => item.length <= 998).slice(0, 100);
}
function headerValue(headers: Map<string, unknown> | undefined, name: string): unknown { return headers?.get(name) ?? headers?.get(name.toLowerCase()); }
interface AllFolderSearchCursor { readonly accountId: string; readonly queryHash: string; readonly generationHash: string; readonly dateMs: number | null; readonly folder: string; readonly uid: number; }
function searchHash(query: string | undefined, filters: MailSearchFilters | undefined): string {
  const canonicalFilters = filters === undefined ? null : Object.fromEntries(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ query: query ?? null, filters: canonicalFilters })).digest("hex");
}
function encodeAllFolderCursor(cursor: AllFolderSearchCursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeAllFolderCursor(value: string | undefined, accountId: string, queryHash: string): AllFolderSearchCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.accountId !== accountId || parsed.queryHash !== queryHash || typeof parsed.generationHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.generationHash) || (parsed.dateMs !== null && (!Number.isSafeInteger(parsed.dateMs))) || typeof parsed.folder !== "string" || parsed.folder.length < 1 || parsed.folder.length > 200 || !Number.isSafeInteger(parsed.uid) || (parsed.uid as number) < 1 || (parsed.uid as number) > IMAP_UID_MAX) throw new Error();
    return { accountId, queryHash, generationHash: parsed.generationHash, dateMs: parsed.dateMs as number | null, folder: parsed.folder, uid: parsed.uid as number };
  } catch { throw new SafeError("REFERENCE_INVALID", "The all-folder search cursor is invalid for this query."); }
}
function searchDateMs(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
function compareSearchSummary(left: MailSummary, right: MailSummary): number {
  return searchDateMs(right.date) - searchDateMs(left.date) || left.folder.localeCompare(right.folder) || right.uid - left.uid;
}
function comesAfterSearchCursor(item: MailSummary, cursor: AllFolderSearchCursor): boolean {
  const itemDate = searchDateMs(item.date);
  const cursorDate = cursor.dateMs ?? Number.NEGATIVE_INFINITY;
  if (itemDate !== cursorDate) return cursorDate - itemDate > 0;
  if (item.folder !== cursor.folder) return item.folder.localeCompare(cursor.folder) > 0;
  return item.uid < cursor.uid;
}
function safeForwarding(headers: Map<string, unknown> | undefined): MailForwardMetadata | undefined {
  const originalMessageReference = safeHeader(headerValue(headers, "x-hermes-forwarded-message-reference"), 512);
  const originalMessageId = safeHeader(headerValue(headers, "x-hermes-forwarded-message-id"), 998);
  const originalSubject = safeHeader(headerValue(headers, "x-hermes-forwarded-subject"), 998);
  if (originalMessageReference === undefined && originalMessageId === undefined && originalSubject === undefined) return undefined;
  return { ...(originalMessageReference === undefined ? {} : { originalMessageReference }), ...(originalMessageId === undefined ? {} : { originalMessageId }), ...(originalSubject === undefined ? {} : { originalSubject }) };
}
function mapError(error: unknown): never { if (error instanceof SafeError) throw error; throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider is unavailable."); }
interface AttachmentPart { readonly part: string; readonly filename?: string; readonly contentType: string; readonly encoding?: string; readonly size?: number; readonly disposition?: string; readonly contentId?: string; }
function attachmentParts(structure: MessageStructureObject): AttachmentPart[] {
  const result: AttachmentPart[] = [];
  const visit = (node: MessageStructureObject): void => {
    if (node.childNodes?.length) { for (const child of node.childNodes) visit(child); return; }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (!node.part || (node.disposition?.toLowerCase() !== "attachment" && !filename)) return;
    result.push({ part: node.part, ...(filename === undefined ? {} : { filename }), contentType: node.type, ...(node.encoding === undefined ? {} : { encoding: node.encoding }), ...(node.size === undefined ? {} : { size: node.size }), ...(node.disposition === undefined ? {} : { disposition: node.disposition }), ...(node.id === undefined ? {} : { contentId: node.id }) });
  };
  visit(structure);
  return result.slice(0, 32);
}

const IMAP_UID_MAX = 0xffff_ffff;
const IMAP_UID_WINDOW_SIZE = 1_024;
const IMAP_UID_SEARCH_WINDOW_BUDGET = 128;
const IMAP_ALL_FOLDER_SEARCH_WINDOW_BUDGET = 512;

/** Provider-independent, bounded IMAP operations. No reconnect or retry is performed. */
export class ImapFlowMailAdapter implements ImapAdapter {
  private readonly endpoint: { host: string; port: number; secure: boolean };
  private readonly factory: ImapFlowClientFactory;
  private readonly maxResults: number;
  private readonly maxReadBytes: number;
  private readonly maxAttachmentDownloadBytes: number;
  constructor(private readonly options: ImapFlowMailAdapterOptions) { this.endpoint = parseEndpoint(options.account.imapEndpoint); this.factory = options.clientFactory ?? ((clientOptions) => new ImapFlow(clientOptions)); this.maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 101); this.maxReadBytes = Math.min(Math.max(options.maxReadBytes ?? 1_000_000, 1), 10_000_000); this.maxAttachmentDownloadBytes = Math.min(Math.max(options.maxAttachmentDownloadBytes ?? 10_000_000, 1), 25_000_000); }

  private selectedUidValidity(client: ImapFlowClient): number {
    const raw = (client as ImapFlowClient & { mailbox?: { uidValidity?: bigint | number } }).mailbox?.uidValidity;
    const value = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > IMAP_UID_MAX) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider returned no valid mailbox generation.");
    return value;
  }
  private validateUidValidity(client: ImapFlowClient, expected: number | undefined): number {
    const actual = this.selectedUidValidity(client);
    if (expected !== undefined && actual !== expected) throw new SafeError("REFERENCE_STALE", "The mailbox changed; query again for a current reference or cursor.");
    return actual;
  }

  private selectedUidNext(client: ImapFlowClient): number {
    const raw = (client as ImapFlowClient & { mailbox?: { uidNext?: number } }).mailbox?.uidNext;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > IMAP_UID_MAX + 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider returned no valid UID range.");
    return raw;
  }

  private async searchUidsInWindows(client: ImapFlowClient, criteria: SearchObject, startUid: number, uidNext: number, maxResults: number, budget: { remaining: number }): Promise<number[]> {
    if (!Number.isSafeInteger(startUid) || startUid < 1 || startUid > IMAP_UID_MAX + 1 || !Number.isSafeInteger(maxResults) || maxResults < 1) throw new SafeError("INVALID_INPUT", "The mailbox search range is invalid.");
    const lastUid = uidNext - 1;
    const result: number[] = [];
    let lower = startUid;
    while (lower <= lastUid && result.length < maxResults) {
      if (budget.remaining <= 0) throw new SafeError("QUERY_TOO_LARGE", "The mailbox search exceeded its bounded UID scan; narrow the query.");
      budget.remaining -= 1;
      const upper = Math.min(lastUid, lower + IMAP_UID_WINDOW_SIZE - 1);
      const found = await client.search({ ...criteria, uid: `${lower}:${upper}` }, { uid: true });
      if (!Array.isArray(found)) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned an incomplete mailbox search result.");
      if (found.length > upper - lower + 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned too many mailbox UIDs for a bounded range.");
      const windowUids = new Set<number>();
      for (const uid of found) {
        if (!Number.isSafeInteger(uid) || uid < lower || uid > upper || windowUids.has(uid)) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned an invalid or duplicate mailbox UID.");
        windowUids.add(uid);
      }
      for (const uid of [...windowUids].sort((left, right) => left - right)) {
        result.push(uid);
        if (result.length === maxResults) break;
      }
      lower = upper + 1;
    }
    if (lower <= lastUid && result.length < maxResults) throw new SafeError("QUERY_TOO_LARGE", "The mailbox search exceeded its bounded UID scan; narrow the query.");
    return result;
  }

  private async withClient<T>(operation: (client: ImapFlowClient) => Promise<T>): Promise<T> {
    let client: ImapFlowClient | undefined;
    try { const credential = await this.options.credentials.get(this.options.account.credentialRef); if (!credential) throw new SafeError("PROVIDER_UNAVAILABLE", "The IMAP provider is unavailable."); client = this.factory({ ...this.endpoint, doSTARTTLS: !this.endpoint.secure, auth: { user: credential.username, pass: credential.password }, logger: false }); await client.connect(); return await operation(client); } catch (error) { return mapError(error); } finally { if (client) { try { await client.logout(); } catch { /* close below */ } client.close(); } }
  }

  private async exactSentExists(client: ImapFlowClient, messageIdHeader: string): Promise<boolean> {
    let found: number[];
    try {
      found = await this.searchUidsInWindows(client, { header: { "Message-ID": messageIdHeader } }, 1, this.selectedUidNext(client), this.maxResults + 1, { remaining: IMAP_UID_SEARCH_WINDOW_BUDGET });
    } catch (error) {
      if (error instanceof SafeError && error.code === "QUERY_TOO_LARGE") throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not complete the bounded Sent lookup.");
      throw error;
    }
    if (found.length > this.maxResults) throw new SafeError("PROVIDER_UNAVAILABLE", "The Sent lookup exceeded the safe verification bound.");
    for (const uid of found) {
      const message = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true });
      if (!message || message.uid !== uid || !message.envelope) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the Sent candidate.");
      if (message.envelope.messageId === messageIdHeader) return true;
    }
    return false;
  }

  async listFolders(): Promise<readonly MailFolder[]> { return this.withClient(async (client) => (await client.list()).filter((folder) => !folder.flags?.has("\\Noselect") && !folder.flags?.has("\\NOSELECT")).map((folder) => ({ path: folder.path, name: folder.name, delimiter: folder.delimiter, ...(folder.specialUse === undefined ? {} : { specialUse: folder.specialUse }) }))); }

  async appendSent(rawMime: Buffer, context: DraftAppendContext): Promise<void> {
    if (context.accountId !== this.options.account.accountId || !/^<[^<>\r\n]+>$/.test(context.messageIdHeader)) throw new SafeError("REFERENCE_INVALID", "Sent append context is invalid for this account.");
    return this.withClient(async (client) => {
      if (!client.append) throw new SafeError("UNSUPPORTED_OPERATION", "The configured IMAP provider does not support Sent APPEND.");
      const folder = this.options.account.sentFolder;
      const lock = await client.getMailboxLock(folder);
      try {
        if (await this.exactSentExists(client, context.messageIdHeader)) return;
        const appended = await client.append(folder, rawMime, ["\\Seen"]);
        if (!appended) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the Sent append.");
        let uid = typeof appended.uid === "number" && Number.isSafeInteger(appended.uid) && appended.uid > 0 ? appended.uid : undefined;
        if (uid === undefined) {
          const found = await this.searchUidsInWindows(client, { header: { "Message-ID": context.messageIdHeader } }, 1, this.selectedUidNext(client), 2, { remaining: IMAP_UID_SEARCH_WINDOW_BUDGET });
          if (found.length !== 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return an unambiguous Sent UID.");
          uid = found[0]!;
        }
        const confirmed = await client.fetchOne(uid, { uid: true, envelope: true, flags: true }, { uid: true });
        if (!confirmed || confirmed.uid !== uid || confirmed.envelope?.messageId !== context.messageIdHeader || ![...(confirmed.flags ?? [])].some((flag) => flag.toLowerCase() === "\\seen")) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the exact Sent Message-ID and flag.");
      } finally { lock.release(); }
    });
  }
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
          const found = await this.searchUidsInWindows(client, { header: { "Message-ID": context.messageIdHeader } }, 1, this.selectedUidNext(client), 2, { remaining: IMAP_UID_SEARCH_WINDOW_BUDGET });
          if (found.length !== 1) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return an unambiguous draft UID.");
          uid = found[0]!;
        } else uid = returnedUid;
        const confirmed = await client.fetchOne(uid, { uid: true, envelope: true, flags: true }, { uid: true });
        if (!confirmed || confirmed.uid !== uid || confirmed.envelope?.messageId !== context.messageIdHeader || ![...(confirmed.flags ?? [])].some((flag) => flag.toLowerCase() === "\\draft")) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not confirm the exact draft Message-ID and flag.");
        return { reference: encodeReference(this.options.account.accountId, folder, uid, uidValidity), folder, uid, uidValidity };
      } finally { lock.release(); }
    });
  }

  async checkConnectivity(): Promise<void> { await this.withClient(async () => undefined); }

  async searchAllFolders(query: string | undefined, filters: MailSearchFilters | undefined, limit = this.maxResults, cursor?: string): Promise<MailSearchPage> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    const criteria: SearchObject[] = [];
    if (query) criteria.push({ or: [{ text: query }, { subject: query }, { header: { Subject: query } }] });
    if (filters) criteria.push(...this.searchCriteria(filters));
    if (criteria.length === 0) throw new SafeError("INVALID_INPUT", "A search query or structured search filter is required.");
    const search = Object.assign({}, ...criteria) as SearchObject;
    const queryHash = searchHash(query, filters);
    const decodedCursor = decodeAllFolderCursor(cursor, this.options.account.accountId, queryHash);
    const totalCandidateLimit = Math.min(Math.max(bounded * 20, 100), 2_000);

    return this.withClient(async (client) => {
      const folders = [...new Set((await client.list()).filter((item) => !item.flags?.has("\\Noselect") && !item.flags?.has("\\NOSELECT")).map((item) => item.path))].sort();
      if (folders.length > 100) throw new SafeError("QUERY_TOO_LARGE", "The provider has too many selectable folders for a bounded all-folder search.");
      const candidates: MailSummary[] = [];
      const generations: Array<[string, number, number]> = [];
      const searchBudget = { remaining: IMAP_ALL_FOLDER_SEARCH_WINDOW_BUDGET };
      let totalCandidates = 0;

      for (const folder of folders) {
        const lock = await client.getMailboxLock(folder);
        try {
          const uidValidity = this.selectedUidValidity(client);
          const uidNext = this.selectedUidNext(client);
          generations.push([folder, uidValidity, uidNext]);
          const remainingCandidateCapacity = totalCandidateLimit - totalCandidates;
          const uids = await this.searchUidsInWindows(client, search, 1, uidNext, remainingCandidateCapacity + 1, searchBudget);
          if (uids.length > remainingCandidateCapacity) throw new SafeError("QUERY_TOO_LARGE", "The all-folder search exceeds the configured candidate bound; narrow the search.");
          totalCandidates += uids.length;
          if (uids.length === 0) continue;
          const expectedUids = new Set(uids);
          for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
            if (!Number.isSafeInteger(message.uid) || !expectedUids.delete(message.uid)) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned an unexpected or duplicate search result.");
            candidates.push(this.summary(folder, message, uidValidity));
          }
          if (expectedUids.size > 0) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox changed while the search was running; retry the query.");
        } finally { lock.release(); }
      }

      const generationHash = createHash("sha256").update(JSON.stringify(generations)).digest("hex");
      if (decodedCursor && decodedCursor.generationHash !== generationHash) throw new SafeError("REFERENCE_STALE", "The mailbox folders changed since this search cursor was created.");
      if (decodedCursor && !folders.includes(decodedCursor.folder)) throw new SafeError("REFERENCE_STALE", "The search cursor folder is no longer selectable.");
      const seen = new Set<string>();
      const unique = candidates.filter((item) => {
        const key = item.messageId ? `id:${item.messageId}` : `ref:${item.folder}\u0000${item.uid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      unique.sort(compareSearchSummary);
      const remaining = decodedCursor ? unique.filter((item) => comesAfterSearchCursor(item, decodedCursor)) : unique;
      const messages = remaining.slice(0, bounded);
      const truncated = remaining.length > bounded;
      const last = messages.at(-1);
      const lastDateMs = searchDateMs(last?.date);
      const nextCursor = truncated && last ? encodeAllFolderCursor({ accountId: this.options.account.accountId, queryHash, generationHash, dateMs: Number.isFinite(lastDateMs) ? lastDateMs : null, folder: last.folder, uid: last.uid }) : undefined;
      return { messages, truncated, foldersSearched: folders.length, ...(nextCursor === undefined ? {} : { nextCursor }) };
    });
  }

  async listMessages(folder: string, query?: string, limit = this.maxResults, afterUid?: number, expectedUidValidity?: number, filters?: MailSearchFilters): Promise<readonly MailSummary[]> {
    // Single-folder pages may request one internal lookahead; the service removes it.
    const bounded = Math.min(Math.max(limit, 1), this.maxResults + 1, 101);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uidValidity = this.validateUidValidity(client, expectedUidValidity);
        const uidNext = this.selectedUidNext(client);
        const criteria: SearchObject[] = [];
        if (query) criteria.push({ or: [{ text: query }, { subject: query }, { header: { Subject: query } }] });
        if (filters) criteria.push(...this.searchCriteria(filters));
        const base: SearchObject = criteria.length === 0 ? { all: true } : Object.assign({}, ...criteria) as SearchObject;
        if (afterUid !== undefined && (!Number.isSafeInteger(afterUid) || afterUid < 0 || afterUid > IMAP_UID_MAX)) throw new SafeError("REFERENCE_INVALID", "The mailbox cursor UID is invalid.");
        const uids = await this.searchUidsInWindows(client, base, afterUid === undefined ? 1 : afterUid + 1, uidNext, bounded, { remaining: IMAP_UID_SEARCH_WINDOW_BUDGET });
        const remaining = new Set(uids);
        const result: MailSummary[] = [];
        for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
          if (!Number.isSafeInteger(message.uid) || !remaining.delete(message.uid)) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned an unexpected or duplicate mailbox message.");
          result.push(this.summary(folder, message, uidValidity));
        }
        if (remaining.size > 0) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox changed while the search page was being fetched; retry the query.");
        return result;
      } finally { lock.release(); }
    });
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

  async read(reference: string): Promise<MailMessage> { const target = decodeReference(reference, this.options.account.accountId); return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try { const uidValidity = this.validateUidValidity(client, target.uidValidity); const message = await client.fetchOne(target.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: this.maxReadBytes } }, { uid: true }); if (!message || !message.source) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found."); if (!Number.isSafeInteger(message.size) || message.size !== message.source.length || message.size > this.maxReadBytes) throw new SafeError("MESSAGE_TOO_LARGE", "The complete message exceeds the safe read bound or could not be verified as complete."); const parsed = await simpleParser(message.source); const summary = this.summary(target.folder, message, uidValidity); const references = messageIdHeaders(headerValue(parsed.headers, "references")); const forwarding = safeForwarding(parsed.headers); return { ...summary, ...(references.length === 0 ? {} : { references }), ...(forwarding === undefined ? {} : { forwarding }), ...(parsed.text === undefined ? {} : { text: parsed.text }), ...(typeof parsed.html === "string" ? { html: parsed.html } : {}), attachments: parsed.attachments.map((item) => ({ ...(item.filename === undefined ? {} : { filename: item.filename }), ...(item.contentType === undefined ? {} : { contentType: item.contentType }), ...(item.size === undefined ? {} : { size: item.size }), ...(item.contentDisposition === undefined ? {} : { disposition: item.contentDisposition }), ...(item.contentId === undefined ? {} : { contentId: item.contentId }), content: Buffer.from(item.content) })) }; } finally { lock.release(); } }); }

  /** Return the exact bounded octets whose length was verified; never attest a separate download stream. */
  private async verifyRawAttachmentPart(client: ImapFlowClient, uid: number, part: string, expectedSize: number): Promise<Buffer> {
    const maximumRawBytes = this.maxAttachmentDownloadBytes * 4 + 65_536;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return a verifiable attachment-part size.");
    if (expectedSize > maximumRawBytes) throw new SafeError("ATTACHMENT_TOO_LARGE", "The encoded attachment exceeds the safe verification bound.");
    let offset = 0;
    const chunks: Buffer[] = [];
    while (offset < expectedSize) {
      const requested = Math.min(64 * 1024, expectedSize - offset);
      const response = await client.fetchOne(uid, { uid: true, bodyParts: [{ key: part, start: offset, maxLength: requested }] }, { uid: true });
      if (!response || response.uid !== uid) throw new SafeError("ATTACHMENT_CHANGED", "The attachment message changed while its raw MIME part was being verified.");
      const bytes = response.bodyParts?.get(part);
      if (!bytes || bytes.length !== requested) throw new SafeError("ATTACHMENT_CHANGED", "The raw MIME attachment part was incomplete or inconsistent with its announced size.");
      chunks.push(Buffer.from(bytes));
      offset += bytes.length;
    }
    const sentinel = await client.fetchOne(uid, { uid: true, bodyParts: [{ key: part, start: expectedSize, maxLength: 1 }] }, { uid: true });
    if (!sentinel || sentinel.uid !== uid) throw new SafeError("ATTACHMENT_CHANGED", "The attachment message changed before its raw MIME part was fully verified.");
    const extra = sentinel.bodyParts?.get(part);
    if (extra && extra.length > 0) throw new SafeError("ATTACHMENT_CHANGED", "The raw MIME attachment part exceeds its announced size.");
    return Buffer.concat(chunks, expectedSize);
  }

  async listAttachments(reference: string): Promise<readonly MailAttachment[]> {
    const target = decodeReference(reference, this.options.account.accountId);
    return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try {
      this.validateUidValidity(client, target.uidValidity);
      const message = await client.fetchOne(target.uid, { uid: true, size: true, bodyStructure: true }, { uid: true });
      if (!message) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found.");
      if (!message.bodyStructure) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return message attachment metadata.");
      return attachmentParts(message.bodyStructure).map((item) => ({ ...(safeHeader(item.filename, 255) === undefined ? {} : { filename: item.filename }), ...(safeHeader(item.contentType, 128) === undefined ? {} : { contentType: item.contentType }), ...(Number.isSafeInteger(item.size) && item.size! >= 0 ? { size: item.size } : {}), ...(item.disposition === undefined ? {} : { disposition: item.disposition }), ...(item.contentId === undefined ? {} : { contentId: item.contentId }) }));
    } finally { lock.release(); } });
  }

  async downloadAttachment(reference: string, attachmentIndex: number): Promise<DownloadedAttachment> {
    if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 31) throw new SafeError("INVALID_INPUT", "Attachment index is out of range.");
    const target = decodeReference(reference, this.options.account.accountId);
    return this.withClient(async (client) => { const lock = await client.getMailboxLock(target.folder); try {
      this.validateUidValidity(client, target.uidValidity);
      const message = await client.fetchOne(target.uid, { uid: true, size: true, bodyStructure: true }, { uid: true });
      if (!message) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found.");
      if (message.uid !== target.uid) throw new SafeError("ATTACHMENT_CHANGED", "The provider returned attachment metadata for a different message.");
      if (!Number.isSafeInteger(message.size) || message.size! < 0) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return a verifiable full-message size.");
      if (!message.bodyStructure) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider did not return message attachment metadata.");
      const item = attachmentParts(message.bodyStructure)[attachmentIndex];
      if (!item) throw new SafeError("INVALID_INPUT", "Attachment index is out of range.");
      const filename = item.filename; const contentType = item.contentType;
      if (!filename || filename === "." || filename === ".." || filename.length > 255 || /[\u0000-\u001f\u007f\\/]/.test(filename) || !contentType || contentType.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(contentType) || item.disposition?.toLowerCase() === "inline" || item.contentId) throw new SafeError("UNSUPPORTED_OPERATION", "This attachment is inline or has unsafe metadata.");
      const encoding = (item.encoding ?? "binary").toLowerCase();
      if (!["base64", "quoted-printable", "7bit", "8bit", "binary"].includes(encoding)) throw new SafeError("UNSUPPORTED_OPERATION", "The attachment transfer encoding is unsupported.");
      const raw = await this.verifyRawAttachmentPart(client, target.uid, item.part, item.size ?? Number.NaN);
      // MIME decoders are deliberately forgiving; reject malformed transfer syntax before decoding.
      if (encoding === "base64") {
        const encoded = raw.toString("latin1").replace(/[\r\n\t ]/g, "");
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new SafeError("ATTACHMENT_CHANGED", "The attachment has malformed base64 transfer data.");
      }
      // Force a single opaque attachment so mailparser does not transform text or interpret nested MIME.
      const headers = Buffer.from(`Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="part.bin"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`, "ascii");
      const parsed = await simpleParser(Buffer.concat([headers, raw]));
      if (parsed.attachments.length !== 1) throw new SafeError("ATTACHMENT_CHANGED", "The verified attachment could not be decoded unambiguously.");
      const content = Buffer.from(parsed.attachments[0]!.content);
      if (content.length > this.maxAttachmentDownloadBytes) throw new SafeError("ATTACHMENT_TOO_LARGE", "The attachment exceeds the configured download bound.");
      return { filename, contentType, size: content.length, sha256: createHash("sha256").update(content).digest("hex"), content };
    } finally { lock.release(); } });
  }

  async mutate(action: MailboxMutation): Promise<MailboxMutationResult> {
    const target = decodeReference(action.messageReference, this.options.account.accountId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(target.folder);
      let sourceReleased = false;
      try {
        const uidValidity = this.validateUidValidity(client, target.uidValidity);
        let resultUid = target.uid;
        let resultUidValidity = uidValidity;
        let confirmationFolder = target.folder;
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
          const mappedUid = movedMeta?.uidMap instanceof Map ? movedMeta.uidMap.get(target.uid) : undefined;
          if (typeof mappedUid !== "number" || !Number.isSafeInteger(mappedUid) || mappedUid < 1 || mappedUid > IMAP_UID_MAX) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the mutation.");
          const rawDestinationUidValidity = movedMeta?.uidValidity;
          const destinationUidValidity = typeof rawDestinationUidValidity === "bigint" ? Number(rawDestinationUidValidity) : rawDestinationUidValidity;
          if (typeof destinationUidValidity !== "number" || !Number.isSafeInteger(destinationUidValidity) || destinationUidValidity < 1 || destinationUidValidity > IMAP_UID_MAX) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the destination mailbox generation.");
          resultUid = mappedUid;
          resultUidValidity = destinationUidValidity;
          confirmationFolder = destination;
        }
        if (!confirmationFolder) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the destination mailbox.");
        if (action.type === "move" || action.type === "copy" || action.type === "trash" || action.type === "restore") {
          sourceReleased = true;
          lock.release();
          const destinationLock = await client.getMailboxLock(confirmationFolder);
          try {
            if (this.selectedUidValidity(client) !== resultUidValidity) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the destination mailbox generation.");
            const confirmed = await client.fetchOne(resultUid, { uid: true, flags: true }, { uid: true });
            if (!confirmed || confirmed.uid !== resultUid) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the mutation.");
            return { action: action.type, reference: encodeReference(this.options.account.accountId, confirmationFolder, resultUid, resultUidValidity), folder: confirmationFolder, uid: resultUid, flags: [...(confirmed.flags ?? [])] };
          } finally { destinationLock.release(); }
        }
        const confirmed = await client.fetchOne(resultUid, { uid: true, flags: true }, { uid: true });
        if (!confirmed || confirmed.uid !== resultUid) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the mutation.");
        const flags = [...(confirmed.flags ?? [])];
        const hasFlag = (flag: string) => flags.includes(flag);
        if (action.type === "markRead" && !hasFlag("\\Seen")) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the read state.");
        if (action.type === "markUnread" && hasFlag("\\Seen")) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the unread state.");
        if (action.type === "addFlag" && !hasFlag(action.flag!)) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the flag.");
        if (action.type === "removeFlag" && hasFlag(action.flag!)) throw new SafeError("PROVIDER_UNAVAILABLE", "The mailbox provider did not confirm the flag removal.");
        return { action: action.type, reference: encodeReference(this.options.account.accountId, confirmationFolder, resultUid, resultUidValidity), folder: confirmationFolder, uid: resultUid, flags };
      } finally { if (!sourceReleased) lock.release(); }
    });
  }

  async thread(folder: string, anchorReference: string, limit = this.maxResults, scope: "currentFolder" | "allFolders" = "allFolders"): Promise<readonly MailSummary[]> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    const target = decodeReference(anchorReference, this.options.account.accountId);
    if (target.folder !== folder) throw new SafeError("INVALID_INPUT", "Thread folder does not match message reference folder.");
    return this.withClient(async (client) => {
      const folders = scope === "allFolders"
        ? [...new Set((await client.list()).filter((item) => !item.flags?.has("\\Noselect") && !item.flags?.has("\\NOSELECT")).map((item) => item.path))]
        : [folder];
      if (folders.length > 100) throw new SafeError("THREAD_TOO_LARGE", "The provider has too many selectable folders for a bounded thread lookup.");
      if (!folders.includes(target.folder)) throw new SafeError("MESSAGE_NOT_FOUND", "The anchor message folder is not selectable.");

      let anchor: FetchMessageObject;
      let anchorUidValidity: number;
      let anchorReferences: string[];
      const anchorLock = await client.getMailboxLock(target.folder);
      try {
        anchorUidValidity = this.validateUidValidity(client, target.uidValidity);
        const fetched = await client.fetchOne(target.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, headers: ["References"] }, { uid: true });
        if (!fetched || fetched.uid !== target.uid) throw new SafeError("MESSAGE_NOT_FOUND", "The anchor message was not found.");
        anchor = fetched;
        const parsedHeaders = await simpleParser(fetched.headers ?? Buffer.alloc(0));
        anchorReferences = messageIdHeaders(headerValue(parsedHeaders.headers, "references"));
      } finally { anchorLock.release(); }

      const rawIds = [...new Set([anchor.envelope?.messageId, anchor.envelope?.inReplyTo, ...anchorReferences].filter((value): value is string => typeof value === "string" && /^<[^<>\r\n]+>$/.test(value)))];
      if (rawIds.length > 50) throw new SafeError("THREAD_TOO_LARGE", "The anchor has too many reference identifiers for a bounded thread lookup.");
      const ids = rawIds;
      const anchorSummary = this.summary(target.folder, anchor, anchorUidValidity);
      const summaries: MailSummary[] = [{ ...anchorSummary, ...(anchorReferences.length === 0 ? {} : { references: anchorReferences }) }];
      const candidateLimit = Math.min(Math.max(this.maxResults * 20, bounded * 20), 2_000);
      const searchBudget = { remaining: IMAP_ALL_FOLDER_SEARCH_WINDOW_BUDGET };
      let totalCandidates = 0;

      for (const candidateFolder of folders) {
        const lock = await client.getMailboxLock(candidateFolder);
        try {
          const uidValidity = candidateFolder === target.folder ? this.validateUidValidity(client, target.uidValidity) : this.selectedUidValidity(client);
          const uidNext = this.selectedUidNext(client);
          const uidSet = new Set<number>();
          const criteria: SearchObject[] = ids.flatMap((id) => [
            { header: { "Message-ID": id } },
            { header: { "In-Reply-To": id } },
            { header: { References: id } },
          ]);
          for (const criterion of criteria) {
            let found: number[];
            try { found = await this.searchUidsInWindows(client, criterion, 1, uidNext, candidateLimit + 1, searchBudget); }
            catch (error) {
              if (error instanceof SafeError && error.code === "QUERY_TOO_LARGE") throw new SafeError("THREAD_TOO_LARGE", "The thread search exceeded its bounded UID scan.");
              throw error;
            }
            if (found.length > candidateLimit) throw new SafeError("THREAD_TOO_LARGE", "The provider returned too many thread candidates for a bounded lookup.");
            for (const uid of found) {
              if (!(candidateFolder === target.folder && uid === target.uid)) uidSet.add(uid);
              if (uidSet.size + totalCandidates > candidateLimit) throw new SafeError("THREAD_TOO_LARGE", "The thread exceeds the total bounded candidate limit.");
            }
          }
          totalCandidates += uidSet.size;
          if (uidSet.size === 0) continue;
          const expectedUids = new Set(uidSet);
          for await (const message of client.fetch([...uidSet], { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
            if (!Number.isSafeInteger(message.uid) || !expectedUids.delete(message.uid)) throw new SafeError("PROVIDER_UNAVAILABLE", "The provider returned an unexpected or duplicate thread candidate.");
            if (!message.envelope?.messageId || !/^<[^<>\r\n]+>$/.test(message.envelope.messageId)) throw new SafeError("PROVIDER_UNAVAILABLE", "A thread message has no valid Message-ID.");
            summaries.push(this.summary(candidateFolder, message, uidValidity));
          }
          if (expectedUids.size > 0) throw new SafeError("PROVIDER_UNAVAILABLE", "The thread changed while it was being read; retry the query.");
        } finally { lock.release(); }
      }

      const seen = new Set<string>();
      const unique = summaries.filter((item) => {
        const key = item.messageId ? `id:${item.messageId}` : `ref:${item.folder}\u0000${item.uid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      unique.sort((left, right) => {
        const leftDate = left.date ? Date.parse(left.date) : Number.POSITIVE_INFINITY;
        const rightDate = right.date ? Date.parse(right.date) : Number.POSITIVE_INFINITY;
        return leftDate - rightDate || left.folder.localeCompare(right.folder) || left.uid - right.uid;
      });
      if (unique.length > bounded) throw new SafeError("THREAD_TOO_LARGE", "The thread exceeds the requested result limit; narrow the query or increase the limit.");
      return unique;
    });
  }

  async verifySent(messageIdHeader: string): Promise<boolean> { if (!/^<[^<>\r\n]+>$/.test(messageIdHeader)) throw new SafeError("REFERENCE_INVALID", "Message-ID header is invalid."); return this.withClient(async (client) => { const lock = await client.getMailboxLock(this.options.account.sentFolder); try { return await this.exactSentExists(client, messageIdHeader); } finally { lock.release(); } }); }

  private summary(folder: string, message: FetchMessageObject, uidValidity: number): MailSummary {
    const envelope = message.envelope;
    const dateValue = envelope?.date;
    const dateMs = dateValue === undefined ? Number.NaN : dateValue instanceof Date ? dateValue.getTime() : Date.parse(dateValue);
    const date = Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : undefined;
    return { reference: encodeReference(this.options.account.accountId, folder, message.uid, uidValidity), folder, uid: message.uid, uidValidity, ...(envelope?.subject === undefined ? {} : { subject: envelope.subject }), ...(envelope?.messageId === undefined ? {} : { messageId: envelope.messageId }), ...(date === undefined ? {} : { date }), from: addresses(envelope?.from), to: addresses(envelope?.to), cc: addresses(envelope?.cc), ...(envelope?.replyTo === undefined ? {} : { replyTo: addresses(envelope.replyTo) }), ...(envelope?.inReplyTo === undefined ? {} : { inReplyTo: safeHeader(envelope.inReplyTo) }), ...(message.size === undefined ? {} : { size: message.size }), flags: [...(message.flags ?? [])] };
  }
}
