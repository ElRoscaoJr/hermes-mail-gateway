import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../helpers.js";
import { MailGatewayService } from "../../src/application/service.js";
import { ImapFlowMailAdapter, FakeSmtpAdapter, type ImapFlowClient } from "../../src/mail/adapters.js";

function setup(subjects: string[], options: { reverse?: boolean; missing?: boolean; duplicate?: boolean; stale?: boolean; fetchFails?: boolean; uidNext?: number; metadata?: (uid: number) => object } = {}) {
  const base = fixture();
  const searches: unknown[] = [];
  const client: ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number } } = {
    mailbox: { uidValidity: 7n, uidNext: options.uidNext ?? subjects.length + 1 },
    connect: async () => {}, logout: async () => {}, close: () => {},
    list: async () => [], getMailboxLock: async () => ({ release: () => {} }),
    search: async (criteria) => {
      searches.push(criteria);
      const [lo, hi] = String(criteria.uid).split(":").map(Number);
      return subjects.map((_, i) => i + 1).filter((uid) => uid >= lo! && uid <= hi!);
    },
    fetch: async function* (range) {
      const uids = [...range as number[]];
      if (options.reverse) uids.reverse();
      if (options.missing) uids.pop();
      for (const uid of uids) { yield { seq: uid, uid, envelope: { subject: subjects[uid - 1]! }, ...options.metadata?.(uid) }; if (options.duplicate) yield { seq: uid, uid, envelope: { subject: subjects[uid - 1]! } }; }
      if (options.stale) client.mailbox.uidValidity = 8n;
      if (options.fetchFails) return false;
    },
    fetchOne: async () => false,
  };
  const clientOptions: Array<{ maxResponseSize?: number | undefined; maxLiteralSize?: number | undefined; maxLineLength?: number | undefined }> = [];
  const adapter = new ImapFlowMailAdapter({ account: base.accounts.get("acct")!, maxResults: 2, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: (options) => { clientOptions.push(options); return client; } });
  return { ...base, adapter, searches, client, clientOptions };
}

test("parser limits apply only to Unicode subject connections", async () => {
  const b = setup(["reunión"]);
  try {
    await b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" });
    await b.adapter.searchWithFilters("Inbox", undefined, { subject: "meeting" });
    assert.equal(b.clientOptions[0]?.maxResponseSize, 1024 * 1024);
    assert.equal(b.clientOptions[0]?.maxLiteralSize, 512 * 1024);
    assert.equal(b.clientOptions[0]?.maxLineLength, 512 * 1024);
    assert.equal(b.clientOptions[1]?.maxResponseSize, undefined);
    assert.equal(b.clientOptions[1]?.maxLiteralSize, undefined);
    assert.equal(b.clientOptions[1]?.maxLineLength, undefined);
  } finally { b.db.close(); }
});

test("unicode subject bounds aggregate fetched metadata even for nonmatches", async () => {
  const b = setup(Array(12).fill("other"), { metadata: () => ({ envelope: { subject: "other", from: [{ name: "x".repeat(800_000) }] } }) });
  try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "QUERY_TOO_LARGE" }); }
  finally { b.db.close(); }
});

test("unicode subject rejects oversized single messages and flag metadata", async () => {
  for (const metadata of [
    () => ({ envelope: { subject: "reunión", from: [{ name: "x".repeat(4_194_305) }] } }),
    () => ({ flags: new Set(["x".repeat(4_194_305)]) }),
  ]) {
    const b = setup(["reunión"], { metadata });
    try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "QUERY_TOO_LARGE" }); }
    finally { b.db.close(); }
  }
});

test("unicode subject is matched locally over all candidates in UID order", async () => {
  const b = setup(["other", "REUNIO\u0301N", "reunion", "reunión final"], { reverse: true });
  try {
    const results = await b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }, 3);
    assert.deepEqual(results.map(m => m.uid), [2, 4]);
    assert.ok(b.searches.every(s => !JSON.stringify(s).includes("subject")));
  } finally { b.db.close(); }
});


