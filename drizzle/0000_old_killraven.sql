CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"round_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assigned_to" serial NOT NULL,
	"status" text DEFAULT 'pending',
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"admin_id" bigint,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "admins_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "engagement_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" serial NOT NULL,
	"project_id" uuid,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"user_id" bigint,
	"role" text DEFAULT 'participant',
	"commitment_level" text DEFAULT 'active',
	"project_profile" jsonb DEFAULT '{}'::jsonb,
	"contribution_score" integer DEFAULT 0,
	"member_level" integer DEFAULT 0,
	"onboarding_status" text DEFAULT 'fresh',
	"certificate_issued" boolean DEFAULT false,
	"joined_at" timestamp DEFAULT now(),
	"last_active" timestamp
);
--> statement-breakpoint
CREATE TABLE "problem_definition_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"problem_definition_id" uuid,
	"member_id" serial NOT NULL,
	"vote" text NOT NULL,
	"vote_text" text,
	"voted_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "problem_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"round_id" uuid,
	"topic_text" text NOT NULL,
	"refined_text" text,
	"status" text DEFAULT 'pending',
	"vote_deadline" timestamp,
	"votes_received" integer DEFAULT 0,
	"total_voters" integer DEFAULT 0,
	"confidence_score" integer,
	"clarification_round" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" bigint,
	"bot_telegram_id" bigint,
	"bot_token_hash" text,
	"bot_token_encrypted" text,
	"webhook_secret" text,
	"encrypted_api_key" text,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{"cycleFrequency":"weekly","questionsPerRound":3,"questionDepth":"medium","anonymity":"optional","votingMechanism":"poll","reportFrequency":"per_cycle","actionTracking":true,"nudgeAfterHours":24,"language":"en","timezone":"UTC"}'::jsonb NOT NULL,
	"master_prompt" text,
	"status" text DEFAULT 'pending',
	"channel_id" bigint,
	"group_ids" bigint[],
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "projects_bot_telegram_id_unique" UNIQUE("bot_telegram_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid,
	"member_id" serial NOT NULL,
	"question_text" text NOT NULL,
	"question_type" text DEFAULT 'open',
	"telegram_message_id" bigint,
	"sent_at" timestamp DEFAULT now(),
	"answered_at" timestamp,
	"follow_up_of" uuid
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid,
	"project_id" uuid,
	"content" text NOT NULL,
	"structured_data" jsonb NOT NULL,
	"telegram_message_id" bigint,
	"reactions" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid,
	"member_id" serial NOT NULL,
	"response_text" text,
	"response_data" jsonb,
	"telegram_message_id" bigint,
	"created_at" timestamp DEFAULT now(),
	"analyzed" boolean DEFAULT false,
	"analysis" jsonb
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"round_number" serial NOT NULL,
	"topic" text,
	"status" text DEFAULT 'scheduled',
	"round_type" text DEFAULT 'alignment',
	"scope" text DEFAULT 'group',
	"scope_member_ids" bigint[],
	"scheduled_for" timestamp,
	"started_at" timestamp,
	"deadline" timestamp,
	"deadline_extended_count" integer DEFAULT 0,
	"completed_at" timestamp,
	"anonymity" text,
	"convergence_score" text,
	"convergence_tier" text,
	"response_count" integer DEFAULT 0,
	"member_count" integer,
	"retry_count" integer DEFAULT 0,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"sub_problem_id" uuid,
	"problem_definition_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sub_problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"problem_text" text NOT NULL,
	"status" text DEFAULT 'todo',
	"priority" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"display_name" text,
	"language" text DEFAULT 'en',
	"timezone" text,
	"communication_profile" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_assigned_to_members_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_definition_votes" ADD CONSTRAINT "problem_definition_votes_problem_definition_id_problem_definitions_id_fk" FOREIGN KEY ("problem_definition_id") REFERENCES "public"."problem_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_definition_votes" ADD CONSTRAINT "problem_definition_votes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_definitions" ADD CONSTRAINT "problem_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_definitions" ADD CONSTRAINT "problem_definitions_round_id_projects_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_sub_problem_id_sub_problems_id_fk" FOREIGN KEY ("sub_problem_id") REFERENCES "public"."sub_problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_problem_definition_id_problem_definitions_id_fk" FOREIGN KEY ("problem_definition_id") REFERENCES "public"."problem_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_problems" ADD CONSTRAINT "sub_problems_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_definition_votes_member_idx" ON "problem_definition_votes" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "problem_definitions_project_idx" ON "problem_definitions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "problem_definitions_status_idx" ON "problem_definitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_admin_idx" ON "projects" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "rounds_project_idx" ON "rounds" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rounds_status_idx" ON "rounds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sub_problems_project_idx" ON "sub_problems" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sub_problems_status_idx" ON "sub_problems" USING btree ("status");