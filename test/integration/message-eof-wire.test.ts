import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { ImapFlowMailAdapter } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

/** Real ImapFlow, loopback-only protocol fixture: no accounts or external mail. */
async function wireFixture(raw: Buffer, advertisedSize: number, bound: number, omitEof = false) {
  const requests: Array<{ start: number; maxLength: number }> = [];
  const unsupported: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK synthetic IMAP ready\r\n");
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 2);
        const tag = line.split(" ")[0]!;
        const command = line.slice(tag.length + 1);
        if (/^CAPABILITY\b/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        else if (/^LOGIN\b/i.test(command)) socket.write(`${tag} OK LOGIN completed\r\n`);
        else if (/^LIST\b/i.test(command)) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        else if (/^LSUB\b/i.test(command)) socket.write(`* LSUB () "/" "INBOX"\r\n${tag} OK LSUB completed\r\n`);
        else if (/^SELECT\b/i.test(command)) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 8] next\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        else if (/^UID FETCH 7\b/i.test(command)) {
          const partial = /BODY\.PEEK\[\]<([0-9]+)\.([0-9]+)>/i.exec(command);
          if (!partial) {
            unsupported.push(command);
            socket.write(`${tag} BAD unsupported synthetic FETCH\r\n`);
            continue;
          }
          const start = Number(partial[1]);
          const maxLength = Number(partial[2]);
          requests.push({ start, maxLength });
          const content = raw.subarray(start, start + maxLength);
          const metadata = /RFC822\.SIZE/i.test(command) ? ` RFC822.SIZE ${advertisedSize} FLAGS () INTERNALDATE "01-Jan-2026 00:00:00 +0000" ENVELOPE (NIL "Synthetic EOF" NIL NIL NIL NIL NIL NIL NIL "<synthetic@example.test>")` : "";
          socket.write(`* 1 FETCH (UID 7${metadata}`);
          // A zero literal is deliberately different from an omitted BODY[] response.
          if (content.length || !omitEof) {
            socket.write(` BODY[]<${start}> {${content.length}}\r\n`);
            socket.write(content);
          }
          socket.write(`)\r\n${tag} OK FETCH completed\r\n`);
        } else if (/^LOGOUT\b/i.test(command)) socket.write(`* BYE closing\r\n${tag} OK LOGOUT completed\r\n`);
        else {
          unsupported.push(command);
          socket.write(`${tag} BAD unsupported synthetic command\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const account: AccountProjection = {
    accountId: "synthetic", displayName: "Synthetic", providerKind: "generic_imap_smtp",
    imapEndpoint: `imap://127.0.0.1:${port}`, smtpEndpoint: "smtp://smtp.example.test",
    credentialRef: "synthetic-only", sentPolicy: "provider_managed", enabled: true,
    allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "INBOX", sentFolder: "Sent",
  };
  const adapter = new ImapFlowMailAdapter({
    account, maxReadBytes: bound,
    credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) },
    clientFactory: (options) => new ImapFlow({ ...options, doSTARTTLS: false, socketTimeout: 5_000 }),
  });
  const reference = Buffer.from(JSON.stringify({ accountId: account.accountId, folder: "INBOX", uid: 7, uidValidity: 1 })).toString("base64url");
  return {
    adapter, reference, requests, unsupported,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function mime(length: number) {
  const header = Buffer.from("Subject: Synthetic EOF\r\nContent-Type: text/plain\r\n\r\n");
  return Buffer.concat([header, Buffer.alloc(length - header.length, 97)]);
}

for (const [length, hint, bound] of [[4037, 13086, 100000], [70000, 1, 100000], [65536, 9000000, 65536]]) {
  test(`adapter.read verifies wire EOF for ${length} bytes despite RFC822.SIZE ${hint}`, { timeout: 10_000 }, async () => {
    const raw = mime(length!);
    const f = await wireFixture(raw, hint!, bound!);
    try {
      const message = await f.adapter.read(f.reference);
      assert.equal(message.size, raw.length);
      assert.equal(message.subject, "Synthetic EOF");
      assert.equal(message.text, "a".repeat(raw.length - raw.indexOf("\r\n\r\n") - 4));
      assert.deepEqual(f.requests, length === 70000
        ? [{ start: 0, maxLength: 65536 }, { start: 65536, maxLength: 34464 }, { start: length, maxLength: 1 }]
        : [{ start: 0, maxLength: 65536 }, { start: length, maxLength: 1 }]);
      assert.deepEqual(f.unsupported, []);
    } finally { await f.close(); }
  });
}

test("adapter.read rejects a wire byte beyond its exact bound with an understated size hint", { timeout: 10_000 }, async () => {
  const f = await wireFixture(mime(65537), 1, 65536);
  try {
    await assert.rejects(f.adapter.read(f.reference), { code: "MESSAGE_TOO_LARGE" });
    assert.deepEqual(f.requests, [{ start: 0, maxLength: 65536 }, { start: 65536, maxLength: 1 }]);
    assert.deepEqual(f.unsupported, []);
  } finally { await f.close(); }
});

test("adapter.read rejects an omitted wire EOF body instead of accepting it as a zero literal", { timeout: 10_000 }, async () => {
  const f = await wireFixture(mime(4037), 13086, 100000, true);
  try {
    await assert.rejects(f.adapter.read(f.reference), { code: "PROVIDER_UNAVAILABLE" });
    assert.deepEqual(f.requests, [{ start: 0, maxLength: 65536 }, { start: 4037, maxLength: 1 }]);
    assert.deepEqual(f.unsupported, []);
  } finally { await f.close(); }
});
