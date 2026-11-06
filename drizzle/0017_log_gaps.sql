ALTER TABLE "set_records" DROP CONSTRAINT "set_records_missed_reps_ck";--> statement-breakpoint
ALTER TABLE "set_records" DROP CONSTRAINT "set_records_seconds_ck";--> statement-breakpoint
ALTER TABLE "set_records" ADD COLUMN "assistance" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD COLUMN "exercise_position" integer;--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workout_substitutions_workout_idx" ON "workout_substitutions" USING btree ("workout_id");--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_measure_ck" CHECK ("set_records"."is_skipped" or num_nonnulls("set_records"."reps", "set_records"."seconds", "set_records"."metres") > 0);--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_assistance_ck" CHECK ("set_records"."assistance" > 0);--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_load_ck" CHECK ("set_records"."weight" is null or "set_records"."assistance" is null);--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_missed_reps_ck" CHECK ("set_records"."missed_reps" between 0 and 50 and ("set_records"."missed_reps" = 0 or "set_records"."reps" is not null));--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_seconds_ck" CHECK ("set_records"."seconds" between 1 and 86400);--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD CONSTRAINT "workout_substitutions_exercise_position_ck" CHECK ("workout_substitutions"."exercise_position" >= 1);