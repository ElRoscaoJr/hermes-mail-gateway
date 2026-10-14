import assert from "node:assert/strict";
import test from "node:test";
import { ImapFlowMailAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

const account: AccountProjection = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://example.test", smtpEndpoint: "smtps://example.test", credentialRef: "keychain:synthetic/user", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "A", sentFolder: "B" };
test("global pagination preserves total ordering across equal, invalid and missing dates", async () => {
  let selected = "A";
  const rows = [
    { folder: "A", uid: 1, date: new Date("2026-01-01T00:00:00Z") },
    { folder: "B", uid: 1, date: new Date("2026-01-01T00:00:00Z") },
    { folder: "A", uid: 2, date: "invalid" },
    { folder: "A", uid: 3, date: undefined },
    { folder: "B", uid: 2, date: "invalid" },
    { folder: "B", uid: 3, date: undefined },
  ];
  const client: ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number } } = {
    mailbox: { uidValidity: 1n, uidNext: 4 }, connect: async () => {}, logout: async () => {}, close: () => {},
    list: async () => ["A", "B"].map((path) => ({ path, pathAsListed: path, name: path, delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true })),
    getMailboxLock: async (folder) => { selected = folder; return { release: () => {} }; },
    search: async () => rows.filter((row) => row.folder === selected).map((row) => row.uid),
    fetch: async function* (range) { for (const uid of range as number[]) { const row = rows.find((item) => item.folder === selected && item.uid === uid)!; yield { seq: uid, uid, envelope: { date: row.date, messageId: `<${selected}-${uid}@example.test>` } }; } },
    fetchOne: async () => false,
  };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => client });
  const expected = (await adapter.searchAllFolders("token", undefined, 10)).messages.map((row) => row.reference);
  for (const limit of [1, 2, 3]) {
    const seen: string[] = []; let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await adapter.searchAllFolders("token", undefined, limit, cursor);
      seen.push(...page.messages.map((row) => row.reference)); cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, rows.length);
  }
});
