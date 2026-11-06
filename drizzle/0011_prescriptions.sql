CREATE TABLE "planned_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"lineage_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"exercise_id" uuid NOT NULL,
	"superset" integer,
	"baseline_lift" text,
	"substituted_from_exercise_id" uuid,
	"substitution_reason" text,
	"instructions" text,
	"notes" text,
	CONSTRAINT "planned_exercises_position_ck" CHECK ("planned_exercises"."position" >= 1),
	CONSTRAINT "planned_exercises_superset_ck" CHECK ("planned_exercises"."superset" >= 1),
	CONSTRAINT "planned_exercises_substitution_ck" CHECK (("planned_exercises"."substituted_from_exercise_id" is null) = ("planned_exercises"."substitution_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "planned_run_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"repeat_group" integer,
	"repeats" integer,
	"distance_m" integer,
	"duration_s" integer,
	"pace_min_s_per_km" integer,
	"pace_max_s_per_km" integer,
	"hr_zone" integer,
	"target_rpe" numeric(3, 1),
	CONSTRAINT "planned_run_segments_position_ck" CHECK ("planned_run_segments"."position" >= 1),
	CONSTRAINT "planned_run_segments_repeats_ck" CHECK (("planned_run_segments"."repeat_group" is null) = ("planned_run_segments"."repeats" is null) and "planned_run_segments"."repeat_group" >= 1 and "planned_run_segments"."repeats" >= 2),
	CONSTRAINT "planned_run_segments_measure_ck" CHECK ("planned_run_segments"."distance_m" is not null or "planned_run_segments"."duration_s" is not null),
	CONSTRAINT "planned_run_segments_distance_ck" CHECK ("planned_run_segments"."distance_m" >= 1),
	CONSTRAINT "planned_run_segments_duration_ck" CHECK ("planned_run_segments"."duration_s" >= 1),
	CONSTRAINT "planned_run_segments_pace_ck" CHECK (("planned_run_segments"."pace_min_s_per_km" is null) = ("planned_run_segments"."pace_max_s_per_km" is null) and "planned_run_segments"."pace_min_s_per_km" between 1 and "planned_run_segments"."pace_max_s_per_km"),
	CONSTRAINT "planned_run_segments_hr_zone_ck" CHECK ("planned_run_segments"."hr_zone" between 1 and 5),
	CONSTRAINT "planned_run_segments_target_rpe_ck" CHECK ("planned_run_segments"."target_rpe" between 1 and 10 and "planned_run_segments"."target_rpe" * 2 = trunc("planned_run_segments"."target_rpe" * 2))
);
--> statement-breakpoint
CREATE TABLE "planned_session_details" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"target_rpe" numeric(3, 1),
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	CONSTRAINT "planned_session_details_duration_ck" CHECK ("planned_session_details"."duration_minutes" >= 1),
	CONSTRAINT "planned_session_details_target_rpe_ck" CHECK ("planned_session_details"."target_rpe" between 1 and 10 and "planned_session_details"."target_rpe" * 2 = trunc("planned_session_details"."target_rpe" * 2)),
	CONSTRAINT "planned_session_details_metrics_ck" CHECK (jsonb_typeof("planned_session_details"."metrics") = 'array')
);
--> statement-breakpoint
CREATE TABLE "set_prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"planned_exercise_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"sets" integer NOT NULL,
	"reps_min" integer,
	"reps_max" integer,
	"seconds" integer,
	"metres" integer,
	"target_rpe" numeric(3, 1),
	"load_kind" text NOT NULL,
	"load_value" numeric,
	"load_unit" text,
	"load_basis" text,
	"reference_1rm" numeric,
	"reference_1rm_unit" text,
	"rest_seconds" integer,
	"tempo" text,
	"notes" text,
	CONSTRAINT "set_prescriptions_position_ck" CHECK ("set_prescriptions"."position" >= 1),
	CONSTRAINT "set_prescriptions_sets_ck" CHECK ("set_prescriptions"."sets" between 1 and 20),
	CONSTRAINT "set_prescriptions_reps_ck" CHECK (("set_prescriptions"."reps_min" is null) = ("set_prescriptions"."reps_max" is null) and "set_prescriptions"."reps_min" between 1 and "set_prescriptions"."reps_max" and "set_prescriptions"."reps_max" <= 100),
	CONSTRAINT "set_prescriptions_seconds_ck" CHECK ("set_prescriptions"."seconds" between 1 and 3600),
	CONSTRAINT "set_prescriptions_metres_ck" CHECK ("set_prescriptions"."metres" between 1 and 10000),
	CONSTRAINT "set_prescriptions_measure_ck" CHECK (num_nonnulls(coalesce("set_prescriptions"."reps_min", "set_prescriptions"."reps_max"), "set_prescriptions"."seconds", "set_prescriptions"."metres") = 1),
	CONSTRAINT "set_prescriptions_target_rpe_ck" CHECK ("set_prescriptions"."target_rpe" between 5 and 10 and "set_prescriptions"."target_rpe" * 2 = trunc("set_prescriptions"."target_rpe" * 2)),
	CONSTRAINT "set_prescriptions_rest_ck" CHECK ("set_prescriptions"."rest_seconds" between 0 and 900),
	CONSTRAINT "set_prescriptions_tempo_ck" CHECK ("set_prescriptions"."tempo" ~ '^[0-9X]{4}$'),
	CONSTRAINT "set_prescriptions_load_kind_ck" CHECK (load_kind in ('absolute', 'percent_1rm', 'rpe_based', 'from_e1rm')),
	CONSTRAINT "set_prescriptions_load_unit_ck" CHECK (load_unit in ('kg', 'lb')),
	CONSTRAINT "set_prescriptions_load_basis_ck" CHECK (load_basis in ('measured', 'estimated')),
	CONSTRAINT "set_prescriptions_reference_1rm_unit_ck" CHECK (reference_1rm_unit in ('kg', 'lb')),
	CONSTRAINT "set_prescriptions_load_needs_ck" CHECK (case "set_prescriptions"."load_kind" when 'absolute' then "set_prescriptions"."load_value" is not null and "set_prescriptions"."load_unit" is not null and "set_prescriptions"."load_basis" is null and "set_prescriptions"."reference_1rm" is null and "set_prescriptions"."reference_1rm_unit" is null when 'percent_1rm' then "set_prescriptions"."load_value" is not null and "set_prescriptions"."load_unit" is null and "set_prescriptions"."load_basis" is not null and "set_prescriptions"."reference_1rm" is not null and "set_prescriptions"."reference_1rm_unit" is not null when 'rpe_based' then "set_prescriptions"."load_value" is null and "set_prescriptions"."load_unit" is null and "set_prescriptions"."load_basis" is null and "set_prescriptions"."reference_1rm" is null and "set_prescriptions"."reference_1rm_unit" is null when 'from_e1rm' then "set_prescriptions"."load_value" is not null and "set_prescriptions"."load_unit" is null and "set_prescriptions"."load_basis" is null and "set_prescriptions"."reference_1rm" is null and "set_prescriptions"."reference_1rm_unit" is null else true end),
	CONSTRAINT "set_prescriptions_rpe_based_ck" CHECK ("set_prescriptions"."load_kind" <> 'rpe_based' or "set_prescriptions"."target_rpe" is not null),
	CONSTRAINT "set_prescriptions_load_value_ck" CHECK (case "set_prescriptions"."load_kind" when 'absolute' then case "set_prescriptions"."load_unit" when 'kg' then "set_prescriptions"."load_value" between 1 and 500 when 'lb' then "set_prescriptions"."load_value" between 2 and 1100 else true end when 'percent_1rm' then "set_prescriptions"."load_value" between 0.3 and 1 when 'from_e1rm' then "set_prescriptions"."load_value" between 0.3 and 1 else true end),
	CONSTRAINT "set_prescriptions_reference_1rm_ck" CHECK (case "set_prescriptions"."reference_1rm_unit" when 'kg' then "set_prescriptions"."reference_1rm" between 1 and 500 when 'lb' then "set_prescriptions"."reference_1rm" between 2 and 1100 else true end)
);
--> statement-breakpoint
ALTER TABLE "planned_exercises" ADD CONSTRAINT "planned_exercises_session_id_planned_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."planned_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_exercises" ADD CONSTRAINT "planned_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_exercises" ADD CONSTRAINT "planned_exercises_substituted_from_exercise_id_exercises_id_fk" FOREIGN KEY ("substituted_from_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_run_segments" ADD CONSTRAINT "planned_run_segments_session_id_planned_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."planned_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_session_details" ADD CONSTRAINT "planned_session_details_session_id_planned_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."planned_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_prescriptions" ADD CONSTRAINT "set_prescriptions_planned_exercise_id_planned_exercises_id_fk" FOREIGN KEY ("planned_exercise_id") REFERENCES "public"."planned_exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planned_exercises_session_position_uq" ON "planned_exercises" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_run_segments_session_position_uq" ON "planned_run_segments" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "set_prescriptions_exercise_position_uq" ON "set_prescriptions" USING btree ("planned_exercise_id","position");