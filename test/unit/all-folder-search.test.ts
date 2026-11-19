import assert from "node:assert/strict";
import test from "node:test";
import type { SearchObject } from "imapflow";
import { fixture } from "../helpers.js";
import { MailGatewayService, type MailQueryInput } from "../../src/application/service.js";
import { SafeError } from "../../src/errors.js";
import { FakeSmtpAdapter, ImapFlowMailAdapter, type ImapFlowClient, type MailSearchPage, type MailSummary } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

const account: AccountProjection = { accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://example.test", smtpEndpoint: "smtps://example.test", credentialRef: "keychain:synthetic/user", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "Inbox", sentFolder: "Sent" };

interface Row { readonly uid: number; readonly subject?: string; readonly messageId?: string; readonly date?: Date | string; readonly fromName?: string; readonly from?: string; readonly to?: ReadonlyArray<readonly [string, string]>; readonly cc?: ReadonlyArray<readonly [string, string]>; readonly sender?: ReadonlyArray<readonly [string, string]>; readonly bcc?: ReadonlyArray<readonly [string, string]>; readonly references?: readonly string[]; readonly size?: number; readonly flags?: readonly string[]; readonly read?: boolean }
interface FolderSpec { rows: readonly Row[]; uidNext?: number; uidValidity?: number; fetch?: "ok" | "completeFalse" | "emptyFalse" | "short" | "duplicate"; searchMode?: "false" | "undefined"; noselect?: boolean; /** Raw FETCH members a provider may return and the summary drops; they must never be charged. */ discarded?: (row: Row) => Record<string, unknown> }
type FetchMode = NonNullable<FolderSpec["fetch"]>;

function rowsOf(count: number, options: { subject?: string; fromName?: string; from?: string } = {}): Row[] {
  return Array.from({ length: count }, (_, index) => ({ uid: index + 1, subject: options.subject ?? "other", ...(options.fromName === undefined ? {} : { fromName: options.fromName }), ...(options.from === undefined ? {} : { from: options.from }) }));
}

function inWindow(criteria: SearchObject, uid: number): boolean {
  const range = typeof criteria.uid === "string" ? criteria.uid : undefined;
  if (range === undefined) return true;
  const [lower, upper] = range.split(":").map(Number);
  return uid >= lower! && uid <= upper!;
}

function contains(value: string | undefined, needle: string): boolean {
  return (value ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** Synthetic server-side evaluation: the subject needle is deliberately absent from every
 *  Unicode local-subject search, so every row in the UID window becomes a candidate. */
function serverMatches(criteria: SearchObject, row: Row): boolean {
  if (criteria.all) return true;
  if (criteria.from !== undefined && row.from !== criteria.from) return false;
  if (typeof criteria.subject === "string" && !contains(row.subject, criteria.subject)) return false;
  const headerId = criteria.header?.["Message-ID"];
  if (typeof headerId === "string" && row.messageId !== headerId) return false;
  if (criteria.seen !== undefined && (row.read ?? false) !== criteria.seen) return false;
  // Date criteria apply only to rows that carry a parseable date; undated synthetic rows stay
  // candidates so the budget tests keep exercising the scan instead of the date filter.
  const rowDate = row.date === undefined ? Number.NaN : row.date instanceof Date ? row.date.getTime() : Date.parse(row.date);
  if (criteria.since instanceof Date && Number.isFinite(rowDate) && rowDate < criteria.since.getTime()) return false;
  if (criteria.before instanceof Date && Number.isFinite(rowDate) && rowDate >= criteria.before.getTime()) return false;
  if (criteria.or !== undefined) {
    const any = criteria.or.some((clause) => (typeof clause.text === "string" && contains(row.subject, clause.text)) || (typeof clause.subject === "string" && contains(row.subject, clause.subject)) || (typeof clause.header?.Subject === "string" && contains(row.subject, clause.header.Subject)));
    if (!any) return false;
  }
  return true;
}

// Absent envelope fields are omitted, as providers do, so metadata accounting reflects real shapes.
function addressList(values: ReadonlyArray<readonly [string, string]> | undefined): Array<{ name: string; address: string }> | undefined {
  return values?.map(([name, address]) => ({ name, address }));
}
function envelope(row: Row) {
  return {
    ...(row.subject === undefined ? {} : { subject: row.subject }),
    ...(row.date === undefined ? {} : { date: row.date }),
    ...(row.messageId === undefined ? {} : { messageId: row.messageId }),
    from: [{ name: row.fromName ?? "Sender", address: row.from ?? "sender@example.test" }],
    ...(row.to === undefined ? {} : { to: addressList(row.to) }),
    ...(row.cc === undefined ? {} : { cc: addressList(row.cc) }),
    ...(row.references === undefined ? {} : { references: [...row.references] }),
    // Sender and Bcc are wire-only here: the summary keeps From/To/Cc/Reply-To and drops them.
    ...(row.sender === undefined ? {} : { sender: addressList(row.sender) }),
    ...(row.bcc === undefined ? {} : { bcc: addressList(row.bcc) }),
  };
}

function setup(specs: Record<string, FolderSpec>) {
  let selected = "";
  const searches: Array<{ folder: string; criteria: SearchObject }> = [];
  const fetched: Array<{ folder: string; uids: number[] }> = [];
  const client: ImapFlowClient & { mailbox: { uidValidity: bigint; uidNext: number } } = {
    mailbox: { uidValidity: 1n, uidNext: 1 },
    connect: async () => {}, logout: async () => {}, close: () => {},
    list: async () => Object.keys(specs).map((path) => ({ path, pathAsListed: path, name: path, delimiter: "/", parent: [], parentPath: "", flags: new Set<string>(specs[path]!.noselect ? ["\\Noselect"] : []), listed: true, subscribed: true })),
    getMailboxLock: async (folder) => {
      selected = folder;
      const spec = specs[folder]!;
      client.mailbox = { uidValidity: BigInt(spec.uidValidity ?? 1), uidNext: spec.uidNext ?? Math.max(1, ...spec.rows.map((row) => row.uid)) + 1 };
      return { release: () => {} };
    },
    search: async (criteria) => {
      searches.push({ folder: selected, criteria });
      const spec = specs[selected]!;
      if (spec.searchMode === "false") return false;
      if (spec.searchMode === "undefined") return undefined as unknown as number[];
      return spec.rows.filter((row) => inWindow(criteria, row.uid) && serverMatches(criteria, row)).map((row) => row.uid);
    },
    fetch: async function* (range) {
      const uids = [...(range as number[])];
      const spec = specs[selected]!;
      fetched.push({ folder: selected, uids });
      const mode: FetchMode = spec.fetch ?? "ok";
      // A real FETCH response also carries internalDate, RFC822.SIZE and a flag Set; those are
      // yielded so accounting runs against realistic shapes rather than a bare envelope.
      const message = (uid: number, row: Row) => ({
        seq: uid,
        uid,
        envelope: envelope(row),
        flags: new Set<string>([...(row.flags ?? []), ...(row.read ? ["\\Seen"] : [])]),
        internalDate: new Date("2026-02-01T10:00:00.000Z"),
        size: row.size ?? 12_345,
        ...spec.discarded?.(row),
      });
      if (mode === "emptyFalse") return false;
      for (const uid of uids) {
        const row = spec.rows.find((item) => item.uid === uid);
        if (row === undefined || mode === "short") continue;
        yield message(uid, row);
        if (mode === "duplicate") yield { seq: uid, uid, envelope: envelope(row), flags: new Set<string>() };
      }
      if (mode === "completeFalse") return false;
      return undefined;
    },
    fetchOne: async () => false,
  };
  const adapter = new ImapFlowMailAdapter({ account, maxResults: 100, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => client });
  return { adapter, client, searches, fetched, specs };
}

async function allPages(adapter: ImapFlowMailAdapter, limit: number, query?: string, filters?: Parameters<ImapFlowMailAdapter["searchAllFolders"]>[1]): Promise<MailSummary[]> {
  const seen: MailSummary[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index++) {
    const page: MailSearchPage = await adapter.searchAllFolders(query, filters, limit, cursor);
    seen.push(...page.messages);
    cursor = page.nextCursor;
    if (cursor === undefined) break;
  }
  return seen;
}

// --- Cross-folder shared candidate budget -------------------------------------------------------

test("all-folder candidate budget is absolute and charged for nonmatches", async () => {
  const limited = setup({ A: { rows: rowsOf(50) }, B: { rows: rowsOf(50) } });
  const page = await limited.adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(page.messages, []);
  assert.equal(page.truncated, false);
  assert.equal(page.foldersSearched, 2);

  // The bound no longer scales with the requested page size: 100 nonmatching candidates used to
  // exhaust a page-size-derived cap for limit 2 and now complete.
  const wide = setup({ A: { rows: rowsOf(50) }, B: { rows: rowsOf(51) } });
  const widePage = await wide.adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(widePage.messages, []);
  assert.equal(widePage.truncated, false);
});

test("all-folder candidate budget charges nonmatching candidates across folders", async () => {
  // 100 nonmatching candidates ahead of a real match no longer hide it: all folders are scanned.
  const fits = setup({ A: { rows: rowsOf(100) }, B: { rows: [{ uid: 1, subject: "reunión" }] } });
  const page = await fits.adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(page.messages.map((message) => [message.folder, message.uid]), [["B", 1]]);
  assert.equal(page.truncated, false);

  // Nonmatching candidates are still charged against the absolute bound: a folder that would push
  // the total past it fails closed before that folder's candidates are fetched or any page exists.
  const hidden = setup({ A: { rows: rowsOf(4_000) }, B: { rows: rowsOf(6_001) } });
  await assert.rejects(hidden.adapter.searchAllFolders(undefined, { subject: "reunión" }, 2), { code: "QUERY_TOO_LARGE" });
  assert.deepEqual([...new Set(hidden.fetched.map((entry) => entry.folder))], ["A"]);
});

// --- Cross-folder shared UID-window budget ------------------------------------------------------

test("all-folder UID-window budget is shared across folders and fails closed", async () => {
  const single = await setup({ A: { rows: [], uidNext: 300_000 } }).adapter.searchAllFolders("token", undefined, 2);
  assert.equal(single.foldersSearched, 1);
  assert.deepEqual(single.messages, []);

  const shared = setup({ A: { rows: [], uidNext: 300_000 }, B: { rows: [], uidNext: 300_000 } });
  await assert.rejects(shared.adapter.searchAllFolders("token", undefined, 2), { code: "QUERY_TOO_LARGE" });
  // 293 windows for the first folder leave only 219 of the 512 shared windows for the second.
  assert.equal(shared.searches.length, 512);
  assert.equal(shared.searches.filter((entry) => entry.folder === "A").length, 293);
});

// --- Cross-folder aggregate metadata budget -----------------------------------------------------

test("all-folder aggregate metadata budget is shared across folders and counts nonmatches", async () => {
  // 32,000-character address names stay inside the 65,536-code-unit per-value cap and cost about
  // 64 KB of retained metadata per message.
  const metadataRows = (count: number) => rowsOf(count, { fromName: "x".repeat(32_000) });
  const one = await setup({ A: { rows: metadataRows(170) } }).adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(one.messages, []);
  assert.equal(one.truncated, false);

  const two = await setup({ A: { rows: metadataRows(170) }, B: { rows: metadataRows(170) } }).adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(two.messages, []);

  // 170 messages cost ~10.6 MiB, so two folders fit the 32 MiB aggregate budget while three
  // 180-message folders (~33.7 MiB) do not: the budget is shared, charged for nonmatches and
  // fails closed instead of returning a partial page.
  await assert.rejects(setup({ A: { rows: metadataRows(180) }, B: { rows: metadataRows(180) }, C: { rows: metadataRows(180) } }).adapter.searchAllFolders(undefined, { subject: "reunión" }, 2), { code: "QUERY_TOO_LARGE" });
});

test("all-folder metadata accounting ignores raw FETCH members the summary drops", async () => {
  // ~75 MB of wire metadata that the summary never keeps: bodyStructure, headers, labels, threadId,
  // and Sender/Bcc address lists. Charging the raw FETCH object (as the previous accounting did)
  // exhausted the budget after a handful of messages; the retained projection stays under 1 MiB.
  const bodyStructure = { part: "1", type: "text/plain", parameters: { charset: "utf-8", padding: "p".repeat(120_000) }, size: 1_024 };
  const headers = Buffer.alloc(64 * 1024, 0x61);
  const threadId = "t".repeat(4_096);
  const wireOnly = (row: Row): Record<string, unknown> => ({
    bodyStructure,
    headers,
    labels: ["\\Inbox", "\\Important"],
    threadId,
    envelope: { ...envelope(row), sender: [{ name: "s".repeat(60_000), address: "sender@example.test" }], bcc: [{ name: "b".repeat(60_000), address: "bcc@example.test" }] },
  });
  const specs: Record<string, FolderSpec> = {};
  for (let index = 0; index < 22; index++) specs[`Folder ${String(index).padStart(2, "0")}`] = { rows: rowsOf(14), discarded: wireOnly };
  const page = await setup(specs).adapter.searchAllFolders(undefined, { subject: "reunión" }, 10);
  assert.deepEqual(page.messages, []);
  assert.equal(page.truncated, false);
  assert.equal(page.foldersSearched, 22);
});

test("all-folder metadata accounting fails closed on an oversized retained header value", async () => {
  // 70,000 code units exceed the 65,536 per-retained-value cap even though they are only 140 KB.
  const oversized: Row[] = [
    { uid: 1, subject: "reunión " + "x".repeat(70_000) },
    { uid: 1, fromName: "x".repeat(70_000) },
    { uid: 1, references: ["<" + "r".repeat(70_000) + "@example.test>"] },
  ];
  for (const row of oversized) {
    await assert.rejects(setup({ A: { rows: [row] } }).adapter.searchAllFolders(undefined, { subject: "reunión" }, 2), (error: unknown) => error instanceof SafeError && error.code === "QUERY_TOO_LARGE" && /too large/.test(error.message));
  }

  // Just below the cap the same shape is charged exactly and completes.
  const near = await setup({ A: { rows: [{ uid: 1, subject: "reunión " + "x".repeat(60_000) }] } }).adapter.searchAllFolders(undefined, { subject: "reunión" }, 2);
  assert.deepEqual(near.messages.map((message) => message.uid), [1]);
});

// --- Absolute all-folder local-subject candidate budget -----------------------------------------

/** A realistic message: accented subject, Message-ID, date, one From, two To, one Cc, two flags and
 *  RFC822.SIZE, so the metadata charge reflects a real mailbox instead of a minimal fixture. */
function realisticRows(count: number, folderIndex: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    subject: `Re: Presupuesto Q3 - revisión de facturas y proveedores (borrador ${index})`,
    messageId: `<caf9b2f1.${folderIndex}.${index}@mail.example.test>`,
    date: new Date(Date.UTC(2026, 2, 14, 9, 31, 0) - index * 60_000),
    fromName: "Facturación Proveedores",
    from: "facturas@proveedor.example.test",
    to: [["Samuel", "samuel@example.test"], ["Administración", "admin@example.test"]],
    cc: [["Copias", "copias@example.test"]],
    flags: index % 2 === 0 ? ["\\Seen"] : ["\\Seen", "\\Flagged"],
    size: 48_213 + index,
  }));
}

