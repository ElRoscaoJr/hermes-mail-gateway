import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";
import { join } from "node:path";
import { buildMime } from "../../src/mail/mime.js";
import { ImapFlowMailAdapter, NodemailerSmtpAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import type { MessageEnvelopeObject, MessageStructureObject, SearchObject } from "imapflow";
import type { AccountProjection } from "../../src/domain/types.js";
import { parseCredentialReference } from "../../src/mail/credentials.js";
import type { PreparedMessage } from "../../src/domain/types.js";
import { accountConfigSchema } from "../../src/config/model.js";

const baseMessage: PreparedMessage = {
  messageId: "message-a", accountId: "acct", idempotencyKey: "idem-123456", messageIdHeader: "<fixed@hermes-mail-gateway.local>",
  fromAddress: "sender@example.test", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "plain body", state: "PREPARED", attachments: [],
  cc: [], bcc: [], references: [],
};

test("credential references require exactly keychain service/account", () => {
  assert.deepEqual(parseCredentialReference("keychain:smtp/account"), { service: "smtp", account: "account" });
  for (const value of ["smtp/account", "keychain:smtp", "keychain:/account", "keychain:smtp/", "keychain:smtp/a/b", "keychain:smtp/a b", "keychain:smtp\\account"]) {
    assert.throws(() => parseCredentialReference(value), { code: "REFERENCE_INVALID" });
  }
});

test("Nodemailer MIME preserves headers, HTML, attachment bytes, and Message-ID", async () => {
  const dir = "/tmp";
  const path = join(dir, `hermes-mime-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const secondPath = join(dir, `hermes-mime-second-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  const secondBytes = Buffer.from("second attachment");
  writeFileSync(path, bytes);
  writeFileSync(secondPath, secondBytes);
  const message = { ...baseMessage, htmlBody: "<strong>html body</strong>", attachments: [{ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream" }, { path: secondPath, size: secondBytes.length, sha256: createHash("sha256").update(secondBytes).digest("hex"), contentType: "text/plain" }] };
  const raw = await buildMime(message, { attachmentRoots: [dir] });
  const mime = raw.toString("utf8");
  assert.match(mime, /\r\n/);
  assert.doesNotMatch(mime, /(^|[^\r])\n/);
  assert.match(mime, /Message-ID: <fixed@hermes-mail-gateway\.local>/i);
  assert.match(mime, /Content-Type: text\/plain/i);
  assert.match(mime, /html body/);
  assert.match(mime, /Content-Disposition: attachment/);
  assert.ok(mime.includes(bytes.toString("base64")));
  assert.ok(mime.includes(secondBytes.toString("base64")));
  const second = await buildMime(message, { attachmentRoots: [dir] });
  assert.match(second.toString("utf8"), /Message-ID: <fixed@hermes-mail-gateway\.local>/i);
});

test("MIME separates visible recipients from BCC and preserves reply/forward headers", async () => {
  const message: PreparedMessage = { ...baseMessage, recipients: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], replyTo: "reply@example.test", inReplyTo: "<parent@example.test>", references: ["<root@example.test>", "<parent@example.test>"], forwarding: { originalMessageReference: "mailbox-ref", originalMessageId: "<forwarded@example.test>", originalSubject: "Original subject" } };
  const mime = (await buildMime(message, { attachmentRoots: ["/tmp"] })).toString("utf8");
  assert.match(mime, /To: to@example\.test/i);
  assert.match(mime, /Cc: cc@example\.test/i);
  assert.doesNotMatch(mime, /Bcc:/i);
  assert.match(mime, /Reply-To: reply@example\.test/i);
  assert.match(mime, /In-Reply-To: <parent@example\.test>/i);
  assert.match(mime, /References: <root@example\.test> <parent@example\.test>/i);
  assert.match(mime, /X-Hermes-Forwarded-Message-Reference: mailbox-ref/i);
  assert.match(mime, /X-Hermes-Forwarded-Message-ID: <forwarded@example\.test>/i);
});

function adapter(sendMail: (options: unknown) => Promise<{ message: Buffer; rejected?: readonly string[] }>) {
  return new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transport: { sendMail } });
}

const envelope = { from: baseMessage.fromAddress, to: baseMessage.recipients, cc: [], bcc: [] };

test("SMTP adapter classifies provider rejection", async () => {
  const result = await adapter(async () => { throw { responseCode: 550, response: "rejected" }; }).submit("<fixed@id>", Buffer.from("body"), envelope);
  assert.deepEqual(result, { outcome: "REJECTED", evidence: "provider_rejected:550" });
});

test("SMTP adapter classifies an accepted provider response", async () => {
  assert.deepEqual(await adapter(async () => ({ message: Buffer.from("accepted"), rejected: [] })).submit("<fixed@id>", Buffer.from("body"), envelope), { outcome: "ACKNOWLEDGED", evidence: "smtp_acknowledged" });
});

test("SMTP adapter passes the explicit envelope with raw MIME", async () => {
  let options: unknown;
  const result = await adapter(async (value) => { options = value; return { message: Buffer.from("accepted"), rejected: [] }; }).submit("<fixed@id>", Buffer.from("stored raw MIME"), envelope);
  assert.deepEqual(result, { outcome: "ACKNOWLEDGED", evidence: "smtp_acknowledged" });
  assert.deepEqual(options, { raw: Buffer.from("stored raw MIME"), envelope: { from: "sender@example.test", to: ["recipient@example.test"], cc: [], bcc: [] } });
});

test("SMTP health verification uses transport.verify and never sends", async () => {
  let verified = 0;
  let sent = 0;
  const smtp = new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transport: { sendMail: async () => { sent += 1; return { message: Buffer.alloc(0) }; }, verify: async () => { verified += 1; } } });
  await smtp.verify();
  assert.equal(verified, 1);
  assert.equal(sent, 0);
});

test("SMTP adapter resolves its independent credential reference", async () => {
  let requested: string | undefined;
  const smtp = new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async (reference) => { requested = reference; return { username: "user", password: "secret" }; } }, transport: { sendMail: async () => ({ message: Buffer.from("accepted"), rejected: [] }) } });
  assert.equal((await smtp.submit("<fixed@id>", Buffer.from("body"), envelope)).outcome, "ACKNOWLEDGED");
  assert.equal(requested, "keychain:smtp/account");
});

test("SMTP adapter maps cross-keychain credentials to Nodemailer auth options", async () => {
  let options: unknown;
  const transport = { sendMail: async () => ({ message: Buffer.from("accepted"), rejected: [] }) };
  const smtp = new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transportFactory: (value) => { options = value; return transport; } });
  assert.deepEqual((await smtp.submit("<fixed@id>", Buffer.from("body"), envelope)).outcome, "ACKNOWLEDGED");
  assert.deepEqual(options, { host: "smtp.example.test", port: 465, secure: true, requireTLS: false, auth: { user: "user", pass: "secret" } });
  assert.doesNotMatch(JSON.stringify(options), /username|password/);
});

