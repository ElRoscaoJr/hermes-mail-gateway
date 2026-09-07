import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMime } from "../../src/mail/mime.js";
import { NodemailerSmtpAdapter } from "../../src/mail/adapters.js";
import { parseCredentialReference } from "../../src/mail/credentials.js";
import type { PreparedMessage } from "../../src/domain/types.js";

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

test("SMTP adapter classifies provider rejection", async () => {
  assert.equal(await adapter(async () => { throw { responseCode: 550, response: "rejected" }; }).submit("<fixed@id>", Buffer.from("body")), "REJECTED");
});

test("SMTP adapter classifies an accepted provider response", async () => {
  assert.equal(await adapter(async () => ({ message: Buffer.from("accepted"), rejected: [] })).submit("<fixed@id>", Buffer.from("body")), "ACKNOWLEDGED");
});

test("SMTP adapter classifies pre-submission connection failure", async () => {
  assert.equal(await adapter(async () => { throw { code: "ECONNECTION", command: "CONN" }; }).submit("<fixed@id>", Buffer.from("body")), "PRE_SUBMISSION_FAILURE");
});

test("SMTP adapter classifies exceptions after the SMTP attempt as unknown", async () => {
  assert.equal(await adapter(async () => { throw { code: "ESOCKET", command: "DATA" }; }).submit("<fixed@id>", Buffer.from("body")), "UNKNOWN");
});
