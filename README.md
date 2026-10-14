# Hermes Mail Gateway

A minimal, fail-safe multi-account mail gateway and MCP server for Hermes Agent.

## Scope

Version 1 targets exactly:

- Gmail accounts
- Zoho Mail accounts
- Generic IMAP/SMTP accounts
- Four small MCP tools with `accountId`
- Durable SQLite outbox and idempotent execution
- MIME messages and attachments
- Message-ID based Sent verification
- Redacted audit logging

It intentionally does not target Outlook, Microsoft Graph, EWS, Apple Mail, Mailtrap, Sieve, JMAP, or provider-specific automation in v1.

## Reliability contract

The gateway must never blindly retry an SMTP operation whose delivery outcome is unknown. Every outgoing message receives a durable record and a Message-ID before SMTP is attempted. After an ambiguous outcome, the gateway verifies Sent before any user-approved resend.

Sent-copy policy is explicit per account. `provider_managed` checks the provider's Sent folder and never adds a second copy (appropriate for providers that save one themselves). `gateway_append` is available only for generic IMAP/SMTP accounts whose SMTP submission does not save Sent: after SMTP acknowledges a message, the gateway first checks for an exact Message-ID in the configured Sent folder, then appends the **persisted raw MIME** once with `\\Seen` only if absent, and verifies the exact Message-ID. An ambiguous APPEND is reconciled by another exact lookup; if still unconfirmed, the outcome is non-retryable `SENT_UNVERIFIED`. An ambiguous SMTP outcome never triggers APPEND or a resend. Confirm the folder and provider behavior before selecting either policy.

TLS is mandatory for both transports: `imaps://` uses implicit TLS, `imap://` requires STARTTLS before authentication (no plaintext fallback), `smtps://` uses implicit TLS, and `smtp://` requires STARTTLS. A failed/undefined IMAP SEARCH, missing candidate, or a lookup exceeding the configured verification bound is **not** proof of absence: Sent APPEND is refused rather than risking a duplicate.

The pre-APPEND exact lookup and APPEND cannot be atomic against an **external IMAP client** adding a message with the same Message-ID at the same moment. Use one active send path for an account and keep Message-IDs unique; this policy prevents blind gateway retries but does not promise global exactly-once behavior across other writers.

## Project status

The local runtime, all four MCP tools, multi-account configuration composition, bounded IMAP reads/searches, UIDVALIDITY-safe mailbox mutations, durable MIME preparation, To/CC/BCC routing, replies, forwarding, no-retry execution, exact Sent verification, provider-visible draft APPEND, draft preparation/cancellation, and redacted responses are implemented. Hermes/systemd activation remains separate.

## Run locally

The process requires an explicit operator configuration file; it does not load `.env` files or use defaults. Set `HERMES_MAIL_CONFIG=/absolute/path/to/config.json` and run `npm run build && npm start`. The file contains non-secret account metadata and `keychain:<service>/<account>` references only. It must define `databasePath`, server `attachmentRoots`, unique `accounts`, and `limits`; each account defines its own IMAP/SMTP endpoints, folders, sender, and attachment roots. `credentialRef` is the IMAP reference. Optional `smtpCredentialRef` selects a separate SMTP reference; when omitted, SMTP uses `credentialRef` for backward compatibility. Neither reference is returned by account-listing tools. The process writes MCP protocol messages only to stdout and startup diagnostics only to stderr.

For local verification, use the synthetic fixtures in `test/` and the process startup smoke test. The controlled real-provider validation used a separately created disposable database/attachment root, credentials in the host keychain, and configuration outside this repository. It exercised multiple configured accounts through the compiled MCP process; recipient inbox read-back is not included because only sender accounts are configured locally. Never test with a customer or unapproved third-party recipient, and never enable automatic retry.

Folder discovery and mailbox operations are implemented as bounded, account-scoped queries: `mail_query` with `operation:"folders"` returns only provider folder `path`, `name`, `delimiter`, and optional `specialUse`. `mail_execute` supports one reference-based mutation per call, plus strict `{type:"saveDraft", messageId}` for a durable `PREPARED` message with `intent:"draft"`. Destination folders must be discovered selectable folders; no expunge or permanent delete is exposed. List/search/read already support any discovered folder, so drafts use the same existing operations. Draft save uses configured `draftsFolder` when present, otherwise selectable `\\Drafts` discovery; it never assumes a localized name or uses Sent. APPEND sets `\\Draft`, verifies the exact Message-ID, and requires a provider UID or one unambiguous exact-Message-ID verification result. Confirmed saves are durable and idempotent; an interrupted or ambiguous append becomes verification-required and is never blindly retried. References and list/search cursors include IMAP `UIDVALIDITY`; stale generations return `REFERENCE_STALE` before any old UID is used. `cancelPrepared` remains durable and cannot cancel a provider-saved or verification-required draft. Startup changes expired execution leases to audited, verification-required `OUTCOME_UNKNOWN` without SMTP submission. Query/read limits are configured as `maxQueryResults` (default 50, maximum 100) and `maxReadBytes` (default 1,000,000, maximum 10,000,000), alongside existing recipient and attachment limits. The gateway never silently approximates unsupported operations.

Search also accepts a strict provider-neutral `search` object (`from`, `to`, `cc`, `subject`, `since`, `before`, `hasAttachment`, `isRead`, `isFlagged`, and `messageId`) in addition to the query string. Representable criteria are compiled to bounded server-side IMAP search; unsupported criteria fail safely without scanning an unbounded mailbox. Attachment metadata remains the default; adding `attachmentIndex` enables a selected account-bound download with filename, content type, size, SHA-256, and base64 bytes. `maxAttachmentDownloadBytes` controls the decoded download bound (default 10,000,000 bytes, maximum 25,000,000); base64 adds transport overhead. Full-message reads use the separate `maxReadBytes` bound and reject missing, oversized, or inconsistent message sizes before parsing. Oversized, stale, cross-account, and invalid selections are rejected. See [capabilities and limits](docs/capabilities-and-limits.md) for the precise release boundaries.

## Security

No credentials, OAuth tokens, customer mail, real addresses beyond public service identifiers, or local account files belong in this repository. Runtime secrets are stored outside the repository using the host credential store.

## License

MIT. See `LICENSE`.
