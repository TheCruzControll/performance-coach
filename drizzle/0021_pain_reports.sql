CREATE TABLE "pain_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"workout_id" uuid NOT NULL,
	"exercise_id" uuid,
	"planned_exercise_lineage_id" uuid,
	"exercise_position" integer NOT NULL,
	"body_area" text,
	"severity" text,
	"action" text NOT NULL,
	"substitution_client_id" uuid,
	"note" text,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pain_reports_exercise_position_ck" CHECK ("pain_reports"."exercise_position" >= 1),
	CONSTRAINT "pain_reports_severity_ck" CHECK (severity in ('mild', 'moderate', 'severe')),
	CONSTRAINT "pain_reports_action_ck" CHECK (action in ('stopped', 'substituted', 'ended_workout')),
	CONSTRAINT "pain_reports_substitution_ck" CHECK ("pain_reports"."substitution_client_id" is null or "pain_reports"."action" = 'substituted'),
	CONSTRAINT "pain_reports_note_ck" CHECK (char_length("pain_reports"."note") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "pain_reports" ADD CONSTRAINT "pain_reports_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_reports" ADD CONSTRAINT "pain_reports_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_reports" ADD CONSTRAINT "pain_reports_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pain_reports_owner_reported_idx" ON "pain_reports" USING btree ("owner_id","reported_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "pain_reports_workout_idx" ON "pain_reports" USING btree ("workout_id");