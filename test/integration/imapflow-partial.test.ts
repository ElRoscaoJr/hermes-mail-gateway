import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { ImapFlow } from "imapflow";

/** Exercises ImapFlow's actual BODY.PEEK partial-fetch and decoded download behavior offline. */
test("ImapFlow returns exact encoded MIME octets for bounded section offsets and reports whole-message size", async () => {
  const rawPart = Buffer.from("YWJjZGVm");
  const servedOffsets: number[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK synthetic IMAP ready\r\n");
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.includes(Buffer.from("\r\n"))) {
        const end = pending.indexOf(Buffer.from("\r\n"));
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 2);
        const tag = line.split(" ")[0]!;
        const command = line.slice(tag.length + 1);
        if (/^CAPABILITY\b/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        else if (/^LOGIN\b/i.test(command)) socket.write(`${tag} OK LOGIN completed\r\n`);
        else if (/^LIST\b/i.test(command)) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        else if (/^LSUB\b/i.test(command)) socket.write(`* LSUB () "/" "INBOX"\r\n${tag} OK LSUB completed\r\n`);
        else if (/^SELECT\b/i.test(command)) socket.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 8] next\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        else if (/\bFETCH\b/i.test(command)) {
          const partial = /BODY\.PEEK\[2\]<([0-9]+)\.([0-9]+)>/i.exec(command);
          if (partial) {
            const offset = Number(partial[1]);
            const length = Number(partial[2]);
            servedOffsets.push(offset);
            const content = rawPart.subarray(offset, offset + length);
            const crlf = String.fromCharCode(13, 10);
            const mime = Buffer.from(["Content-Type: application/octet-stream; name=data.bin", "Content-Disposition: attachment; filename=data.bin", "Content-Transfer-Encoding: base64", ""].join(crlf), "ascii");
            const size = command.toUpperCase().includes("RFC822.SIZE") ? " RFC822.SIZE 100" : "";
            const mimeHeaders = command.toUpperCase().includes("BODY.PEEK[2.MIME]") ? ` BODY[2.MIME] {${mime.length}}${crlf}${mime.toString("ascii")}` : "";
            const body = content.length ? ` BODY[2]<${offset}> {${content.length}}${crlf}${content.toString("ascii")}` : "";
            socket.write(`* 1 FETCH (UID 7${size}${mimeHeaders}${body})${crlf}${tag} OK FETCH completed${crlf}`);
          } else if (/RFC822\.SIZE/i.test(command)) socket.write(`* 1 FETCH (UID 7 RFC822.SIZE 100)\r\n${tag} OK FETCH completed\r\n`);
          else socket.write(`${tag} BAD unsupported synthetic FETCH\r\n`);
        } else if (/^LOGOUT\b/i.test(command)) socket.write(`* BYE closing\r\n${tag} OK LOGOUT completed\r\n`);
        else socket.write(`${tag} BAD unsupported synthetic command\r\n`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new ImapFlow({ host: "127.0.0.1", port, secure: false, doSTARTTLS: false, auth: { user: "synthetic", pass: "synthetic" }, logger: false });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    const metadata = await client.fetchOne(7, { uid: true, size: true }, { uid: true });
    const first = await client.fetchOne(7, { uid: true, bodyParts: [{ key: "2", start: 0, maxLength: 4 }] }, { uid: true });
    const second = await client.fetchOne(7, { uid: true, bodyParts: [{ key: "2", start: 4, maxLength: 4 }] }, { uid: true });
    const sentinel = await client.fetchOne(7, { uid: true, bodyParts: [{ key: "2", start: 8, maxLength: 1 }] }, { uid: true });
    assert.ok(metadata);
    assert.equal(metadata.size, 100);
    assert.ok(first);
    assert.equal(first.bodyParts?.get("2")?.toString("ascii"), "YWJj");
    assert.ok(second);
    assert.equal(second.bodyParts?.get("2")?.toString("ascii"), "ZGVm");
    assert.ok(sentinel);
    assert.equal(sentinel.uid, 7);
    assert.equal(sentinel.bodyParts?.get("2"), undefined);

    const download = await client.download(7, "2", { uid: true, maxBytes: 7 });
    assert.equal(download.meta.expectedSize, 100);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString("ascii"), "abcdef");
    assert.deepEqual(servedOffsets, [0, 4, 8, 0]);
  } finally {
    try { await client.logout(); } catch { client.close(); }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
