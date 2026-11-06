CREATE TABLE "planned_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_id" uuid NOT NULL,
	"lineage_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_on" date NOT NULL,
	"time_of_day" text,
	"order_in_day" integer DEFAULT 1 NOT NULL,
	"discipline" text NOT NULL,
	"custom_discipline" text,
	"session_type" text NOT NULL,
	"title" text NOT NULL,
	"est_minutes" integer NOT NULL,
	"est_load" numeric(6, 1),
	"intensity" text NOT NULL,
	"target_rpe" numeric(3, 1),
	"status" text DEFAULT 'planned' NOT NULL,
	"moved_from" date,
	"source" text NOT NULL,
	"commitment_ref" uuid,
	"instructions" text,
	"notes" text,
	CONSTRAINT "planned_sessions_order_ck" CHECK ("planned_sessions"."order_in_day" >= 1),
	CONSTRAINT "planned_sessions_title_ck" CHECK (char_length("planned_sessions"."title") > 0),
	CONSTRAINT "planned_sessions_est_minutes_ck" CHECK ("planned_sessions"."est_minutes" > 0),
	CONSTRAINT "planned_sessions_est_load_ck" CHECK ("planned_sessions"."est_load" >= 0),
	CONSTRAINT "planned_sessions_intensity_ck" CHECK (intensity in ('easy', 'moderate', 'hard', 'very_hard')),
	CONSTRAINT "planned_sessions_target_rpe_ck" CHECK ("planned_sessions"."target_rpe" between 0 and 10),
	CONSTRAINT "planned_sessions_status_ck" CHECK (status in ('planned', 'skipped', 'moved')),
	CONSTRAINT "planned_sessions_moved_ck" CHECK ("planned_sessions"."status" <> 'moved' or "planned_sessions"."moved_from" is not null)
);
--> statement-breakpoint
CREATE TABLE "program_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"lineage_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"phase" text NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"outline" boolean DEFAULT false NOT NULL,
	"goal_refs" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"progression" jsonb,
	CONSTRAINT "program_blocks_position_ck" CHECK ("program_blocks"."position" >= 1),
	CONSTRAINT "program_blocks_dates_ck" CHECK ("program_blocks"."ends_on" >= "program_blocks"."starts_on"),
	CONSTRAINT "program_blocks_name_ck" CHECK (char_length("program_blocks"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "program_version_blocks" (
	"version_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	CONSTRAINT "program_version_blocks_pk" PRIMARY KEY("version_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "program_version_weeks" (
	"version_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	CONSTRAINT "program_version_weeks_pk" PRIMARY KEY("version_id","week_id")
);
--> statement-breakpoint
CREATE TABLE "program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"parent_version_id" uuid,
	"created_by" text NOT NULL,
	"summary" text NOT NULL,
	"generator" text,
	"input_fingerprint" text,
	"catalogue_digest" text,
	"input_snapshot" jsonb,
	"starts_on" date NOT NULL,
	"first_planned_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_versions_number_ck" CHECK ("program_versions"."number" >= 1),
	CONSTRAINT "program_versions_parent_ck" CHECK (("program_versions"."number" = 1) = ("program_versions"."parent_version_id" is null)),
	CONSTRAINT "program_versions_created_by_ck" CHECK (created_by in ('owner', 'coach', 'rules')),
	CONSTRAINT "program_versions_summary_ck" CHECK (char_length("program_versions"."summary") > 0),
	CONSTRAINT "program_versions_first_planned_day_ck" CHECK ("program_versions"."first_planned_day" between "program_versions"."starts_on" and "program_versions"."starts_on" + 6)
);
--> statement-breakpoint
CREATE TABLE "program_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"lineage_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"index_in_block" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"kind" text NOT NULL,
	"targets" jsonb,
	CONSTRAINT "program_weeks_index_ck" CHECK ("program_weeks"."index_in_block" >= 1),
	CONSTRAINT "program_weeks_span_ck" CHECK ("program_weeks"."ends_on" = "program_weeks"."starts_on" + 6)
);
--> statement-breakpoint
CREATE TABLE "programming_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "programming_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"program_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rule_key" text,
	"summary" text NOT NULL,
	"why" text NOT NULL,
	"decided_by" text NOT NULL,
	"affected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programming_decisions_decided_by_ck" CHECK (decided_by in ('owner', 'coach', 'rules')),
	CONSTRAINT "programming_decisions_summary_ck" CHECK (char_length("programming_decisions"."summary") > 0),
	CONSTRAINT "programming_decisions_why_ck" CHECK (char_length("programming_decisions"."why") > 0)
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "programs_status_ck" CHECK (status in ('active', 'archived')),
	CONSTRAINT "programs_archived_ck" CHECK (("programs"."status" = 'archived') = ("programs"."archived_at" is not null)),
	CONSTRAINT "programs_title_ck" CHECK (char_length("programs"."title") > 0)
);
--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_week_id_program_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."program_weeks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_blocks" ADD CONSTRAINT "program_blocks_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_version_blocks" ADD CONSTRAINT "program_version_blocks_version_id_program_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_version_blocks" ADD CONSTRAINT "program_version_blocks_block_id_program_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."program_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_version_weeks" ADD CONSTRAINT "program_version_weeks_version_id_program_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_version_weeks" ADD CONSTRAINT "program_version_weeks_week_id_program_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."program_weeks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_parent_version_id_program_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_weeks" ADD CONSTRAINT "program_weeks_block_id_program_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."program_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programming_decisions" ADD CONSTRAINT "programming_decisions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programming_decisions" ADD CONSTRAINT "programming_decisions_version_id_program_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_current_version_id_program_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_sessions_week_day_idx" ON "planned_sessions" USING btree ("week_id","scheduled_on","order_in_day");--> statement-breakpoint
CREATE INDEX "planned_sessions_lineage_idx" ON "planned_sessions" USING btree ("lineage_id");--> statement-breakpoint
CREATE INDEX "program_version_weeks_week_idx" ON "program_version_weeks" USING btree ("week_id");--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_program_number_uq" ON "program_versions" USING btree ("program_id","number");--> statement-breakpoint
CREATE INDEX "programming_decisions_program_idx" ON "programming_decisions" USING btree ("program_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "programming_decisions_version_idx" ON "programming_decisions" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_owner_active_uq" ON "programs" USING btree ("owner_id") WHERE "programs"."status" = 'active';