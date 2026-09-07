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

The local runtime, all four MCP tools, multi-account configuration composition, bounded IMAP reads, durable MIME preparation, no-retry execution, exact Sent verification, and redacted responses are implemented. See `docs/PROGRESS.md` for remaining operator-only work.

## Run locally

The process requires an explicit operator configuration file; it does not load `.env` files or use defaults. Set `HERMES_MAIL_CONFIG=/absolute/path/to/config.json` and run `npm run build && npm start`. The file contains non-secret account metadata and `keychain:<service>/<account>` references only. It must define `databasePath`, server `attachmentRoots`, unique `accounts`, and `limits`; each account defines its own IMAP/SMTP endpoints, folders, sender, and attachment roots. `credentialRef` is the IMAP reference. Optional `smtpCredentialRef` selects a separate SMTP reference; when omitted, SMTP uses `credentialRef` for backward compatibility. Neither reference is returned by account-listing tools. The process writes MCP protocol messages only to stdout and startup diagnostics only to stderr.

For local-only verification, use the synthetic fixtures in `test/` and the process startup smoke test. A future real-provider check must use a separately created, operator-controlled self-test address, a disposable database, credentials inserted manually into the host keychain, and a configuration file outside this repository. First run `mail_accounts`, then bounded `mail_query`; only after confirming the account, folder, recipient, and Sent policy should an operator prepare a message. Never test with a customer or third-party recipient, and never enable automatic retry.

Threads, attachment-only mailbox operations, drafts, replies, forwards, and destructive organization operations are intentionally unsupported in v1. They return a stable `UNSUPPORTED_OPERATION` response where exposed; the gateway never silently approximates them.

## Security

No credentials, OAuth tokens, customer mail, real addresses beyond public service identifiers, or local account files belong in this repository. Runtime secrets are stored outside the repository using the host credential store.

## License

MIT. See `LICENSE`.