test("SMTP 587 requires STARTTLS for submission and no-send verification", async () => {
  const seen: unknown[] = [];
  const smtp = new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 587, secure: false, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transportFactory: (options) => { seen.push(options); return { sendMail: async () => ({ message: Buffer.from("accepted"), rejected: [] }), verify: async () => undefined }; } });
  await smtp.verify();
  assert.equal((await smtp.submit("<fixed@id>", Buffer.from("body"), envelope)).outcome, "ACKNOWLEDGED");
  assert.equal(seen.length, 2);
  for (const options of seen) assert.deepEqual(options, { host: "smtp.example.test", port: 587, secure: false, requireTLS: true, auth: { user: "user", pass: "secret" } });
});

test("local stream transport acknowledges raw submission with the explicit envelope", async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const raw = Buffer.from("Message-ID: <fixed@id>\r\nFrom: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Synthetic\r\n\r\nbody");
  const result = await new NodemailerSmtpAdapter({ host: "unused.example.test", port: 1, secure: false, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transport }).submit("<fixed@id>", raw, envelope);
  assert.equal(result.outcome, "ACKNOWLEDGED");
});

test("SMTP adapter classifies pre-submission connection failure", async () => {
  assert.deepEqual(await adapter(async () => { throw { code: "ECONNECTION", command: "CONN" }; }).submit("<fixed@id>", Buffer.from("body"), envelope), { outcome: "PRE_SUBMISSION_FAILURE", evidence: "smtp_error:connection:ECONNECTION" });
});

test("SMTP adapter classifies exceptions after the SMTP attempt as unknown", async () => {
  assert.deepEqual(await adapter(async () => { throw { code: "ESOCKET", command: "DATA" }; }).submit("<fixed@id>", Buffer.from("body"), envelope), { outcome: "UNKNOWN", evidence: "smtp_error:smtp_command:ESOCKET" });
});

test("connection timeout without an explicit connection phase remains unknown", async () => {
  assert.deepEqual(await adapter(async () => { throw { code: "ETIMEDOUT" }; }).submit("<fixed@id>", Buffer.from("body"), envelope), { outcome: "UNKNOWN", evidence: "smtp_error:unknown:ETIMEDOUT" });
});

test("SMTP diagnostics are bounded and never include provider response text", async () => {
  const result = await adapter(async () => { throw { code: "ESECRET", command: "DATA", response: "password=must-not-escape" }; }).submit("<fixed@id>", Buffer.from("body"), envelope);
  assert.deepEqual(result, { outcome: "UNKNOWN", evidence: "smtp_error:smtp_command:ESECRET" });
  assert.doesNotMatch(result.evidence, /password|must-not-escape/i);
});

const imapAccount: AccountProjection = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "keychain:imap/account", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX-custom", sentFolder: "Archive/Sent-custom" };
function imapPartSize(structure: MessageStructureObject | undefined, part: string): number | undefined { if (!structure) return undefined; if (structure.part === part) return structure.size; for (const child of structure.childNodes ?? []) { const size = imapPartSize(child, part); if (size !== undefined) return size; } return undefined; }
function imapFake(messages: Record<string, { uid: number; source?: Buffer; size?: number; bodyStructure?: MessageStructureObject; envelope?: MessageEnvelopeObject; rawParts?: Record<string, Buffer> }>, searched: number[] | ((query: SearchObject) => number[]) = []): ImapFlowClient & { options?: unknown; mailbox: { uidValidity: bigint; uidNext: number }; locks: string[]; searches: SearchObject[]; flags: Set<string> } {
  const state = { options: undefined as unknown, locks: [] as string[], searches: [] as SearchObject[], flags: new Set<string>() };
  return { ...state, mailbox: { uidValidity: 1n, uidNext: Math.max(100, Math.max(0, ...Object.keys(messages).map(Number), ...(Array.isArray(searched) ? searched : [])) + 1) }, connect: async () => undefined, logout: async () => undefined, close: () => undefined, list: async () => [{ path: "INBOX-custom", pathAsListed: "INBOX-custom", name: "INBOX-custom", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true }], getMailboxLock: async (path) => { state.locks.push(path); return { release: () => undefined }; }, search: async (query) => { state.searches.push(query); return typeof searched === "function" ? searched(query) : searched; }, fetch: async function* (range) { for (const uid of range as number[]) { const message = messages[String(uid)]; if (message) yield { seq: uid, uid: message.uid, source: message.source, size: message.size ?? message.source?.length, bodyStructure: message.bodyStructure, envelope: message.envelope, flags: new Set(state.flags) }; } }, fetchOne: async (uid, query) => { const message = messages[String(uid)]; if (!message) return false; const bodyParts = query.bodyParts ? new Map(query.bodyParts.flatMap((request) => { const key = typeof request === "string" ? request : request.key; const start = typeof request === "string" ? 0 : request.start ?? 0; const maxLength = typeof request === "string" ? Number.MAX_SAFE_INTEGER : request.maxLength ?? Number.MAX_SAFE_INTEGER; const size = imapPartSize(message.bodyStructure, key); return size === undefined ? [] : [[key, message.rawParts?.[key]?.subarray(start, start + maxLength) ?? Buffer.alloc(Math.max(0, Math.min(size - start, maxLength)))]]; })) : undefined; return { seq: uid as number, uid: message.uid, source: query.source ? message.source?.subarray(query.source.start ?? 0, (query.source.start ?? 0) + query.source.maxLength) : message.source, headers: query.headers ? message.source : undefined, size: message.size ?? message.source?.length, bodyStructure: message.bodyStructure, bodyParts, envelope: message.envelope, flags: new Set(state.flags) }; } };
}

test("IMAP non-implicit TLS endpoints require STARTTLS before authenticating", async () => {
  const fake = imapFake({});
  let options: unknown;
  const account = { ...imapAccount, imapEndpoint: "imap://imap.example.test:143", sentPolicy: "gateway_append" as const };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: (value) => { options = value; return fake; } });
  await adapter.checkConnectivity();
  assert.deepEqual({ secure: (options as { secure: boolean }).secure, doSTARTTLS: (options as { doSTARTTLS?: boolean }).doSTARTTLS }, { secure: false, doSTARTTLS: true });
});

