import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, loadServerConfig } from "../../src/runtime.js";
import type { ImapFlowClient } from "../../src/mail/adapters.js";

const reference = Buffer.from(JSON.stringify({ accountId: "synthetic", folder: "INBOX", uid: 7, uidValidity: 1 })).toString("base64url");
const header = Buffer.from("Subject: Synthetic boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=test.bin\r\n\r\n");

for (const [configured, bound, overflow] of [[25_000_000, 25_000_000, false], [25_000_000, 25_000_000, true], [8192, 8192, false], [8192, 8192, true], [undefined, 4_000_000, true]] as const) {
  test(`configured maxRead ${configured ?? "default"} ${overflow ? "rejects one byte over" : "accepts exact boundary"}`, { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-read-limit-"));
    const configPath = join(dir, "config.json");
    const raw = Buffer.alloc(bound + (overflow ? 1 : 0), 97);
    header.copy(raw);
    const requests: Array<{ start: number; maxLength: number }> = [];
    const client = {
      mailbox: { uidValidity: 1n }, connect: async () => {}, logout: async () => {}, close: () => {},
      getMailboxLock: async () => ({ release() {} }),
      fetchOne: async (_uid: unknown, query: { source: { start: number; maxLength: number } }) => {
        requests.push({ ...query.source });
        return { seq: 1, uid: 7, size: 1, envelope: { subject: "Synthetic boundary" }, source: raw.subarray(query.source.start, query.source.start + query.source.maxLength) };
      },
    };
    writeFileSync(configPath, JSON.stringify({
      databasePath: join(dir, "mail.db"), attachmentRoots: [],
      accounts: [{ accountId: "synthetic", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imap://localhost", smtpEndpoint: "smtp://localhost", credentialRef: "synthetic", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent" }],
      limits: { maxRecipients: 10, maxAttachmentBytes: 1_000_000, ...(configured === undefined ? {} : { maxReadBytes: configured }) },
    }));
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const loaded = loadServerConfig(configPath);
      assert.equal(loaded.limits.maxReadBytes, bound);
      runtime = createRuntime(loaded, { credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, imapClientFactory: () => client as unknown as ImapFlowClient });
      const read = runtime.service.mailQuery({ accountId: "synthetic", operation: "read", messageReference: reference }, { caller: "Hermes main", correlationId: "boundary" });
      if (overflow) await assert.rejects(read, { code: "MESSAGE_TOO_LARGE" });
      else {
        const result = await read as { message: { size: number; subject: string } };
        assert.equal(result.message.size, bound);
        assert.equal(result.message.subject, "Synthetic boundary");
      }
      let offset = 0;
      for (const request of requests.slice(0, -1)) {
        assert.equal(request.start, offset);
        assert.equal(request.maxLength, Math.min(65_536, bound - offset));
        offset += request.maxLength;
      }
      assert.equal(offset, bound);
      assert.deepEqual(requests.at(-1), { start: bound, maxLength: 1 });
      assert.equal(requests.length, Math.ceil(bound / 65_536) + 1);
    } finally {
      runtime?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("configuration loader rejects a maxRead one byte above the 25 MB maximum", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-read-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ databasePath: join(dir, "mail.db"), attachmentRoots: [], accounts: [], limits: { maxRecipients: 10, maxAttachmentBytes: 1_000_000, maxReadBytes: 25_000_001 } }));
    assert.throws(() => loadServerConfig(path), { code: "CONFIGURATION_INVALID" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
