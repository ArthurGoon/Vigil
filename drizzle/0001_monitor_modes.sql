ALTER TABLE watches ADD COLUMN IF NOT EXISTS monitor_mode text NOT NULL DEFAULT 'text_changed';
ALTER TABLE watches ADD COLUMN IF NOT EXISTS target_text text;
ALTER TABLE watches ALTER COLUMN webhook_url DROP NOT NULL;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT true;
