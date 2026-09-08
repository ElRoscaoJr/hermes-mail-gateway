# Production Completeness Audit

Date: 2026-09-08
Scope: Hermes Mail Gateway at commit `269edb2`, after the real Gmail/Zoho folder, health, send, attachment, routing, thread, and Sent-verification checks.

## Executive conclusion

The project has a strong provider-independent send core: durable raw MIME, idempotency, account isolation, explicit SMTP envelopes, bounded IMAP reads, Message-ID verification, ambiguous-outcome blocking, redaction, and real Gmail/Zoho evidence.

It is **not yet a complete production mail connector**. It is currently best described as a reliable multi-account send-and-query gateway. A production connector also needs safe mailbox mutations, drafts, stable mailbox identity across UIDVALIDITY changes, crash recovery, operational limits, authentication strategy, and a documented synchronization model.

The four-tool MCP boundary is still sufficient. Missing capabilities should be added as strict modes under the existing tools, not as one tool per feature or mailbox.

## Evidence and sources

- IMAP4rev2: https://www.ietf.org/rfc/rfc9051.html
- IMAP CONDSTORE/QRESYNC: https://www.rfc-editor.org/rfc/rfc7162.txt
- Internet Message Format: https://datatracker.ietf.org/doc/html/rfc5322
- MIME: https://www.rfc-editor.org/rfc/rfc2045.html
- Gmail API overview: https://developers.google.com/workspace/gmail/api/guides
- Gmail messages and threads: https://developers.google.com/gmail/api/reference/rest/v1/users.messages and https://developers.google.com/gmail/api/guides/threads
- Gmail incremental sync: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push notifications: https://developers.google.com/gmail/api/guides/push
- Gmail labels: https://developers.google.com/gmail/api/guides/labels
- Zoho Mail API overview: https://www.zoho.com/mail/help/api/overview.html
- Zoho email message API: https://www.zoho.com/mail/help/api/email-api.html
- Zoho IMAP: https://www.zoho.com/mail/help/imap-access.html
- Zoho SMTP: https://www.zoho.com/mail/help/zoho-smtp.html

## Capability boundary

| Area | Standard IMAP/SMTP | Gmail/Zoho provider APIs | Current gateway |
|---|---|---|---|
| Mailbox listing, summaries, read, MIME attachments | Yes | Yes | Implemented and real-tested |
| Search | IMAP SEARCH, provider syntax varies | Rich provider-specific syntax | Basic bounded text/subject/header search |
| Threads | Header-based approximation | Native thread/resource IDs | Bounded header-based lookup |
| Send/reply/forward | SMTP + MIME + headers | Native send/thread semantics | Durable SMTP/MIME flow implemented |
| Draft lifecycle | IMAP Drafts/APPEND/flags, semantics vary | Native draft resources | Not implemented as drafts |
| Read/unread and flags | IMAP STORE flags | Gmail labels; Zoho tags/flags | Read-only flags in summaries |
| Move/archive/trash/restore | COPY/MOVE/STORE/EXPUNGE, extensions vary | Native operations | Not implemented |
| Attachments download | MIME traversal | Dedicated attachment resources | Metadata query and bounded full read internally; no public download operation |
| OAuth2 | XOAUTH2 is an extension, not base IMAP/SMTP | First-class Gmail/Zoho OAuth | Password/App Password keychain only |
| Incremental sync | UID/UIDVALIDITY; CONDSTORE/QRESYNC where supported | Gmail historyId/watch | No sync engine or push/watch |
| Sent verification | Provider folder + exact Message-ID | Provider IDs/thread IDs | Exact Message-ID in configured Sent |

## Findings by priority

### P0 — must fix before production

1. **Crash recovery can strand `SEND_ATTEMPTED` messages.**
   - Evidence: `src/mail/execute.ts` and `src/outbox/repository.ts` use leases, but startup does not reconcile expired execution ownership into an explicit verification-required state.
   - Risk: a process crash can leave a message permanently stuck or encourage an unsafe manual resend.
   - Required behavior: on startup/recovery, expire leases into a non-blind-retry state; require exact Sent verification before any recovery action.

2. **Opaque references and cursors do not carry mailbox `UIDVALIDITY`.**
   - Evidence: `src/mail/adapters.ts` encodes account/folder/UID only.
   - Risk: after mailbox recreation or UIDVALIDITY change, an old UID is not a safe identity and could refer to a different message.
   - Required behavior: capture UIDVALIDITY on SELECT, include it in references/cursors, and reject stale references with a distinct safe error requiring a fresh listing.

