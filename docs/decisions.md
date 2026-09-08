# Decisions — Hermes Mail Gateway

> Append-only. A future session must not re-open a decision unless the project operator explicitly reverses it.

## D-001 — Project shape
- Date / phase: 2026-09-07 / Phase 1
- Decision: Build a new minimal local mail gateway and MCP server rather than deploy a general-purpose third-party mail MCP unchanged.
- Why: The initial operator scope is Gmail, Zoho, and generic IMAP/SMTP. A small controlled surface is easier to audit and harden than a large multi-provider server.
- Alternatives rejected: Direct Himalaya automation (historically unreliable for agent sends); unmodified third-party MCP (no persistent idempotency and unnecessary provider surface).
- Supersedes: none

## D-002 — Protocol layer
- Date / phase: 2026-09-07 / Phase 1
- Decision: Use mature IMAP/SMTP and MIME libraries in v1. Do not implement the protocols from scratch. Keep official Gmail/Zoho API adapters as a later option, not a v1 requirement.
- Why: All three current accounts already work through IMAP/SMTP, and a single adapter keeps the first release small. APIs do not eliminate ambiguous network outcomes or the need for an outbox.
- Alternatives rejected: Separate Gmail API and Zoho API implementations in v1 (more provider-specific code and OAuth setup before the reliability core is proven).
- Supersedes: none

## D-003 — Reliability model
- Date / phase: 2026-09-07 / Phase 1
- Decision: Every outgoing message uses a durable SQLite outbox, a preassigned Message-ID, persistent idempotency, and Sent verification. Unknown delivery outcomes are never retried automatically.
- Why: This directly addresses the duplicate and attachment failures experienced with Himalaya.
- Alternatives rejected: Relying only on an MCP confirmation token; it is not human approval and is in-memory in the candidate implementation.
- Supersedes: none

## D-004 — Tool surface
- Date / phase: 2026-09-07 / Phase 1
- Decision: Expose four semantic MCP tools: `mail_accounts`, `mail_query`, `mail_prepare`, and `mail_execute`, all using `accountId`.
- Why: Keeps the LLM surface small while making the send lifecycle explicit and durable.
- Alternatives rejected: One tool per mailbox; dozens of provider-specific tools.
- Supersedes: none

## D-005 — Runtime deployment
- Date / phase: 2026-09-07 / Phase 1
- Decision: Run one pinned local stdio MCP process under the selected Hermes profile. Do not use `npx @latest` in production.
- Why: One SQLite authority prevents races between Hermes profiles and gives reproducible upgrades.
- Alternatives rejected: Unauthenticated network transport; dynamic npm execution.
- Supersedes: none

## D-006 — Test safety
- Date / phase: 2026-09-07 / Phase 1
- Decision: All real-mail tests go only to the operator-controlled self-test address configured outside the repository; never test against clients or third parties.
- Why: The operator requires real-mail tests to use only explicitly authorized self-test recipients.
- Alternatives rejected: Sending test messages to customer accounts.
- Supersedes: none

## D-007 — Initial project defaults
- Date / phase: 2026-09-07 / Phase 1
- Decision: Use MIT, English repository artifacts, IMAP/SMTP app-password adapters in v1, OAuth adapters later, and expose the gateway only to Hermes `main` initially.
- Why: These defaults minimize scope while preserving reuse and keep the first real-provider verification focused on the already-working account path.
- Alternatives rejected: Starting with three separate OAuth implementations; exposing mail access to every Hermes profile.
- Supersedes: none

## D-008 — Phase 2 technical foundation
- Date / phase: 2026-09-07 / Phase 2
- Decision: Use a strict TypeScript application-layer architecture with four MCP tools, SQLite repositories/migrations, mature IMAP/SMTP/MIME adapters, host keychain/Secret Service credential references, and a single systemd user service on Debian 13.
- Why: Separating the MCP boundary, use cases, durable state machine, provider adapters, and security policy keeps provider failures and model-controlled inputs away from the reliability core.
- Alternatives rejected: Protocol implementation from scratch; direct tool-to-provider calls; in-memory send state; remote/multi-user deployment in v1.
- Supersedes: none

## D-009 — Phase 2 outbox and verification contract
- Date / phase: 2026-09-07 / Phase 2
- Decision: A prepared message is immutable, receives its Message-ID before the SQLite transaction commits, and can become confirmed only through exact Message-ID verification in the configured Sent location. `OUTCOME_UNKNOWN` and `SENT_UNVERIFIED` never trigger an automatic resend.
- Why: This is the smallest enforceable contract that prevents duplicate sends and duplicate Sent copies after ambiguous SMTP/provider behavior.
- Alternatives rejected: Subject/time matching as confirmation; SMTP acknowledgement alone; automatic retry after timeout; gateway APPEND for Gmail/Zoho.
- Supersedes: none

## D-010 — Phase 2 dependency pins
- Date / phase: 2026-09-07 / Phase 2
- Decision: Initial implementation pins Node.js 24.20.0, TypeScript 7.0.2, MCP SDK 1.30.0, ImapFlow 2.0.0, Nodemailer 10.0.1, mailparser 3.9.23, Zod 4.5.4, and better-sqlite3 13.0.3; the generated lockfile is authoritative after the scaffold.
- Why: Reproducible builds and explicit dependency review are release requirements for an email-capable service.
- Alternatives rejected: Floating `latest` ranges and runtime downloads.
- Supersedes: none

## D-011 — Provider-managed Sent and bounded query health
- Date / phase: 2026-09-08 / Phase 5
- Decision: Active configuration accepts only `provider_managed`; account health is opt-in at the call boundary and uses no-send IMAP connectivity plus SMTP transport verification; list/search pagination uses scoped opaque UID cursors.
- Why: IMAP APPEND is not implemented, provider diagnostics must not cross the public boundary, and mailbox queries must remain bounded and account-safe.
- Alternatives rejected: Retaining `gateway_append`; exposing provider errors; unbounded mailbox scans or client-only pagination.
- Supersedes: D-009 only for Sent policy wording; D-009's no-duplicate and no-retry reliability contract remains unchanged.

## D-012 — Provider-authoritative mailbox folders
- Date / phase: 2026-09-08 / Phase 5
- Decision: Expose one `folders` operation within `mail_query` for safe provider folder metadata. List/search accept any real provider folder or the configured inbox default; read/attachments use the folder encoded in the account-bound reference; thread requires an anchor-folder match; `verifySent` remains configured-Sent bound.
- Why: Mailboxes commonly contain user-created folders beyond Inbox and Sent, while opaque references and explicit thread checks preserve account and mailbox routing safety.
- Alternatives rejected: Maintaining a static Inbox/Sent-only service allow-list; exposing raw provider folder responses.
- Supersedes: none

## D-013 — Single-message mailbox mutations and local draft cancellation
- Date / phase: 2026-09-08 / Phase 5
- Decision: Add reference-based mailbox mutations under `mail_execute`, limited to one UIDVALIDITY-bound message per call. Destinations are exact discovered selectable folders; Trash uses `\\Trash` special-use discovery and restore returns to the configured inbox. Add explicit durable draft intent and cancellation, while deferring provider Drafts APPEND.
- Why: Mailbox state changes need provider confirmation, account isolation, mailbox locks, auditability, and no permanent deletion. Draft APPEND needs a durable provider outcome protocol that is not yet available.
- Alternatives rejected: A fifth MCP tool, localized-name assumptions, permanent delete/expunge, batch mutation, and fake local provider drafts.
- Supersedes: none
