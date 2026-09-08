# Competitive landscape — Hermes Mail Gateway

## Scope and sources

This scan covers the candidate connectors and the current local baseline. Facts were checked against repository READMEs, source code, npm metadata, and live GitHub metadata on 2026-09-07.

## Competitor inventory

### Himalaya
- URL: https://github.com/pimalaya/himalaya
- Category: IMAP/SMTP terminal mail client.
- Strengths: Mature protocol client and usable interactive CLI.
- Relevant functionality: account-based IMAP/SMTP operations, folders, messages, compose/send.
- Gap for this project: not a durable semantic agent backend; the local v1.2.0 workflow exposed parser, attachment, Sent-copy, and retry problems.
- Status: mature client; not selected as the write backend.

### 1amSheldon/mail-mcp v2.0.1
- URL: https://github.com/1amSheldon/mail-mcp
- License: MIT.
- Category: multi-provider MCP email server.
- Checked release: v2.0.1, commit `feaa2fc1451e1002a9a407b20fdfbce98436b0c4`.
- Relevant functionality: 3 MCP tools, accountId routing, IMAP/SMTP, MIME/attachments, drafts, replies, Sent verification, provider-aware Sent policy, structured SMTP outcome states, keychain credentials, confirmation/audit/redaction flags.
- Verified quality: 50 test files and 788 tests pass; stdio and HTTP smoke tests pass.
- Gaps: project created in 2026-08; 0 GitHub stars at scan time; normal tests use mocks/local fixtures rather than real Gmail/Zoho; no persistent idempotency outbox; `--confirm` is a two-call model token, not human approval; published lock initially reported one high and one moderate npm vulnerability.
- Status: useful design reference and possible code reference; not deployed unchanged.

### tecnologicachile/mail-mcp
- URL: https://github.com/tecnologicachile/mail-mcp
- License: MIT.
- Category: Rust multi-provider MCP mail server.
- Checked release: v0.4.10, commit `229404563d35c1d318b4dec177a74d679044c205`.
- Relevant functionality: 31-ish provider-specific tools, IMAP/SMTP, Gmail/Zoho provider-aware Sent behavior, OAuth2, Microsoft Graph, EWS, attachments, reply/forward.
- Strengths: older and more adopted than the other candidate; 76 stars and 23 forks at scan time; 84 Rust test markers in the shallow release checkout.
- Gaps: larger tool surface; no verified persistent idempotency; no equivalent durable `smtp_outcome_unknown` / `retrySafe` / `verifySentMessage` contract.
- Status: not selected for v1; useful comparison and fallback.

### Gmail API and Zoho Mail API
- Gmail send/draft docs: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send
- Zoho API index: https://www.zoho.com/mail/help/api/
- Strengths: official provider APIs, OAuth support, Gmail draft-send semantics, native provider resources.
- Gaps: two provider-specific adapters and OAuth flows; HTTP timeouts can still leave delivery ambiguous; an outbox and verification layer remain necessary.
- Status: future adapters, not required for v1.

## Unified feature baseline

The v1 must provide:

- Multi-account selection with `accountId`.
- Bounded listing/search and paginated reads.
- Message and thread reading.
- Attachment metadata and safe retrieval.
- MIME composition with attachments.
- Reply/forward threading.
- Durable draft/outbox preparation.
- Idempotent execution.
- Structured delivery states.
- Exact Message-ID verification in Sent.
- Account-specific Sent-copy policy.
- Redacted audit logging.
- Credentials outside repository and model context.
- Destructive operations disabled by default.

## Honest opportunity

### Table stakes

Use the baseline above, but keep the exposed MCP surface to four semantic tools rather than one tool per mailbox or dozens of provider-specific tools.

### Differentiator

The differentiator is not supporting many providers. It is a small, self-hosted, failure-safe send lifecycle designed around persistent idempotency and explicit unknown-delivery handling.

### AI/MCP value

Added value: `accountId` plus semantic query/prepare/execute tools reduces model selection errors and makes the send lifecycle inspectable. Provider breadth beyond Gmail, Zoho, and generic IMAP/SMTP is explicitly dropped from v1 as forced scope.
