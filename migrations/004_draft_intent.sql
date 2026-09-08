ALTER TABLE outbox_messages ADD COLUMN intent TEXT NOT NULL DEFAULT 'send' CHECK (intent IN ('send', 'draft'));
