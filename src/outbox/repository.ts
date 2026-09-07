import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SafeError } from "../errors.js";
import type { OutboxState, PreparedMessage } from "../domain/types.js";
import { redact } from "../observability/redaction.js";
const transitions: Record<OutboxState, readonly OutboxState[]> = {
  PREPARED: ["SEND_ATTEMPTED", "FAILED_PERMANENT", "CANCELLED"], SEND_ATTEMPTED: ["SENT_UNVERIFIED", "SENT_VERIFIED", "FAILED_PERMANENT", "OUTCOME_UNKNOWN"],
  SENT_UNVERIFIED: ["SENT_VERIFIED", "OUTCOME_UNKNOWN", "FAILED_RETRY_BLOCKED"], OUTCOME_UNKNOWN: ["SENT_VERIFIED", "FAILED_RETRY_BLOCKED"],
  SENT_VERIFIED: [], FAILED_PERMANENT: [], FAILED_RETRY_BLOCKED: [], CANCELLED: []
};
const now = () => new Date().toISOString();
export interface PrepareInput { accountId: string; idempotencyKey: string; fromAddress: string; recipients: readonly string[]; subject: string; textBody?: string; htmlBody?: string; attachments: readonly unknown[]; rawMime: Buffer; requestDigest: string; messageId: string; messageIdHeader: string; audit?: { correlationId: string; caller: string; tool: string; metadata: unknown }; }
export class OutboxRepository {
  constructor(private readonly db: Database.Database) {}
  prepare(input: PrepareInput): PreparedMessage {
    const existing = this.db.prepare("SELECT message_id, request_digest FROM idempotency_keys WHERE account_id = ? AND idempotency_key = ?").get(input.accountId, input.idempotencyKey) as { message_id: string; request_digest: string } | undefined;
    if (existing) { if (existing.request_digest !== input.requestDigest) throw new SafeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request."); return this.get(existing.message_id); }
    const created = now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("INSERT INTO outbox_messages(message_id, account_id, idempotency_key, message_id_header, from_address, recipients, subject, text_body, html_body, attachment_manifest, raw_mime, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)").run(input.messageId, input.accountId, input.idempotencyKey, input.messageIdHeader, input.fromAddress, JSON.stringify(input.recipients), input.subject, input.textBody ?? null, input.htmlBody ?? null, JSON.stringify(input.attachments), input.rawMime, created, created);
      this.db.prepare("INSERT INTO idempotency_keys(account_id, idempotency_key, message_id, request_digest, created_at) VALUES (?, ?, ?, ?, ?)").run(input.accountId, input.idempotencyKey, input.messageId, input.requestDigest, created);
      if (input.audit) this.db.prepare("INSERT INTO audit_events(event_id, correlation_id, caller, tool, account_id, message_id, old_state, new_state, outcome_code, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'PREPARED', 'OK', ?, ?)").run(randomUUID(), input.audit.correlationId, input.audit.caller, input.audit.tool, input.accountId, input.messageId, JSON.stringify(redact(input.audit.metadata)), created);
    });
    try { transaction(); } catch (error) { if (error instanceof Error && error.message.includes("UNIQUE")) throw new SafeError("IDEMPOTENCY_CONFLICT", "Idempotency key was concurrently reused."); throw error; }
    return this.get(input.messageId);
  }
  get(messageId: string): PreparedMessage { const row = this.db.prepare("SELECT * FROM outbox_messages WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined; if (!row) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found."); return this.map(row); }
  getRawMime(messageId: string): Buffer { const row = this.db.prepare("SELECT raw_mime FROM outbox_messages WHERE message_id = ?").get(messageId) as { raw_mime: Buffer } | undefined; if (!row) throw new SafeError("MESSAGE_NOT_FOUND", "Message was not found."); return Buffer.from(row.raw_mime); }
  transition(messageId: string, next: OutboxState, evidence?: string): PreparedMessage {
    const current = this.get(messageId); if (!transitions[current.state].includes(next)) throw new SafeError("STATE_CONFLICT", `Transition from ${current.state} to ${next} is not permitted.`);
    this.db.prepare("UPDATE outbox_messages SET state = ?, provider_evidence = COALESCE(?, provider_evidence), updated_at = ? WHERE message_id = ?").run(next, evidence ?? null, now(), messageId); return this.get(messageId);
  }
  claim(messageId: string, owner: string, leaseMs: number, at = now()): PreparedMessage {
    const until = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = this.db.prepare("UPDATE outbox_messages SET state = 'SEND_ATTEMPTED', attempt_owner = ?, lease_until = ?, updated_at = ? WHERE message_id = ? AND state = 'PREPARED' AND (lease_until IS NULL OR lease_until < ?)").run(owner, until, at, messageId, at);
    if (result.changes !== 1) { const current = this.get(messageId); throw new SafeError(current.state === "SEND_ATTEMPTED" ? "EXECUTION_IN_PROGRESS" : "STATE_CONFLICT", "Message cannot be claimed for execution."); }
    return this.get(messageId);
  }
  appendAudit(event: { correlationId: string; caller: string; tool: string; accountId?: string; messageId?: string; oldState?: string; newState?: string; outcomeCode: string; metadata: unknown }): void { this.db.prepare("INSERT INTO audit_events(event_id, correlation_id, caller, tool, account_id, message_id, old_state, new_state, outcome_code, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), event.correlationId, event.caller, event.tool, event.accountId ?? null, event.messageId ?? null, event.oldState ?? null, event.newState ?? null, event.outcomeCode, JSON.stringify(redact(event.metadata)), now()); }
  private map(row: Record<string, unknown>): PreparedMessage { return { messageId: row.message_id as string, accountId: row.account_id as string, idempotencyKey: row.idempotency_key as string, messageIdHeader: row.message_id_header as string, fromAddress: row.from_address as string, recipients: JSON.parse(row.recipients as string) as string[], subject: row.subject as string, ...(row.text_body === null ? {} : { textBody: row.text_body as string }), ...(row.html_body === null ? {} : { htmlBody: row.html_body as string }), attachments: JSON.parse(row.attachment_manifest as string) as never[], state: row.state as OutboxState }; }
}
