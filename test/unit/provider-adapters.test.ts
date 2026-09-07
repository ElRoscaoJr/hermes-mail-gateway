import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMime } from "../../src/mail/mime.js";
import { ImapFlowMailAdapter, NodemailerSmtpAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";
import { parseCredentialReference } from "../../src/mail/credentials.js";
import type { PreparedMessage } from "../../src/domain/types.js";
import { accountConfigSchema } from "../../src/config/model.js";

const baseMessage: PreparedMessage = {
  messageId: "message-a", accountId: "acct", idempotencyKey: "idem-123456", messageIdHeader: "<fixed@hermes-mail-gateway.local>",
  fromAddress: "sender@example.test", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "plain body", state: "PREPARED", attachments: [],
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
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  writeFileSync(path, bytes);
  const message = { ...baseMessage, htmlBody: "<strong>html body</strong>", attachments: [{ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream" }] };
  const raw = await buildMime(message, { attachmentRoots: [dir] });
  const mime = raw.toString("utf8");
  assert.match(mime, /\r\n/);
  assert.doesNotMatch(mime, /(^|[^\r])\n/);
  assert.match(mime, /Message-ID: <fixed@hermes-mail-gateway\.local>/i);
  assert.match(mime, /Content-Type: text\/plain/i);
  assert.match(mime, /html body/);
  assert.match(mime, /Content-Disposition: attachment/);
  assert.ok(mime.includes(bytes.toString("base64")));
  const second = await buildMime(message, { attachmentRoots: [dir] });
  assert.match(second.toString("utf8"), /Message-ID: <fixed@hermes-mail-gateway\.local>/i);
});

function adapter(sendMail: (options: unknown) => Promise<{ message: Buffer; rejected?: readonly string[] }>) {
  return new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async () => ({ username: "user", password: "secret" }) }, transport: { sendMail } });
}

const envelope = { from: baseMessage.fromAddress, to: baseMessage.recipients };

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
  assert.deepEqual(options, { raw: Buffer.from("stored raw MIME"), envelope: { from: "sender@example.test", to: ["recipient@example.test"] } });
});

test("SMTP adapter resolves its independent credential reference", async () => {
  let requested: string | undefined;
  const smtp = new NodemailerSmtpAdapter({ host: "smtp.example.test", port: 465, secure: true, credentialRef: "keychain:smtp/account", credentials: { get: async (reference) => { requested = reference; return { username: "user", password: "secret" }; } }, transport: { sendMail: async () => ({ message: Buffer.from("accepted"), rejected: [] }) } });
  assert.equal((await smtp.submit("<fixed@id>", Buffer.from("body"), envelope)).outcome, "ACKNOWLEDGED");
  assert.equal(requested, "keychain:smtp/account");
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
function imapFake(messages: Record<string, { uid: number; source?: Buffer; envelope?: { messageId?: string; subject?: string } }>, searched: number[] = []): ImapFlowClient & { options?: unknown; locks: string[] } {
  const state = { options: undefined as unknown, locks: [] as string[] };
  return { ...state, connect: async () => undefined, logout: async () => undefined, close: () => undefined, list: async () => [{ path: "INBOX-custom", pathAsListed: "INBOX-custom", name: "INBOX-custom", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true }], getMailboxLock: async (path) => { state.locks.push(path); return { release: () => undefined }; }, search: async () => searched, fetch: async function* (range) { for (const uid of range as number[]) { const message = messages[String(uid)]; if (message) yield { seq: uid, uid: message.uid, source: message.source, envelope: message.envelope, flags: new Set<string>() }; } }, fetchOne: async (uid) => { const message = messages[String(uid)]; return message ? { seq: uid as number, uid: message.uid, source: message.source, envelope: message.envelope, flags: new Set<string>() } : false; } };
}

test("IMAP adapter uses explicit folders, credentials, UID-safe references, and bounded reads", async () => {
  const source = Buffer.from("Message-ID: <read@example.test>\r\nSubject: Read me\r\nContent-Type: text/plain\r\n\r\nbounded body");
  const fake = imapFake({ "7": { uid: 7, source, envelope: { messageId: "<read@example.test>", subject: "Read me" } } }, [7]);
  let requested: unknown;
  let credentialCalls = 0;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async (reference) => { credentialCalls += 1; requested = reference; return { username: "user", password: "secret" }; } }, clientFactory: (options) => { fake.options = options; return fake; }, maxResults: 1, maxReadBytes: 256 });
  const summaries = await adapter.listMessages("INBOX-custom", "read", 20);
  assert.equal(summaries.length, 1);
  const reference = summaries[0]?.reference;
  assert.ok(reference);
  const read = await adapter.read(reference);
  assert.equal(read.uid, 7);
  assert.equal(read.folder, "INBOX-custom");
  assert.equal(read.text, "bounded body");
  assert.equal(credentialCalls, 2);
  assert.equal(requested, "keychain:imap/account");
  assert.deepEqual((fake.options as { auth: { user: string; pass: string }; logger: unknown }).auth, { user: "user", pass: "secret" });
  assert.equal((fake.options as { logger: unknown }).logger, false);
  assert.deepEqual(fake.locks, ["INBOX-custom", "INBOX-custom"]);
  assert.equal((await adapter.listFolders())[0]?.path, "INBOX-custom");
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

test("IMAP adapter maps connection and credential failures safely", async () => {
  let called = false;
  const adapter = new ImapFlowMailAdapter({ account: imapAccount, credentials: { get: async () => { called = true; throw new Error("keychain detail"); } }, clientFactory: () => { throw new Error("must not construct"); } });
  await assert.rejects(adapter.listFolders(), { code: "PROVIDER_UNAVAILABLE", message: "The IMAP provider is unavailable." });
  assert.equal(called, true);
  assert.throws(() => new ImapFlowMailAdapter({ account: { ...imapAccount, imapEndpoint: "https://imap.example.test" }, credentials: { get: async () => null } }), { code: "REFERENCE_INVALID" });
});
