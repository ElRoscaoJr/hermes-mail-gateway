import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../helpers.js";
import { MailGatewayService } from "../../src/application/service.js";
import { FakeSmtpAdapter, type ImapAdapter, type MailMessage, type MailSummary } from "../../src/mail/adapters.js";
import { SafeError } from "../../src/errors.js";

function message(folder: string, reference: string, subject: string): MailSummary {
  return { folder, reference, uid: 7, subject, messageId: `<${reference}@example.test>`, from: [{ address: "sender@example.test" }], to: [{ address: "recipient@example.test" }], flags: [], size: 42 };
}

class FakeMailboxAdapter implements ImapAdapter {
  readonly calls: string[] = [];
  constructor(private readonly label: string, private readonly verified = true) {}
  async list(folder: string, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`list:${folder}:${limit}`); return [message(folder, `${this.label}-list`, this.label)]; }
  async search(folder: string, query: string, limit?: number): Promise<readonly MailSummary[]> { this.calls.push(`search:${folder}:${query}:${limit}`); return [message(folder, `${this.label}-search`, query)]; }
  async read(reference: string): Promise<MailMessage> { this.calls.push(`read:${reference}`); return { ...message("Inbox", reference, this.label), text: `safe body ${this.label}`, attachments: [] }; }
  async verifySent(messageIdHeader: string): Promise<boolean> { this.calls.push(`verify:${messageIdHeader}`); return this.verified; }
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

test("mailAccounts returns only safe account projections", () => {
  const { service } = serviceFixture();
  const result = service.mailAccounts({ includeHealth: true });
  assert.deepEqual(result.accounts.map((account) => account.accountId), ["acct", "other"]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /credentialRef|keychain|imapEndpoint|smtpEndpoint|password|auth/i);
  assert.deepEqual(result.accounts[0], { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", allowedSender: "sender@example.test", enabled: true });
});

test("mailQuery dispatches all supported operations to the account-scoped mailbox adapter", async () => {
  const { service, first, second } = serviceFixture();
  await service.mailQuery({ accountId: "acct", operation: "list", limit: 200 }, context);
  await service.mailQuery({ accountId: "acct", operation: "search", query: "invoice", limit: 3 }, context);
  await service.mailQuery({ accountId: "acct", operation: "read", messageReference: "ref-1", limit: 1 }, context);
  const verified = await service.mailQuery({ accountId: "other", operation: "verifySent", messageReference: "<sent@example.test>", limit: 1 }, context);
  assert.deepEqual(verified, { messageIdHeader: "<sent@example.test>", verified: true });
  assert.deepEqual(first.calls, ["list:Inbox:100", "search:Inbox:invoice:3", "read:ref-1"]);
  assert.deepEqual(second.calls, ["verify:<sent@example.test>"]);
});

test("thread and attachments fail explicitly instead of falling through", async () => {
  const { service } = serviceFixture();
  await assert.rejects(service.mailQuery({ accountId: "acct", operation: "thread", messageReference: "ref-1", limit: 1 }, context), (error: unknown) => error instanceof SafeError && error.code === "UNSUPPORTED_OPERATION");
  await assert.rejects(service.mailQuery({ accountId: "acct", operation: "attachments", messageReference: "ref-1", limit: 1 }, context), (error: unknown) => error instanceof SafeError && error.code === "UNSUPPORTED_OPERATION");
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
