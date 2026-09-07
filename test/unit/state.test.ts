import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input } from "../helpers.js";
import { prepareMessage } from "../../src/mail/prepare.js";
test("state transitions enforce the outbox contract", () => { const { repo } = fixture(); repo.prepare(input()); assert.equal(repo.transition("message-a", "CANCELLED").state, "CANCELLED"); assert.throws(() => repo.transition("message-a", "SENT_VERIFIED"), { code: "STATE_CONFLICT" }); });
test("idempotency replays and conflicts durably", () => { const { repo } = fixture(); const first = repo.prepare(input()); assert.equal(repo.prepare(input()).messageId, first.messageId); assert.throws(() => repo.prepare(input({ requestDigest: "different", messageId: "message-b", messageIdHeader: "<message-b@hermes-mail-gateway.local>" })), { code: "IDEMPOTENCY_CONFLICT" }); });
test("public preparation derives the sender and rejects a mismatch", () => {
  const { accounts, repo } = fixture();
  const prepared = prepareMessage(repo, accounts, { accountId: "acct", idempotencyKey: "sender-123456", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello", attachments: [] });
  assert.equal(prepared.fromAddress, "sender@example.test");
  assert.throws(() => prepareMessage(repo, accounts, { accountId: "acct", idempotencyKey: "sender-654321", fromAddress: "attacker@example.test", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello", attachments: [] }), { code: "INVALID_INPUT" });
});
