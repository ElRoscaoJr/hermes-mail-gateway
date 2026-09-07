# Development test points

## Slice 1 — local durable foundation

- Strict tool schemas reject unknown fields and invalid values.
- Account, outbox, idempotency, and audit tables are created through the initial migration.
- Preparation replay/conflict behavior and transaction atomicity are covered.
- State transitions and one-owner execution leases are covered.
- Message-ID and immutable MIME stability, attachment confinement/hash checks, redaction, and unknown-outcome no-retry behavior are covered.

Real-provider, mailbox, real-keychain, and systemd tests are intentionally deferred.

## Slice 3 — local provider adapters

- [x] `cross-keychain` is pinned exactly at 1.1.0; tests parse references only and never call a real keychain.
- [x] Nodemailer 10.0.1 stream transport covers Message-ID, text/plain, optional HTML, attachment bytes, and manifest hash/size validation.
- [x] Injected Nodemailer transports cover provider rejection, pre-submission connection failure, and unknown post-attempt exceptions.
- [x] No provider host, mailbox, credential, or message send is used by the unit tests.
- [x] MIME is built before `OutboxRepository.prepare`, bad attachments leave zero outbox/idempotency rows, and execution submits the stored BLOB after source deletion.
- [x] Raw MIME is excluded from `PreparedMessage` and both MCP result representations.
- [x] Verification results for this slice: typecheck, all local tests, and build pass; `npm audit` result is recorded in `docs/PROGRESS.md`.

## Slice 2 — real MCP boundary

- [x] Exactly four tools are listed through the SDK in `test/integration/mcp.test.ts`.
- [x] Public `mail_prepare` rejects unknown fields, including caller-controlled `fromAddress`.
- [x] Handler-boundary validation rejects malformed input and returns a safe MCP error.
- [x] Success and error responses are JSON structured content with redaction; no stack traces or secret values are returned.
- [x] Each invocation receives a generated correlation ID.
- [x] The service seam carries the account ID to execution; implementations must reject ownership mismatch, and the smoke fake verifies that path.
- [x] `verifyOnly` is an explicit no-send execution request: exact Sent verification atomically confirms `PREPARED`, `SEND_ATTEMPTED`, `SENT_UNVERIFIED`, or `OUTCOME_UNKNOWN`; a missing message leaves state unchanged.
- [x] Provider behavior remains injected; no credentials, IMAP/SMTP connections, or sends are used.
- [x] `npm run typecheck`, `npm test`, and `npm run build` pass for this slice.

## Slice 4 — provider-independent ImapFlow mailbox adapter

- [x] Account configuration and the persisted account projection require explicit `inboxFolder` and `sentFolder` values; no provider folder-name heuristics are used.
- [x] ImapFlow 2.0.0 is constructed through an injectable client factory in tests; tests use no network, keychain, real mailbox, real credentials, or sends.
- [x] Each operation resolves the configured credential reference, creates and closes one client, disables client logging, and maps connection/credential failures to `PROVIDER_UNAVAILABLE`.
- [x] Folder listing, bounded summary search, bounded source reads, mailbox locks, UID-safe calls, and opaque folder+UID reference round trips are covered.
- [x] Sent verification searches the configured `sentFolder` and confirms the exact Message-ID from the fetched envelope.
- [x] Verification target for this slice: `npm run typecheck`, `npm test`, `npm run build`, and `npm audit`.

## Slice 5 — application-service wiring

- [x] `MailGatewayService` composes account and outbox repositories with an accountId-keyed IMAP/SMTP adapter registry.
- [x] `mailAccounts` returns only accountId, displayName, providerKind, allowed sender, enabled, and optional non-secret health; credential references and endpoints are excluded.
- [x] `mailQuery` explicitly resolves accounts, bounds limits to 100, dispatches list/search/read/verifySent, and returns normalized adapter values.
- [x] Thread and attachment query operations return `UNSUPPORTED_OPERATION`.
- [x] `mailPrepare` delegates durable asynchronous preparation without returning raw MIME.
- [x] `mailExecute` enforces message ownership, durably confirms exact Sent matches with no-send `verifyOnly`, and delegates normal execution to `executeOnce` with stored MIME.
- [x] Integration tests use SQLite plus fake mailbox/IMAP and SMTP adapters; no real mail, keychain, systemd, credentials, or sends are used.
- [x] Compiled stdio startup is smoke-tested with an MCP `initialize` frame and with absent configuration; diagnostics stay off stdout. The child-process checks skip only when the host sandbox denies process creation.
- [x] `npm run typecheck`, `npm test`, and `npm run build` pass with 9 test files and 0 failures.
- [x] `npm audit --offline --audit-level=high` found 0 vulnerabilities.
- [ ] Online `npm audit --audit-level=high` could not complete because the environment could not resolve `registry.npmjs.org` (`EAI_AGAIN`).

## Slice 6 — operator keychain provisioning helper

- [x] `scripts/store-keychain-credential.mjs` accepts exactly non-secret service/account arguments and requires an interactive TTY.
- [x] Password input uses raw mode with terminal echo disabled, calls `cross-keychain.setPassword`, restores terminal state in `finally`, and emits only a generic error.
- [x] Static security validation passes; piped non-TTY input is refused without reading the supplied value.
- [x] `npm run typecheck`, `npm test`, `npm run build`, offline `npm audit --audit-level=moderate`, and `git diff --check` pass.
