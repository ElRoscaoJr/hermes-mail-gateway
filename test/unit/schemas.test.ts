import test from "node:test";
import assert from "node:assert/strict";
import { mailPrepareSchema, mailQuerySchema } from "../../src/mcp/schemas.js";
test("schemas reject unknown fields and invalid input", () => { assert.equal(mailQuerySchema.safeParse({ accountId: "a", operation: "list", extra: true }).success, false); assert.equal(mailPrepareSchema.safeParse({ accountId: "a", idempotencyKey: "short", fromAddress: "bad", recipients: [], subject: "x" }).success, false); });
test("preparation sender is optional at the boundary because the account supplies it", () => { const parsed = mailPrepareSchema.safeParse({ accountId: "acct", idempotencyKey: "idem-123456", recipients: ["recipient@example.test"], subject: "x" }); assert.equal(parsed.success, true); });
test("attachment manifests require a declared size", () => { const valid = { path: "/tmp/file.txt", size: 4, sha256: "a".repeat(64), contentType: "text/plain" }; assert.equal(mailPrepareSchema.safeParse({ accountId: "acct", idempotencyKey: "idem-123456", recipients: ["recipient@example.test"], subject: "x", attachments: [valid] }).success, true); const missingSize = { ...valid }; delete (missingSize as { size?: number }).size; assert.equal(mailPrepareSchema.safeParse({ accountId: "acct", idempotencyKey: "idem-123456", recipients: ["recipient@example.test"], subject: "x", attachments: [missingSize] }).success, false); });
test("prepare schema strictly validates routing, reply, and forwarding metadata", () => {
  const valid = { accountId: "acct", idempotencyKey: "idem-123456", recipients: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], replyTo: "reply@example.test", inReplyTo: "<parent@example.test>", references: ["<root@example.test>", "<parent@example.test>"], forwarding: { originalMessageReference: "mailbox-ref", originalMessageId: "<forwarded@example.test>", originalSubject: "Original" }, subject: "x" };
  assert.equal(mailPrepareSchema.safeParse(valid).success, true);
  assert.equal(mailPrepareSchema.safeParse({ ...valid, inReplyTo: "not-a-message-id" }).success, false);
  assert.equal(mailPrepareSchema.safeParse({ ...valid, bcc: ["not-an-address"] }).success, false);
  assert.equal(mailPrepareSchema.safeParse({ ...valid, forwarding: { originalMessageReference: "mailbox-ref", extra: true } }).success, false);
});
