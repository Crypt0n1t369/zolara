-- Allow system/project-level audit events that are not tied to a specific member.
-- The original schema used serial for member_id, which made omitted member IDs
-- auto-generate invalid foreign-key values and blocked lifecycle worker summaries.
ALTER TABLE "engagement_events" ALTER COLUMN "member_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "engagement_events" ALTER COLUMN "member_id" DROP NOT NULL;