test("IMAP refuses authentication when a synthetic server lacks STARTTLS", async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    socket.write("* OK synthetic IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        commands.push(line);
        const tag = line.split(" ")[0];
        if (/\bCAPABILITY\b/i.test(line)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK completed\r\n`);
        else socket.write(`${tag} NO synthetic server rejects command\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const account = { ...imapAccount, imapEndpoint: `imap://127.0.0.1:${port}`, sentPolicy: "gateway_append" as const };
    const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) } });
    await assert.rejects(adapter.checkConnectivity(), { code: "PROVIDER_UNAVAILABLE" });
    assert.ok(commands.some((line) => /\bCAPABILITY\b/i.test(line)));
    assert.equal(commands.some((line) => /\b(LOGIN|AUTHENTICATE)\b/i.test(line)), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("IMAP adapter uses explicit folders, credentials, UID-safe references, and bounded reads", async () => {
  const source = Buffer.from("Message-ID: <read@example.test>\r\nSubject: Read me\r\nCc: visible@example.test\r\nReply-To: replies@example.test\r\nIn-Reply-To: <parent@example.test>\r\nReferences: <root@example.test> <parent@example.test>\r\nX-Hermes-Forwarded-Message-Reference: source-ref\r\nX-Hermes-Forwarded-Message-ID: <source@example.test>\r\nX-Hermes-Forwarded-Subject: Original subject\r\nX-Secret-Arbitrary: must-not-escape\r\nContent-Type: text/plain\r\n\r\nbounded body");
  const fake = imapFake({ "7": { uid: 7, source, envelope: { messageId: "<read@example.test>", subject: "Read me", cc: [{ address: "visible@example.test" }], replyTo: [{ address: "replies@example.test" }], inReplyTo: "<parent@example.test>", bcc: [{ address: "hidden@example.test" }] } } }, [7]);
  let requested: unknown;
  let credentialCalls = 0;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async (reference) => { credentialCalls += 1; requested = reference; return { username: "user", password: "secret" }; } }, clientFactory: (options) => { fake.options = options; return fake; }, maxResults: 1, maxReadBytes: 4096 });
  const summaries = await adapter.listMessages("INBOX-custom", "read", 20);
  assert.equal(summaries.length, 1);
  const reference = summaries[0]?.reference;
  assert.ok(reference);
  const read = await adapter.read(reference);
  assert.equal(read.uid, 7);
  assert.equal(read.folder, "INBOX-custom");
  assert.equal(read.text, "bounded body");
  assert.deepEqual(read.cc, [{ address: "visible@example.test" }]);
  assert.deepEqual(read.replyTo, [{ address: "replies@example.test" }]);
  assert.equal(read.inReplyTo, "<parent@example.test>");
  assert.deepEqual(read.references, ["<root@example.test>", "<parent@example.test>"]);
  assert.deepEqual(read.forwarding, { originalMessageReference: "source-ref", originalMessageId: "<source@example.test>", originalSubject: "Original subject" });
  assert.doesNotMatch(JSON.stringify(read), /hidden@example|X-Secret|must-not-escape|bcc/i);
  assert.equal(credentialCalls, 2);
  assert.equal(requested, "keychain:imap/account");
  assert.deepEqual((fake.options as { auth: { user: string; pass: string }; logger: unknown }).auth, { user: "user", pass: "secret" });
  assert.equal((fake.options as { logger: unknown }).logger, false);
  assert.deepEqual(fake.searches[0], { or: [{ text: "read" }, { subject: "read" }, { header: { Subject: "read" } }], uid: "1:99" });
  assert.deepEqual(fake.locks, ["INBOX-custom", "INBOX-custom"]);
  assert.equal((await adapter.listFolders())[0]?.path, "INBOX-custom");
});
test("IMAP read refuses a MIME body truncated by the configured limit", async () => {
  const fake = imapFake({ "7": { uid: 7, size: 4096, source: Buffer.concat([Buffer.from("Subject: partial\r\n\r\n"), Buffer.alloc(4096, 97)]) } }, [7]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake, maxReadBytes: 128 });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  await assert.rejects(adapter.read(reference), { code: "MESSAGE_TOO_LARGE" });
});
test("IMAP downloads a complete selected attachment without fetching a truncated full MIME message", async () => {
  const content = Buffer.alloc(600, 0x61);
  const bodyStructure: MessageStructureObject = { type: "multipart/mixed", childNodes: [
    { part: "1", type: "text/plain", size: 4 },
    { part: "2", type: "application/octet-stream", encoding: "base64", size: 800, disposition: "attachment", dispositionParameters: { filename: "old.txt" } },
  ] };
  const fake = imapFake({ "7": { uid: 7, size: 4096, source: Buffer.alloc(4096), bodyStructure, rawParts: { "2": Buffer.from(content.toString("base64"), "ascii") } } }, [7]) as unknown as ImapFlowClient & { download: (uid: number, part: string, options: { uid: boolean; maxBytes: number }) => Promise<{ meta: { expectedSize: number; filename: string; contentType: string; disposition: string }; content: Readable }> };
  fake.download = async (uid, part, options) => { assert.equal(uid, 7); assert.equal(part, "2"); assert.equal(options?.uid, true); assert.ok((options?.maxBytes ?? 0) > content.length); return { meta: { expectedSize: 4096, filename: "old.txt", contentType: "application/octet-stream", disposition: "attachment" }, content: Readable.from([content]) }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake, maxReadBytes: 128 });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  const result = await adapter.downloadAttachment(reference, 0);
  assert.equal(result.content.length, 600);
  assert.equal(result.filename, "old.txt");
  assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
});
test("IMAP attachment download rejects a raw part size mismatch", async () => {
  const structure: MessageStructureObject = { type: "multipart/mixed", childNodes: [{ part: "2", type: "application/octet-stream", size: 6, disposition: "attachment", dispositionParameters: { filename: "data.bin" } }] };
  const fake = imapFake({ "7": { uid: 7, size: 100, source: Buffer.alloc(100), bodyStructure: structure, rawParts: { "2": Buffer.from("12345") } } }, [7]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  await assert.rejects(adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});
test("IMAP attachment download rejects a truncated raw MIME section even when the decoded stream ends", async () => {
  const structure: MessageStructureObject = { type: "multipart/mixed", childNodes: [{ part: "2", type: "application/octet-stream", encoding: "base64", size: 8, disposition: "attachment", dispositionParameters: { filename: "data.bin" } }] };
  const fake = imapFake({ "7": { uid: 7, size: 100, source: Buffer.alloc(100), bodyStructure: structure } }, [7]) as unknown as ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number }; download: NonNullable<ImapFlowClient["download"]> };
  const originalFetchOne = fake.fetchOne.bind(fake);
  fake.fetchOne = async (uid, query, options) => {
    const response = await originalFetchOne(uid, query, options);
    if (!response || !query.bodyParts) return response;
    const request = query.bodyParts?.[0];
    const start = typeof request === "string" ? 0 : request?.start ?? 0;
    return { ...response, bodyParts: new Map([["2", start >= 4 ? Buffer.alloc(0) : Buffer.from("YWJj")]]) };
  };
  fake.download = async () => ({ meta: { expectedSize: 100, filename: "data.bin", contentType: "application/octet-stream", disposition: "attachment" }, content: Readable.from([Buffer.from("abc")]) });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  await assert.rejects(adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});
test("IMAP attachment download rejects raw part chunks returned for a different UID", async () => {
  const structure: MessageStructureObject = { type: "multipart/mixed", childNodes: [{ part: "2", type: "application/octet-stream", size: 8, disposition: "attachment", dispositionParameters: { filename: "data.bin" } }] };
  const fake = imapFake({ "7": { uid: 7, size: 100, source: Buffer.alloc(100), bodyStructure: structure } }, [7]) as unknown as ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number }; download: NonNullable<ImapFlowClient["download"]> };
  const originalFetchOne = fake.fetchOne.bind(fake);
  fake.fetchOne = async (uid, query, options) => {
    const response = await originalFetchOne(uid, query, options);
    if (!response || !query.bodyParts) return response;
    const request = query.bodyParts[0];
    const start = typeof request === "string" ? 0 : request?.start ?? 0;
    const requested = request && typeof request !== "string" ? request.maxLength ?? 8 : 8;
    return { ...response, uid: 8, bodyParts: new Map([["2", Buffer.alloc(Math.max(0, Math.min(8 - start, requested)))]] ) };
  };
  fake.download = async () => ({ meta: { expectedSize: 100, filename: "data.bin", contentType: "application/octet-stream", disposition: "attachment" }, content: Readable.from([Buffer.from("decoded")]) });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  await assert.rejects(adapter.downloadAttachment(reference, 0), { code: "ATTACHMENT_CHANGED" });
});

