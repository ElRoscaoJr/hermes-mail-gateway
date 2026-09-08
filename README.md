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

## Project status

The local runtime, all four MCP tools, multi-account configuration composition, bounded IMAP reads/searches, UIDVALIDITY-safe mailbox mutations, durable MIME preparation, To/CC/BCC routing, replies, forwarding, no-retry execution, exact Sent verification, draft preparation/cancellation, and redacted responses are implemented. Provider draft APPEND is intentionally not implemented yet; Hermes/systemd activation remains separate.

## Run locally

The process requires an explicit operator configuration file; it does not load `.env` files or use defaults. Set `HERMES_MAIL_CONFIG=/absolute/path/to/config.json` and run `npm run build && npm start`. The file contains non-secret account metadata and `keychain:<service>/<account>` references only. It must define `databasePath`, server `attachmentRoots`, unique `accounts`, and `limits`; each account defines its own IMAP/SMTP endpoints, folders, sender, and attachment roots. `credentialRef` is the IMAP reference. Optional `smtpCredentialRef` selects a separate SMTP reference; when omitted, SMTP uses `credentialRef` for backward compatibility. Neither reference is returned by account-listing tools. The process writes MCP protocol messages only to stdout and startup diagnostics only to stderr.

For local verification, use the synthetic fixtures in `test/` and the process startup smoke test. The controlled real-provider validation used a separately created disposable database/attachment root, credentials in the host keychain, and configuration outside this repository. It exercised all three configured accounts through the compiled MCP process; recipient inbox read-back is not included because only the sender accounts are configured locally. Never test with a customer or unapproved third-party recipient, and never enable automatic retry.

Folder discovery and mailbox operations are implemented as bounded, account-scoped queries: `mail_query` with `operation:"folders"` returns only provider folder `path`, `name`, `delimiter`, and optional `specialUse`. `mail_execute` supports one reference-based mutation per call: read state, standard flags, copy, move, provider Trash, and restore to the configured inbox. Destination folders must be discovered selectable folders; no expunge or permanent delete is exposed. List/search use the requested folder or inbox default; read/attachments use the exact folder in the opaque reference; thread rejects anchor-folder mismatches; `verifySent` remains bound to configured Sent. References and list/search cursors include IMAP `UIDVALIDITY`; stale generations return `REFERENCE_STALE` before any old UID is used. Draft preparation accepts `intent:"draft"` and `cancelPrepared` is durable; provider Drafts APPEND is the next slice and is not faked. An optional `draftsFolder` is an explicit configured fallback; omission never assumes a localized name. Startup changes expired execution leases to audited, verification-required `OUTCOME_UNKNOWN` without SMTP submission. Query/read limits are configured as `maxQueryResults` (default 50, maximum 100) and `maxReadBytes` (default 1,000,000, maximum 10,000,000), alongside existing recipient and attachment limits. The gateway never silently approximates unsupported operations.

Search also accepts a strict provider-neutral `search` object (`from`, `to`, `cc`, `subject`, `since`, `before`, `hasAttachment`, `isRead`, `isFlagged`, and `messageId`) in addition to the query string. Representable criteria are compiled to bounded server-side IMAP search; unsupported criteria fail safely without scanning an unbounded mailbox. Attachment metadata remains the default; adding `attachmentIndex` enables a selected account-bound download with filename, content type, size, SHA-256, and base64 bytes, limited by `maxReadBytes` and 5,000,000 public bytes. Inline, unsafe, oversized, stale, cross-account, and invalid selections are rejected.

## Security

No credentials, OAuth tokens, customer mail, real addresses beyond public service identifiers, or local account files belong in this repository. Runtime secrets are stored outside the repository using the host credential store.

## License

MIT. See `LICENSE`.
