# Development test points

## Slice 7 — mailbox mutations and draft lifecycle

- Strict `mail_execute` mutation actions are account-scoped and limited to one UIDVALIDITY-bound reference.
- Selectable-folder validation, mailbox locking, provider confirmation, safe normalized output, and audit append are covered by fake-provider and service tests.
- No expunge or permanent delete operation exists; stale and cross-account references remain rejected by the adapter.
- Explicit durable `intent:"draft"`, strict `saveDraft`, provider Drafts APPEND, exact Message-ID/`\\Draft` verification, idempotent repeat, cancellation, account isolation, ambiguous outcome blocking, and `cancelPrepared` are covered. No fake local provider draft is claimed.

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
- [x] Mail projections expose visible CC and bounded Reply-To/In-Reply-To/References plus selected Hermes forwarding metadata; Bcc, arbitrary headers, raw MIME, and attachment bytes remain outside normal public output, with bytes available only through explicit bounded download mode.
- [x] Sent verification searches the configured `sentFolder` and confirms the exact Message-ID from the fetched envelope.
- [x] Verification target for this slice: `npm run typecheck`, `npm test`, `npm run build`, and `npm audit`.

## Slice 5 — application-service wiring

- [x] `MailGatewayService` composes account and outbox repositories with an accountId-keyed IMAP/SMTP adapter registry.
- [x] `mailAccounts` returns only accountId, displayName, providerKind, allowed sender, enabled, and optional non-secret health; credential references and endpoints are excluded.
- [x] `mailQuery` explicitly resolves accounts, bounds limits to 100, dispatches folder discovery/list/search/read/verifySent, and returns normalized adapter values.
- [x] Folder discovery returns only safe metadata; list/search route any provider-returned folder or the configured inbox default; reads/attachments use opaque reference folders; thread rejects folder/reference mismatches; reads remain bounded by the adapter.
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
- [x] Cross-account opaque reference rejection, arbitrary-folder routing, folder mismatch, attachment metadata, thread criteria/deduplication/limit, header-injection rejection, idempotency conflict, and public MCP redaction were verified without sending additional mail.
- [ ] Recipient inboxes were not read back because only the three sender accounts are configured locally; SMTP acceptance plus exact sender Sent verification is confirmed, but recipient-side rendering remains an external observation.

## Slice 8 — configuration, health, and cursor hardening

- [x] `sentPolicy` accepts only `provider_managed`; `gateway_append` is rejected safely and no APPEND path was added.
- [x] `mail_accounts` health is optional, contacts no provider when disabled, performs no-send IMAP connectivity and SMTP `verify()` when enabled, and maps failures to generic `ok`/`failed` projections.
- [x] List/search pagination is bounded, uses opaque account/folder/operation/last-UID cursors, applies server-side IMAP UID criteria, rejects invalid or cross-scope cursors, and preserves strict limits.
- [x] No provider, credential, mailbox, or send is used by the new tests.
- [x] `npm test`, integration tests, typecheck, build, audit, and diff check pass.

## Slice 9 — all-mailbox-folder query

- [x] `mail_query` accepts `folders` and returns only safe folder metadata, including optional special-use values.
- [x] Folder discovery is exposed through `ImapAdapter` and `MailGatewayService`; disabled health does not discover folders.
- [x] Provider-returned arbitrary folders route through list/search; thread folder/reference mismatches and cross-account opaque references are rejected safely.
- [x] MCP output redaction removes arbitrary provider fields and keeps exactly four tools.
- [x] Full typecheck, tests, build, audit, and diff check pass after this slice; no provider was contacted and no mail was sent.

## Slice 10 — Gmail/Zoho parity: structured search and bounded attachment download

- [x] Strict search filters reject unknown fields, invalid date ranges, misplaced filters, and unsafe bounds.
- [x] IMAP fake-adapter tests verify server-side from/to/cc/subject/date/read/flagged/Message-ID criteria, UID cursor composition, and explicit no-scan rejection for `hasAttachment`.
- [x] Attachment download is an explicit `mail_query` mode, account/reference/UIDVALIDITY bound, limited to index 0–31, configured `maxReadBytes`, and a 5,000,000-byte public maximum.
- [x] Fake-adapter tests verify selected bytes, size, SHA-256, base64 public output, out-of-range/cross-account/stale behavior, and MCP redaction excludes raw MIME and raw content fields.
- [x] Exactly four MCP tools remain; delete semantics remain trash-only with no EXPUNGE or permanent deletion.
- [x] Typecheck, full tests, build, audit, and diff check pass; no provider was contacted and no mail was sent.

## Slice 11 — provider-visible drafts

- [x] `saveDraft` is strict, durable, account-bound, idempotent, and limited to `PREPARED` messages with `intent:"draft"`; normal SMTP execution rejects draft intent.
- [x] Configured `draftsFolder` is validated as selectable; without it, the adapter discovers selectable special-use `\\Drafts`; Sent is never an APPEND destination.
- [x] Fake-provider coverage verifies `\\Draft`, exact Message-ID, provider UID/UIDVALIDITY, mailbox locking, missing/ambiguous UID failure, repeat idempotency, cancellation, account isolation, and redacted MCP output.
- [x] An exception after APPEND begins leaves durable verification-required state and a second call performs no APPEND.
- [x] Final local verification: `npm run typecheck`, `npm test`, `npm run build`, offline high-severity audit, and `git diff --check` pass with 87 tests and 0 failures; no provider was contacted and no mail was sent.
