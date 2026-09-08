import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../helpers.js";
import { MailGatewayService } from "../../src/application/service.js";
import { FakeSmtpAdapter, type ImapAdapter, type MailFolder, type MailMessage, type MailSummary } from "../../src/mail/adapters.js";
import { SafeError } from "../../src/errors.js";

function message(folder: string, reference: string, subject: string): MailSummary {
  return { folder, reference, uid: 7, uidValidity: 1, subject, messageId: `<${reference}@example.test>`, from: [{ address: "sender@example.test" }], to: [{ address: "recipient@example.test" }], cc: [], flags: [], size: 42 };
}

class FakeMailboxAdapter implements ImapAdapter {
  readonly calls: string[] = [];
  constructor(private readonly label: string, private readonly verified = true, private readonly source?: Partial<MailMessage>) {}
  async list(folder: string, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`list:${folder}:${limit}`); return [message(folder, `${this.label}-list`, this.label)]; }
  async search(folder: string, query: string, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`search:${folder}:${query}:${limit}`); return [message(folder, `${this.label}-search`, query)]; }
  async searchWithFilters(folder: string, query: string | undefined, filters: Record<string, unknown>, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`filtered:${folder}:${query ?? ""}:${Object.keys(filters).sort().join(",")}:${limit}`); return [message(folder, `${this.label}-filtered`, "filtered")]; }
  async listFolders(): Promise<readonly MailFolder[]> { this.calls.push("folders"); return [{ path: "Inbox", name: "Inbox", delimiter: "/" }, { path: "Archive/Receipts", name: "Receipts", delimiter: "/", specialUse: "\\All" }]; }
  async read(reference: string): Promise<MailMessage> { this.calls.push(`read:${reference}`); return { ...message("Inbox", reference, this.label), text: `safe body ${this.label}`, attachments: [], ...this.source }; }
  async downloadAttachment(reference: string, attachmentIndex: number) { this.calls.push(`download:${reference}:${attachmentIndex}`); return { filename: "safe.txt", contentType: "text/plain", size: 4, sha256: "a".repeat(64), content: Buffer.from("safe") }; }
  async thread(folder: string, reference: string, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`thread:${folder}:${reference}:${limit}`); return [message(folder, `${this.label}-thread`, "thread subject")]; }
  async mutate(action: { type: "move" | "copy" | "markRead" | "markUnread" | "addFlag" | "removeFlag" | "trash" | "restore"; messageReference: string; destinationFolder?: string; flag?: "\\Flagged" | "\\Answered" }): Promise<{ action: typeof action.type; reference: string; folder: string; uid: number; flags: readonly string[] }> { this.calls.push(`mutate:${action.type}`); return { action: action.type, reference: action.messageReference, folder: action.destinationFolder ?? "Inbox", uid: 7, flags: [] }; }
  async verifySent(messageIdHeader: string): Promise<boolean> { this.calls.push(`verify:${messageIdHeader}`); return this.verified; }
  async checkConnectivity(): Promise<void> { this.calls.push("health:imap"); }
}

function serviceFixture() {
  const base = fixture();
  base.accounts.upsert({ accountId: "other", displayName: "Other", providerKind: "gmail", imapEndpoint: "imaps://other.example.test", smtpEndpoint: "smtps://other.example.test", credentialRef: "keychain:private/other", smtpCredentialRef: "keychain:private/other-smtp", sentPolicy: "provider_managed", enabled: true, allowedSender: "other@example.test", allowedAttachmentRoots: [base.dir], inboxFolder: "INBOX", sentFolder: "[Gmail]/Sent Mail" });
  const first = new FakeMailboxAdapter("first");
  const second = new FakeMailboxAdapter("second");
  const firstSmtp = new FakeSmtpAdapter();
  const secondSmtp = new FakeSmtpAdapter();
  const service = new MailGatewayService(base.accounts, base.repo, new Map([
    ["acct", { imap: first, smtp: firstSmtp }],
    ["other", { imap: second, smtp: secondSmtp }],
  ]));
  return { ...base, service, first, second, firstSmtp, secondSmtp };
}

const context = { caller: "Hermes main" as const, correlationId: "corr-service" };