function realisticSpecs(total: number, folderCount: number): Record<string, FolderSpec> {
  const specs: Record<string, FolderSpec> = {};
  const base = Math.floor(total / folderCount);
  const extra = total % folderCount;
  for (let index = 0; index < folderCount; index++) specs[`Folder ${String(index).padStart(2, "0")}`] = { rows: realisticRows(base + (index < extra ? 1 : 0), index) };
  return specs;
}

test("all-folder Unicode subject search completes a realistic 4,441-message mailbox across 22 folders", async () => {
  const page = await setup(realisticSpecs(4_441, 22)).adapter.searchAllFolders(undefined, { subject: "reunión" }, 10);
  assert.deepEqual(page.messages, []);
  assert.equal(page.truncated, false);
  assert.equal(page.foldersSearched, 22);
});

test("all-folder Unicode subject search completes 10,000 realistic candidates and fails closed above", async () => {
  // This fixture's retained metadata is ~14 MiB, so the scan cannot complete under the previous
  // 8 MiB budget; 32 MiB covers ~22,700 realistic messages, leaving margin at the 10,000 boundary.
  // 10,001 candidates then fail closed on the absolute candidate budget.
  const boundary = await setup(realisticSpecs(10_000, 22)).adapter.searchAllFolders(undefined, { subject: "reunión" }, 10);
  assert.deepEqual(boundary.messages, []);
  assert.equal(boundary.truncated, false);
  assert.equal(boundary.foldersSearched, 22);

  const over = setup(realisticSpecs(10_001, 22));
  await assert.rejects(over.adapter.searchAllFolders(undefined, { subject: "reunión" }, 10), (error: unknown) => error instanceof SafeError && error.code === "QUERY_TOO_LARGE" && /since\/before/.test(error.message));
  // The overflowing folder is never fetched: the bound is enforced on its UID list first.
  assert.equal(over.fetched.some((entry) => entry.folder === "Folder 21"), false);
});

