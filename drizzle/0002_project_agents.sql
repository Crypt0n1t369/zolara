CREATE TABLE IF NOT EXISTS "project_agents" (
  "id" serial PRIMARY KEY,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE UNIQUE,
  "session_key" text,
  "agent_type" text NOT NULL DEFAULT 'team_coordinator',
  "config" text DEFAULT '{}',
  "display_name" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW(),
  "deleted_at" timestamp,
  "restore_until" timestamp
);
CREATE INDEX IF NOT EXISTS "project_agents_status_idx" ON "project_agents"("status");
