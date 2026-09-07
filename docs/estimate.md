# Estimate v1 — Preliminary

This is a preliminary AI-time estimate for discovery only, not a traditional human project quote. It will be revised after the functional specification.

| Work area | AI working time range | Notes |
|---|---:|---|
| Functional specification and threat model | 1–2 h | Contract, state machine, account policy, failure matrix |
| Gateway core and SQLite outbox | 3–6 h | Four tools, schema, idempotency, recovery |
| IMAP/SMTP/MIME adapters | 3–6 h | Mature libraries, attachment and threading handling |
| Hermes/systemd integration | 1–2 h | Local HTTP MCP, service unit, profile configuration |
| Tests and fault injection | 4–8 h | Unit, local fake servers, self-only real-provider tests |
| Documentation and release hygiene | 1–3 h | Operations, security, migration, reusable-agent setup |
| Contingency | +30% | Provider quirks and real-mail verification |

Assumptions: no UI, no client-facing deployment, no OAuth provider adapter in v1, and real tests only to the operator-controlled self-test address configured outside the repository. The operator supplies or configures credentials manually; the agent never stores raw secrets in Git or memory.

AI cost mode: subscription; no API-cost estimate included.
