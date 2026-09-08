ALTER TABLE outbox_messages ADD COLUMN draft_save_status TEXT NOT NULL DEFAULT 'NOT_SAVED' CHECK (draft_save_status IN ('NOT_SAVED', 'APPEND_STARTED', 'SAVED'));
ALTER TABLE outbox_messages ADD COLUMN draft_provider_reference TEXT;
ALTER TABLE outbox_messages ADD COLUMN draft_folder TEXT;
ALTER TABLE outbox_messages ADD COLUMN draft_uid INTEGER;
ALTER TABLE outbox_messages ADD COLUMN draft_uid_validity INTEGER;
