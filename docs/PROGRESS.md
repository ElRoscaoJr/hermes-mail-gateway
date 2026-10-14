# PROGRESS — Hermes Mail Gateway

> Living state. Read this first in every session. Keep current and compact.

## Project card
- Name / one-line purpose: Minimal, fail-safe multi-account mail gateway and MCP server for Hermes Agent.
- Project type: MCP server / reusable local service
- Stack & target platform(s): Node.js, TypeScript, MCP, IMAP/SMTP, SQLite, Debian 13; no UI.
- License: MIT
- Docs language: English (token economy)
- Security profile: `.claude/skills/keel/references/security/mcp-server.md`
- Accessibility: N/A — headless backend with no human UI.
- i18n: Single-language runtime contract; protocol identifiers and errors in English.
- Installed base: Fresh v1; no existing production data migration.
- Design system: N/A — no UI.
- Keel portability: lock + embedded v1.11.0
- Claude config: lock only; native rules/agents deferred.
- Keel baseline: v1.11.0
- Website intent: No

## Phase status
| Phase | Status | Key artifacts |
|-------|--------|---------------|
| 1 Discovery | done | docs/00-competitive-landscape.md, docs/01-discovery.md |
| 2 Functional spec | done | docs/02-functional-spec.md, docs/03-technical-plan.md, docs/flows/, docs/budget.md |
| 3 Design handoff | n/a | No UI |
| 4 Faithful build | n/a | No UI |
| 5 Development | complete | durable foundation, provider adapters, routing/reply/forward support, and controlled-provider validation |
| 6 Documentation | pending | docs/architecture.md, docs/api/ |
| 7 Release | pending | docs/07-release.md |
| 8 Website | n/a | No website intent |

## Current position
- Phase: 5 — Development and controlled-provider validation complete; production rollout remains intentionally disabled.
- Current position: UIDVALIDITY-aware, audited single-message mailbox mutations and durable provider-visible draft preparation/save/cancellation are implemented; structured provider-neutral search filters and bounded selected-attachment downloads remain under the existing four-tool boundary. Thread header scans now use bounded 65,536-UID windows (512 total-window budget) to reduce serial round trips; metadata-only attachment listings expose raw BODYSTRUCTURE `encodedSize`, while parsed/downloaded `size` is decoded file bytes. Selected inline/Content-ID parts are downloadable; filenames and media types are normalized while exact-byte, UID, encoding, and size checks remain enforced. Draft APPEND is exact-Message-ID/`\\Draft` verified, UID/UIDVALIDITY-bound, idempotent, and permanently verification-required after ambiguous outcomes. The next P0 slice is connection/command timeout, concurrency, rate policy, and provider backoff enforcement. Never retry an ambiguous send or draft append automatically.

## Open items
- Unresolved user questions: none for the v1 defaults; MIT, English project artifacts, IMAP/SMTP first, OAuth later, and one-profile access are recorded decisions that the project operator can explicitly reverse.
- Open Design Requests: none
- Unverified external steps/assets: The sender-side provider path is verified for the configured Gmail and Zoho accounts. Controlled gateway messages reached `SENT_VERIFIED`; exact Message-ID, search, read, attachment hashes, To/CC/BCC envelope, reply headers, and forwarding headers were checked from provider Sent copies. Provider-visible draft APPEND, read-back, idempotency, and Trash cleanup were subsequently exercised against Gmail and Zoho. Recipient inboxes are not configured for read-back in this gateway, so recipient-side presentation is not independently inspected.
- Post-change live validation: after the operator reloaded MCP, all three configured accounts reported healthy and folder discovery succeeded. A Gmail thread lookup returned `complete: true` with two messages. Metadata-only listings on both Zoho accounts exposed `encodedSize` without a decoded `size`; a selected Zoho download had base64-decoded length and SHA-256 matching its returned `size`/hash, with decoded length different from `encodedSize`. The selected message's unread flags were unchanged. No message was sent or mutated.
- Phase 2 operational values still to pin before implementation: local authorization-token provisioning, account-specific folder names, retention periods, and rate/size limits. These must not be filled with credentials or real mailbox data in repository docs.
- Phase 2 internal budget is recorded in docs/budget.md; this is not a client quote and has no billable rate or tax treatment.
- Forge issues in progress: none

Last updated: 2026-10-14 — Attachment metadata distinguishes raw IMAP `encodedSize` from decoded file `size`; thread scans use larger bounded UID windows with existing scan/candidate/result limits. Typecheck and 250/250 unit/integration tests pass; production dependency audit reports 0 vulnerabilities; compiled MCP discovery exposes exactly four tools. After MCP reload, all three configured accounts passed health and folder checks; live Gmail returned a complete two-message thread; Zoho metadata and a selected download verified encoded/decoded size semantics and SHA-256, with flags unchanged. No email was sent or mailbox mutated.
