import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input } from "../helpers.js";
import { prepareMessage } from "../../src/mail/prepare.js";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { file } from "../helpers.js";
test("state transitions enforce the outbox contract", () => { const { repo } = fixture(); repo.prepare(input()); assert.equal(repo.transition("message-a", "CANCELLED").state, "CANCELLED"); assert.throws(() => repo.transition("message-a", "SENT_VERIFIED"), { code: "STATE_CONFLICT" }); });
test("idempotency replays and conflicts durably", () => { const { repo } = fixture(); const first = repo.prepare(input()); assert.equal(repo.prepare(input()).messageId, first.messageId); assert.throws(() => repo.prepare(input({ requestDigest: "different", messageId: "message-b", messageIdHeader: "<message-b@hermes-mail-gateway.local>" })), { code: "IDEMPOTENCY_CONFLICT" }); });
test("public preparation derives the sender and rejects a mismatch", async () => {
  const { accounts, repo } = fixture();
  const prepared = await prepareMessage(repo, accounts, { accountId: "acct", idempotencyKey: "sender-123456", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello", attachments: [] });
  assert.equal(prepared.fromAddress, "sender@example.test");
  await assert.rejects(prepareMessage(repo, accounts, { accountId: "acct", idempotencyKey: "sender-654321", fromAddress: "attacker@example.test", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello", attachments: [] }), { code: "INVALID_INPUT" });
});

test("bad attachment validation happens before any durable preparation row", async () => {
  const { dir, db, accounts, repo } = fixture();
  const attachment = file(dir, "bad.txt", "actual");
  await assert.rejects(prepareMessage(repo, accounts, {
    accountId: "acct", idempotencyKey: "bad-attachment-123", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello",
    attachments: [{ path: attachment, size: 6, sha256: createHash("sha256").update("different").digest("hex"), contentType: "text/plain" }],
  }), { code: "ATTACHMENT_CHANGED" });
  assert.equal((db.prepare("SELECT count(*) AS n FROM outbox_messages").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM idempotency_keys").get() as { n: number }).n, 0);
  rmSync(attachment);
});