test("unicode subject pages preserve sparse matches and lookahead", async () => {
  const b = setup(["x", "reunión 1", "x", "reunión 2", "x", "reunión 3"], { reverse: true });
  try {
    const first = await b.adapter.searchWithFilters("Inbox", undefined, { subject: "REUNIÓN" }, 3);
    assert.deepEqual(first.map(m => m.uid), [2, 4, 6]);
    const next = await b.adapter.searchWithFilters("Inbox", undefined, { subject: "REUNIÓN" }, 3, 4, 7);
    assert.deepEqual(next.map(m => m.uid), [6]);
  } finally { b.db.close(); }
});

test("unicode subject fails closed above candidate cap", async () => {
  const b = setup(Array.from({ length: 2001 }, () => "other"));
  try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "QUERY_TOO_LARGE" }); }
  finally { b.db.close(); }
});

test("unicode subject rejects fetch failure after all candidates were yielded", async () => {
  const b = setup(["reunión"], { fetchFails: true });
  try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "PROVIDER_UNAVAILABLE" }); }
  finally { b.db.close(); }
});

test("unicode subject rejects incomplete fetch", async () => {
  const b = setup(["reunión"], { missing: true });
  try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "PROVIDER_UNAVAILABLE" }); }
  finally { b.db.close(); }
});

test("unicode subject fails closed for all folders", async () => {
  const b = setup([]);
  try { await assert.rejects(b.adapter.searchAllFolders(undefined, { subject: "reunión" }), { code: "UNSUPPORTED_OPERATION" }); }
  finally { b.db.close(); }
});


test("unicode subject cursor cannot be reused with a different search", async () => {
  const b = setup(["reunión 1", "reunión 2", "reunión 3"]);
  const service = new MailGatewayService(b.accounts, b.repo, new Map([["acct", { imap: b.adapter, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, 2);
  const context = { caller: "Hermes main" as const, correlationId: "unicode-cursor" };
  try {
    const page = await service.mailQuery({ accountId: "acct", operation: "search", search: { subject: "reunión" }, limit: 2 }, context) as { nextCursor: string };
    assert.ok(page.nextCursor);
    await assert.rejects(service.mailQuery({ accountId: "acct", operation: "search", search: { subject: "reuniones" }, limit: 2, cursor: page.nextCursor }, context), { code: "INVALID_INPUT" });
  } finally { b.db.close(); }
});


test("unicode subject rejects duplicate UIDs and changed UIDVALIDITY", async () => {
  for (const options of [{ duplicate: true }, { stale: true }]) {
    const b = setup(["reunión"], options);
    try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: options.duplicate ? "PROVIDER_UNAVAILABLE" : "REFERENCE_STALE" }); }
    finally { b.db.close(); }
  }
});

test("unicode subject respects the bounded UID window budget", async () => {
  const b = setup([], { uidNext: 100_000_000 });
  try { await assert.rejects(b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión" }), { code: "QUERY_TOO_LARGE" }); }
  finally { b.db.close(); }
});

test("unicode subject preserves other server-side structured filters", async () => {
  const b = setup(["reunión"]);
  try {
    await b.adapter.searchWithFilters("Inbox", undefined, { subject: "reunión", from: "person@example.test", isRead: true });
    assert.deepEqual(b.searches[0], { from: "person@example.test", seen: true, uid: "1:1" });
  } finally { b.db.close(); }
});


test("unicode subject cursor rejects a changed UIDNEXT snapshot", async () => {
  const b = setup(["reunión 1", "reunión 2", "reunión 3"]);
  const service = new MailGatewayService(b.accounts, b.repo, new Map([["acct", { imap: b.adapter, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, 2);
  const context = { caller: "Hermes main" as const, correlationId: "uidnext" };
  try {
    const input = { accountId: "acct", operation: "search" as const, search: { subject: "reunión" }, limit: 2 };
    const first = await service.mailQuery(input, context) as { nextCursor: string };
    b.client.mailbox.uidNext++;
    await assert.rejects(service.mailQuery({ ...input, cursor: first.nextCursor }, context), { code: "REFERENCE_STALE" });
  } finally { b.db.close(); }
});
