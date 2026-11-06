CREATE TABLE "coach_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence" jsonb,
	"program_id" uuid,
	"base_version_id" uuid,
	"applied_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_proposals_status_ck" CHECK (status in ('proposed', 'accepted', 'rejected', 'applied')),
	CONSTRAINT "coach_proposals_applied_ck" CHECK (("coach_proposals"."status" = 'applied') = ("coach_proposals"."applied_version_id" is not null)),
	CONSTRAINT "coach_proposals_program_ck" CHECK ("coach_proposals"."program_id" is not null or ("coach_proposals"."base_version_id" is null and "coach_proposals"."applied_version_id" is null)),
	CONSTRAINT "coach_proposals_kind_ck" CHECK (char_length("coach_proposals"."kind") > 0),
	CONSTRAINT "coach_proposals_title_ck" CHECK (char_length("coach_proposals"."title") > 0),
	CONSTRAINT "coach_proposals_summary_ck" CHECK (char_length("coach_proposals"."summary") > 0),
	CONSTRAINT "coach_proposals_rationale_ck" CHECK (char_length("coach_proposals"."rationale") > 0)
);
--> statement-breakpoint
CREATE TABLE "cycle_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"block_lineage_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" text NOT NULL,
	"narrative" text,
	"next_version_id" uuid,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_reviews_summary_ck" CHECK (char_length("cycle_reviews"."summary") > 0),
	CONSTRAINT "cycle_reviews_narrative_ck" CHECK (char_length("cycle_reviews"."narrative") > 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"week_starts_on" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" text NOT NULL,
	"narrative" text,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_reviews_week_ck" CHECK (extract(isodow from "weekly_reviews"."week_starts_on") = 1),
	CONSTRAINT "weekly_reviews_summary_ck" CHECK (char_length("weekly_reviews"."summary") > 0),
	CONSTRAINT "weekly_reviews_narrative_ck" CHECK (char_length("weekly_reviews"."narrative") > 0)
);
--> statement-breakpoint
ALTER TABLE "exercise_preferences" ADD COLUMN "exercise_id" uuid;--> statement-breakpoint
ALTER TABLE "exercise_preferences" ADD COLUMN "source" text DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_base_version_id_program_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_applied_version_id_program_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_next_version_id_program_versions_id_fk" FOREIGN KEY ("next_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_reviews" ADD CONSTRAINT "cycle_reviews_proposal_id_coach_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."coach_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_proposal_id_coach_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."coach_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_proposals_owner_status_idx" ON "coach_proposals" USING btree ("owner_id","status","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_reviews_block_uq" ON "cycle_reviews" USING btree ("program_id","block_lineage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_reviews_owner_week_uq" ON "weekly_reviews" USING btree ("owner_id","week_starts_on");--> statement-breakpoint
ALTER TABLE "exercise_preferences" ADD CONSTRAINT "exercise_preferences_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_preferences_owner_exercise_id_uq" ON "exercise_preferences" USING btree ("owner_id","exercise_id") WHERE "exercise_preferences"."exercise_id" is not null;--> statement-breakpoint
ALTER TABLE "exercise_preferences" ADD CONSTRAINT "exercise_preferences_source_ck" CHECK (source in ('onboarding', 'profile', 'swap', 'workout', 'coach'));