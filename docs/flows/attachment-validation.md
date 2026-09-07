# Flow — Attachment validation

## Trigger / entry point

`mail_prepare` receives one or more attachment descriptors.

## Steps

1. Gateway checks that each path is relative to a configured allow-listed root and canonicalizes it.
2. Gateway rejects traversal, symlink escape, special files, unreadable files, unsupported types, and size-limit violations.
3. Gateway computes a content hash and records bounded metadata in the immutable attachment manifest.
4. Gateway builds the complete MIME before persistence without returning file contents.
5. Gateway persists the raw MIME BLOB atomically with the outbox and idempotency rows.

## Failure paths

- Any preparation-time failure prevents the outbox transaction from committing.
- Source attachment changes after preparation do not affect execution; execution submits the stored MIME and does not reread attachment paths.
- Missing/expired paths during preparation are never silently omitted and leave no outbox or idempotency row.