test("IMAP references are rejected after mailbox UIDVALIDITY changes before fetch", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Subject: x\r\n\r\nbody") } }, [7]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  fake.mailbox = { uidValidity: 2n, uidNext: fake.mailbox.uidNext };
  await assert.rejects(adapter.read(reference), { code: "REFERENCE_STALE" });
});
test("IMAP cursors are rejected after mailbox UIDVALIDITY changes before afterUid search", async () => {
  const fake = imapFake({ "8": { uid: 8, envelope: { subject: "next" } } }, [8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  fake.mailbox = { uidValidity: 2n, uidNext: fake.mailbox.uidNext };
  await assert.rejects(adapter.list("INBOX-custom", 1, 7, 1), { code: "REFERENCE_STALE" });
  assert.deepEqual(fake.searches, []);
});

test("IMAP folder discovery excludes non-selectable namespaces", async () => {
  const fake = imapFake({}, []);
  fake.list = async () => [
    { path: "[Gmail]", pathAsListed: "[Gmail]", name: "[Gmail]", delimiter: "/", parent: [], parentPath: "", flags: new Set(["\\Noselect"]), listed: true, subscribed: true },
    { path: "[Gmail]/Spam", pathAsListed: "[Gmail]/Spam", name: "Spam", delimiter: "/", parent: ["[Gmail]"], parentPath: "[Gmail]", flags: new Set<string>(), specialUse: "\\Junk", listed: true, subscribed: true },
  ];
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  assert.deepEqual(await adapter.listFolders(), [{ path: "[Gmail]/Spam", name: "Spam", delimiter: "/", specialUse: "\\Junk" }]);
});

test("IMAP Sent APPEND uses configured folder, Seen flag, and verifies the exact Message-ID", async () => {
  const header = "<sent-copy@example.test>";
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: header } } });
  fake.flags.add("\\Seen");
  let appended = false;
  fake.search = async (query) => { fake.searches.push(query); return appended ? [7] : []; };
  fake.append = async (path, content, flags) => {
    assert.equal(path, "Archive/Sent-custom");
    assert.equal(Buffer.from(content).toString(), "persisted raw MIME");
    assert.deepEqual(flags, ["\\Seen"]);
    appended = true;
    return { destination: "Archive/Sent-custom", uid: 7, uidValidity: 1n };
  };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.appendSent(Buffer.from("persisted raw MIME"), { accountId: "acct", messageIdHeader: header });
  assert.equal(appended, true);
  assert.deepEqual(fake.locks, ["Archive/Sent-custom"]);
  assert.deepEqual(fake.searches, [{ header: { "Message-ID": header }, uid: "1:99" }]);
});

test("IMAP Sent APPEND refuses a cross-account context before opening a connection", async () => {
  const fake = imapFake({});
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await assert.rejects(adapter.appendSent(Buffer.from("raw"), { accountId: "other", messageIdHeader: "<id@example.test>" }), { code: "REFERENCE_INVALID" });
  assert.deepEqual(fake.locks, []);
});

test("IMAP Sent APPEND does not duplicate an existing exact Message-ID", async () => {
  const header = "<already-sent@example.test>";
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: header } } }, [7]);
  let appends = 0;
  fake.append = async () => { appends++; return { destination: "Archive/Sent-custom", uid: 8 }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.appendSent(Buffer.from("raw"), { accountId: "acct", messageIdHeader: header });
  assert.equal(appends, 0);
});

test("IMAP Sent APPEND verifies an unambiguous provider UID when UIDPLUS is absent", async () => {
  const header = "<uidless-sent@example.test>";
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: header } } });
  fake.flags.add("\\Seen");
  let appended = false;
  fake.search = async (query) => { fake.searches.push(query); return appended ? [7] : []; };
  fake.append = async () => { appended = true; return { destination: "Archive/Sent-custom" }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.appendSent(Buffer.from("raw"), { accountId: "acct", messageIdHeader: header });
  assert.equal(appended, true);
  assert.equal(fake.searches.length, 2);
});

test("IMAP Sent APPEND never claims success for a wrong Message-ID", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: "<wrong@example.test>" } } }, []);
  fake.flags.add("\\Seen");
  fake.append = async () => ({ destination: "Archive/Sent-custom", uid: 7 });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await assert.rejects(adapter.appendSent(Buffer.from("raw"), { accountId: "acct", messageIdHeader: "<wanted@example.test>" }), { code: "PROVIDER_UNAVAILABLE" });
});

