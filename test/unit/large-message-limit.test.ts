import assert from "node:assert/strict";
import test from "node:test";
import { serverConfigSchema } from "../../src/config/model.js";

const config = (maxReadBytes: number) => ({ databasePath: "/tmp/mail.db", attachmentRoots: [], accounts: [], limits: { maxRecipients: 10, maxAttachmentBytes: 1_000_000, maxReadBytes } });

test("full-message read limit permits up to 25 MB but no more", () => {
  assert.equal(serverConfigSchema.safeParse(config(25_000_000)).success, true);
  assert.equal(serverConfigSchema.safeParse(config(25_000_001)).success, false);
});
