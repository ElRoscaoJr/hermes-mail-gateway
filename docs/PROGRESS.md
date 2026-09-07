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
| 5 Development | pending | docs/05-test-points.md |
| 6 Documentation | pending | docs/architecture.md, docs/api/ |
| 7 Release | pending | docs/07-release.md |
| 8 Website | n/a | No website intent |

## Current position
- Phase: 5 — Development, scaffold and first test point.
- Next action: Create the TypeScript scaffold and implement the domain/outbox slice before wiring provider adapters.

## Open items
- Unresolved user questions: none for the v1 defaults; MIT, English project artifacts, IMAP/SMTP first, OAuth later, and main-only access are recorded decisions that The operator can explicitly reverse.
- Open Design Requests: none
- Unverified external steps/assets: Real mailbox integration tests are pending and must use only the operator-controlled self-test address configured outside the repository.
- Phase 2 operational values still to pin before implementation: exact dependency versions, local authorization-token provisioning, account-specific folder names, retention periods, and rate/size limits. These must not be filled with credentials or real mailbox data in repository docs.
- Phase 2 internal budget is recorded in docs/budget.md; this is not a client quote and has no billable rate or tax treatment.
- Forge issues in progress: none

Last updated: 2026-09-07 — Phase 2 specification and internal budget complete; no source code or real-mail access used.