test("all-folder Unicode subject scan fails closed when the deadline expires", async () => {
  const b = setup({ A: { rows: rowsOf(2) }, B: { rows: rowsOf(2) } });
  const adapter = new ImapFlowMailAdapter({ account, maxResults: 100, localSubjectScanDeadlineMs: 0, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => b.client });
  await assert.rejects(adapter.searchAllFolders(undefined, { subject: "reunión" }, 2), (error: unknown) => error instanceof SafeError && error.code === "QUERY_TOO_LARGE" && /deadline/.test(error.message));
  // No partial page and no provider search after the deadline: the guard runs before the first folder.
  assert.deepEqual(b.searches, []);
});

test("all-folder Unicode subject search with a since filter pushes the date down and deduplicates", async () => {
  const historical = new Date("2024-06-01T00:00:00Z");
  const recent = new Date("2026-06-01T00:00:00Z");
  const history = (prefix: string): Row[] => Array.from({ length: 600 }, (_, index) => ({ uid: index + 1, subject: "other", messageId: `<${prefix}-${index}@example.test>`, date: historical }));
  const specs: Record<string, FolderSpec> = {
    A: { rows: history("a") },
    B: { rows: [...history("b"), { uid: 601, subject: "reunión", messageId: "<shared@example.test>", date: recent }] },
    C: { rows: history("c") },
    // Same Message-ID as the B copy: deduplication must still collapse the pair across folders.
    D: { rows: [{ uid: 1, subject: "REUNIO\u0301N", messageId: "<d-match@example.test>", date: recent }, { uid: 2, subject: "reunión", messageId: "<shared@example.test>", date: recent }] },
  };
  const filters = { subject: "reunión", since: "2026-01-01" } as const;
  // 2,400 messages exist across four folders; an explicit date filter keeps the scan proportional
  // to what can match instead of examining all history.
  const unpaged = (await setup(specs).adapter.searchAllFolders(undefined, filters, 50)).messages;
  assert.deepEqual(unpaged.map((message) => `${message.folder}:${message.uid}`), ["B:601", "D:1"]);
  for (const limit of [1, 2]) {
    const seen = await allPages(setup(specs).adapter, limit, undefined, filters);
    assert.deepEqual(seen.map((message) => `${message.folder}:${message.uid}`), unpaged.map((message) => `${message.folder}:${message.uid}`), `limit ${limit}`);
    assert.equal(new Set(seen.map((message) => message.messageId)).size, seen.length);
  }

  const scanned = setup(specs);
  await scanned.adapter.searchAllFolders(undefined, filters, 50);
  // The date filter is pushed down: every folder search carries SINCE and only recent UIDs are fetched.
  assert.ok(scanned.searches.length > 0 && scanned.searches.every((entry) => entry.criteria.since instanceof Date));
  assert.ok(scanned.fetched.every((entry) => entry.uids.length <= 2), JSON.stringify(scanned.fetched));
});