test("mailAccounts returns safe projections and provider health", async () => {
  const { service } = serviceFixture();
  const result = await service.mailAccounts({ includeHealth: true });
  assert.deepEqual(result.accounts.map((account) => account.accountId), ["acct", "other"]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /credentialRef|keychain|imapEndpoint|smtpEndpoint|password|auth/i);
  assert.deepEqual(result.accounts[0], { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", allowedSender: "sender@example.test", enabled: true, health: { status: "ok" } });
});

test("mailAccounts skips all provider calls when health is disabled", async () => {
  const { service, first, second } = serviceFixture();
  const result = await service.mailAccounts({ includeHealth: false });
  assert.equal(result.accounts.some((account) => "health" in account), false);
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, []);
});
test("mailExecute performs one account-bound mutation only after destination discovery", async () => {
  const { service, first } = serviceFixture();
  const result = await service.mailExecute({ accountId: "acct", action: { type: "move", messageReference: "opaque-ref", destinationFolder: "Archive/Receipts" } }, context) as { action: string; folder: string; uid: number };
  assert.deepEqual(result, { action: "move", messageReference: "opaque-ref", folder: "Archive/Receipts", uid: 7, flags: [] });
  assert.deepEqual(first.calls, ["folders", "mutate:move"]);
});
test("cancelPrepared is durable and does not invoke a provider", async () => {
  const { service, first } = serviceFixture();
  const prepared = await service.mailPrepare({ accountId: "acct", intent: "draft", idempotencyKey: "draft-cancel-123", recipients: ["recipient@example.test"], subject: "Draft", textBody: "body", attachments: [] }, context) as { messageId: string; intent?: string };
  assert.equal(prepared.intent, "draft");
  await assert.rejects(service.mailExecute({ accountId: "acct", messageId: prepared.messageId, verifyOnly: false }, context), (error: unknown) => error instanceof SafeError && error.code === "UNSUPPORTED_OPERATION");
  const result = await service.mailExecute({ accountId: "acct", action: { type: "cancelPrepared", messageId: prepared.messageId } }, context) as { state: string; action: string };
  assert.deepEqual(result, { messageId: prepared.messageId, accountId: "acct", intent: "draft", state: "CANCELLED", action: "cancelPrepared" });
  assert.deepEqual(first.calls, []);
});

test("failed account health is generic and does not prevent listing", async () => {
  const base = fixture();
  const imap: ImapAdapter = {
    verifySent: async () => false,
    checkConnectivity: async () => { throw new Error("provider password and transcript must not escape"); },
    list: async (folder) => [message(folder, "safe-ref", "safe")],
  };
  const smtp: FakeSmtpAdapter = new FakeSmtpAdapter();
  smtp.verify = async () => { throw new Error("smtp diagnostic must not escape"); };
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp }]]));
  const accounts = await service.mailAccounts({ includeHealth: true });
  assert.deepEqual(accounts.accounts[0]?.health, { status: "failed" });
  assert.doesNotMatch(JSON.stringify(accounts), /provider password|transcript|smtp diagnostic|credential|keychain/i);
  assert.equal((await service.mailQuery({ accountId: "acct", operation: "list", limit: 1 }, context) as { messages: unknown[] }).messages.length, 1);
});

test("mailQuery list uses an opaque bounded cursor and rejects scope reuse", async () => {
  const base = fixture();
  base.accounts.upsert({ accountId: "other", displayName: "Other", providerKind: "gmail", imapEndpoint: "imaps://other.example.test", smtpEndpoint: "smtps://other.example.test", credentialRef: "keychain:private/other", sentPolicy: "provider_managed", enabled: true, allowedSender: "other@example.test", allowedAttachmentRoots: [base.dir], inboxFolder: "INBOX", sentFolder: "Sent" });
  const all = [1, 2, 3].map((uid) => ({ ...message("Inbox", `ref-${uid}`, `subject-${uid}`), uid }));
  const imap: ImapAdapter = {
    verifySent: async () => false,
    list: async (_folder, limit = 100, afterUid) => all.filter((item) => afterUid === undefined || item.uid > afterUid).slice(0, limit),
  };
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }], ["other", { imap, smtp: new FakeSmtpAdapter() }]]));
  const first = await service.mailQuery({ accountId: "acct", operation: "list", limit: 2 }, context) as { messages: MailSummary[]; hasMore: boolean; nextCursor?: string };
  assert.deepEqual(first.messages.map((item) => item.uid), [1, 2]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await service.mailQuery({ accountId: "acct", operation: "list", cursor: first.nextCursor, limit: 2 }, context) as { messages: MailSummary[]; hasMore: boolean };
  assert.deepEqual(second.messages.map((item) => item.uid), [3]);
  assert.equal(second.hasMore, false);
  await assert.rejects(service.mailQuery({ accountId: "other", operation: "list", cursor: first.nextCursor, limit: 2 }, context), { code: "INVALID_INPUT" });
  await assert.rejects(service.mailQuery({ accountId: "acct", operation: "search", query: "x", cursor: first.nextCursor, limit: 2 }, context), { code: "INVALID_INPUT" });
  await assert.rejects(service.mailQuery({ accountId: "acct", operation: "list", cursor: "not-a-cursor", limit: 2 }, context), { code: "INVALID_INPUT" });
});