test("IMAP failed or undefined SEARCH cannot authorize a Sent APPEND", async () => {
  const searchResults: Array<false | undefined> = [false, undefined];
  for (const searchResult of searchResults) {
    const fake = imapFake({});
    let appends = 0;
    fake.search = async () => searchResult;
    fake.append = async () => { appends++; return { destination: "Archive/Sent-custom", uid: 7 }; };
    const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
    await assert.rejects(adapter.verifySent("<wanted@example.test>"), { code: "PROVIDER_UNAVAILABLE" });
    await assert.rejects(adapter.appendSent(Buffer.from("raw"), { accountId: "acct", messageIdHeader: "<wanted@example.test>" }), { code: "PROVIDER_UNAVAILABLE" });
    assert.equal(appends, 0);
  }
});

test("IMAP partial HEADER matches beyond the bound cannot authorize a duplicate Sent APPEND", async () => {
  const header = "<exact-match@example.test>";
  const fake = imapFake({ "1": { uid: 1, envelope: { messageId: "<partial-a@example.test>" } }, "2": { uid: 2, envelope: { messageId: "<partial-b@example.test>" } }, "3": { uid: 3, envelope: { messageId: header } } }, [1, 2, 3]);
  fake.flags.add("\\Seen");
  let appends = 0;
  fake.append = async () => { appends++; return { destination: "Archive/Sent-custom", uid: 3 }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake, maxResults: 2 });
  await assert.rejects(adapter.verifySent(header), { code: "PROVIDER_UNAVAILABLE" });
  await assert.rejects(adapter.appendSent(Buffer.from("raw"), { accountId: "acct", messageIdHeader: header }), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(appends, 0);
});

test("IMAP draft APPEND sets the Draft flag, verifies Message-ID, and returns an opaque UID reference", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: "<draft@example.test>" } } }, [7]);
  fake.flags.add("\\Draft");
  fake.append = async (path, content, flags) => { assert.equal(path, "Brouillons"); assert.equal(Buffer.from(content).toString(), "raw draft"); assert.deepEqual(flags, ["\\Draft"]); return { destination: "Brouillons", uid: 7, uidValidity: 1n }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const result = await adapter.appendDraft!(Buffer.from("raw draft"), "Brouillons", { accountId: "acct", messageIdHeader: "<draft@example.test>" });
  assert.deepEqual({ folder: result.folder, uid: result.uid, uidValidity: result.uidValidity }, { folder: "Brouillons", uid: 7, uidValidity: 1 });
  assert.deepEqual(fake.locks, ["Brouillons"]);
});

test("IMAP draft APPEND treats a missing or ambiguous UID as unsupported and never claims saved", async () => {
  const ambiguous = imapFake({ "7": { uid: 7, envelope: { messageId: "<draft@example.test>" } }, "8": { uid: 8, envelope: { messageId: "<draft@example.test>" } } }, [7, 8]);
  ambiguous.flags.add("\\Draft");
  ambiguous.append = async () => ({ destination: "Drafts" });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => ambiguous });
  await assert.rejects(adapter.appendDraft!(Buffer.from("raw"), "Drafts", { accountId: "acct", messageIdHeader: "<draft@example.test>" }), { code: "PROVIDER_UNAVAILABLE" });
  assert.deepEqual(ambiguous.searches, [{ header: { "Message-ID": "<draft@example.test>" }, uid: "1:99" }]);
});
test("IMAP all-folder search bounds UID responses before enforcing its candidate cap", async () => {
  const uids = Array.from({ length: 2_000 }, (_, index) => index + 1);
  const messages = Object.fromEntries(uids.map((uid) => [String(uid), { uid, envelope: { subject: `Message ${uid}` } }]));
  const fake = imapFake(messages, (query) => {
    const match = typeof query.uid === "string" ? /^(\d+):(\d+|\*)$/.exec(query.uid) : undefined;
    const lower = match ? Number(match[1]) : 1;
    const upper = match && match[2] !== "*" ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
    return uids.filter((uid) => uid >= lower && uid <= upper);
  });
  (fake.mailbox as { uidValidity: bigint; uidNext: number }).uidNext = 2_001;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  await assert.rejects(adapter.searchAllFolders("token", undefined, 1), { code: "QUERY_TOO_LARGE" });
  assert.equal(fake.searches.length, 1);
  assert.equal(fake.searches[0]?.uid, "1:1024");
});

test("IMAP listing uses bounded UID windows and fetches only the requested page", async () => {
  const uids = Array.from({ length: 2_000 }, (_, index) => index + 1);
  const messages = Object.fromEntries(uids.map((uid) => [String(uid), { uid, envelope: { subject: `Message ${uid}` } }]));
  const fake = imapFake(messages, (query) => {
    const match = typeof query.uid === "string" ? /^(\d+):(\d+|\*)$/.exec(query.uid) : undefined;
    const lower = match ? Number(match[1]) : 1;
    const upper = match && match[2] !== "*" ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
    return uids.filter((uid) => uid >= lower && uid <= upper);
  });
  (fake.mailbox as { uidValidity: bigint; uidNext: number }).uidNext = 2_001;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const result = await adapter.listMessages("INBOX-custom", undefined, 2);
  assert.deepEqual(result.map((item) => item.uid), [1, 2]);
  assert.equal(fake.searches.length, 1);
  assert.equal(fake.searches[0]?.uid, "1:1024");
});

test("IMAP listing fails closed when FETCH omits a searched UID", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { subject: "Present" } } }, [7, 8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await assert.rejects(adapter.list("INBOX-custom", 2), { code: "PROVIDER_UNAVAILABLE" });
});

test("IMAP listing fails closed when SEARCH is undefined or incomplete", async () => {
  for (const result of [false, undefined] as const) {
    const fake = imapFake({});
    fake.search = async () => result;
    const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
    await assert.rejects(adapter.list("INBOX-custom", 5), { code: "PROVIDER_UNAVAILABLE" });
  }
});

test("IMAP list without a query remains an all-message search", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { subject: "Synthetic" } } }, [7]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.list("INBOX-custom", 1);
  assert.deepEqual(fake.searches, [{ all: true, uid: "1:99" }]);
});