// --- Fetch completion ---------------------------------------------------------------------------

test("all-folder search rejects a fetch that returns false after yielding every candidate", async () => {
  const local = setup({ A: { rows: [{ uid: 1, subject: "reunión" }] }, B: { rows: [{ uid: 1, subject: "reunión" }], fetch: "completeFalse" } });
  await assert.rejects(local.adapter.searchAllFolders(undefined, { subject: "reunión" }, 2), { code: "PROVIDER_UNAVAILABLE" });

  // The same completion contract applies when no local subject matching is involved.
  const remote = setup({ A: { rows: [{ uid: 1, subject: "urgent" }], fetch: "completeFalse" } });
  await assert.rejects(remote.adapter.searchAllFolders("urgent", undefined, 2), { code: "PROVIDER_UNAVAILABLE" });

  const empty = setup({ A: { rows: [{ uid: 1, subject: "urgent" }], fetch: "emptyFalse" } });
  await assert.rejects(empty.adapter.searchAllFolders("urgent", undefined, 2), { code: "PROVIDER_UNAVAILABLE" });
});

test("all-folder search fails closed on duplicate or missing candidates in any folder", async () => {
  await assert.rejects(setup({ A: { rows: [{ uid: 1, subject: "urgent" }] }, B: { rows: [{ uid: 1, subject: "urgent" }], fetch: "duplicate" } }).adapter.searchAllFolders("urgent", undefined, 2), { code: "PROVIDER_UNAVAILABLE" });
  await assert.rejects(setup({ A: { rows: [{ uid: 1, subject: "urgent" }, { uid: 2, subject: "urgent" }], fetch: "short" } }).adapter.searchAllFolders("urgent", undefined, 2), { code: "PROVIDER_UNAVAILABLE" });
});

