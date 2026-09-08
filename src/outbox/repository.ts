import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SafeError } from "../errors.js";
import type { DraftSaveStatus, OutboxState, PreparedMessage } from "../domain/types.js";
import { redact } from "../observability/redaction.js";
const transitions: Record<OutboxState, readonly OutboxState[]> = {
  PREPARED: ["SEND_ATTEMPTED", "FAILED_PERMANENT", "CANCELLED"], SEND_ATTEMPTED: ["SENT_UNVERIFIED", "SENT_VERIFIED", "FAILED_PERMANENT", "OUTCOME_UNKNOWN"],
  SENT_UNVERIFIED: ["SENT_VERIFIED", "OUTCOME_UNKNOWN", "FAILED_RETRY_BLOCKED"], OUTCOME_UNKNOWN: ["SENT_VERIFIED", "FAILED_RETRY_BLOCKED"],
  SENT_VERIFIED: [], FAILED_PERMANENT: [], FAILED_RETRY_BLOCKED: [], CANCELLED: []
};
const now = () => new Date().toISOString();
export interface PrepareInput { accountId: string; idempotencyKey: string; intent?: "send" | "draft"; fromAddress: string; recipients: readonly string[]; cc?: readonly string[]; bcc?: readonly string[]; replyTo?: string; inReplyTo?: string; references?: readonly string[]; forwarding?: { originalMessageReference: string; originalMessageId?: string; originalSubject?: string }; subject: string; textBody?: string; htmlBody?: string; attachments: readonly unknown[]; rawMime: Buffer; requestDigest: string; messageId: string; messageIdHeader: string; audit?: { correlationId: string; caller: string; tool: string; metadata: unknown }; }
export class OutboxRepository {
  constructor(private readonly db: Database.Database) {}
  findByIdempotencyKey(accountId: string, idempotencyKey: string): { messageId: string; requestDigest: string } | undefined { const row = this.db.prepare("SELECT message_id, request_digest FROM idempotency_keys WHERE account_id = ? AND idempotency_key = ?").get(accountId, idempotencyKey) as { message_id: string; request_digest: string } | undefined; return row ? { messageId: row.message_id, requestDigest: row.request_digest } : undefined; }
  prepare(input: PrepareInput): PreparedMessage {
    const existing = this.db.prepare("SELECT message_id, request_digest FROM idempotency_keys WHERE account_id = ? AND idempotency_key = ?").get(input.accountId, input.idempotencyKey) as { message_id: string; request_digest: string } | undefined;
    if (existing) { if (existing.request_digest !== input.requestDigest) throw new SafeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request."); return this.get(existing.message_id); }
    const created = now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("INSERT INTO outbox_messages(message_id, account_id, idempotency_key, message_id_header, from_address, recipients, cc, bcc, reply_to, in_reply_to, references_header, forwarding_metadata, subject, text_body, html_body, attachment_manifest, raw_mime, intent, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)").run(input.messageId, input.accountId, input.idempotencyKey, input.messageIdHeader, input.fromAddress, JSON.stringify(input.recipients), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []), input.replyTo ?? null, input.inReplyTo ?? null, JSON.stringify(input.references ?? []), input.forwarding === undefined ? null : JSON.stringify(input.forwarding), input.subject, input.textBody ?? null, input.htmlBody ?? null, JSON.stringify(input.attachments), input.rawMime, input.intent ?? "send", created, created);
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
  confirmSent(messageId: string, evidence = "exact Message-ID found in Sent"): PreparedMessage {
    const at = now();
    const result = this.db.prepare("UPDATE outbox_messages SET state = 'SENT_VERIFIED', provider_evidence = COALESCE(?, provider_evidence), updated_at = ? WHERE message_id = ? AND state IN ('PREPARED', 'SEND_ATTEMPTED', 'SENT_UNVERIFIED', 'OUTCOME_UNKNOWN')").run(evidence, at, messageId);
    if (result.changes === 1) return this.get(messageId);
    const current = this.get(messageId);
    if (current.state === "SENT_VERIFIED") return current;
    throw new SafeError("STATE_CONFLICT", `Confirmation from ${current.state} is not permitted.`);
  }
  beginDraftSave(messageId: string): PreparedMessage {
    const current = this.get(messageId);
    if (current.intent !== "draft") throw new SafeError("STATE_CONFLICT", "Only prepared draft messages can be saved as drafts.");
    if (current.state !== "PREPARED") throw new SafeError("STATE_CONFLICT", "Only a durable PREPARED draft can be saved.");
    if (current.draftSaveStatus === "SAVED") return current;
    if (current.draftSaveStatus === "APPEND_STARTED") throw new SafeError("DRAFT_SAVE_VERIFICATION_REQUIRED", "Draft provider state requires verification; the draft will not be appended again.");
    this.db.prepare("UPDATE outbox_messages SET draft_save_status = 'APPEND_STARTED', updated_at = ? WHERE message_id = ? AND intent = 'draft' AND state = 'PREPARED' AND draft_save_status = 'NOT_SAVED'").run(now(), messageId);
    return this.get(messageId);
  }
  confirmDraftSaved(messageId: string, result: { reference: string; folder: string; uid: number; uidValidity: number }): PreparedMessage {
    const current = this.get(messageId);
    if (current.draftSaveStatus === "SAVED") return current;
    if (current.intent !== "draft" || current.state !== "PREPARED" || current.draftSaveStatus !== "APPEND_STARTED") throw new SafeError("STATE_CONFLICT", "Draft save confirmation is not permitted for this message.");
    this.db.prepare("UPDATE outbox_messages SET draft_save_status = 'SAVED', draft_provider_reference = ?, draft_folder = ?, draft_uid = ?, draft_uid_validity = ?, provider_evidence = ?, updated_at = ? WHERE message_id = ? AND draft_save_status = 'APPEND_STARTED'").run(result.reference, result.folder, result.uid, result.uidValidity, "exact Message-ID and \\Draft flag confirmed", now(), messageId);
    return this.get(messageId);
  }
  claim(messageId: string, owner: string, leaseMs: number, at = now()): PreparedMessage {
    const until = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = this.db.prepare("UPDATE outbox_messages SET state = 'SEND_ATTEMPTED', attempt_owner = ?, lease_until = ?, updated_at = ? WHERE message_id = ? AND state = 'PREPARED' AND (lease_until IS NULL OR lease_until < ?)").run(owner, until, at, messageId, at);
    if (result.changes !== 1) { const current = this.get(messageId); throw new SafeError(current.state === "SEND_ATTEMPTED" ? "EXECUTION_IN_PROGRESS" : "STATE_CONFLICT", "Message cannot be claimed for execution."); }
    return this.get(messageId);
  }
  /** Moves expired execution leases to verification-required OUTCOME_UNKNOWN without resubmitting SMTP. */
  reconcileExpiredLeases(at = now()): number {
    const rows = this.db.prepare("SELECT message_id, account_id, attempt_owner, lease_until FROM outbox_messages WHERE state = 'SEND_ATTEMPTED' AND lease_until IS NOT NULL AND lease_until < ?").all(at) as Array<{ message_id: string; account_id: string; attempt_owner: string | null; lease_until: string }>;
    if (rows.length === 0) return 0;
    const reconcile = this.db.transaction(() => {
      let count = 0;
      for (const row of rows) {
        const result = this.db.prepare("UPDATE outbox_messages SET state = 'OUTCOME_UNKNOWN', provider_evidence = COALESCE(provider_evidence, 'recovery_required:expired_execution_lease'), attempt_owner = NULL, lease_until = NULL, updated_at = ? WHERE message_id = ? AND state = 'SEND_ATTEMPTED' AND lease_until = ?").run(at, row.message_id, row.lease_until);
        if (result.changes !== 1) continue;
        this.db.prepare("INSERT INTO audit_events(event_id, correlation_id, caller, tool, account_id, message_id, old_state, new_state, outcome_code, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), `recovery:${row.message_id}`, "Hermes runtime", "startup_recovery", row.account_id, row.message_id, "SEND_ATTEMPTED", "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN", JSON.stringify(redact({ reason: "expired_execution_lease", previousOwner: row.attempt_owner, expiredAt: row.lease_until })), at);
        count += 1;
      }
      return count;
    });
    return reconcile();
  }
  appendAudit(event: { correlationId: string; caller: string; tool: string; accountId?: string; messageId?: string; oldState?: string; newState?: string; outcomeCode: string; metadata: unknown }): void { this.db.prepare("INSERT INTO audit_events(event_id, correlation_id, caller, tool, account_id, message_id, old_state, new_state, outcome_code, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), event.correlationId, event.caller, event.tool, event.accountId ?? null, event.messageId ?? null, event.oldState ?? null, event.newState ?? null, event.outcomeCode, JSON.stringify(redact(event.metadata)), now()); }
  private map(row: Record<string, unknown>): PreparedMessage { return { messageId: row.message_id as string, accountId: row.account_id as string, idempotencyKey: row.idempotency_key as string, messageIdHeader: row.message_id_header as string, intent: (row.intent as "send" | "draft") ?? "send", draftSaveStatus: (row.draft_save_status as DraftSaveStatus) ?? "NOT_SAVED", ...(typeof row.draft_provider_reference === "string" ? { draftProviderReference: row.draft_provider_reference } : {}), ...(typeof row.draft_folder === "string" ? { draftFolder: row.draft_folder } : {}), ...(typeof row.draft_uid === "number" ? { draftUid: row.draft_uid } : {}), ...(typeof row.draft_uid_validity === "number" ? { draftUidValidity: row.draft_uid_validity } : {}), fromAddress: row.from_address as string, recipients: JSON.parse(row.recipients as string) as string[], cc: JSON.parse((row.cc as string | null) ?? "[]") as string[], bcc: JSON.parse((row.bcc as string | null) ?? "[]") as string[], ...(row.reply_to === null || row.reply_to === undefined ? {} : { replyTo: row.reply_to as string }), ...(row.in_reply_to === null || row.in_reply_to === undefined ? {} : { inReplyTo: row.in_reply_to as string }), references: JSON.parse((row.references_header as string | null) ?? "[]") as string[], ...(typeof row.forwarding_metadata === "string" ? { forwarding: JSON.parse(row.forwarding_metadata) as NonNullable<PreparedMessage["forwarding"]> } : {}), subject: row.subject as string, ...(row.text_body === null ? {} : { textBody: row.text_body as string }), ...(row.html_body === null ? {} : { htmlBody: row.html_body as string }), attachments: JSON.parse(row.attachment_manifest as string) as never[], state: row.state as OutboxState }; }
}
