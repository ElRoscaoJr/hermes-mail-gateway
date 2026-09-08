# Draft lifecycle

1. `mail_prepare` receives `intent:"draft"` and persists immutable raw MIME with a stable Message-ID in `PREPARED` state.
2. `mail_execute` receives only the strict action `{type:"saveDraft", messageId}`. It verifies account ownership, draft intent, and `PREPARED` state.
3. The gateway resolves the account's configured `draftsFolder`, or discovers the selectable folder with special-use `\\Drafts`. It never guesses a localized name and never uses Sent.
4. Immediately before IMAP APPEND, the durable row becomes `APPEND_STARTED`. The adapter appends the stored bytes with `\\Draft` while holding the exact mailbox lock, then confirms the exact Message-ID and flag and captures UID/UIDVALIDITY.
5. Only confirmed provider metadata is persisted as `SAVED` and returned as a safe opaque reference, folder, UID, state, and Message-ID. Repeating `saveDraft` returns the same confirmed reference without another APPEND.
6. If APPEND begins and the outcome is not confirmed, the row remains non-retryable verification-required (`APPEND_STARTED`). A later call never appends again. `cancelPrepared` is allowed only before provider submission.
7. Existing `mail_query` `folders`, `list`, and `read` operations read drafts by the discovered/configured folder and account-bound opaque reference. Raw MIME, credentials, and provider diagnostics remain private.