// --- Matching before deduplication --------------------------------------------------------------

test("local subject matching is applied before Message-ID deduplication across folders", async () => {
  for (const [folderASubject, folderBSubject, expected] of [["other", "reunión", "B"], ["reunión", "other", "A"], ["reunión", "reunión", "A"]] as const) {
    const b = setup({ A: { rows: [{ uid: 1, subject: folderASubject, messageId: "<dup@example.test>" }] }, B: { rows: [{ uid: 1, subject: folderBSubject, messageId: "<dup@example.test>" }] } });
    const page = await b.adapter.searchAllFolders(undefined, { subject: "reunión" }, 10);
    assert.deepEqual(page.messages.map((message) => message.folder), [expected]);
    assert.equal(page.truncated, false);
  }

  // A nonmatching copy never consumes the deduplication slot of a later matching copy.
  const third = setup({ A: { rows: [{ uid: 1, subject: "other", messageId: "<dup@example.test>" }] }, B: { rows: [{ uid: 1, subject: "otro", messageId: "<dup@example.test>" }] }, C: { rows: [{ uid: 1, subject: "reunión", messageId: "<dup@example.test>" }] } });
  const page = await third.adapter.searchAllFolders(undefined, { subject: "reunión" }, 10);
  assert.deepEqual(page.messages.map((message) => `${message.folder}:${message.uid}`), ["C:1"]);
});

// --- Global pagination and cursor ---------------------------------------------------------------

