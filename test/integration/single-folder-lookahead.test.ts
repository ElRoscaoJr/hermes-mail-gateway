import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../helpers.js";
import { MailGatewayService, type MailQueryInput } from "../../src/application/service.js";
import { FakeSmtpAdapter, ImapFlowMailAdapter, type ImapFlowClient, type MailSummary } from "../../src/mail/adapters.js";

const context = { caller: "Hermes main" as const, correlationId: "lookahead" };
function setup(maxResults: number, count: number) {
  const base = fixture();
  const uids = Array.from({ length: count }, (_, index) => index + 1);
  const fetched: number[][] = [];
  const client: ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number } } = {
    mailbox: { uidValidity: 7n, uidNext: count + 1 },
    connect: async () => {}, logout: async () => {}, close: () => {},
    list: async () => [{ path: "Inbox", pathAsListed: "Inbox", name: "Inbox", delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(), listed: true, subscribed: true }],
    getMailboxLock: async () => ({ release: () => {} }),
    search: async (criteria) => {
      const [lower, upper] = String(criteria.uid).split(":").map(Number);
      return uids.filter((uid) => uid >= lower! && uid <= upper!);
    },
    fetch: async function* (range) {
      fetched.push([...(range as number[])]);
      for (const uid of range as number[]) yield { seq: uid, uid, size: 42, envelope: { subject: "token", messageId: `<${uid}@example.test>` } };
    },
    fetchOne: async () => false,
  };
  const adapter = new ImapFlowMailAdapter({ account: base.accounts.get("acct")!, maxResults, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => client });
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: adapter, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, maxResults);
  return { ...base, adapter, service, fetched };
}

for (const maxResults of [2, 100]) {
  for (const search of [{ operation: "list" }, { operation: "search", query: "token" }, { operation: "search", search: { subject: "token" } }] as const) {
    test(`single-folder ${JSON.stringify(search)} retains continuation at configured public limit ${maxResults}`, async () => {
      const base = setup(maxResults, maxResults + 1);
      try {
        const input: MailQueryInput = { accountId: "acct", limit: 100, ...search };
        type Page = { messages: MailSummary[]; hasMore: boolean; nextCursor?: string };
        const first = await base.service.mailQuery(input, context) as Page;
        assert.equal(first.hasMore, true);
        assert.equal(first.messages.length, maxResults);
        assert.ok(first.nextCursor);
        const second = await base.service.mailQuery({ ...input, cursor: first.nextCursor }, context) as Page;
        assert.equal(second.hasMore, false);
        assert.equal(second.nextCursor, undefined);
        assert.deepEqual([...first.messages, ...second.messages].map((message) => message.uid), Array.from({ length: maxResults + 1 }, (_, index) => index + 1));
        assert.ok(base.fetched.every((uids) => uids.length <= maxResults + 1));
        assert.equal((await base.adapter.list("Inbox")).length, maxResults);
        assert.equal((await base.adapter.list("Inbox", 10_000)).length, maxResults + 1);
        const global = await base.adapter.searchAllFolders("token", undefined, 10_000);
        assert.equal(global.messages.length, maxResults);
        assert.equal(global.truncated, true);
      } finally { base.db.close(); }
    });
  }
}
