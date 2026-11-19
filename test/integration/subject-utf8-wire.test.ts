import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { ImapFlowMailAdapter } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

// Synthetic loopback server: explicitly rejects UTF-8 SEARCH; no external accounts.
test("accented subject search is not mistaken for empty results when UTF-8 is rejected", { timeout: 10_000 }, async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK synthetic ready\r\n");
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 2);
        const tag = line.split(" ")[0]!;
        const command = line.slice(tag.length + 1);
        commands.push(command);
        if (/^CAPABILITY\b/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
        else if (/^LOGIN\b/i.test(command)) socket.write(`${tag} OK login\r\n`);
        else if (/^LIST\b/i.test(command)) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (/^LSUB\b/i.test(command)) socket.write(`* LSUB () "/" "INBOX"\r\n${tag} OK lsub\r\n`);
        else if (/^SELECT\b/i.test(command)) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 2] next\r\n${tag} OK [READ-WRITE] select\r\n`);
        else if (/^UID SEARCH\b/i.test(command)) socket.write(`${tag} NO [BADCHARSET (US-ASCII)] UTF-8 unsupported\r\n`);
        else if (/^LOGOUT\b/i.test(command)) socket.write(`* BYE closing\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const account: AccountProjection = { accountId: "synthetic", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: `imap://127.0.0.1:${port}`, smtpEndpoint: "smtp://smtp.example.test", credentialRef: "synthetic-only", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent" };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: (options) => new ImapFlow({ ...options, doSTARTTLS: false, socketTimeout: 5_000 }) });
  try {
    await assert.rejects(adapter.search("INBOX", "reunión"), { code: "PROVIDER_UNAVAILABLE" });
    assert.ok(commands.some((command) => /^UID SEARCH CHARSET UTF-8\b/i.test(command)), JSON.stringify(commands));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Local matching must work against a server which rejects UTF-8 SEARCH.
test("accented subject matches a decoded envelope without UTF-8 SEARCH", { timeout: 10_000 }, async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK synthetic ready\r\n");
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (true) {
        const end = pending.indexOf("\r\n");
        if (end < 0) return;
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 2);
        const tag = line.split(" ")[0]!;
        const command = line.slice(tag.length + 1);
        commands.push(command);
        if (/^CAPABILITY\b/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
        else if (/^LOGIN\b/i.test(command)) socket.write(`${tag} OK login\r\n`);
        else if (/^LIST\b/i.test(command)) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (/^LSUB\b/i.test(command)) socket.write(`* LSUB () "/" "INBOX"\r\n${tag} OK lsub\r\n`);
        else if (/^SELECT\b/i.test(command)) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 2] next\r\n${tag} OK [READ-WRITE] select\r\n`);
        else if (/^UID SEARCH\b/i.test(command)) {
          if (/CHARSET|SUBJECT/i.test(command)) socket.write(`${tag} NO [BADCHARSET (US-ASCII)] UTF-8 unsupported\r\n`);
          else socket.write(`* SEARCH 1\r\n${tag} OK search\r\n`);
        } else if (/^UID FETCH\b/i.test(command)) socket.write(`* 1 FETCH (UID 1 FLAGS () RFC822.SIZE 42 INTERNALDATE "01-Jan-2025 00:00:00 +0000" ENVELOPE ("Wed, 1 Jan 2025 00:00:00 +0000" "=?UTF-8?B?cmV1bmnDs24=?=" NIL NIL NIL NIL NIL NIL NIL "<1@example.test>"))\r\n${tag} OK fetch\r\n`);
        else if (/^LOGOUT\b/i.test(command)) socket.write(`* BYE closing\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const account: AccountProjection = { accountId: "synthetic", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: `imap://127.0.0.1:${port}`, smtpEndpoint: "smtp://smtp.example.test", credentialRef: "synthetic-only", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent" };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: (options) => new ImapFlow({ ...options, doSTARTTLS: false, socketTimeout: 5_000 }) });
  try {
    const result = await adapter.searchWithFilters("INBOX", undefined, { subject: "reunión" }).catch((error: unknown) => { throw new Error(`Search failed; commands: ${JSON.stringify(commands)}`, { cause: error }); });
    assert.deepEqual(result.map((message) => [message.uid, message.subject]), [[1, "reunión"]]);
    assert.ok(commands.some((command) => /^UID SEARCH\b/i.test(command)), JSON.stringify(commands));
    assert.ok(commands.every((command) => !/^UID SEARCH.*(?:CHARSET|SUBJECT)/i.test(command)), JSON.stringify(commands));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