test("folder ordering uses UTF-16 code units so ICU-collation-equal names cannot drop messages", async () => {
  const plain = "Ax";
  const softHyphen = "A\u00adx";
  assert.notEqual(plain, softHyphen);
  // Precondition for the regression: ICU collation treats the soft hyphen as ignorable, so
  // localeCompare reports distinct folder names as equal (and returns 0 in both directions).
  assert.equal(plain.localeCompare(softHyphen), 0);
  const date = new Date("2026-01-01T00:00:00Z");
  const folderRows = (prefix: string): Row[] => [1, 2].map((uid) => ({ uid, subject: "reunión", messageId: `<${prefix}${uid}@example.test>`, date }));
  const specs: Record<string, FolderSpec> = { [plain]: { rows: folderRows("p") }, [softHyphen]: { rows: folderRows("s") } };
  const filters = { subject: "reunión" } as const;
  const unpaged = (await setup(specs).adapter.searchAllFolders(undefined, filters, 50)).messages;
  assert.equal(unpaged.length, 4);
  for (const limit of [1, 2, 3]) {
    const seen = await allPages(setup(specs).adapter, limit, undefined, filters);
    // A collation-equal comparison used to filter every later page as "not after the cursor",
    // dropping the remaining folder and reporting truncated:false as if the page were complete.
    assert.deepEqual(seen.map((message) => `${message.folder}:${message.uid}`), unpaged.map((message) => `${message.folder}:${message.uid}`), `limit ${limit}`);
    assert.equal(new Set(seen.map((message) => message.messageId)).size, seen.length);
  }
});

test("global pagination is exhaustive across folders with duplicates, equal and missing dates", async () => {
  const specs: Record<string, FolderSpec> = {
    A: { rows: [
      { uid: 1, subject: "reunión", messageId: "<dup@example.test>", date: new Date("2026-01-01T00:00:00Z") },
      { uid: 2, subject: "reunión", messageId: "<a2@example.test>", date: new Date("2026-01-01T00:00:00Z") },
      { uid: 3, subject: "other", messageId: "<a3@example.test>" },
    ] },
    B: { rows: [
      { uid: 1, subject: "reunión", messageId: "<dup@example.test>", date: new Date("2026-01-01T00:00:00Z") },
      { uid: 2, subject: "reunión", messageId: "<b2@example.test>" },
      { uid: 3, subject: "other", messageId: "<b3@example.test>" },
    ] },
    C: { rows: [
      { uid: 1, subject: "reunión", messageId: "<c1@example.test>", date: "not-a-date" },
      { uid: 2, subject: "other", messageId: "<c2@example.test>", date: new Date("2026-01-02T00:00:00Z") },
    ] },
  };
  const expected = (await setup(specs).adapter.searchAllFolders(undefined, { subject: "reunión" }, 50)).messages;
  assert.deepEqual(expected.map((message) => `${message.folder}:${message.uid}`), ["A:2", "A:1", "B:2", "C:1"]);
  for (const limit of [1, 2, 3]) {
    const seen = await allPages(setup(specs).adapter, limit, undefined, { subject: "reunión" });
    assert.deepEqual(seen.map((message) => `${message.folder}:${message.uid}`), expected.map((message) => `${message.folder}:${message.uid}`));
    assert.equal(new Set(seen.map((message) => message.messageId)).size, seen.length);
  }
});

test("global cursor is bound to the combined query and structured filters", async () => {
  const specs: Record<string, FolderSpec> = {
    A: { rows: [{ uid: 1, subject: "urgent reunión", messageId: "<a1@example.test>", from: "a@example.test", read: true, date: new Date("2026-01-03T00:00:00Z") }, { uid: 2, subject: "urgent reunión", messageId: "<a2@example.test>", from: "a@example.test", read: true, date: new Date("2026-01-02T00:00:00Z") }] },
    B: { rows: [{ uid: 1, subject: "urgent reunión", messageId: "<b1@example.test>", from: "a@example.test", read: true, date: new Date("2026-01-01T00:00:00Z") }] },
  };
  const filters = { subject: "reunión", from: "a@example.test", isRead: true } as const;
  const b = setup(specs);
  const first = await b.adapter.searchAllFolders("urgent", filters, 1);
  assert.deepEqual(first.messages.map((message) => message.messageId), ["<a1@example.test>"]);
  const cursor = first.nextCursor!;
  for (const [query, changed] of [["urgent ", filters], ["urgent", { ...filters, from: "b@example.test" }], ["urgent", { ...filters, isRead: false }], ["urgent", { ...filters, subject: "reunion" }]] as const) {
    await assert.rejects(b.adapter.searchAllFolders(query, changed, 1, cursor), { code: "REFERENCE_INVALID" });
  }
  const second = await b.adapter.searchAllFolders("urgent", filters, 1, cursor);
  assert.deepEqual(second.messages.map((message) => message.messageId), ["<a2@example.test>"]);
});

