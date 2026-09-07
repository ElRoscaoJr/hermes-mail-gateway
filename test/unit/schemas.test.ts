import test from "node:test";
import assert from "node:assert/strict";
import { mailPrepareSchema, mailQuerySchema } from "../../src/mcp/schemas.js";
test("schemas reject unknown fields and invalid input", () => { assert.equal(mailQuerySchema.safeParse({ accountId: "a", operation: "list", extra: true }).success, false); assert.equal(mailPrepareSchema.safeParse({ accountId: "a", idempotencyKey: "short", fromAddress: "bad", recipients: [], subject: "x" }).success, false); });
test("preparation sender is optional at the boundary because the account supplies it", () => { const parsed = mailPrepareSchema.safeParse({ accountId: "acct", idempotencyKey: "idem-123456", recipients: ["recipient@example.test"], subject: "x" }); assert.equal(parsed.success, true); });
