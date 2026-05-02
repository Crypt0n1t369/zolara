CREATE TABLE IF NOT EXISTS "pending_web_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "telegram_username" text NOT NULL,
  "telegram_username_normalized" text NOT NULL,
  "role" text DEFAULT 'lead' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "telegram_id" bigint,
  "source" text DEFAULT 'landing_page',
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp DEFAULT now(),
  "linked_at" timestamp
);

CREATE INDEX IF NOT EXISTS "pending_web_profiles_username_status_idx"
  ON "pending_web_profiles" ("telegram_username_normalized", "status");

CREATE INDEX IF NOT EXISTS "pending_web_profiles_telegram_id_idx"
  ON "pending_web_profiles" ("telegram_id");

CREATE UNIQUE INDEX IF NOT EXISTS "pending_web_profiles_pending_username_uniq"
  ON "pending_web_profiles" ("telegram_username_normalized")
  WHERE "status" = 'pending';