test("IMAP structured search compiles representable filters server-side and rejects attachment scans", async () => {
  const fake = imapFake({ "8": { uid: 8, envelope: { subject: "Synthetic" } } }, [8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.searchWithFilters!("INBOX-custom", "token", { from: "from@example.test", to: "to@example.test", cc: "cc@example.test", subject: "invoice", since: "2026-01-01", before: "2026-02-01", isRead: false, isFlagged: true, messageId: "<id@example.test>" }, 1, 7, 1);
  assert.deepEqual(fake.searches[0], { or: [{ text: "token" }, { subject: "token" }, { header: { Subject: "token" } }], from: "from@example.test", to: "to@example.test", cc: "cc@example.test", subject: "invoice", since: new Date("2026-01-01T00:00:00.000Z"), before: new Date("2026-02-01T00:00:00.000Z"), seen: false, flagged: true, header: { "Message-ID": "<id@example.test>" }, uid: "8:99" });
  await assert.rejects(adapter.searchWithFilters!("INBOX-custom", undefined, { hasAttachment: true }, 1), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(fake.locks.length, 2);
});

test("IMAP bounded attachment download returns bytes, hash, and safe metadata", async () => {
  const source = Buffer.from("Content-Type: multipart/mixed; boundary=box\r\n\r\n--box\r\nContent-Type: text/plain\r\n\r\nbody\r\n--box\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\n\r\npdf-bytes\r\n--box--\r\n");
  const bodyStructure: MessageStructureObject = { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain", size: 4 }, { part: "2", type: "application/pdf", size: 9, disposition: "attachment", dispositionParameters: { filename: "invoice.pdf" } }] };
  const fake = imapFake({ "7": { uid: 7, source, envelope: { subject: "With file" }, bodyStructure, rawParts: { "2": Buffer.from("pdf-bytes") } } }, [7]) as unknown as ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number }; download: (uid: number, part: string, options: { uid: boolean; maxBytes: number; chunkSize: number }) => Promise<{ meta: { expectedSize: number; filename: string; contentType: string; disposition: string }; content: Readable }> };
  const requestedParts: string[] = [];
  fake.download = async (_uid, part) => { requestedParts.push(part ?? ""); return { meta: { expectedSize: source.length, filename: "invoice.pdf", contentType: "application/pdf", disposition: "attachment" }, content: Readable.from([Buffer.from("pdf-bytes")]) }; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake, maxReadBytes: 256 });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  const result = await adapter.downloadAttachment!(reference, 0);
  assert.deepEqual(requestedParts, []); // Verified raw FETCH is the only source of returned bytes.
  assert.deepEqual({ filename: result.filename, contentType: result.contentType, size: result.size, sha256: result.sha256, content: result.content.toString("utf8") }, { filename: "invoice.pdf", contentType: "application/pdf", size: 9, sha256: createHash("sha256").update("pdf-bytes").digest("hex"), content: "pdf-bytes" });
  await assert.rejects(adapter.downloadAttachment!(reference, 1), { code: "INVALID_INPUT" });
  await assert.rejects(adapter.downloadAttachment!(reference, 32), { code: "INVALID_INPUT" });
  fake.mailbox = { uidValidity: 2n, uidNext: fake.mailbox.uidNext };
  await assert.rejects(adapter.downloadAttachment!(reference, 0), { code: "REFERENCE_STALE" });
  fake.mailbox = { uidValidity: 1n, uidNext: fake.mailbox.uidNext };
  const other = new ImapFlowMailAdapter({ account: { ...imapAccount, accountId: "other" }, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await assert.rejects(other.downloadAttachment!(reference, 0), { code: "REFERENCE_INVALID" });
});

test("IMAP pagination applies the cursor as a server-side UID criterion", async () => {
  const fake = imapFake({ "8": { uid: 8, envelope: { subject: "Synthetic" } } }, [8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  await adapter.list("INBOX-custom", 1, 7);
  assert.deepEqual(fake.searches, [{ all: true, uid: "8:99" }]);
});

test("IMAP references reject UID and UIDVALIDITY values outside the protocol range", async () => {
  const fake = imapFake({});
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  for (const target of [{ accountId: "acct", folder: "INBOX-custom", uid: 4_294_967_296, uidValidity: 1 }, { accountId: "acct", folder: "INBOX-custom", uid: 1, uidValidity: 4_294_967_296 }]) {
    const reference = Buffer.from(JSON.stringify(target), "utf8").toString("base64url");
    await assert.rejects(adapter.read(reference), { code: "REFERENCE_INVALID" });
  }
  assert.deepEqual(fake.locks, []);
});

test("IMAP references are bound to the account that issued them", async () => {
  const first = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => imapFake({ "7": { uid: 7, source: Buffer.from("Subject: x\r\n\r\nbody") } }, [7]) });
  const reference = (await first.listMessages("INBOX-custom", undefined, 1).catch(() => []))[0]?.reference;
  assert.ok(reference);
  const other = new ImapFlowMailAdapter({ account: { ...imapAccount, accountId: "other" }, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => imapFake({}) });
  await assert.rejects(other.read(reference), { code: "REFERENCE_INVALID" });
  await assert.rejects(other.thread("INBOX-custom", reference, 1), { code: "REFERENCE_INVALID" });
});

test("account configuration requires explicit inbox and sent folders", () => {
  const valid = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "keychain:imap/account", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent" };
  assert.equal(accountConfigSchema.safeParse(valid).success, true);
  assert.equal(accountConfigSchema.safeParse({ ...valid, smtpCredentialRef: "keychain:smtp/account" }).success, true);
  const missing = { ...valid };
  delete (missing as { sentFolder?: string }).sentFolder;
  assert.equal(accountConfigSchema.safeParse(missing).success, false);
});

test("IMAP verifySent checks the exact Message-ID in the configured sent folder", async () => {
  const fake = imapFake({ "9": { uid: 9, envelope: { messageId: "<different@example.test>" } }, "10": { uid: 10, envelope: { messageId: "<wanted@example.test>" } } }, [9, 10]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  assert.equal(await adapter.verifySent("<wanted@example.test>"), true);
  assert.equal(await adapter.verifySent("<absent@example.test>"), false);
  assert.deepEqual(fake.locks, ["Archive/Sent-custom", "Archive/Sent-custom"]);
});

test("IMAP exact Sent lookup bounds candidate enumeration by UID range", async () => {
  const uids = Array.from({ length: 60 }, (_, index) => index + 1);
  const messages = Object.fromEntries(uids.map((uid) => [String(uid), { uid, envelope: { messageId: `<other-${uid}@example.test>` } }]));
  const fake = imapFake(messages, uids);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  await assert.rejects(adapter.verifySent("<wanted@example.test>"), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(fake.searches[0]?.uid, "1:99");
});

test("IMAP thread bounds UID search windows before enforcing its candidate limit", async () => {
  const uids = Array.from({ length: 500 }, (_, index) => index + 1);
  const messages = Object.fromEntries(uids.map((uid) => [String(uid), { uid, envelope: { messageId: uid === 1 ? "<anchor@example.test>" : `<child-${uid}@example.test>` } }]));
  const fake = imapFake(messages, (query) => {
    if (!query.header) return [1];
    const match = typeof query.uid === "string" ? /^(\d+):(\d+|\*)$/.exec(query.uid) : undefined;
    const lower = match ? Number(match[1]) : 1;
    const upper = match && match[2] !== "*" ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
    return uids.filter((uid) => uid >= lower && uid <= upper);
  });
  (fake.mailbox as { uidValidity: bigint; uidNext: number }).uidNext = 501;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  const searchesBeforeThread = fake.searches.length;
  await assert.rejects(adapter.thread("INBOX-custom", reference, 10), { code: "THREAD_TOO_LARGE" });
  assert.equal(fake.searches[searchesBeforeThread]?.uid, "1:500");
});

test("IMAP thread search fails rather than returning a silently truncated conversation", async () => {
  const source = Buffer.from("Message-ID: <anchor@example.test>\r\nIn-Reply-To: <parent@example.test>\r\nReferences: <root@example.test> <parent@example.test>\r\nSubject: Anchor\r\n\r\nbody");
  const fake = imapFake({
    "7": { uid: 7, source, envelope: { messageId: "<anchor@example.test>", subject: "Anchor", inReplyTo: "<parent@example.test>" } },
    "8": { uid: 8, envelope: { messageId: "<reply@example.test>", subject: "Reply" } },
    "9": { uid: 9, envelope: { messageId: "<later@example.test>", subject: "Later" } },
  }, (query) => {
    const header = query.header;
    if (header?.["Message-ID"] === "<anchor@example.test>") return [7, 8];
    if (header?.["In-Reply-To"] === "<anchor@example.test>") return [8];
    if (header?.References === "<anchor@example.test>") return [9];
    if (header?.["Message-ID"] === "<parent@example.test>") return [8, 9];
    if (header?.["In-Reply-To"] === "<parent@example.test>") return [9];
    return [];
  });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const anchor = (await adapter.read(Buffer.from(JSON.stringify({ accountId: "acct", folder: "INBOX-custom", uid: 7, uidValidity: 1 }), "utf8").toString("base64url"))).reference;
  await assert.rejects(adapter.thread("INBOX-custom", anchor, 2), { code: "THREAD_TOO_LARGE" });
  assert.deepEqual(fake.searches.map((criteria) => criteria.header), [
    { "Message-ID": "<anchor@example.test>" }, { "In-Reply-To": "<anchor@example.test>" }, { References: "<anchor@example.test>" },
    { "Message-ID": "<parent@example.test>" }, { "In-Reply-To": "<parent@example.test>" }, { References: "<parent@example.test>" },
    { "Message-ID": "<root@example.test>" }, { "In-Reply-To": "<root@example.test>" }, { References: "<root@example.test>" },
  ]);
  assert.ok(fake.searches.every((criteria) => criteria.uid === "1:99"));
});

test("IMAP thread rejects a folder mismatch before searching the wrong mailbox", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Subject: Anchor\r\n\r\nbody"), envelope: { messageId: "<anchor@example.test>" } } }, [7]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = Buffer.from(JSON.stringify({ accountId: "acct", folder: "INBOX-custom", uid: 7, uidValidity: 1 }), "utf8").toString("base64url");
  await assert.rejects(adapter.thread("Archive/Other", reference, 1), { code: "INVALID_INPUT", message: "Thread folder does not match message reference folder." });
  assert.deepEqual(fake.locks, []);
});

test("IMAP all-folder thread lookup includes messages from Sent and removes duplicate copies", async () => {
  const anchorSource = Buffer.from("Message-ID: <anchor@example.test>\r\nSubject: Anchor\r\n\r\nbody");
  const fake = imapFake({
    "7": { uid: 7, source: anchorSource, envelope: { messageId: "<anchor@example.test>", subject: "Anchor", date: new Date("2026-01-01T00:00:00Z") } },
    "8": { uid: 8, source: Buffer.from("Message-ID: <reply@example.test>\r\nIn-Reply-To: <anchor@example.test>\r\n\r\nreply"), envelope: { messageId: "<reply@example.test>", subject: "Re: Anchor", inReplyTo: "<anchor@example.test>", date: new Date("2026-01-02T00:00:00Z") } },
  });
  const listed = await fake.list();
  fake.list = async () => [...listed, { ...listed[0]!, path: "Archive/Sent", pathAsListed: "Archive/Sent", name: "Sent" }];
  let selectedFolder = "INBOX-custom";
  fake.getMailboxLock = async (folder) => { selectedFolder = folder; fake.locks.push(folder); return { release: () => undefined }; };
  fake.search = async (query) => {
    fake.searches.push(query);
    const messageId = query.header?.["Message-ID"];
    const replyTo = query.header?.["In-Reply-To"];
    if (selectedFolder === "INBOX-custom" && messageId === "<anchor@example.test>") return [7];
    if (selectedFolder === "Archive/Sent" && replyTo === "<anchor@example.test>") return [8];
    if (selectedFolder === "Archive/Sent" && messageId === "<anchor@example.test>") return [7];
    return [];
  };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = Buffer.from(JSON.stringify({ accountId: "acct", folder: "INBOX-custom", uid: 7, uidValidity: 1 }), "utf8").toString("base64url");
  const result = await adapter.thread("INBOX-custom", reference, 10, "allFolders");
  assert.deepEqual(result.map((item) => `${item.folder}:${item.uid}`), ["INBOX-custom:7", "Archive/Sent:8"]);
  assert.deepEqual(fake.locks, ["INBOX-custom", "INBOX-custom", "Archive/Sent"]);
});

test("IMAP thread lookup fails closed when a provider search result is incomplete", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Message-ID: <anchor@example.test>\r\n\r\nbody"), envelope: { messageId: "<anchor@example.test>" } } });
  fake.search = async () => false;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = Buffer.from(JSON.stringify({ accountId: "acct", folder: "INBOX-custom", uid: 7, uidValidity: 1 }), "utf8").toString("base64url");
  await assert.rejects(adapter.thread("INBOX-custom", reference, 20), { code: "PROVIDER_UNAVAILABLE" });
});

test("IMAP all-folder cursors reject UIDs outside the protocol range", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: "<a@example.test>" } }, "8": { uid: 8, envelope: { messageId: "<b@example.test>" } } }, [7, 8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const first = await adapter.searchAllFolders("token", undefined, 1);
  const payload = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
  payload.uid = 4_294_967_296;
  const malformed = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  await assert.rejects(adapter.searchAllFolders("token", undefined, 1, malformed), { code: "REFERENCE_INVALID" });
});

