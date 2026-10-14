import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../helpers.js";
import { MailGatewayService, type MailQueryInput } from "../../src/application/service.js";
import { FakeSmtpAdapter, type ImapAdapter, type MailMessage } from "../../src/mail/adapters.js";

for (const query of [{ operation: "list" }, { operation: "read", messageReference: "ref" }, { operation: "thread", messageReference: "ref" }, { operation: "thread", messageReference: "ref", includeBodies: true }] as const) {
  test(`public mail projection excludes undeclared provider fields for ${JSON.stringify(query)}`, async () => {
    const base = fixture();
    const summary = { reference: "ref", folder: "Inbox", uid: 1, uidValidity: 7, subject: "subject", messageId: "<safe@example.test>", date: "2026-01-01", from: [{ address: "sender@example.test" }], to: [], cc: [], replyTo: [], inReplyTo: "<prior@example.test>", references: ["<prior@example.test>"], forwarding: { originalSubject: "original" }, size: 42, flags: [], rawMime: Buffer.from("PRIVATE"), source: Buffer.from("PRIVATE"), credentialRef: "PRIVATE" };
    const message: MailMessage = { ...summary, text: "safe text", html: "<p>safe</p>", attachments: [{ filename: "safe.txt", contentType: "invalid/type\\r\\nX-Evil: value", size: 4, content: Buffer.from("PRIVATE") }] };
    const imap: ImapAdapter = { verifySent: async () => false, list: async () => [message], read: async () => message, thread: async () => [message] };
    const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }]]));
    try {
      const result = await service.mailQuery({ accountId: "acct", ...query } as MailQueryInput, { caller: "Hermes main", correlationId: "projection" }) as { message?: Record<string, unknown>; messages?: Record<string, unknown>[] };
      const publicMessage = result.message ?? result.messages![0]!;
      for (const field of ["rawMime", "source", "credentialRef", "uidValidity"]) assert.equal(field in publicMessage, false, field);
      const { rawMime: _raw, source: _source, credentialRef: _credential, uidValidity: _generation, ...expectedSummary } = summary;
      if (query.operation === "read" || (query.operation === "thread" && "includeBodies" in query)) {
        assert.deepEqual(publicMessage, { ...expectedSummary, text: "safe text", html: "<p>safe</p>", attachments: [{ filename: "safe.txt", contentType: "application/octet-stream", size: 4 }] });
      } else assert.deepEqual(publicMessage, expectedSummary);
    } finally { base.db.close(); }
  });
}
