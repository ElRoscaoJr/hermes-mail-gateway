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
- Next action: Final release review, commit/push, and only then consider Hermes/systemd integration. Never retry an ambiguous send automatically.

## Open items
- Unresolved user questions: none for the v1 defaults; MIT, English project artifacts, IMAP/SMTP first, OAuth later, and main-only access are recorded decisions that The operator can explicitly reverse.
- Open Design Requests: none
- Unverified external steps/assets: The sender-side provider path is verified for all three configured accounts. Eighteen controlled gateway messages (six per account) reached `SENT_VERIFIED`; exact Message-ID, search, read, attachment hashes, To/CC/BCC envelope, reply headers, and forwarding headers were checked from provider Sent copies. The three recipient inboxes are not configured for read-back in this gateway, so recipient-side inbox presentation was not independently inspected.
- Phase 2 operational values still to pin before implementation: local authorization-token provisioning, account-specific folder names, retention periods, and rate/size limits. These must not be filled with credentials or real mailbox data in repository docs.
- Phase 2 internal budget is recorded in docs/budget.md; this is not a client quote and has no billable rate or tax treatment.
- Forge issues in progress: none

Last updated: 2026-09-08 — Implemented bounded attachment metadata and provider-independent thread queries with account-scoped references, server-side individual IMAP header criteria for provider compatibility, anchor inclusion, UID deduplication, and strict limits. Automated coverage includes account isolation and MCP redaction. Real-provider read-only verification then confirmed attachment metadata and the two-message reply thread (reply plus original) in the configured Gmail and Zoho accounts using existing Sent messages; no new real-provider messages were sent in this phase. Recipient inbox read-back remains outside the configured three sender accounts.
