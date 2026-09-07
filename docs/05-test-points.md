# Development test points

## Slice 1 — local durable foundation

- Strict tool schemas reject unknown fields and invalid values.
- Account, outbox, idempotency, and audit tables are created through the initial migration.
- Preparation replay/conflict behavior and transaction atomicity are covered.
- State transitions and one-owner execution leases are covered.
- Message-ID and immutable MIME stability, attachment confinement/hash checks, redaction, and unknown-outcome no-retry behavior are covered.

Real-provider, mailbox, credential, transport, and systemd tests are intentionally deferred.
