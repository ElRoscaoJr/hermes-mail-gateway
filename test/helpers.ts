import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/outbox/database.js";
import { AccountRepository } from "../src/outbox/accounts.js";
import { OutboxRepository } from "../src/outbox/repository.js";
export interface TestFixture { dir: string; db: Database.Database; accounts: AccountRepository; repo: OutboxRepository; }
export function fixture(): TestFixture { const dir = mkdtempSync(join(tmpdir(), "hermes-")); const db = openDatabase(join(dir, "test.db")); const accounts = new AccountRepository(db); accounts.upsert({ accountId: "acct", displayName: "Synthetic", providerKind: "generic_imap_smtp", imapEndpoint: "imap://localhost", smtpEndpoint: "smtp://localhost", credentialRef: "keychain:test", sentPolicy: "provider_managed", enabled: true, allowedSender: "sender@example.test", allowedAttachmentRoots: [dir] }); return { dir, db, accounts, repo: new OutboxRepository(db) }; }
export function input(overrides: Partial<Parameters<OutboxRepository["prepare"]>[0]> = {}) { return { accountId: "acct", idempotencyKey: "idem-123456", fromAddress: "sender@example.test", recipients: ["recipient@example.test"], subject: "Synthetic", textBody: "hello", attachments: [], rawMime: Buffer.from("stored raw mime"), requestDigest: "digest-a", messageId: "message-a", messageIdHeader: "<message-a@hermes-mail-gateway.local>", ...overrides }; }
export function file(dir: string, name: string, contents: string): string { const path = join(dir, name); writeFileSync(path, contents); return path; }
