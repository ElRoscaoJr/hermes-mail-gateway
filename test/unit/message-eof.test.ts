import assert from "node:assert/strict";
import test from "node:test";
import { ImapFlowMailAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import { fixture as serviceFixture } from "../helpers.js";
import { MailGatewayService } from "../../src/application/service.js";
import { FakeSmtpAdapter } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";
const account: AccountProjection = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "keychain:test", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "Inbox", sentFolder: "Sent" };
const reference = Buffer.from(JSON.stringify({ accountId: "acct", folder: "Inbox", uid: 7, uidValidity: 1 })).toString("base64url");
function fixture(raw: Buffer, size = raw.length, bound = 1_000_000) {
  const requests: Array<{ start: number; maxLength: number }> = [];
  const client = { mailbox: { uidValidity: 1n }, connect: async () => {}, logout: async () => {}, close: () => {}, getMailboxLock: async () => ({ release() {} }), fetchOne: async (_uid: unknown, query: { source?: { start?: number; maxLength: number } }) => {
    const request = { start: query.source?.start ?? 0, maxLength: query.source?.maxLength ?? 0 }; requests.push(request);
    return { seq: 1, uid: 7, size, source: raw.subarray(request.start, request.start + request.maxLength) };
  } };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, maxReadBytes: bound, clientFactory: () => client as unknown as ImapFlowClient });
  return { adapter, client, requests };
}
for (const phase of [0, 1, 2]) for (const uid of [undefined, 8]) {
  test(`read refuses mismatched UID ${uid} at fetch ${phase}`, async () => {
    const f = fixture(Buffer.alloc(65540, 97));
    const fetch = f.client.fetchOne;
    let calls = 0;
    f.client.fetchOne = async (...args) => { const result = await fetch(...args); return calls++ === phase ? { ...result, uid: uid as number } : result; };
    await assert.rejects(f.adapter.read(reference), { code: "PROVIDER_UNAVAILABLE" });
  });
}
for (const phase of [0, 1, 2]) {
  test(`read detects mailbox generation change at fetch ${phase}`, async () => {
    const f = fixture(Buffer.alloc(65540, 97)); const fetch = f.client.fetchOne; let calls = 0;
    f.client.fetchOne = async (...args) => { const result = await fetch(...args); if (calls++ === phase) f.client.mailbox.uidValidity = 2n; return result; };
    await assert.rejects(f.adapter.read(reference), { code: "REFERENCE_STALE" });
  });
}
for (const hint of [1, 9_000_000]) {
  test(`expanded thread accounts verified bytes rather than size hint ${hint}`, async () => {
    const base = serviceFixture(); const f = fixture(Buffer.from("Content-Type: text/plain\r\n\r\nhello"), hint);
    const summary = { reference, folder: "Inbox", uid: 7, from: [], to: [], cc: [], flags: [], size: hint };
    const imap = { read: (ref: string) => f.adapter.read(ref), thread: async () => [summary], verifySent: async () => false };
    const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }]]));
    try { const result = await service.mailQuery({ accountId: "acct", operation: "thread", messageReference: reference, includeBodies: true }, { caller: "Hermes main", correlationId: "eof" }) as { messages: { size: number; text: string }[] }; assert.equal(result.messages[0]!.size, Buffer.byteLength("Content-Type: text/plain\r\n\r\nhello")); assert.equal(result.messages[0]!.text, "hello"); } finally { base.db.close(); }
  });
}
for (const [length, hint, bound] of [[4037, 13086, 1_000_000], [70000, 1, 100000], [65536, 1, 65536], [1_000_000, 9_000_000, 1_000_000]]) {
  test(`read verifies contiguous bytes length ${length} with hint ${hint}`, async () => {
    const raw = Buffer.concat([Buffer.from("Content-Type: text/plain\r\n\r\n"), Buffer.alloc(length! - 28, 97)]); const f = fixture(raw, hint, bound);
    assert.equal((await f.adapter.read(reference)).size, raw.length);
    let offset = 0; for (const request of f.requests.slice(0, -1)) { assert.equal(request.start, offset); offset += Math.min(request.maxLength, raw.length - offset); }
    assert.deepEqual(f.requests.at(-1), { start: raw.length, maxLength: 1 });
    assert.ok(f.requests.length <= Math.ceil(bound! / 65536) + 1);
  });
}
test("read refuses a byte beyond the exact read bound despite underestimated metadata", async () => {
  const f = fixture(Buffer.alloc(65537, 97), 1, 65536); await assert.rejects(f.adapter.read(reference), { code: "MESSAGE_TOO_LARGE" }); assert.equal(f.requests.length, 2);
});
for (const phase of [0, 1, 2]) {
  test(`read refuses fetch failure at phase ${phase}`, async () => {
    const f = fixture(Buffer.alloc(65540, 97)); const fetch = f.client.fetchOne; let calls = 0;
    f.client.fetchOne = async (...args) => { if (calls++ === phase) throw new Error("synthetic"); return fetch(...args); };
    await assert.rejects(f.adapter.read(reference));
  });
}
for (const size of [undefined, -1, NaN, 1.5]) {
  test(`read refuses invalid size metadata ${size}`, async () => {
    const f = fixture(Buffer.from("Subject: safe\r\n\r\nbody")); const fetch = f.client.fetchOne;
    f.client.fetchOne = async (...args) => ({ ...await fetch(...args), size: size as number });
    await assert.rejects(f.adapter.read(reference), { code: "PROVIDER_UNAVAILABLE" });
  });
}
for (const mode of ["missing", "overlong", "short-interior"] as const) {
  test(`read refuses ${mode} source data`, async () => {
    const f = fixture(Buffer.alloc(65540, 97)); const fetch = f.client.fetchOne;
    f.client.fetchOne = async (...args) => { const result = await fetch(...args); const start = args[1].source?.start ?? 0; return { ...result, source: mode === "missing" ? undefined as unknown as Buffer : mode === "overlong" ? Buffer.alloc((args[1].source?.maxLength ?? 0) + 1) : start === 0 ? result.source.subarray(0, 10) : result.source }; };
    await assert.rejects(f.adapter.read(reference), { code: "PROVIDER_UNAVAILABLE" });
  });
}
test("read refuses a missing EOF source instead of interpreting omission as an empty literal", async () => {
  const f = fixture(Buffer.from("Subject: safe\r\n\r\nbody")); const fetch = f.client.fetchOne;
  f.client.fetchOne = async (...args) => { const result = await fetch(...args); return args[1].source?.maxLength === 1 ? { ...result, source: undefined as unknown as Buffer } : result; };
  await assert.rejects(f.adapter.read(reference), { code: "PROVIDER_UNAVAILABLE" });
});
test("read verifies EOF rather than treating an overstated size hint as truncation", async () => {
  const raw = Buffer.concat([Buffer.from("Content-Type: text/plain\r\n\r\n"), Buffer.alloc(32043, 97)]);
  const f = fixture(raw, 43038);
  const message = await f.adapter.read(reference);
  assert.equal(message.size, raw.length);
  assert.equal(message.text?.length, 32043);
  assert.deepEqual(f.requests, [{ start: 0, maxLength: 65536 }, { start: raw.length, maxLength: 1 }]);
});

