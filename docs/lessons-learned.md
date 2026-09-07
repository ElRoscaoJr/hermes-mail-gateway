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
