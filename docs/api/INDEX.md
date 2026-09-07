# API index

| Surface | Location | Purpose |
|---|---|---|
| Four MCP input schemas | `src/mcp/schemas.ts` | Strict schemas for `mail_accounts`, `mail_query`, `mail_prepare`, and `mail_execute`. |
| Safe errors/results | `src/errors.ts` | Stable error taxonomy and typed result envelope. |
| Account projection repository | `src/outbox/accounts.ts` | Secret-free account configuration projection. |
| Outbox repository | `src/outbox/repository.ts` | Atomic preparation, idempotency, transitions, leases, and audit append. |
| Database migrations | `src/outbox/database.ts`, `migrations/001_initial.sql` | WAL SQLite authority and schema initialization. |
| Attachment validation | `src/security/attachments.ts` | Allow-listed roots, regular-file, size, and SHA-256 validation. |
| Redaction | `src/observability/redaction.ts` | Recursive secret and bearer-token redaction. |
| Provider-free adapters | `src/mail/adapters.ts` | IMAP/SMTP contracts and deterministic test fakes. |
| Preparation/execution | `src/mail/prepare.ts`, `src/mail/execute.ts` | Stable Message-ID, immutable MIME, one-claim execution, and no-retry unknown outcomes. |