test("read verifies exact chunk EOF below a larger configured bound", async () => {
  const f = fixture(Buffer.alloc(65_536, 97), 1, 100_000);
  assert.equal((await f.adapter.read(reference)).size, 65_536);
  assert.deepEqual(f.requests, [{ start: 0, maxLength: 65_536 }, { start: 65_536, maxLength: 34_464 }, { start: 65_536, maxLength: 1 }]);
});

for (const overflow of [false, true]) {
  test(`expanded thread ${overflow ? "rejects one byte above" : "accepts exactly"} its verified aggregate budget`, async () => {
    const base = serviceFixture();
    const summaries = [0, 1, 2].map((uid) => ({ reference: `ref${uid}`, folder: "Inbox", uid, from: [], to: [], cc: [], flags: [], size: 1 }));
    const selected = overflow ? summaries : summaries.slice(0, 2);
    const reads: string[] = [];
    const imap = {
      thread: async () => selected,
      verifySent: async () => false,
      read: async (ref: string) => { reads.push(ref); const summary = selected.find((s) => s.reference === ref)!; return { ...summary, size: ref === "ref1" && overflow ? 33 : 32, text: "body", attachments: [] }; },
    };
    const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, 100, 64);
    try {
      const result = service.mailQuery({ accountId: "acct", operation: "thread", messageReference: "ref0", includeBodies: true }, { caller: "Hermes main", correlationId: "budget" });
      if (overflow) await assert.rejects(result, { code: "THREAD_TOO_LARGE" });
      else assert.equal(((await result) as { messages: unknown[] }).messages.length, 2);
      assert.deepEqual(reads, ["ref0", "ref1"]);
    } finally { base.db.close(); }
  });
}