test("mailQuery discovers safe folders and routes arbitrary folders to the account adapter", async () => {
  const { service, first, second } = serviceFixture();
  const folders = await service.mailQuery({ accountId: "acct", operation: "folders", limit: 1 }, context);
  assert.deepEqual(folders, { folders: [{ path: "Inbox", name: "Inbox", delimiter: "/" }, { path: "Archive/Receipts", name: "Receipts", delimiter: "/", specialUse: "\\All" }] });
  await service.mailQuery({ accountId: "acct", operation: "list", folder: "Archive/Receipts", limit: 1 }, context);
  await service.mailQuery({ accountId: "acct", operation: "search", folder: "Archive/Receipts", query: "invoice", limit: 3 }, context);
  assert.deepEqual(first.calls.slice(0, 3), ["folders", "list:Archive/Receipts:2", "search:Archive/Receipts:invoice:4"]);
  assert.deepEqual(second.calls, []);
});

test("mailQuery dispatches supported operations to the account-scoped mailbox adapter", async () => {
  const { service, first, second } = serviceFixture();
  await service.mailQuery({ accountId: "acct", operation: "list", limit: 200 }, context);
  await service.mailQuery({ accountId: "acct", operation: "search", query: "invoice", limit: 3 }, context);
  await service.mailQuery({ accountId: "acct", operation: "read", messageReference: "ref-1", limit: 1 }, context);
  const verified = await service.mailQuery({ accountId: "other", operation: "verifySent", messageReference: "<sent@example.test>", limit: 1 }, context);
  assert.deepEqual(verified, { messageIdHeader: "<sent@example.test>", verified: true });
  assert.deepEqual(first.calls, ["list:Inbox:101", "search:Inbox:invoice:4", "read:ref-1"]);
  assert.deepEqual(second.calls, ["verify:<sent@example.test>"]);
});

test("mailQuery returns bounded attachment metadata and thread summaries", async () => {
  const base = fixture();
  const first = new FakeMailboxAdapter("first", true, { attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 12, content: Buffer.from("secret bytes") }] });
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: first, smtp: new FakeSmtpAdapter() }]]));
  const attachments = await service.mailQuery({ accountId: "acct", operation: "attachments", messageReference: "ref-1", limit: 1 }, context);
  assert.deepEqual(attachments, { attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 12 }] });
  assert.doesNotMatch(JSON.stringify(attachments), /secret bytes|"content"/i);
  const thread = await service.mailQuery({ accountId: "acct", operation: "thread", messageReference: "ref-1", limit: 1 }, context);
  assert.deepEqual(thread, { messages: [{ folder: "Inbox", reference: "first-thread", uid: 7, subject: "thread subject", messageId: "<first-thread@example.test>", from: [{ address: "sender@example.test" }], to: [{ address: "recipient@example.test" }], cc: [], flags: [], size: 42 }] });
});
test("mailQuery structured search and attachment download stay account-bound and public-safe", async () => {
  const { service, first } = serviceFixture();
  const filtered = await service.mailQuery({ accountId: "acct", operation: "search", search: { from: "from@example.test", isRead: true }, limit: 1 }, context) as { messages: MailSummary[] };
  assert.equal(filtered.messages[0]?.subject, "filtered");
  const downloaded = await service.mailQuery({ accountId: "acct", operation: "attachments", messageReference: "ref-1", attachmentIndex: 0, limit: 1 }, context) as { attachment: Record<string, unknown> };
  assert.deepEqual(downloaded.attachment, { filename: "safe.txt", contentType: "text/plain", size: 4, sha256: "a".repeat(64), contentBase64: "c2FmZQ==" });
  assert.deepEqual(first.calls.slice(-2), ["filtered:Inbox::from,isRead:2", "download:ref-1:0"]);
});

