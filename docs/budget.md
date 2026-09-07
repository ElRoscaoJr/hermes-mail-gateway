# Internal budget — Hermes Mail Gateway

## Purpose

This is an internal infrastructure project for The operator's Hermes installation, not a client quote. No customer price, tax, or billable developer rate is being invented.

## Scope basis

The budget covers the v1 scope in `docs/02-functional-spec.md`:

- Four MCP tools.
- Gmail, Zoho, and generic IMAP/SMTP account adapters.
- SQLite transactional outbox and persistent idempotency.
- MIME messages, attachments, replies, and exact Message-ID Sent verification.
- Local systemd deployment, security tests, fault injection, documentation, and self-only real-provider tests.

OAuth/API adapters, remote access, provider webhooks, destructive mailbox operations, and extra providers are excluded from v1.

## AI and operator effort

| Work area | AI working range | The operator/operator effort | Status |
|---|---:|---:|---|
| Functional specification | 1–2 h | 15–30 min decisions/review | Complete/in review |
| Gateway implementation | 3–6 h | 30–60 min review | Pending |
| Protocol adapters and MIME | 3–6 h | 30–60 min self-test setup | Pending |
| Fault-injection and real-provider verification | 4–8 h | 30–60 min mailbox observation | Pending |
| Deployment and documentation | 1–3 h | 15–30 min service verification | Pending |
| Contingency | +30% | — | Included |

These are AI working-time ranges, not calendar promises or traditional human-development estimates.

## Cost treatment

- AI access: ChatGPT/Codex subscription; no separate API cost is charged to this internal project.
- Operator time: not billed to a client.
- External infrastructure: uses the existing Debian host and existing mail accounts; no new paid service is required for v1.

## Approval

Internal project. The scope and cost treatment are approved by The operator's explicit instruction to proceed autonomously. Any new paid dependency or external service requires a separate decision before adoption.