test("global cursor rejects a generation change in any searched folder", async () => {
  const b = setup({ A: { rows: [{ uid: 1, subject: "reunión", messageId: "<a@example.test>", date: new Date("2026-01-01T00:00:00Z") }] }, B: { rows: [{ uid: 1, subject: "reunión", messageId: "<b@example.test>", date: new Date("2026-01-01T00:00:00Z") }] } });
  const first = await b.adapter.searchAllFolders(undefined, { subject: "reunión" }, 1);
  assert.ok(first.nextCursor);
  b.specs.B!.uidNext = 3;
  await assert.rejects(b.adapter.searchAllFolders(undefined, { subject: "reunión" }, 1, first.nextCursor), { code: "REFERENCE_STALE" });
});

test("service exposes global Unicode pagination without leaking internal fields", async () => {
  const base = fixture();
  const b = setup({ A: { rows: [{ uid: 1, subject: "reunión", messageId: "<a@example.test>", date: new Date("2026-01-03T00:00:00Z") }] }, B: { rows: [{ uid: 1, subject: "reunión", messageId: "<b@example.test>", date: new Date("2026-01-02T00:00:00Z") }] } });
  const service = new MailGatewayService(base.accounts, base.repo, new Map([["acct", { imap: b.adapter, smtp: new FakeSmtpAdapter() }]]), 100, 25_000_000, 100);
  const context = { caller: "Hermes main" as const, correlationId: "global-pages" };
  try {
    const input: MailQueryInput = { accountId: "acct", operation: "search", searchScope: "allFolders", search: { subject: "reunión" }, limit: 1 };
    type Page = { messages: Array<Record<string, unknown>>; truncated: boolean; foldersSearched: number; nextCursor?: string };
    const first = await service.mailQuery(input, context) as Page;
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    assert.equal(first.foldersSearched, 2);
    assert.equal(first.messages[0]?.messageId, "<a@example.test>");
    assert.ok(!("uidValidity" in (first.messages[0] ?? {})) && !("searchUidNext" in (first.messages[0] ?? {})));
    const second = await service.mailQuery({ ...input, cursor: first.nextCursor }, context) as Page;
    assert.equal(second.truncated, false);
    assert.equal(second.messages[0]?.messageId, "<b@example.test>");
    await assert.rejects(service.mailQuery({ ...input, search: { subject: "reuniones" }, cursor: first.nextCursor }, context), { code: "REFERENCE_INVALID" });
  } finally { base.db.close(); }
});

// --- Combined criteria --------------------------------------------------------------------------

test("combined query and filters are evaluated server-side while the Unicode subject stays local", async () => {
  const a = setup({ A: { rows: [
    { uid: 1, subject: "urgent reunión", messageId: "<a1@example.test>", from: "a@example.test", read: true },
    { uid: 2, subject: "urgent reunión", messageId: "<a2@example.test>", from: "b@example.test", read: true },
    { uid: 3, subject: "urgent reunión", messageId: "<a3@example.test>", from: "a@example.test", read: false },
    { uid: 4, subject: "urgent other", messageId: "<a4@example.test>", from: "a@example.test", read: true },
  ] }, B: { rows: [{ uid: 1, subject: "urgent reunión", messageId: "<b1@example.test>", from: "a@example.test", read: true }] } });
  const filters = { subject: "reunión", from: "a@example.test", isRead: true } as const;
  const page = await a.adapter.searchAllFolders("urgent", filters, 10);
  assert.deepEqual(page.messages.map((message) => `${message.folder}:${message.uid}`), ["A:1", "B:1"]);
  assert.deepEqual(a.searches[0]!.criteria, { or: [{ text: "urgent" }, { subject: "urgent" }, { header: { Subject: "urgent" } }], from: "a@example.test", seen: true, uid: "1:4" });
  assert.equal("subject" in a.searches[0]!.criteria, false);

  const single = setup({ Inbox: { rows: [{ uid: 1, subject: "urgent reunión", messageId: "<s1@example.test>", from: "a@example.test", read: true }] } });
  const results = await single.adapter.searchWithFilters("Inbox", "urgent", filters, 10);
  assert.deepEqual(results.map((message) => message.uid), [1]);
  assert.deepEqual(single.searches[0]!.criteria, { or: [{ text: "urgent" }, { subject: "urgent" }, { header: { Subject: "urgent" } }], from: "a@example.test", seen: true, uid: "1:1" });
});

test("all-folder search rejects a request with no query and no useful filter", async () => {
  await assert.rejects(setup({ A: { rows: [] } }).adapter.searchAllFolders(undefined, undefined, 2), { code: "INVALID_INPUT" });
});