test("arbitrary provider folder failures are safely mapped without provider text", async () => {
  const { service } = serviceFixture();
  const base = fixture();
  const imap: ImapAdapter = { verifySent: async () => false, list: async () => { throw new Error("provider transcript secret"); }, search: async () => { throw new Error("provider transcript secret"); } };
  const failing = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }]]));
  await assert.rejects(failing.mailQuery({ accountId: "acct", operation: "search", folder: "Private/Other", query: "invoice", limit: 1 }, context), (error: unknown) => error instanceof SafeError && error.code === "PROVIDER_UNAVAILABLE" && !String(error).includes("provider transcript"));
});

test("prepare is idempotent across CC/BCC, reply, forwarding metadata, and repeated execution", async () => {
  const { service, repo, firstSmtp } = serviceFixture();
  const input = { accountId: "acct", idempotencyKey: "routing-123456", recipients: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], replyTo: "reply@example.test", inReplyTo: "<parent@example.test>", references: ["<root@example.test>", "<parent@example.test>"], forwarding: { originalMessageReference: "mailbox-ref", originalMessageId: "<forwarded@example.test>", originalSubject: "Original" }, subject: "Routing", textBody: "body", attachments: [] };
  const first = await service.mailPrepare(input, context) as { messageId: string; state: string };
  const second = await service.mailPrepare(input, context) as { messageId: string; state: string };
  assert.equal(second.messageId, first.messageId);
  assert.equal(second.state, "PREPARED");
  const prepared = repo.get(first.messageId);
  assert.deepEqual(prepared.cc, ["cc@example.test"]);
  assert.deepEqual(prepared.bcc, ["bcc@example.test"]);
  assert.equal(prepared.inReplyTo, "<parent@example.test>");
  assert.deepEqual(prepared.references, ["<root@example.test>", "<parent@example.test>"]);
  assert.deepEqual(prepared.forwarding, { originalMessageReference: "mailbox-ref", originalMessageId: "<mailbox-ref@example.test>", originalSubject: "first" });
  const sent = await service.mailExecute({ accountId: "acct", messageId: first.messageId, verifyOnly: false }, context) as { state: string };
  assert.equal(sent.state, "SENT_VERIFIED");
  assert.deepEqual(firstSmtp.submissions[0]?.envelope, { from: "sender@example.test", to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"] });
  assert.equal(firstSmtp.submissions.length, 1);
  assert.match(firstSmtp.submissions[0]?.mime.toString("utf8") ?? "", /X-Hermes-Forwarded-Message-Reference: mailbox-ref/);
  assert.match(firstSmtp.submissions[0]?.mime.toString("utf8") ?? "", /safe body first/);
});

test("forwarding persists a deterministic body and real source attachment bytes", async () => {
  const base = fixture();
  const bytes = Buffer.from("source attachment bytes");
  const source = new FakeMailboxAdapter("source", true, { subject: "Source subject", messageId: "<source@example.test>", text: "original text", attachments: [{ filename: "source.txt", contentType: "text/plain", size: bytes.length, content: bytes }] });
  const smtp = new FakeSmtpAdapter();
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: source, smtp }]]));
  const prepared = await service.mailPrepare({ accountId: "acct", idempotencyKey: "forward-bytes-123", recipients: ["recipient@example.test"], subject: "Fwd", forwarding: { originalMessageReference: "source-ref" }, textBody: "Prefix", attachments: [] }, context) as { messageId: string };
  const raw = base.repo.getRawMime(prepared.messageId).toString("utf8");
  assert.match(raw, /Prefix\r?\n\r?\n---------- Forwarded message ----------/);
  assert.match(raw, /Subject: Source subject/);
  assert.match(raw, /Message-ID: <source@example.test>/);
  assert.ok(raw.includes(bytes.toString("base64")));
  assert.equal(source.calls.filter((call) => call === "read:source-ref").length, 1);
  await service.mailPrepare({ accountId: "acct", idempotencyKey: "forward-bytes-123", recipients: ["recipient@example.test"], subject: "Fwd", forwarding: { originalMessageReference: "source-ref" }, textBody: "Prefix", attachments: [] }, context);
  assert.equal(source.calls.filter((call) => call === "read:source-ref").length, 1);
});

