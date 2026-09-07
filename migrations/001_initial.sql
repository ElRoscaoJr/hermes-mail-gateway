CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, provider_kind TEXT NOT NULL,
  imap_endpoint TEXT NOT NULL, smtp_endpoint TEXT NOT NULL, credential_ref TEXT NOT NULL,
  sent_policy TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  allowed_sender TEXT NOT NULL, mailbox_policy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_messages (
  message_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
  idempotency_key TEXT NOT NULL, message_id_header TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL, recipients TEXT NOT NULL, subject TEXT NOT NULL,
  text_body TEXT, html_body TEXT, attachment_manifest TEXT NOT NULL,
  state TEXT NOT NULL, attempt_owner TEXT, lease_until TEXT, provider_evidence TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id TEXT NOT NULL REFERENCES accounts(account_id), idempotency_key TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES outbox_messages(message_id), request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(account_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, caller TEXT NOT NULL,
  tool TEXT NOT NULL, account_id TEXT, message_id TEXT, old_state TEXT, new_state TEXT,
  outcome_code TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at);
