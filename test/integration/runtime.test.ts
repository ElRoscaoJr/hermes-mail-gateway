import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime, createRuntimeFromEnvironment, loadServerConfig } from "../../src/runtime.js";

function config(databasePath: string, root: string) {
  const account = (accountId: string) => ({ accountId, displayName: accountId, providerKind: "generic_imap_smtp" as const, imapEndpoint: "imap://localhost", smtpEndpoint: "smtp://localhost", credentialRef: "keychain:test/account", sentPolicy: "provider_managed" as const, enabled: true, allowedSender: `${accountId}@example.test`, allowedAttachmentRoots: [root], inboxFolder: "INBOX", sentFolder: "Sent" });
  return { databasePath, attachmentRoots: [root], accounts: [account("first"), account("second")], limits: { maxRecipients: 10, maxAttachmentBytes: 1_000_000 } };
}

test("runtime requires an explicit configuration path and rejects duplicate accounts", () => {
  assert.throws(() => createRuntimeFromEnvironment({}), { code: "CONFIGURATION_MISSING" });
  const dir = mkdtempSync(join(tmpdir(), "hermes-runtime-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ ...config(join(dir, "mail.db"), dir), accounts: [config(join(dir, "mail.db"), dir).accounts[0], config(join(dir, "mail.db"), dir).accounts[0]] }));
  assert.throws(() => loadServerConfig(file), { code: "CONFIGURATION_INVALID" });
});

test("runtime composes multiple account projections without contacting providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-runtime-"));
  const runtime = createRuntime(config(join(dir, "mail.db"), dir), { credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) } });
  try {
    const result = await runtime.service.mailAccounts({ includeHealth: false });
    assert.deepEqual(result.accounts.map((account) => account.accountId), ["first", "second"]);
    assert.doesNotMatch(JSON.stringify(result), /keychain|localhost|synthetic|credential/i);
  } finally { runtime.close(); }
});

test("compiled stdio process fails clearly and keeps stdout free of diagnostics when config is absent", (t) => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/src/main.js")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") { t.skip("The managed test sandbox disallows child processes."); return; }
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HERMES_MAIL_CONFIG must name an explicit configuration file/);
  assert.doesNotMatch(result.stderr, /password|token|credential|stack/i);
});

test("compiled stdio process answers MCP initialize with protocol output only", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-stdio-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config(join(dir, "mail.db"), dir)));
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-smoke", version: "1.0.0" } } });
  const frame = `${request}\n`;
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/src/main.js")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HERMES_MAIL_CONFIG: configPath }, input: frame, encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") { t.skip("The managed test sandbox disallows child processes."); return; }
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"result"/);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /password|token|credential|localhost|keychain/i);
});
