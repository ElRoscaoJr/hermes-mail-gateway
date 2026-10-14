# Capabilities and release boundaries

## Transport and reuse

Gmail, Zoho and generic providers use IMAP/SMTP with operator-provisioned credentials (including app passwords where supported). OAuth, Gmail REST, Zoho REST and Microsoft Graph are not implemented. Provider account policies must permit IMAP/SMTP. No provider-specific labels/tags parity is claimed.

Configure each installation independently, outside the repository: explicit account IDs, endpoints, selectable inbox/sent folders, optional drafts folder, sender policy, attachment roots, database and keychain references. Do not copy another agent's credentials. The four-tool contract remains account-scoped.

## Query modes

- `folders`: selectable server paths and optional special-use role; never assume localized names.
- `list` / `search`: ascending UID pages in one folder. Server-side filters: from/to/cc/subject/since/before/read/flagged/Message-ID. `hasAttachment` is unsupported and rejected.
- `searchScope: allFolders`: deduplicated Message-ID results sorted by date descending, folder then UID, with continuation cursor. Maximum 100 folders and 100–2,000 candidates (dependent on requested page size). Oversized queries return `QUERY_TOO_LARGE`, not a supposedly complete partial result.
- UID searches use windows of at most 1,024 UID values. Single-folder scan budget: 128 windows; global/thread budget: 512 total windows. Sparse high-UID mailboxes may exceed this budget even with few matches. Narrowing text filters alone does not necessarily reduce UID-range scan work. This is a bounded implementation, not universal webmail search parity.
- Cursors are opaque encoded values, not credentials or authorization grants. Account and query scope are validated. Global cursors reject changed folder generations/UIDNEXT. They are not transactional snapshots: external flag changes/deletions can change subsequent results; restart the query when consistency matters.
- `read`: verified bounded full MIME read; public response contains bodies and attachment metadata, not raw MIME or attachment content. Full MIME is fetched in contiguous chunks of at most 64 KiB, with a one-byte probe at the accumulated offset requiring an explicit zero-length `BODY[]` literal to confirm EOF. Missing source data is not EOF; a short interior chunk followed by more bytes fails closed. Every fetch must retain the requested UID and mailbox generation. `RFC822.SIZE` must be valid nonnegative integer metadata but is only a hint, not proof of completeness or the read-limit decision: overstated and understated hints are tolerated when the actual bytes and EOF verify. A byte beyond the configured read bound returns `MESSAGE_TOO_LARGE`; exactly the bound is accepted only after explicit EOF. Successful full reads report the verified raw MIME byte count as `size`; list/search metadata may still carry the provider's size hint.
- `attachments`: metadata by default; explicit zero-based `attachmentIndex` selects a bounded base64 download. Base64 expands response size; receiving agents must provision an adequate tool-output budget. SHA-256 identifies returned bytes, not provider authenticity.
- `thread`: bounded relationships inferred from the anchor's Message-ID, In-Reply-To and References across selectable folders or current folder. This is not recursive provider-native conversation discovery. A successful result means the bounded anchor-derived lookup completed, not that every possible descendant or malformed-header message exists in the result. Optional bodies: at most 20 messages, aggregate bound and per-message verified read bound. The aggregate budget sums each completed read's verified raw MIME byte count, not the summaries' `RFC822.SIZE` hints; crossing it returns `THREAD_TOO_LARGE`, not a partial successful thread. This counts full MIME, including encoded attachments, rather than only displayed body text. No embedded attachment bytes. These are verified raw-byte budgets, not strict heap-memory ceilings: one additional per-message-bounded read may complete before aggregate overflow is detected, and MIME parsing, chunk concatenation and attachment copies add transient allocations. EOF verification assumes a conforming server; it does not authenticate the bytes, detect dishonest EOF claims or guarantee a snapshot across multiple fetches.

## Outgoing mail and drafts

Send/reply/forward use durable prepared MIME, stable Message-ID, To/CC/BCC, attachment manifests, account policy and idempotency. BCC is not exposed in received public projections. SMTP acknowledgment and Sent verification are separate outcomes. Unknown delivery and acknowledged-but-unverified sends cannot be blindly retried. Sent policy is explicit; Gmail/Zoho default to provider-managed copies.

Draft intent may omit recipients. `saveDraft` appends persisted MIME once with Draft flag to configured/discovered Drafts; ambiguous writes remain verification-required. Saved drafts can be read and moved to Trash via their mailbox reference. Editing/sending an existing provider draft in place and automated ambiguous-draft reconciliation are not implemented. Prepare a new message deliberately rather than claiming provider draft lifecycle parity.

## Mailbox actions

Mark read/unread, add/remove standard Flagged/Answered flags, move/copy, Trash and restore. Archive uses move/copy to a discovered operator-selected archive folder; no dedicated archive action. Trash discovery requires a selectable special-use Trash role. Restore targets configured Inbox, not the former folder. No EXPUNGE or permanent delete API is exposed. MOVE/COPY require provider UIDPLUS-style destination mapping; a successful server write with an unconfirmable response is not safe to blindly repeat.

## Verification and deployment

Local tests and synthetic IMAP fixtures demonstrate application/protocol behavior only. They do not demonstrate Gmail/Zoho live compatibility. Run typecheck, build, full tests, audit, scoped secret/diff checks and compiled stdio protocol tests before release. Then perform separately authorized read-only provider validation. Never send test email without an approved controlled recipient.

Code merged on GitHub does not update an already running MCP process. Each agent must install the release, compile, provision its own external config/credentials, reload its MCP and verify actual tool discovery plus provider behavior. Do not claim deployment from repository presence alone.