test("IMAP all-folder cursors reject a mailbox that gained messages", async () => {
  const fake = imapFake({ "7": { uid: 7, envelope: { messageId: "<a@example.test>" } }, "8": { uid: 8, envelope: { messageId: "<b@example.test>" } } }, [7, 8]);
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const first = await adapter.searchAllFolders("token", undefined, 1);
  assert.ok(first.nextCursor);
  fake.mailbox.uidNext += 1;
  await assert.rejects(adapter.searchAllFolders("token", undefined, 1, first.nextCursor), { code: "REFERENCE_STALE" });
});

test("IMAP all-folder search merges, deduplicates, sorts newest first, and reports truncation", async () => {
  const fake = imapFake({
    "7": { uid: 7, envelope: { messageId: "<original@example.test>", subject: "Urgent original", date: new Date("2026-01-01T00:00:00Z") } },
    "8": { uid: 8, envelope: { messageId: "<reply@example.test>", subject: "Urgent reply", date: new Date("2026-01-03T00:00:00Z") } },
    "9": { uid: 9, envelope: { messageId: "<original@example.test>", subject: "Urgent original copy", date: new Date("2026-01-01T00:00:00Z") } },
  });
  const listed = await fake.list();
  fake.list = async () => [...listed, { ...listed[0]!, path: "Archive/Sent", pathAsListed: "Archive/Sent", name: "Sent" }];
  let selectedFolder = "INBOX-custom";
  fake.getMailboxLock = async (folder) => { selectedFolder = folder; fake.locks.push(folder); return { release: () => undefined }; };
  fake.search = async (query) => { fake.searches.push(query); return selectedFolder === "INBOX-custom" ? [7, 8] : [9]; };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const complete = await adapter.searchAllFolders("urgent", undefined, 10);
  assert.deepEqual(complete.messages.map((item) => item.messageId), ["<reply@example.test>", "<original@example.test>"]);
  assert.equal(complete.truncated, false);
  const bounded = await adapter.searchAllFolders("urgent", undefined, 1);
  assert.deepEqual(bounded.messages.map((item) => item.messageId), ["<reply@example.test>"]);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.nextCursor);
  const nextPage = await adapter.searchAllFolders("urgent", undefined, 1, bounded.nextCursor);
  assert.deepEqual(nextPage.messages.map((item) => item.messageId), ["<original@example.test>"]);
  assert.equal(nextPage.truncated, false);
  assert.equal(complete.foldersSearched, 2);
});

