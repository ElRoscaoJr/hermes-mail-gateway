ALTER TABLE outbox_messages ADD COLUMN cc TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbox_messages ADD COLUMN bcc TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbox_messages ADD COLUMN reply_to TEXT;
ALTER TABLE outbox_messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE outbox_messages ADD COLUMN references_header TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbox_messages ADD COLUMN forwarding_metadata TEXT;
