ALTER TABLE "problem_definitions" DROP CONSTRAINT "problem_definitions_round_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "bot_username" text;