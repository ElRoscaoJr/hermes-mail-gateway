# Development test points

## Slice 1 — local durable foundation

- Strict tool schemas reject unknown fields and invalid values.
- Account, outbox, idempotency, and audit tables are created through the initial migration.
- Preparation replay/conflict behavior and transaction atomicity are covered.
- State transitions and one-owner execution leases are covered.
- Message-ID and immutable MIME stability, attachment confinement/hash checks, redaction, and unknown-outcome no-retry behavior are covered.

Real-provider, mailbox, credential, transport, and systemd tests are intentionally deferred.

## Slice 2 — real MCP boundary

- [x] Exactly four tools are listed through the SDK in `test/integration/mcp.test.ts`.
- [x] Public `mail_prepare` rejects unknown fields, including caller-controlled `fromAddress`.
- [x] Handler-boundary validation rejects malformed input and returns a safe MCP error.
- [x] Success and error responses are JSON structured content with redaction; no stack traces or secret values are returned.
- [x] Each invocation receives a generated correlation ID.
- [x] The service seam carries the account ID to execution; implementations must reject ownership mismatch, and the smoke fake verifies that path.
- [x] `verifyOnly` is passed as an explicit no-send execution request.
- [x] Provider behavior remains injected; no credentials, IMAP/SMTP connections, or sends are used.
- [x] `npm run typecheck`, `npm test`, and `npm run build` pass for this slice.
