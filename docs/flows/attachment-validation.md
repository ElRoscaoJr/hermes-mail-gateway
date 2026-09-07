# Flow — Attachment validation

## Trigger / entry point

`mail_prepare` receives one or more attachment descriptors.

## Steps

1. Gateway checks that each path is relative to a configured allow-listed root and canonicalizes it.
2. Gateway rejects traversal, symlink escape, special files, unreadable files, unsupported types, and size-limit violations.
3. Gateway computes a content hash and records bounded metadata in the immutable attachment manifest.
4. Gateway builds the prepared message without returning file contents.
5. Before execution, gateway repeats the canonical path and hash check.

## Failure paths

- Any preparation-time failure prevents the outbox transaction from committing.
- Any execution-time change produces `ATTACHMENT_CHANGED`; the message is not submitted.
- Missing/expired paths are never silently omitted.
