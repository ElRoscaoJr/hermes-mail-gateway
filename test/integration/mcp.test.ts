import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SafeError } from "../../src/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { MailApplicationService } from "../../src/application/service.js";

test("MCP exposes exactly four tools and rejects invalid public input", async () => {
  const calls: string[] = [];
  const service: MailApplicationService = {
    mailAccounts: () => ({ accounts: [{ accountId: "acct", credentialRef: "keychain:private" }] }),
    mailQuery: (input) => input.operation === "attachments" ? { attachments: [{ filename: "secret.bin", contentType: "application/octet-stream", size: 14, content: Buffer.from("attachment bytes") }], rawMime: Buffer.from("raw mime") } : { messages: [] },
    mailPrepare: (input) => { calls.push(`prepare:${input.accountId}`); return { state: "PREPARED", accountId: input.accountId, bcc: ["hidden@example.test"], attachments: [{ filename: "secret.bin", content: Buffer.from("attachment bytes") }], rawMime: Buffer.from("From: secret@example.test\r\n\r\nbody") }; },
    mailExecute: (input) => {
      if (input.accountId !== "acct") throw new SafeError("ACCOUNT_NOT_FOUND", "Account was not found.");
      return { state: input.verifyOnly ? "VERIFIED_ONLY" : "SENT_VERIFIED", accountId: input.accountId };
    }
  };
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["mail_accounts", "mail_query", "mail_prepare", "mail_execute"]);

  const invalid = await client.callTool({ name: "mail_prepare", arguments: {
    accountId: "acct", idempotencyKey: "idem-123456", fromAddress: "attacker@example.test",
    recipients: ["recipient@example.test"], subject: "Synthetic"
  } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /input/i);

  const prepared = await client.callTool({ name: "mail_prepare", arguments: {
    accountId: "acct", idempotencyKey: "idem-123456", recipients: ["recipient@example.test"], subject: "Synthetic"
  } });
  assert.equal(prepared.isError, undefined);
  assert.doesNotMatch(JSON.stringify(prepared.content), /secret@example\.test|From:/i);
  assert.doesNotMatch(JSON.stringify(prepared.structuredContent), /rawMime|secret@example\.test|From:|hidden@example\.test|attachment bytes|\"bcc\"/i);
  assert.deepEqual(calls, ["prepare:acct"]);

  const attachments = await client.callTool({ name: "mail_query", arguments: { accountId: "acct", operation: "attachments", messageReference: "opaque-ref" } });
  assert.doesNotMatch(JSON.stringify(attachments.structuredContent), /attachment bytes|raw mime|"content":/i);

  const execute = await client.callTool({ name: "mail_execute", arguments: { accountId: "acct", messageId: "message", verifyOnly: true } });
  assert.equal(execute.isError, undefined);
  const mismatch = await client.callTool({ name: "mail_execute", arguments: { accountId: "other", messageId: "message" } });
  assert.equal(mismatch.isError, true);
  assert.doesNotMatch(JSON.stringify(mismatch), /stack|private|attacker/i);
  await client.close();
  await server.close();
});
