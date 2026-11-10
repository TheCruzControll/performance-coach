DROP INDEX "cycle_reviews_block_uq";--> statement-breakpoint
DROP INDEX "weekly_reviews_owner_week_uq";--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "block_starts_on" date;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "block_ends_on" date;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "snapshot_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "analytics_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "inputs_digest" text;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "narrative_run_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "narrative_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "narrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "snapshot_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "analytics_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "inputs_digest" text;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "narrative_run_id" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "narrative_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "narrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_version_id_program_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_narrative_run_id_agent_runs_id_fk" FOREIGN KEY ("narrative_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_narrative_thread_id_coach_threads_id_fk" FOREIGN KEY ("narrative_thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_superseded_by_cycle_reviews_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."cycle_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_version_id_program_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_narrative_run_id_agent_runs_id_fk" FOREIGN KEY ("narrative_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_narrative_thread_id_coach_threads_id_fk" FOREIGN KEY ("narrative_thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_superseded_by_weekly_reviews_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_reviews_block_revision_uq" ON "cycle_reviews" USING btree ("program_id","block_lineage_id","revision");--> statement-breakpoint
CREATE INDEX "cycle_reviews_owner_ends_idx" ON "cycle_reviews" USING btree ("owner_id","block_ends_on" DESC NULLS FIRST) WHERE "cycle_reviews"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_reviews_owner_week_revision_uq" ON "weekly_reviews" USING btree ("owner_id","week_starts_on","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_reviews_block_uq" ON "cycle_reviews" USING btree ("program_id","block_lineage_id") WHERE "cycle_reviews"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_reviews_owner_week_uq" ON "weekly_reviews" USING btree ("owner_id","week_starts_on") WHERE "weekly_reviews"."superseded_at" is null;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_versions_ck" CHECK ("cycle_reviews"."snapshot_version" >= 0 and "cycle_reviews"."analytics_version" >= 0);--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_revision_ck" CHECK ("cycle_reviews"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_superseded_ck" CHECK (("cycle_reviews"."superseded_at" is null) = ("cycle_reviews"."superseded_by" is null));--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_analytics_ck" CHECK ("cycle_reviews"."snapshot_version" < 1 or "cycle_reviews"."analytics_version" >= 1);--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_digest_ck" CHECK (coalesce(char_length("cycle_reviews"."inputs_digest") > 0, "cycle_reviews"."snapshot_version" < 1));--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_narrated_ck" CHECK ("cycle_reviews"."snapshot_version" < 1 or ("cycle_reviews"."narrative" is null) = ("cycle_reviews"."narrated_at" is null));--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_block_ck" CHECK ("cycle_reviews"."snapshot_version" < 1 or ("cycle_reviews"."version_id" is not null and "cycle_reviews"."block_starts_on" is not null and "cycle_reviews"."block_ends_on" >= "cycle_reviews"."block_starts_on") is true);--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_versions_ck" CHECK ("weekly_reviews"."snapshot_version" >= 0 and "weekly_reviews"."analytics_version" >= 0);--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_revision_ck" CHECK ("weekly_reviews"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_superseded_ck" CHECK (("weekly_reviews"."superseded_at" is null) = ("weekly_reviews"."superseded_by" is null));--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_analytics_ck" CHECK ("weekly_reviews"."snapshot_version" < 1 or "weekly_reviews"."analytics_version" >= 1);--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_digest_ck" CHECK (coalesce(char_length("weekly_reviews"."inputs_digest") > 0, "weekly_reviews"."snapshot_version" < 1));--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_narrated_ck" CHECK ("weekly_reviews"."snapshot_version" < 1 or ("weekly_reviews"."narrative" is null) = ("weekly_reviews"."narrated_at" is null));--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_program_ck" CHECK ("weekly_reviews"."snapshot_version" < 1 or "weekly_reviews"."version_id" is null or "weekly_reviews"."program_id" is not null);