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

The local runtime, all four MCP tools, multi-account configuration composition, bounded IMAP reads/searches, durable MIME preparation, To/CC/BCC routing, replies, forwarding, no-retry execution, exact Sent verification, and redacted responses are implemented and validated against the three configured providers. Hermes/systemd activation remains intentionally separate; see `docs/PROGRESS.md` for the release gate.

## Run locally

The process requires an explicit operator configuration file; it does not load `.env` files or use defaults. Set `HERMES_MAIL_CONFIG=/absolute/path/to/config.json` and run `npm run build && npm start`. The file contains non-secret account metadata and `keychain:<service>/<account>` references only. It must define `databasePath`, server `attachmentRoots`, unique `accounts`, and `limits`; each account defines its own IMAP/SMTP endpoints, folders, sender, and attachment roots. `credentialRef` is the IMAP reference. Optional `smtpCredentialRef` selects a separate SMTP reference; when omitted, SMTP uses `credentialRef` for backward compatibility. Neither reference is returned by account-listing tools. The process writes MCP protocol messages only to stdout and startup diagnostics only to stderr.

For local verification, use the synthetic fixtures in `test/` and the process startup smoke test. The controlled real-provider validation used a separately created disposable database/attachment root, credentials in the host keychain, and configuration outside this repository. It exercised all three configured accounts through the compiled MCP process; recipient inbox read-back is not included because only the sender accounts are configured locally. Never test with a customer or unapproved third-party recipient, and never enable automatic retry.

Thread and attachment-only mailbox operations, drafts, and destructive organization operations are intentionally unsupported in v1 and return a stable `UNSUPPORTED_OPERATION` response where exposed. Sends support multiple attachments, separate To/CC/BCC routing, reply headers, and forwarding from an account-scoped bounded IMAP read. Forwarding synthesizes a deterministic plain-text block and persists source attachment bytes in the new MIME; a source attachment without safe bytes is rejected. The gateway never silently approximates unsupported operations.

## Security

No credentials, OAuth tokens, customer mail, real addresses beyond public service identifiers, or local account files belong in this repository. Runtime secrets are stored outside the repository using the host credential store.

## License

MIT. See `LICENSE`.
