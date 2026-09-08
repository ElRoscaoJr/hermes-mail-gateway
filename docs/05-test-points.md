# Development test points

## Slice 1 — local durable foundation

- Strict tool schemas reject unknown fields and invalid values.
- Account, outbox, idempotency, and audit tables are created through the initial migration.
- Preparation replay/conflict behavior and transaction atomicity are covered.
- State transitions and one-owner execution leases are covered.
- Message-ID and immutable MIME stability, single and multiple attachment confinement/hash checks, redaction, and unknown-outcome no-retry behavior are covered.

Initial local slices deferred real-provider, mailbox, real-keychain, and systemd tests; the controlled provider validation is recorded in Slice 7 below. Systemd/Hermes activation remains deferred.

## Slice 3 — local provider adapters

- [x] `cross-keychain` is pinned exactly at 1.1.0; tests parse references only and never call a real keychain.
- [x] Nodemailer 10.0.1 stream transport covers Message-ID, text/plain, optional HTML, attachment bytes, and manifest hash/size validation.
- [x] Strict preparation, durable outbox, MIME, and SMTP envelope coverage preserves separate To/CC/BCC recipients, omits BCC from MIME headers, supports Reply-To/In-Reply-To/References, and persists explicit forwarding metadata.
- [x] Injected Nodemailer transports cover explicit `{ user, pass }` credential mapping, provider rejection, pre-submission connection failure, unknown post-attempt exceptions, and bounded non-secret SMTP evidence.
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
- [x] Folder listing, bounded summary search (text/subject/Subject-header OR criteria), bounded source reads, mailbox locks, UID-safe calls, and opaque folder+UID reference round trips are covered.
- [x] Mail projections expose visible CC and bounded Reply-To/In-Reply-To/References plus selected Hermes forwarding metadata; Bcc, arbitrary headers, raw MIME, and attachment bytes remain outside public MCP output.
- [x] Sent verification searches the configured `sentFolder` and confirms the exact Message-ID from the fetched envelope.
- [x] Verification target for this slice: `npm run typecheck`, `npm test`, `npm run build`, and `npm audit`.

## Slice 5 — application-service wiring

- [x] `MailGatewayService` composes account and outbox repositories with an accountId-keyed IMAP/SMTP adapter registry.
- [x] `mailAccounts` returns only accountId, displayName, providerKind, allowed sender, enabled, and optional non-secret health; credential references and endpoints are excluded.
- [x] `mailQuery` explicitly resolves accounts, bounds limits to 100, dispatches list/search/read/verifySent, and returns normalized adapter values.
- [x] List/search folders are restricted to the configured inbox or Sent folder; reads are bounded by the adapter and use opaque UID references.
- [x] Attachment-only queries return bounded filename/content type/size metadata; thread queries return bounded normalized summaries from server-side header criteria and include the anchor.
- [x] `mailPrepare` delegates durable asynchronous preparation without returning raw MIME.
- [x] Batch sending remains intentionally represented by repeated single-message `mail_prepare`/`mail_execute` calls with distinct idempotency keys; no batch MCP tool was added.
- [x] `mailExecute` enforces message ownership, durably confirms exact Sent matches with no-send `verifyOnly`, and delegates normal execution to `executeOnce` with stored MIME.
- [x] SMTP submission outcomes are classified before Sent verification: SMTP throw/`UNKNOWN` remains `OUTCOME_UNKNOWN`; `ACKNOWLEDGED` followed by verification false/exception becomes `SENT_UNVERIFIED` without retry.
- [x] Account configuration accepts an optional `smtpCredentialRef`; IMAP uses `credentialRef`, SMTP uses the separate reference or falls back to `credentialRef`, and neither reference appears in safe account projections.
- [x] SQLite migrations 2 and 3 add SMTP credential and message-routing metadata exactly once for fresh and legacy databases; repository upsert/get round-trips both without storing credentials.
- [x] Integration tests use SQLite plus fake mailbox/IMAP and SMTP adapters; no real mail, keychain, systemd, credentials, or sends are used.
- [x] Compiled stdio startup is smoke-tested with an MCP `initialize` frame and with absent configuration; diagnostics stay off stdout. The child-process checks skip only when the host sandbox denies process creation.
- [x] `npm run typecheck`, `npm test`, and `npm run build` pass with 56 tests and 0 failures, including bounded forwarding body/attachment, source metadata safety, replay, cross-account reference coverage, thread criteria/deduplication/limit, and MCP redaction coverage.
- [x] `npm audit --offline --audit-level=high` found 0 vulnerabilities.
- [x] Online `npm audit --audit-level=high` completed with 0 vulnerabilities.

## Slice 6 — operator keychain provisioning helper

- [x] `scripts/store-keychain-credential.mjs` accepts exactly non-secret service/account arguments and requires an interactive TTY.
- [x] Password input uses raw mode with terminal echo disabled, calls `cross-keychain.setPassword`, restores terminal state in `finally`, and emits only a generic error.
- [x] Static security validation passes; piped non-TTY input is refused without reading the supplied value.
- [x] `npm run typecheck`, `npm test`, `npm run build`, offline `npm audit --audit-level=moderate`, and `git diff --check` pass.

## Slice 7 — controlled real-provider validation

- [x] Disposable configuration/database/attachment root used outside the repository; no production database or systemd service was touched.
- [x] `mail_accounts`, bounded inbox listing, and bounded search/read work through the compiled MCP stdio process for the configured Gmail and Zoho accounts.
- [x] SMTP authentication works for all three accounts after explicit cross-keychain-to-Nodemailer credential mapping; no credential values were printed.
- [x] Eighteen messages were prepared and executed once (six per account): routing with one attachment, routing with two attachments, two batch messages, one reply, and one forward. Every row ended in durable `SENT_VERIFIED`.
- [x] Zoho Sent indexing latency was exercised; ambiguous/unverified initial results were resolved only with `verifyOnly`, never with a normal resend.
- [x] Provider Sent copies confirmed exact Message-ID, To, CC, BCC envelope, single/multiple attachment SHA-256 values, `In-Reply-To`, `References`, forwarded body, and forwarded attachment bytes for all three accounts.
- [x] Cross-account opaque reference rejection, attachment metadata, thread criteria/deduplication/limit, folder allow-list rejection, header-injection rejection, idempotency conflict, and public MCP redaction were verified without sending additional mail.
- [ ] Recipient inboxes were not read back because only the three sender accounts are configured locally; SMTP acceptance plus exact sender Sent verification is confirmed, but recipient-side rendering remains an external observation.