test("IMAP all-folder search normalizes invalid dates for deterministic cursor pagination", async () => {
  const fake = imapFake({
    "7": { uid: 7, envelope: { messageId: "<bad-date@example.test>", subject: "Urgent invalid date", date: "not-a-date" } },
    "8": { uid: 8, envelope: { messageId: "<missing-date@example.test>", subject: "Urgent missing date" } },
  });
  fake.search = async () => [7, 8];
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const first = await adapter.searchAllFolders("urgent", undefined, 1);
  assert.equal(first.messages[0]?.uid, 8);
  assert.equal(first.messages[0]?.date, undefined);
  assert.ok(first.nextCursor);
  const second = await adapter.searchAllFolders("urgent", undefined, 1, first.nextCursor);
  assert.equal(second.messages[0]?.uid, 7);
  assert.equal(second.messages[0]?.date, undefined);
  assert.equal(second.truncated, false);
});

test("IMAP adapter maps connection and credential failures safely", async () => {
  let called = false;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => { called = true; throw new Error("keychain detail"); } }, clientFactory: () => { throw new Error("must not construct"); } });
  await assert.rejects(adapter.listFolders(), { code: "PROVIDER_UNAVAILABLE", message: "The IMAP provider is unavailable." });
  assert.equal(called, true);
  assert.throws(() => new ImapFlowMailAdapter({ account: { ...imapAccount, imapEndpoint: "https://imap.example.test" }, credentials: { get: async () => null } }), { code: "REFERENCE_INVALID" });
});
test("IMAP move refuses a UID map without the destination UIDVALIDITY", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Subject: x\\r\\n\\r\\nbody") } }, [7]);
  fake.list = async () => [
    { path: "INBOX-custom", pathAsListed: "INBOX-custom", name: "Inbox", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
    { path: "Archive", pathAsListed: "Archive", name: "Archive", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
  ];
  fake.messageMove = async () => ({ uidMap: new Map([[7, 8]]) });
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  await assert.rejects(adapter.mutate({ type: "move", messageReference: reference, destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE" });
});

test("IMAP move returns the provider-confirmed destination UID and generation", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Subject: x\\r\\n\\r\\nbody") }, "8": { uid: 8, envelope: { subject: "Moved" } } }, [7]);
  fake.getMailboxLock = async (folder) => { fake.mailbox.uidValidity = folder === "Archive" ? 55n : 1n; return { release: () => {} }; };
  fake.list = async () => [
    { path: "INBOX-custom", pathAsListed: "INBOX-custom", name: "Inbox", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
    { path: "Archive", pathAsListed: "Archive", name: "Archive", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
  ];
  fake.messageMove = async (uid, destination, options) => {
    assert.equal(uid, 7);
    assert.equal(destination, "Archive");
    assert.equal(options?.uid, true);
    return { uidMap: new Map([[7, 8]]), uidValidity: 55n };
  };
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "synthetic" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  const result = await adapter.mutate({ type: "move", messageReference: reference, destinationFolder: "Archive" });
  assert.equal(result.uid, 8);
  assert.deepEqual(JSON.parse(Buffer.from(result.reference, "base64url").toString("utf8")), { accountId: "acct", folder: "Archive", uid: 8, uidValidity: 55 });
});

test("IMAP mailbox mutation uses UID mode, a mailbox lock, and provider confirmation", async () => {
  const fake = imapFake({ "7": { uid: 7, source: Buffer.from("Subject: x\r\n\r\nbody") } }, [7]);
  const calls: string[] = [];
  fake.messageFlagsAdd = async (uid, flags, options) => { calls.push(`add:${uid}:${flags.join(",")}:${options?.uid}`); for (const flag of flags) fake.flags.add(flag); };
  fake.list = async () => [
    { path: "INBOX-custom", pathAsListed: "INBOX-custom", name: "INBOX-custom", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
    { path: "Archive", pathAsListed: "Archive", name: "Archive", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true },
  ];
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => ({ username: "user", password: "secret" }) }, clientFactory: () => fake });
  const reference = (await adapter.list("INBOX-custom", 1))[0]!.reference;
  const result = await adapter.mutate({ type: "markRead", messageReference: reference });
  assert.equal(result.action, "markRead");
  assert.equal(result.uid, 7);
  assert.deepEqual(calls, ["add:7:\\Seen:true"]);
  assert.deepEqual(fake.locks, ["INBOX-custom", "INBOX-custom"]);
});
