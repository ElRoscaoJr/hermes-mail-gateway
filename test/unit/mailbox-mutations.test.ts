import test from "node:test";
import assert from "node:assert/strict";
import { ImapFlowMailAdapter, type ImapFlowClient, type MailboxMutationType } from "../../src/mail/adapters.js";
import type { AccountProjection } from "../../src/domain/types.js";

const account: AccountProjection = { accountId: "mutation-test", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imaps://imap.example.test", smtpEndpoint: "smtp://smtp.example.test", credentialRef: "keychain:synthetic/test", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [], inboxFolder: "Inbox", sentFolder: "Sent" };
function reference(folder = "Inbox", uidValidity = 10) { return Buffer.from(JSON.stringify({ accountId: account.accountId, folder, uid: 7, uidValidity })).toString("base64url"); }
function fixture() {
  const events: string[] = [];
  let selected = "";
  const state = { destinationGeneration: 20 as number | bigint, mappingGeneration: 20 as number | bigint | undefined, mappedUid: 42 as number | undefined, destinationUid: 42 as number | false, failDestinationLock: false, providerFailure: false, flags: new Set(["\\Seen"]) };
  const client: ImapFlowClient & { mailbox: { uidValidity: number | bigint } } = {
    mailbox: { uidValidity: 10 }, connect: async () => { events.push("connect"); }, logout: async () => { events.push("logout"); }, close: () => { events.push("close"); },
    list: async () => [{ path: "Trash", name: "Trash", pathAsListed: "Trash", delimiter: "/", parent: [], parentPath: "", flags: new Set(), specialUse: "\\Trash", listed: true, subscribed: true }],
    getMailboxLock: async (folder) => {
      events.push(`lock:${folder}`);
      if (folder === "Archive" && state.failDestinationLock) throw new Error("synthetic provider private transcript");
      selected = folder; client.mailbox.uidValidity = folder === "Inbox" || folder === "Trash" ? 10 : state.destinationGeneration;
      return { release: () => { events.push(`release:${folder}`); } };
    },
    search: async () => [], fetch: async function* () {},
    fetchOne: async (uid, query, options) => {
      events.push(`fetch:${selected}:${uid}`); assert.equal(query.uid, true); assert.equal(options?.uid, true);
      if (state.providerFailure) throw new Error("synthetic provider private transcript");
      if (state.destinationUid === false) return false;
      return { seq: 1, uid: state.destinationUid, flags: state.flags };
    },
    messageCopy: async (uid, destination, options) => { events.push(`copy:${uid}:${destination}`); assert.equal(options?.uid, true); return { uidMap: state.mappedUid === undefined ? new Map() : new Map([[uid, state.mappedUid]]), uidValidity: state.mappingGeneration }; },
    messageMove: async (uid, destination, options) => { events.push(`move:${uid}:${destination}`); assert.equal(options?.uid, true); return { uidMap: state.mappedUid === undefined ? new Map() : new Map([[uid, state.mappedUid]]), uidValidity: state.mappingGeneration }; },
    messageFlagsAdd: async (_uid, flags) => { for (const flag of flags) state.flags.add(flag); state.destinationUid = 7; },
    messageFlagsRemove: async (_uid, flags) => { for (const flag of flags) state.flags.delete(flag); state.destinationUid = 7; },
  };
  const adapter = new ImapFlowMailAdapter({ account, credentials: { get: async () => ({ username: "synthetic", password: "synthetic" }) }, clientFactory: () => client });
  return { adapter, state, events, client };
}

for (const type of ["copy", "move", "trash", "restore"] as const) {
  test(`${type} releases the source lock before locking its resolved destination`, async () => {
    const { adapter, events, state } = fixture();
    const source = type === "restore" ? "Trash" : "Inbox";
    const destination = type === "trash" ? "Trash" : type === "restore" ? "Inbox" : "Archive";
    if (destination !== "Archive") state.mappingGeneration = 10;
    await adapter.mutate({ type, messageReference: reference(source), destinationFolder: "Archive" });
    const released = events.indexOf(`release:${source}`);
    const locked = events.lastIndexOf(`lock:${destination}`);
    assert.ok(released >= 0 && locked > released, JSON.stringify(events));
    assert.equal(events.filter((event) => event === `release:${source}`).length, 1);
    assert.equal(events.at(-3), `release:${destination}`);
  });
}

for (const generation of [21, 0, 4_294_967_296, Number.NaN, 21n]) {
  test(`destination generation ${String(generation)} cannot confirm UIDPLUS generation 20`, async () => {
    const { adapter, state, events } = fixture();
    state.destinationGeneration = generation;
    await assert.rejects(adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE" });
    assert.equal(events.at(-3), "release:Archive");
    assert.ok(!events.some((event) => event.startsWith("fetch:")));
  });
}

for (const type of ["copy", "move", "trash", "restore"] as const) {
  for (const uid of [false, 41] as const) {
    test(`${type} refuses success when destination readback is ${String(uid)}`, async () => {
      const { adapter, state, events } = fixture();
      const source = type === "restore" ? "Trash" : "Inbox";
      const destination = type === "trash" ? "Trash" : type === "restore" ? "Inbox" : "Archive";
      if (destination !== "Archive") state.mappingGeneration = 10;
      state.destinationUid = uid;
      await assert.rejects(adapter.mutate({ type, messageReference: reference(source), destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE" });
      assert.ok(events.includes(`fetch:${destination}:42`));
      assert.equal(events.at(-3), `release:${destination}`);
    });
  }
}

test("destination flags come from exact UID readback", async () => {
  const { adapter, events } = fixture();
  const result = await adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" });
  assert.deepEqual(result.flags, ["\\Seen"]);
  assert.ok(events.includes("fetch:Archive:42"));
});

test("copy returns a reference bound to the destination mailbox", async () => {
  const { adapter } = fixture();
  const result = await adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" });
  assert.equal(result.folder, "Archive");
  assert.deepEqual(JSON.parse(Buffer.from(result.reference, "base64url").toString()), { accountId: account.accountId, folder: "Archive", uid: 42, uidValidity: 20 });
});

// Regression coverage for existing fail-closed validation and cleanup seams.
for (const uid of [undefined, 0, -1, 1.5, 4_294_967_296, Number.NaN]) {
  test(`invalid UIDPLUS destination UID ${String(uid)} fails closed`, async () => {
    const { adapter, state, events } = fixture(); state.mappedUid = uid;
    await assert.rejects(adapter.mutate({ type: "move", messageReference: reference(), destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE" });
    assert.ok(!events.includes("lock:Archive")); assert.equal(events.at(-3), "release:Inbox");
  });
}
for (const generation of [undefined, 0, 1.5, 4_294_967_296, 4_294_967_296n]) {
  test(`invalid UIDPLUS generation ${String(generation)} fails closed`, async () => {
    const { adapter, state, events } = fixture(); state.mappingGeneration = generation;
    await assert.rejects(adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE" });
    assert.ok(!events.includes("lock:Archive")); assert.equal(events.at(-3), "release:Inbox");
  });
}
for (const phase of ["lock", "readback"] as const) {
  test(`destination ${phase} error remains sanitized with cleanup`, async () => {
    const { adapter, state, events } = fixture();
    if (phase === "lock") state.failDestinationLock = true; else state.providerFailure = true;
    await assert.rejects(adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" }), { code: "PROVIDER_UNAVAILABLE", message: "The IMAP provider is unavailable." });
    assert.equal(events.filter((event) => event === "release:Inbox").length, 1);
    assert.equal(events.filter((event) => event === "release:Archive").length, phase === "lock" ? 0 : 1);
    assert.deepEqual(events.slice(-2), ["logout", "close"]);
  });
}
test("stale source generation prevents mutation", async () => {
  const { adapter, events } = fixture();
  await assert.rejects(adapter.mutate({ type: "move", messageReference: reference("Inbox", 9), destinationFolder: "Archive" }), { code: "REFERENCE_STALE" });
  assert.ok(!events.some((event) => event.startsWith("move:"))); assert.equal(events.at(-3), "release:Inbox");
});
test("matching bigint UIDPLUS generation is accepted", async () => {
  const { adapter, state } = fixture(); state.mappingGeneration = 20n; state.destinationGeneration = 20n;
  assert.equal((await adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Archive" })).uid, 42);
});
test("same-folder copy releases and reacquires its mailbox lock", async () => {
  const { adapter, state, events } = fixture(); state.mappingGeneration = 10;
  const result = await adapter.mutate({ type: "copy", messageReference: reference(), destinationFolder: "Inbox" });
  assert.equal(result.folder, "Inbox");
  assert.deepEqual(events, ["connect", "lock:Inbox", "copy:7:Inbox", "release:Inbox", "lock:Inbox", "fetch:Inbox:42", "release:Inbox", "logout", "close"]);
});
for (const type of ["markRead", "markUnread", "addFlag", "removeFlag"] as const satisfies readonly MailboxMutationType[]) {
  test(`${type} retains source readback without a second mailbox lock`, async () => {
    const { adapter, events } = fixture();
    const result = await adapter.mutate({ type, messageReference: reference(), flag: "\\Flagged" });
    assert.equal(result.folder, "Inbox"); assert.equal(result.uid, 7);
    assert.equal(result.flags.includes(type === "markRead" || type === "markUnread" ? "\\Seen" : "\\Flagged"), type === "markRead" || type === "addFlag");
    assert.deepEqual(events, ["connect", "lock:Inbox", "fetch:Inbox:7", "release:Inbox", "logout", "close"]);
  });
}
