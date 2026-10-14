import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input } from "../helpers.js";
import { FakeImapAdapter, FakeSmtpAdapter } from "../../src/mail/adapters.js";
import { executeOnce } from "../../src/mail/execute.js";
import { prepareMessage } from "../../src/mail/prepare.js";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
test("Message-ID and persisted SMTP envelope reach the adapter", async () => { const { repo } = fixture(); repo.prepare(input()); const smtp = new FakeSmtpAdapter(); const result = await executeOnce(repo, smtp, new FakeImapAdapter(new Set(["<message-a@hermes-mail-gateway.local>"])), "message-a", "owner"); assert.equal(result.state, "SENT_VERIFIED"); assert.equal(smtp.submissions[0]?.messageIdHeader, result.messageIdHeader); assert.deepEqual(smtp.submissions[0]?.envelope, { from: "sender@example.test", to: ["recipient@example.test"], cc: [], bcc: [] }); });
test("unknown outcome is durable, records bounded evidence, and is never automatically retried", async () => { const { db, repo } = fixture(); repo.prepare(input()); const smtp = new FakeSmtpAdapter("UNKNOWN"); const result = await executeOnce(repo, smtp, new FakeImapAdapter(), "message-a", "owner"); assert.equal(result.state, "OUTCOME_UNKNOWN"); assert.equal((db.prepare("SELECT provider_evidence FROM outbox_messages WHERE message_id = ?").get("message-a") as { provider_evidence: string }).provider_evidence, "fake:unknown"); assert.throws(() => repo.claim("message-a", "new-owner", 10_000), { code: "STATE_CONFLICT" }); assert.equal(smtp.submissions.length, 1); });
test("a thrown SMTP attempt becomes an ambiguous durable outcome and cannot be retried", async () => {
  const { repo } = fixture();
  repo.prepare(input());
  let submissions = 0;
  const smtp = { submit: async () => { submissions += 1; throw new Error("connection lost after DATA"); } };
  const result = await executeOnce(repo, smtp, new FakeImapAdapter(), "message-a", "owner");
  assert.equal(result.state, "OUTCOME_UNKNOWN");
  assert.throws(() => repo.claim("message-a", "new-owner", 10_000), { code: "STATE_CONFLICT" });
  assert.equal(submissions, 1);
});

test("verification failure after SMTP acknowledgement is unverified and cannot be retried", async () => {
  const { repo } = fixture();
  repo.prepare(input());
  const smtp = new FakeSmtpAdapter("ACKNOWLEDGED");
  const imap = { verifySent: async () => { throw new Error("IMAP unavailable"); } };
  const result = await executeOnce(repo, smtp, imap, "message-a", "owner");
  assert.equal(result.state, "SENT_UNVERIFIED");
  assert.throws(() => repo.claim("message-a", "new-owner", 10_000), { code: "STATE_CONFLICT" });
  assert.equal(smtp.submissions.length, 1);
});

test("gateway-managed policy appends the persisted MIME after one SMTP acknowledgment", async () => {
  const { repo } = fixture();
  repo.prepare(input());
  const raw = repo.getRawMime("message-a");
  const smtp = new FakeSmtpAdapter();
  const appends: Array<{ mime: Buffer; accountId: string; messageIdHeader: string }> = [];
  let present = false;
  const imap = { verifySent: async () => present, appendSent: async (mime: Buffer, context: { accountId: string; messageIdHeader: string }) => { appends.push({ mime, ...context }); present = true; } };
  const result = await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append");
  assert.equal(result.state, "SENT_VERIFIED");
  assert.equal(smtp.submissions.length, 1);
  assert.deepEqual(appends, [{ mime: raw, accountId: "acct", messageIdHeader: result.messageIdHeader }]);
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append")).state, "SENT_VERIFIED");
  assert.equal(smtp.submissions.length, 1);
  assert.equal(appends.length, 1);
});

test("provider-managed policy never adds a second Sent copy", async () => {
  const { repo } = fixture(); repo.prepare(input());
  const smtp = new FakeSmtpAdapter();
  let appends = 0;
  const imap = { verifySent: async () => false, appendSent: async () => { appends++; } };
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "provider_managed")).state, "SENT_UNVERIFIED");
  assert.equal(appends, 0);
  assert.equal(smtp.submissions.length, 1);
});

test("gateway-managed policy skips APPEND when Sent already contains the exact message", async () => {
  const { repo } = fixture(); repo.prepare(input());
  const smtp = new FakeSmtpAdapter();
  let appends = 0;
  const imap = { verifySent: async () => true, appendSent: async () => { appends++; } };
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append")).state, "SENT_VERIFIED");
  assert.equal(appends, 0);
  assert.equal(smtp.submissions.length, 1);
});

test("ambiguous Sent APPEND is verified by exact Message-ID, never resent", async () => {
  const { repo } = fixture(); repo.prepare(input());
  const smtp = new FakeSmtpAdapter();
  let present = false; let appends = 0;
  const imap = { verifySent: async () => present, appendSent: async () => { appends++; present = true; throw new Error("lost IMAP response"); } };
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append")).state, "SENT_VERIFIED");
  assert.equal(smtp.submissions.length, 1);
  assert.equal(appends, 1);
});

test("unconfirmed Sent APPEND stays non-retryable even after SMTP acknowledgment", async () => {
  const { repo } = fixture(); repo.prepare(input());
  const smtp = new FakeSmtpAdapter(); let appends = 0;
  const imap = { verifySent: async () => false, appendSent: async () => { appends++; throw new Error("lost IMAP response"); } };
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append")).state, "SENT_UNVERIFIED");
  assert.throws(() => repo.claim("message-a", "new-owner", 10_000), { code: "STATE_CONFLICT" });
  assert.equal(smtp.submissions.length, 1);
  assert.equal(appends, 1);
});

test("ambiguous SMTP never triggers a gateway-managed Sent APPEND", async () => {
  const { repo } = fixture(); repo.prepare(input());
  const smtp = new FakeSmtpAdapter("UNKNOWN"); let appends = 0;
  const imap = { verifySent: async () => false, appendSent: async () => { appends++; } };
  assert.equal((await executeOnce(repo, smtp, imap, "message-a", "owner", "gateway_append")).state, "OUTCOME_UNKNOWN");
  assert.equal(appends, 0);
  assert.equal(smtp.submissions.length, 1);
});

test("execution submits the stored MIME after the source attachment is deleted", async () => {
  const { dir, accounts, repo } = fixture();
  const attachment = `${dir}/source.txt`;
  const bytes = Buffer.from("immutable attachment bytes");
  writeFileSync(attachment, bytes);
  const prepared = await prepareMessage(repo, accounts, {
    accountId: "acct", idempotencyKey: "immutable-123456", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello",
    attachments: [{ path: attachment, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "text/plain" }],
  });
  const stored = repo.getRawMime(prepared.messageId);
  writeFileSync(attachment, "changed");
  rmSync(attachment);
  const smtp = new FakeSmtpAdapter();
  const result = await executeOnce(repo, smtp, new FakeImapAdapter(new Set([prepared.messageIdHeader])), prepared.messageId, "owner");
  assert.equal(result.state, "SENT_VERIFIED");
  assert.deepEqual(smtp.submissions[0]?.mime, stored);
});
