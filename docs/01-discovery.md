# Discovery — Hermes Mail Gateway

## Problem & outcome

Hermes needs one reliable email capability for operator-managed Gmail and Zoho accounts. The current Himalaya-based workflow is a terminal-client integration and has caused parser failures, missing attachments, duplicate Sent copies, and unsafe ambiguity after SMTP errors.

The outcome is a small local MCP service that lets Hermes query and mutate all trusted accounts with `accountId`, while making duplicate sends and blind retries structurally difficult.

## Competitive landscape & opportunity

- Scan status: done; see `docs/00-competitive-landscape.md`.
- Table stakes: account routing, bounded query/read, safe attachments, MIME send/reply, durable outbox, idempotency, structured outcome states, Message-ID verification, account Sent policy, redacted audit log, external credential storage.
- Differentiator: failure-safe send semantics for a personal agent, not provider breadth.
- AI/MCP layer: added value. Four semantic tools reduce LLM tool-choice errors and make the send lifecycle explicit. Extra providers and dozens of tools are dropped as forced filler.

## Project type

- Primary: MCP server
- Secondary: local service/library
- Security profile: `.claude/skills/keel/references/security/mcp-server.md`

## Feature list

| Feature | What it does | Users | Priority | Constraint |
|---|---|---|---|---|
| Account registry | Routes operations by `accountId` | Hermes | must | No credentials in tool output |
| Mail query | Lists, searches, reads, threads, folders, attachments, Sent verification | Hermes | must | Bounded results and opaque references |
| Durable preparation | Persists immutable draft/outbox intent and Message-ID | Hermes | must | SQLite transaction before network send |
| Idempotent execution | Sends a prepared intent at most once from the gateway's perspective | Hermes | must | Unknown state never auto-retries |
| SMTP/IMAP adapters | Handles Gmail, Zoho, and generic accounts | Gateway | must | Mature libraries; no protocol implementation from scratch |
| MIME attachments | Builds and validates text/HTML messages and attachments | Hermes | must | Allow-listed roots, hash and size checks |
| Threaded reply/forward | Preserves `In-Reply-To` and `References` | Hermes | must | Read target first |
| Audit log | Records metadata and outcome without secrets/body by default | Operator | must | Redaction and restrictive permissions |
| Safe organization | Mark/move/archive without permanent deletion | Hermes | should | Permanent delete disabled in v1 |
| OAuth adapters | Gmail/Zoho official APIs | Future | could | Not required to prove v1 reliability |

## Scope

### v1

- Node.js/TypeScript service on Debian 13.
- MCP over loopback HTTP, one systemd user service.
- Four tools: `mail_accounts`, `mail_query`, `mail_prepare`, `mail_execute`.
- Gmail and Zoho accounts configured outside the repository.
- Generic IMAP/SMTP account configuration.
- Keychain-backed credentials.
- SQLite outbox with persistent idempotency and state recovery.
- IMAP verification by exact Message-ID.
- Provider-managed Sent policy for Gmail and Zoho; explicit policy for generic accounts.
- Self-only real-provider tests to the operator-controlled self-test address configured outside the repository.

### Later

- Gmail API adapter with OAuth.
- Zoho Mail API adapter with OAuth.
- Webhook/watch-based inbox notifications.
- Additional providers only when the operator requests one.

## Honest assessment

A new small gateway is justified because the project's reliability requirements are narrower and stricter than the general-purpose competitors' scope. Reusing mature protocol libraries is realistic; implementing IMAP/SMTP ourselves is not. The project cannot guarantee that external providers never fail, but it can guarantee no blind retries, durable state, and explicit verification after ambiguous outcomes.

## Constraints & non-negotiables

- Primary language of conversation: Spanish; project source and documentation: English by default.
- No reading or committing real credential values, OAuth tokens, local account files, or customer mail.
- No real-provider tests to customers or third parties; the self-test recipient is configured outside the repository.
- No automatic retries after `OUTCOME_UNKNOWN`.
- No direct email sends before outbox persistence.
- No provider credentials in MCP configuration or model context.
- No dynamic `npx @latest` production deployment.
- One explicitly selected Hermes profile is the initial consumer; other profiles must not receive mailbox access by default.

## License

- License: MIT (initial project default; user may explicitly reverse this before release).

## Installed base / upgrade

- Fresh v1 with no existing production data. The existing Himalaya configuration is not imported into the repository. Runtime credentials are configured manually or migrated through a local, non-committed setup step.

## External dependencies

| Dependency | Version policy | Source | Failure behavior |
|---|---|---|---|
| Node.js | Pin/document minimum supported version | system runtime | Refuse startup with safe diagnostic |
| MCP SDK | Exact lockfile version | npm | Refuse startup if incompatible |
| IMAP library | Exact lockfile version | npm | Account health becomes unavailable; no send fallback |
| SMTP/MIME library | Exact lockfile version | npm | No send; preserve outbox state |
| SQLite driver | Exact lockfile version | npm | Refuse startup rather than send without durability |
| Secret Service/keychain | Host capability | Debian | Refuse account activation without secure credential store |

## Internationalization & output language

- Multi-language: no for v1.
- Base/output language: English for protocol identifiers, source, errors, and docs.
- Target output locales: none; mail content is user-provided and is not translated by the gateway.
- Docs language: English by default for token economy.

## Accessibility

- Target platform: headless Debian service; no human UI.
- Accessibility reference: not applicable because there is no visual or interactive product surface.

## Project website intent

- No website planned.

## Design needed?

- No. This is a headless MCP server and local service with no human-facing UI.

## Design system / brand identity

- N/A — no UI.

## Preliminary estimate

- Estimate v1 is pending the exact functional specification and implementation slices.
- Token ledger: `docs/token-ledger.md`.

## Open questions for the user

None for the v1 defaults. The repository uses MIT, project artifacts are in English, v1 starts with IMAP/SMTP, OAuth is later, and only one explicitly selected Hermes profile receives the mail MCP. The operator can explicitly reverse any of these decisions before the functional specification is closed.