test("forwarding rejects source attachments without safe content and unsafe source metadata", async () => {
  const base = fixture();
  const noBytes = new FakeMailboxAdapter("source", true, { attachments: [{ filename: "x.txt", contentType: "text/plain", size: 1 }] });
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: noBytes, smtp: new FakeSmtpAdapter() }]]));
  await assert.rejects(service.mailPrepare({ accountId: "acct", idempotencyKey: "forward-no-bytes", recipients: ["recipient@example.test"], subject: "Fwd", forwarding: { originalMessageReference: "ref" }, attachments: [] }, context), (error: unknown) => error instanceof SafeError && error.code === "UNSUPPORTED_OPERATION");
  const unsafe = new FakeMailboxAdapter("source", true, { subject: "bad\nsubject" });
  const unsafeService = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: unsafe, smtp: new FakeSmtpAdapter() }]]));
  await assert.rejects(unsafeService.mailPrepare({ accountId: "acct", idempotencyKey: "forward-unsafe", recipients: ["recipient@example.test"], subject: "Fwd", forwarding: { originalMessageReference: "ref" }, attachments: [] }, context), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT");
});

test("mailPrepare and mailExecute use durable MIME, enforce ownership, and verifyOnly confirms without SMTP", async () => {
  const { service, repo, firstSmtp, first } = serviceFixture();
  const prepared = await service.mailPrepare({ accountId: "acct", idempotencyKey: "service-123456", recipients: ["recipient@example.test"], subject: "Service test", textBody: "body", attachments: [] }, context) as { messageId: string; accountId: string; state: string; messageIdHeader: string };
  assert.equal(prepared.accountId, "acct");
  assert.equal(prepared.state, "PREPARED");
  assert.equal("rawMime" in prepared, false);
  const verified = await service.mailExecute({ accountId: "acct", messageId: prepared.messageId, verifyOnly: true }, context) as { verifyOnly: boolean; verified: boolean };
  assert.deepEqual(verified, { messageId: prepared.messageId, accountId: "acct", messageIdHeader: prepared.messageIdHeader, state: "SENT_VERIFIED", verifyOnly: true, verified: true });
  assert.equal(firstSmtp.submissions.length, 0);
  await assert.rejects(service.mailExecute({ accountId: "other", messageId: prepared.messageId, verifyOnly: false }, context), (error: unknown) => error instanceof SafeError && error.code === "ACCOUNT_NOT_FOUND");
  const executed = await service.mailExecute({ accountId: "acct", messageId: prepared.messageId, verifyOnly: false }, context) as { state: string };
  assert.equal(executed.state, "SENT_VERIFIED");
  assert.equal(firstSmtp.submissions.length, 0);
  assert.equal(repo.getRawMime(prepared.messageId).length > 0, true);
  assert.equal(first.calls.some((call) => call.startsWith("verify:")), true);
  assert.doesNotMatch(JSON.stringify(executed), /rawMime|keychain|credential|password/i);
});

test("verifyOnly leaves a prepared message unchanged when exact Sent verification is missing", async () => {
  const base = fixture();
  const imap: ImapAdapter = { verifySent: async () => false };
  const smtp = new FakeSmtpAdapter();
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp }]]));
  const prepared = await service.mailPrepare({ accountId: "acct", idempotencyKey: "service-missing-123456", recipients: ["recipient@example.test"], subject: "Missing", textBody: "body", attachments: [] }, context) as { messageId: string; state: string };
  const result = await service.mailExecute({ accountId: "acct", messageId: prepared.messageId, verifyOnly: true }, context) as { state: string; verified: boolean };
  assert.equal(result.state, "PREPARED");
  assert.equal(result.verified, false);
  assert.equal(base.repo.get(prepared.messageId).state, "PREPARED");
  assert.equal(smtp.submissions.length, 0);
});
