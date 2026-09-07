import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input } from "../helpers.js";
import { FakeImapAdapter, FakeSmtpAdapter } from "../../src/mail/adapters.js";
import { executeOnce } from "../../src/mail/execute.js";
test("Message-ID is stable and acknowledged send requires exact Sent verification", async () => { const { repo } = fixture(); repo.prepare(input()); const smtp = new FakeSmtpAdapter(); const result = await executeOnce(repo, smtp, new FakeImapAdapter(new Set(["<message-a@hermes-mail-gateway.local>"])), "message-a", "owner"); assert.equal(result.state, "SENT_VERIFIED"); assert.equal(smtp.submissions[0]?.messageIdHeader, result.messageIdHeader); });
test("unknown outcome is durable and never automatically retried", async () => { const { repo } = fixture(); repo.prepare(input()); const smtp = new FakeSmtpAdapter("UNKNOWN"); const result = await executeOnce(repo, smtp, new FakeImapAdapter(), "message-a", "owner"); assert.equal(result.state, "OUTCOME_UNKNOWN"); assert.throws(() => repo.claim("message-a", "new-owner", 10_000), { code: "STATE_CONFLICT" }); assert.equal(smtp.submissions.length, 1); });
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
