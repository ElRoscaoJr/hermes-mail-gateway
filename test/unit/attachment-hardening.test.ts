import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { MessageStructureObject } from "imapflow";
import { ImapFlowMailAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

const account: AccountProjection = { accountId: "synthetic", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "synthetic-only", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent" };
const reference = Buffer.from(JSON.stringify({ accountId: account.accountId, folder: "INBOX", uid: 7, uidValidity: 1 })).toString("base64url");
function fixture(raw: Buffer, overrides: Partial<MessageStructureObject> = {}, limit = 1024) {
  const node: MessageStructureObject = { part: "2", type: "application/octet-stream", disposition: "attachment", dispositionParameters: { filename: "data.bin" }, encoding: "base64", size: raw.length, ...overrides };
  let downloads = 0;
  const client: ImapFlowClient & { mailbox: { uidValidity: bigint } } = {
    mailbox: { uidValidity: 1n }, connect: async () => {}, logout: async () => {}, close: () => {}, list: async () => [], search: async () => [], getMailboxLock: async () => ({ release: () => {} }), fetch: async function* () {},
    fetchOne: async (_uid, query) => {
      const request = query.bodyParts?.[0];
      const start = typeof request === "object" ? request.start ?? 0 : 0;
      const length = typeof request === "object" ? request.maxLength ?? raw.length : raw.length;
      return { seq: 1, uid: 7, size: 4096, bodyStructure: { type: "multipart/mixed", childNodes: [node] }, ...(request ? { bodyParts: new Map([["2", raw.subarray(start, start + length)]]) } : {}) };
    },
    download: async () => { downloads++; return { meta: { expectedSize: 4096, filename: "data.bin", contentType: "application/octet-stream" }, content: Readable.from([Buffer.from("abc")]) }; },
  };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => client, maxAttachmentDownloadBytes: limit });
  return { adapter, client, downloads: () => downloads };
}

test("attachment rejects short interior raw responses instead of permitting an unbounded fetch loop", async () => {
  const f = fixture(Buffer.from("YWJjZGVm"));
  const original = f.client.fetchOne;
  let calls = 0;
  f.client.fetchOne = async (uid, query, options) => {
    const response = await original(uid, query, options);
    if (!response || !query.bodyParts) return response;
    calls++;
    const bytes = response.bodyParts?.get("2");
    return { ...response, bodyParts: new Map([["2", bytes?.subarray(0, 1) ?? Buffer.alloc(0)]]) };
  };
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
  assert.equal(calls, 1);
});

test("attachment refuses malformed base64 rather than silently dropping octets", async () => {
  const f = fixture(Buffer.from("YWJj!ZGVm"));
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});

test("attachment rejects noncanonical base64 padding bits", async () => {
  const f = fixture(Buffer.from("YR=="));
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});

test("base64 decoded size matches the canonical wire length", async () => {
  const f = fixture(Buffer.from("YQ=="));
  const result = await f.adapter.downloadAttachment(reference, 0);
  assert.equal(result.size, 1);
  assert.deepEqual(result.content, Buffer.from("a"));
});

test("attachment metadata must identify the requested UID", async () => {
  const f = fixture(Buffer.from("YWJj"));
  const original = f.client.fetchOne;
  f.client.fetchOne = async (uid, query, options) => {
    const response = await original(uid, query, options);
    return response && !query.bodyParts ? { ...response, uid: 8 } : response;
  };
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});

test("attachment falls back to a generated filename for dot names", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: {}, parameters: { name: ".." } });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).filename, "attachment-1.bin");
});

test("attachment sanitizes control and reserved filename characters", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: {}, parameters: { name: "unsafe\tname?.bin" } });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).filename, "unsafename_.bin");
});

test("attachment sanitizes Windows reserved device filenames", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: { filename: "CON.txt" } });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).filename, "_CON.txt");
});

test("attachment neutralizes bidirectional control characters in filenames", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: { filename: "evil\u202Eexe.pdf" } });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).filename, "evilexe.pdf");
});

test("attachment filename is reduced to its basename", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: { filename: "folder\\..\\invoice.pdf" } });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).filename, "invoice.pdf");
});

test("attachment filename is capped at 255 UTF-8 bytes without splitting a code point", async () => {
  const f = fixture(Buffer.from("YWJj"), { dispositionParameters: { filename: `${"🙂".repeat(70)}.pdf` } });
  const filename = (await f.adapter.downloadAttachment(reference, 0)).filename;
  assert.ok(Buffer.byteLength(filename, "utf8") <= 255);
  assert.doesNotMatch(filename, /\uFFFD/);
});