test("all-folder search fails closed when a provider search result is incomplete", async () => {
  for (const searchMode of ["false", "undefined"] as const) {
    const b = setup({ A: { rows: [{ uid: 1, subject: "urgent" }] }, B: { rows: [{ uid: 1, subject: "urgent" }], searchMode } });
    await assert.rejects(b.adapter.searchAllFolders("urgent", undefined, 2), { code: "PROVIDER_UNAVAILABLE" });
  }
});

test("all-folder search skips non-selectable folders without counting them as searched", async () => {
  const b = setup({ A: { rows: [{ uid: 1, subject: "urgent", messageId: "<a@example.test>" }] }, Trash: { rows: [{ uid: 1, subject: "urgent", messageId: "<t@example.test>" }], noselect: true } });
  const page = await b.adapter.searchAllFolders("urgent", undefined, 10);
  assert.deepEqual(page.messages.map((message) => message.folder), ["A"]);
  assert.equal(page.foldersSearched, 1);
  assert.deepEqual(b.searches.map((entry) => entry.folder), ["A"]);
  assert.deepEqual(b.fetched.map((entry) => entry.folder), ["A"]);
});

test("combined Message-ID criteria survive alongside the query and local subject match", async () => {
  const b = setup({ A: { rows: [
    { uid: 1, subject: "urgent reunión", messageId: "<wanted@example.test>", from: "a@example.test", read: true },
    { uid: 2, subject: "urgent reunión other", messageId: "<other@example.test>", from: "a@example.test", read: true },
  ] } });
  const page = await b.adapter.searchAllFolders("urgent", { subject: "reunión", messageId: "<wanted@example.test>" }, 10);
  assert.deepEqual(page.messages.map((message) => message.uid), [1]);
  assert.deepEqual(b.searches[0]!.criteria, { or: [{ text: "urgent" }, { subject: "urgent" }, { header: { Subject: "urgent" } }], header: { "Message-ID": "<wanted@example.test>" }, uid: "1:2" });
});

test("global cursor pagination matches the unpaged order for deterministic random fixtures", async () => {
  let state = 0x5eed;
  const random = (): number => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const subjects = ["reunión", "REUNIO\u0301N", "reunion", "other"] as const;
  const dates = [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"), undefined, "invalid"] as const;
  for (let seed = 0; seed < 30; seed++) {
    const specs: Record<string, FolderSpec> = {};
    for (const folder of ["A", "B", "C"]) {
      const count = Math.floor(random() * 8);
      const rows: Row[] = [];
      for (let index = 0; index < count; index++) {
        const subject = subjects[Math.floor(random() * subjects.length)];
        const date = dates[Math.floor(random() * dates.length)];
        rows.push({ uid: index + 1, ...(subject === undefined ? {} : { subject }), messageId: random() < 0.2 ? "<shared@example.test>" : `<${folder}-${index}@example.test>`, ...(date === undefined ? {} : { date }) });
      }
      specs[folder] = { rows, ...(random() < 0.3 ? { uidNext: Math.floor(random() * 100_000) + 1 } : {}) };
    }
    const unpaged = (await setup(specs).adapter.searchAllFolders(undefined, { subject: "reunión" }, 100)).messages;
    for (const limit of [1, 2, 3, 5]) {
      const paged = await allPages(setup(specs).adapter, limit, undefined, { subject: "reunión" });
      assert.deepEqual(paged.map((message) => `${message.folder}:${message.uid}`), unpaged.map((message) => `${message.folder}:${message.uid}`), `seed ${seed} limit ${limit}`);
      assert.equal(new Set(paged.map((message) => message.messageId)).size, paged.length);
    }
  }
});

test("global cursor is bound to the account and every folder generation", async () => {
  const specs: Record<string, FolderSpec> = { A: { rows: [{ uid: 1, subject: "reunión", messageId: "<a@example.test>", date: new Date("2026-01-02T00:00:00Z") }] }, B: { rows: [{ uid: 1, subject: "reunión", messageId: "<b@example.test>", date: new Date("2026-01-01T00:00:00Z") }] } };
  const b = setup(specs);
  const first = await b.adapter.searchAllFolders(undefined, { subject: "reunión" }, 1);
  const cursor = first.nextCursor!;
  assert.ok(cursor);

  const other = new ImapFlowMailAdapter({ account: { ...account, accountId: "other" }, maxResults: 100, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => b.client });
  await assert.rejects(other.searchAllFolders(undefined, { subject: "reunión" }, 1, cursor), { code: "REFERENCE_INVALID" });

  b.specs.A!.uidValidity = 2;
  await assert.rejects(b.adapter.searchAllFolders(undefined, { subject: "reunión" }, 1, cursor), { code: "REFERENCE_STALE" });
});
