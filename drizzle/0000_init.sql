CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_uidx" ON "users" ("email");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_uidx" ON "sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "magic_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "magic_links_token_hash_uidx" ON "magic_links" ("token_hash");

CREATE TABLE IF NOT EXISTS "watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "css_selector" text,
  "interval_minutes" integer DEFAULT 360 NOT NULL,
  "webhook_url" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_checked_at" timestamptz,
  "last_changed_at" timestamptz,
  "last_manual_check_at" timestamptz,
  "last_status" text DEFAULT 'ok' NOT NULL,
  "last_error" text,
  "consecutive_errors" integer DEFAULT 0 NOT NULL,
  "next_check_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "watches_user_idx" ON "watches" ("user_id");
CREATE INDEX IF NOT EXISTS "watches_next_check_idx" ON "watches" ("next_check_at");

CREATE TABLE IF NOT EXISTS "snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "watch_id" uuid NOT NULL REFERENCES "watches"("id") ON DELETE CASCADE,
  "content_hash" text NOT NULL,
  "content_text" text NOT NULL,
  "http_status" integer,
  "fetched_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "snapshots_watch_fetched_idx" ON "snapshots" ("watch_id", "fetched_at");

CREATE TABLE IF NOT EXISTS "change_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "watch_id" uuid NOT NULL REFERENCES "watches"("id") ON DELETE CASCADE,
  "old_snapshot_id" uuid REFERENCES "snapshots"("id") ON DELETE SET NULL,
  "new_snapshot_id" uuid REFERENCES "snapshots"("id") ON DELETE SET NULL,
  "diff_summary" text NOT NULL,
  "notified_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "change_events_watch_idx" ON "change_events" ("watch_id");

CREATE TABLE IF NOT EXISTS "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "anonymous_id" text,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "session_id" text,
  "name" text NOT NULL,
  "props" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip_hash" text,
  "ua_hash" text
);
CREATE INDEX IF NOT EXISTS "events_name_occurred_idx" ON "events" ("name", "occurred_at");
CREATE INDEX IF NOT EXISTS "events_user_idx" ON "events" ("user_id");
CREATE INDEX IF NOT EXISTS "events_occurred_idx" ON "events" ("occurred_at");