test("explicit inline Content-ID attachments are downloadable", async () => {
  const f = fixture(Buffer.from("YWJj"), { disposition: "inline", id: "<logo@example.test>" });
  const result = await f.adapter.downloadAttachment(reference, 0);
  assert.equal(result.filename, "data.bin");
  assert.equal(result.content.toString("ascii"), "abc");
});

test("attachment metadata uses the same sanitized name and content type", async () => {
  const f = fixture(Buffer.from("YWJj"), { type: "invalid/type\\r\\nX-Evil: value", disposition: "inline", dispositionParameters: { filename: "folder\\invoice?.pdf" }, id: "<invoice@example.test>" });
  const metadata = await f.adapter.listAttachments(reference);
  assert.equal(metadata[0]?.filename, "invoice_.pdf");
  assert.equal(metadata[0]?.contentType, "application/octet-stream");
  assert.equal(metadata[0]?.disposition, "inline");
});

test("Content-ID-only inline parts receive a generated filename", async () => {
  const f = fixture(Buffer.from("YWJj"), { type: "image/png", disposition: "inline", dispositionParameters: {}, parameters: {}, id: "<logo@example.test>" });
  const result = await f.adapter.downloadAttachment(reference, 0);
  assert.equal(result.filename, "attachment-1.bin");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.content.toString("ascii"), "abc");
});

test("ordinary inline body parts without Content-ID are not listed as attachments", async () => {
  const f = fixture(Buffer.from("YWJj"), { type: "text/plain", disposition: "inline", dispositionParameters: {}, parameters: {} });
  assert.deepEqual(await f.adapter.listAttachments(reference), []);
});

test("invalid attachment content types fall back to octet-stream", async () => {
  const f = fixture(Buffer.from("YWJj"), { type: "application/pdf\r\nX-Evil: value" });
  const result = await f.adapter.downloadAttachment(reference, 0);
  assert.equal(result.contentType, "application/octet-stream");
  assert.equal(result.content.toString("ascii"), "abc");
});

test("valid media type parameters are normalized without rejecting the attachment", async () => {
  const f = fixture(Buffer.from("YWJj"), { type: "Text/Plain; charset=utf-8" });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).contentType, "text/plain");
});

test("unknown attachment transfer encodings remain explicitly unsupported", async () => {
  const f = fixture(Buffer.from("abc"), { encoding: "x-unknown" });
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "UNSUPPORTED_OPERATION" });
});

test("verified quoted-printable decoding preserves binary octets and soft line breaks", async () => {
  const f = fixture(Buffer.from("a=00=FF=\r\nb"), { encoding: "quoted-printable" });
  assert.deepEqual((await f.adapter.downloadAttachment(reference, 0)).content, Buffer.from([0x61, 0, 255, 0x62]));
});

test("quoted-printable decoder rejects malformed escape sequences", async () => {
  const f = fixture(Buffer.from("a=G1"), { encoding: "quoted-printable" });
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});

test("verified binary decoding preserves CRLF and non-ASCII bytes", async () => {
  const raw = Buffer.from([0, 255, 13, 10, 97]);
  const f = fixture(raw, { encoding: "binary" });
  assert.deepEqual((await f.adapter.downloadAttachment(reference, 0)).content, raw);
});

test("verified decoding enforces the decoded byte limit", async () => {
  const f = fixture(Buffer.from("YWJjZGVm"), {}, 5);
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_TOO_LARGE" });
});

test("encoded byte limit is enforced before requesting section data", async () => {
  const f = fixture(Buffer.from("YWJj"), { size: 65541 }, 1);
  let sections = 0;
  const original = f.client.fetchOne;
  f.client.fetchOne = async (uid, query, options) => { if (query.bodyParts) sections++; return original(uid, query, options); };
  await assert.rejects(f.adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_TOO_LARGE" });
  assert.equal(sections, 0);
});

test("verified empty binary attachment is supported", async () => {
  const f = fixture(Buffer.alloc(0), { encoding: "binary" });
  assert.equal((await f.adapter.downloadAttachment(reference, 0)).size, 0);
});

test("attachment content comes from the verified raw bytes, not an independently truncated decoded stream", async () => {
  const f = fixture(Buffer.from("YWJjZGVm"));
  const result = await f.adapter.downloadAttachment(reference, 0);
  assert.equal(result.content.toString(), "abcdef");
  assert.equal(f.downloads(), 0);
});
