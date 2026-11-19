import assert from "node:assert/strict";
import test from "node:test";
import { MailGatewayService } from "../../src/application/service.js";
import { FakeSmtpAdapter, ImapFlowMailAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";
import { fixture as serviceFixture } from "../helpers.js";

const account: AccountProjection = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "keychain:test", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "Inbox", sentFolder: "Sent" };

test("thread aggregate overflow is detected after a complete verified read and stops subsequent reads", async () => {
  const base = serviceFixture();
  const raws = ["first body", "second larger body", "never read"].map((body) => Buffer.from(`Content-Type: text/plain\r\n\r\n${body}`));
  const refs = raws.map((_, index) => Buffer.from(JSON.stringify({ accountId: "acct", folder: "Inbox", uid: index + 1, uidValidity: 1 })).toString("base64url"));
  const summaries = refs.map((reference, index) => ({ reference, folder: "Inbox", uid: index + 1, from: [], to: [], cc: [], flags: [], size: 1 }));
  const requests: Array<{ uid: number; start: number; maxLength: number }> = [];
  const client = { mailbox: { uidValidity: 1n }, connect: async () => {}, logout: async () => {}, close: () => {}, getMailboxLock: async () => ({ release() {} }), fetchOne: async (uid: number, query: { source: { start?: number; maxLength: number } }) => {
    const start = query.source.start ?? 0;
    const maxLength = query.source.maxLength;
    requests.push({ uid, start, maxLength });
    return { seq: uid, uid, size: 1, source: raws[uid - 1]!.subarray(start, start + maxLength) };
  } };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, maxReadBytes: 1000, clientFactory: () => client as unknown as ImapFlowClient });
  const imap = { thread: async () => summaries, read: (reference: string) => adapter.read(reference), verifySent: async () => false };
  const budget = raws[0]!.length + 1;
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, 100, budget);
  try {
    await assert.rejects(service.mailQuery({ accountId: "acct", operation: "thread", messageReference: refs[0]!, includeBodies: true }, { caller: "Hermes main", correlationId: "thread-budget" }), { code: "THREAD_TOO_LARGE" });
    assert.deepEqual([...new Set(requests.map((request) => request.uid))], [1, 2]);
    for (const uid of [1, 2]) {
      const calls = requests.filter((request) => request.uid === uid);
      assert.deepEqual(calls.at(-1), { uid, start: raws[uid - 1]!.length, maxLength: 1 });
    }
    assert.ok(raws[0]!.length + raws[1]!.length > budget);
  } finally { base.db.close(); }
});
