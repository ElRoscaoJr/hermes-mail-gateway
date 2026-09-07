# API index

| Surface | Location | Purpose |
|---|---|---|
| Four MCP input schemas | `src/mcp/schemas.ts` | Strict schemas for `mail_accounts`, `mail_query`, `mail_prepare`, and `mail_execute`. |
| `MailApplicationService` | `src/application/service.ts` | Provider-free four-operation application seam and per-call context. |
| `createMcpServer(service)` | `src/mcp/server.ts` | Exactly four strict, redacting MCP tools with safe error mapping. |
| `startStdio(service)` | `src/stdio.ts` | SDK stdio composition entrypoint; stdout is protocol-only. |
| Safe errors/results | `src/errors.ts` | Stable error taxonomy and typed result envelope. |
| Account projection repository | `src/outbox/accounts.ts` | Secret-free account configuration projection. |
| Outbox repository | `src/outbox/repository.ts` | Atomic preparation including raw MIME BLOB persistence, idempotency, transitions, leases, raw MIME retrieval, and audit append. |
| Database migrations | `src/outbox/database.ts`, `migrations/001_initial.sql` | WAL SQLite authority and schema initialization. |
| Attachment validation | `src/security/attachments.ts` | Allow-listed roots, regular-file, size, and SHA-256 validation. |
| Redaction | `src/observability/redaction.ts` | Recursive secret and bearer-token redaction. |
| Provider-free adapters | `src/mail/adapters.ts` | IMAP/SMTP contracts and deterministic test fakes. |
| `ImapFlowMailAdapter` | `src/mail/adapters.ts` | Provider-independent, per-operation ImapFlow 2.0.0 client lifecycle for explicit-folder listing, bounded UID-safe list/search/read, opaque references, and exact configured-Sent Message-ID verification. |
| Preparation/execution | `src/mail/prepare.ts`, `src/mail/execute.ts` | MIME is built before persistence; execution submits stored bytes once with stable Message-ID and no-retry unknown outcomes. |
| Credential reference parser/store | `src/mail/credentials.ts` | Validates explicit `keychain:<service>/<account>` references and resolves credentials without MCP exposure. |
| MIME builder | `src/mail/mime.ts` | Nodemailer 10.0.1 stream MIME generation for text, optional HTML, and hash/size-validated attachments. |
| Nodemailer SMTP adapter | `src/mail/adapters.ts` | Injected-transport SMTP submission with rejected, pre-submission, acknowledged, and unknown outcomes; no internal retry. |