3. **Operational controls described by the specification are not enforced.**
   - Evidence: adapter limits are hard-coded; config has recipient and attachment limits but no validated provider command/connect timeout, body/read limit, concurrency, or per-account send/query rate policy.
   - Required behavior: explicit validated limits, timeouts, bounded concurrency, and safe provider backoff classification. Never add automatic retry to ambiguous SMTP outcomes.

4. **Production boundary is stdio-only, while some documentation describes loopback HTTP/caller authorization.**
   - Evidence: `src/stdio.ts` is the only transport; `src/mcp/server.ts` uses a fixed `Hermes main` context.
   - Decision required: for local Hermes stdio, document the OS/process trust boundary and remove HTTP claims; if remote/HTTP is required later, add authenticated loopback/HTTP transport before exposing it.

### P1 — required for a complete mailbox connector

5. **Mailbox mutations are absent.**
   - Needed: mark read/unread, set/clear standard flags, archive/move/copy, move to Trash, restore from Trash, and optionally permanent delete behind a separate explicit policy. All mutations need account-scoped opaque references, provider confirmation, audit records, bounded batch size, and no permanent delete by default.

6. **Draft lifecycle is absent.**
   - `PREPARED` is an immutable local outbox record, not a provider-visible draft. A complete connector needs create/list/read/update/delete/send-draft semantics or an explicit decision that local drafts are the only supported draft model. The existing `CANCELLED` state has no public cancellation operation.

7. **Search is too narrow for an agent-facing mail connector.**
   - Current search combines text/subject/Subject-header criteria. Add a strict structured filter model for from/to/cc/subject/date range/has attachment/flags/message ID, with provider-neutral semantics and explicit provider-specific capability reporting. Never pass arbitrary IMAP search syntax from MCP.

8. **Attachment retrieval is not a complete public capability.**
   - Metadata is public and full bytes are used internally for forwarding, but there is no bounded attachment download operation with a safe local artifact handle. Decide whether the gateway needs download-to-approved-path, content streaming through MCP, or metadata-only behavior. Support MIME inline/Content-ID relationships if HTML mail is in scope.

9. **Authentication is password/App-Password only.**
   - Gmail currently prefers OAuth2; App Passwords require 2-Step Verification and may be unavailable under organization policy. Zoho supports application-specific passwords for IMAP/SMTP and OAuth2 for its REST API; REST OAuth must not be assumed to be IMAP XOAUTH2.
   - Required for broad production use: model credential kind separately (`password`/`app_password`/`oauth2`), token refresh/revocation, minimal scopes, and secure token storage. Do not put tokens into the current `{username,password}` interface.

### P2 — required for reliable continuous operation

10. **No incremental synchronization model.**
    - There is no IMAP IDLE/QRESYNC/CONDSTORE state machine and no Gmail `historyId`/watch or Zoho equivalent. Query-on-demand is valid for the current Hermes workflow, but automatic inbox scanning, notifications, and durable local indexing require a separate sync subsystem.

11. **Provider capability discovery is incomplete.**
    - `mail_accounts` reports only basic account projection and health. A production client should know supported operations, authentication kind, provider quirks, limits, and whether native labels/threads/drafts are available.

12. **Retention, cleanup, backup, and observability are not a release policy.**
    - Raw MIME and audit records require retention limits, secure cleanup, SQLite backup/integrity checks, disk-space monitoring, bounded logs, latency metrics, and alerting for stale outbox states.

13. **Generic-provider certification is missing.**
    - Gmail and Zoho are real-tested. `generic_imap_smtp` is protocol-compatible by code and fake-adapter tests, but no independent generic provider has been certified. Provider folder names, AUTH mechanisms, Sent-copy behavior, limits, and extensions vary.

### P3 — provider-specific enhancements

14. Native Gmail labels, thread IDs, history sync, push watch, and API attachment resources.
15. Native Zoho tags, message IDs, REST draft/send operations, and OAuth scopes.
16. Inline images and Content-ID-aware HTML rendering.
17. Server-side sort/thread extensions where supported, with a safe fallback to current bounded queries.

## Recommended implementation order

1. UIDVALIDITY-aware references and cursors.
2. Crash recovery and stale lease reconciliation.
3. Explicit timeout/concurrency/rate/retention configuration and enforcement.
4. Safe non-destructive mailbox mutation modes.
5. Draft lifecycle and cancellation semantics.
6. Structured provider-neutral search filters.
7. Capability projections and generic-provider certification.
8. OAuth2 credential model.
9. Optional continuous sync/watch subsystem.
10. Provider-native Gmail/Zoho adapters only if native labels, history, or API drafts are required.

## Release gate after this audit

The gateway must not be called production-complete until every P0 item is either implemented and tested or explicitly removed from the product contract. P1 items must be implemented if Hermes is expected to manage inbox state rather than only read and send. P2/P3 items must be documented as deliberate scope boundaries, not implied capabilities.
