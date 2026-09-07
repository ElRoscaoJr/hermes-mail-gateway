# Lessons Learned — Hermes Mail Gateway

## L-001 — Do not automate a TUI as an email API
- Problem: Himalaya file/stdin sending produced parser failures and literal attachment markers.
- Where: Previous Hermes email workflow.
- What failed: Treating a terminal mail client as a semantic, idempotent agent backend.
- Working solution: Use a dedicated service with typed operations, MIME composition, durable state, and post-send verification.
- Rule for next time: A successful SMTP command is not sufficient evidence; persist and verify the exact message.

## L-002 — Provider Sent behavior must be explicit per account
- Problem: Provider-side Sent copies combined with client-side IMAP APPEND caused duplicates.
- Where: Gmail and Zoho sending.
- What failed: Assuming one universal save-copy policy.
- Working solution: Configure Sent policy per account and verify against the actual provider.
- Rule for next time: Gmail/Zoho default to provider-managed Sent; generic providers require explicit testing before APPEND.

## L-003 — Tests never target customers
- Problem: Previous email mechanism tests accidentally reached a customer.
- Where: Historical Sebine invoice delivery.
- What failed: Using a real third-party mailbox for mechanism testing.
- Working solution: Restrict every test recipient to the operator-controlled self-test address configured outside the repository.
- Rule for next time: Real-provider tests are self-mail only, always.

## L-004 — MIME must be durable before claiming execution
- Problem: Rebuilding MIME during execution made a prepared message depend on mutable attachment paths.
- Where: Provider-adapter send path.
- What failed: Claiming an outbox row and then rereading attachment files to construct the submission.
- Working solution: Build and validate complete MIME from account-derived roots before `OutboxRepository.prepare`, store it as a raw SQLite BLOB atomically with idempotency, and retrieve it before claiming.
- Rule for next time: Execution submits only the stored bytes; it never regenerates MIME or rereads preparation-time sources.

## L-005 — Explicit Sent confirmation must be durable
- Problem: `mail_execute` with `verifyOnly` observed Sent but returned the outbox row unchanged, allowing a later execution to claim and submit SMTP.
- Where: Phase 5 application-service reliability slice.
- What failed: Treating an explicit post-ambiguity confirmation as a read-only query.
- Working solution: After exact Message-ID verification succeeds, atomically transition only eligible outbox states to `SENT_VERIFIED`; leave state unchanged when verification is missing.
- Rule for next time: Any successful explicit delivery confirmation must close the durable send state before returning.
