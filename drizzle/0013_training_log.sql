CREATE TABLE "other_session_records" (
	"workout_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"rpe" numeric(3, 1),
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "other_session_records_duration_ck" CHECK ("other_session_records"."duration_minutes" >= 1),
	CONSTRAINT "other_session_records_rpe_ck" CHECK ("other_session_records"."rpe" between 1 and 10 and "other_session_records"."rpe" * 2 = trunc("other_session_records"."rpe" * 2)),
	CONSTRAINT "other_session_records_metrics_ck" CHECK (jsonb_typeof("other_session_records"."metrics") = 'array')
);
--> statement-breakpoint
CREATE TABLE "recovery_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"noted_on" date NOT NULL,
	"sleep_hours" numeric(3, 1),
	"soreness" integer,
	"energy" integer,
	"stress" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_notes_sleep_ck" CHECK ("recovery_notes"."sleep_hours" between 0 and 24),
	CONSTRAINT "recovery_notes_soreness_ck" CHECK ("recovery_notes"."soreness" between 1 and 5),
	CONSTRAINT "recovery_notes_energy_ck" CHECK ("recovery_notes"."energy" between 1 and 5),
	CONSTRAINT "recovery_notes_stress_ck" CHECK ("recovery_notes"."stress" between 1 and 5),
	CONSTRAINT "recovery_notes_note_ck" CHECK (char_length("recovery_notes"."note") > 0),
	CONSTRAINT "recovery_notes_content_ck" CHECK (num_nonnulls("recovery_notes"."sleep_hours", "recovery_notes"."soreness", "recovery_notes"."energy", "recovery_notes"."stress", "recovery_notes"."note") > 0)
);
--> statement-breakpoint
CREATE TABLE "run_record_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"workout_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"distance_m" numeric,
	"duration_s" integer,
	"pace_s_per_km" numeric GENERATED ALWAYS AS (case when "run_record_segments"."distance_m" > 0 then "run_record_segments"."duration_s" * 1000.0 / "run_record_segments"."distance_m" end) STORED,
	"avg_hr" integer,
	"rpe" numeric(3, 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_record_segments_position_ck" CHECK ("run_record_segments"."position" >= 1),
	CONSTRAINT "run_record_segments_measure_ck" CHECK ("run_record_segments"."distance_m" is not null or "run_record_segments"."duration_s" is not null),
	CONSTRAINT "run_record_segments_distance_ck" CHECK ("run_record_segments"."distance_m" > 0),
	CONSTRAINT "run_record_segments_duration_ck" CHECK ("run_record_segments"."duration_s" >= 1),
	CONSTRAINT "run_record_segments_avg_hr_ck" CHECK ("run_record_segments"."avg_hr" between 20 and 250),
	CONSTRAINT "run_record_segments_rpe_ck" CHECK ("run_record_segments"."rpe" between 1 and 10 and "run_record_segments"."rpe" * 2 = trunc("run_record_segments"."rpe" * 2))
);
--> statement-breakpoint
CREATE TABLE "run_records" (
	"workout_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"distance_m" numeric,
	"duration_s" integer,
	"pace_s_per_km" numeric GENERATED ALWAYS AS (case when "run_records"."distance_m" > 0 then "run_records"."duration_s" * 1000.0 / "run_records"."distance_m" end) STORED,
	"avg_hr" integer,
	"rpe" numeric(3, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_records_distance_ck" CHECK ("run_records"."distance_m" > 0),
	CONSTRAINT "run_records_duration_ck" CHECK ("run_records"."duration_s" >= 1),
	CONSTRAINT "run_records_avg_hr_ck" CHECK ("run_records"."avg_hr" between 20 and 250),
	CONSTRAINT "run_records_rpe_ck" CHECK ("run_records"."rpe" between 1 and 10 and "run_records"."rpe" * 2 = trunc("run_records"."rpe" * 2))
);
--> statement-breakpoint
CREATE TABLE "set_records" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "set_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"workout_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"planned_exercise_lineage_id" uuid,
	"exercise_position" integer NOT NULL,
	"set_index" integer NOT NULL,
	"weight" numeric(6, 2),
	"unit" text NOT NULL,
	"weight_kg" numeric GENERATED ALWAYS AS (case "set_records"."unit" when 'kg' then "set_records"."weight" when 'lb' then "set_records"."weight" * 0.45359237 end) STORED,
	"reps" integer,
	"missed_reps" integer DEFAULT 0 NOT NULL,
	"seconds" integer,
	"metres" integer,
	"rpe" numeric(3, 1),
	"is_warmup" boolean DEFAULT false NOT NULL,
	"is_extra" boolean DEFAULT false NOT NULL,
	"is_skipped" boolean DEFAULT false NOT NULL,
	"e1rm_kg" numeric,
	"performed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "set_records_exercise_position_ck" CHECK ("set_records"."exercise_position" >= 1),
	CONSTRAINT "set_records_set_index_ck" CHECK ("set_records"."set_index" >= 1),
	CONSTRAINT "set_records_unit_ck" CHECK (unit in ('kg', 'lb')),
	CONSTRAINT "set_records_weight_ck" CHECK ("set_records"."weight" > 0),
	CONSTRAINT "set_records_reps_ck" CHECK ("set_records"."reps" >= 0),
	CONSTRAINT "set_records_missed_reps_ck" CHECK ("set_records"."missed_reps" >= 0 and ("set_records"."missed_reps" = 0 or "set_records"."reps" is not null)),
	CONSTRAINT "set_records_seconds_ck" CHECK ("set_records"."seconds" >= 1),
	CONSTRAINT "set_records_metres_ck" CHECK ("set_records"."metres" >= 1),
	CONSTRAINT "set_records_rpe_ck" CHECK ("set_records"."rpe" between 1 and 10 and "set_records"."rpe" * 2 = trunc("set_records"."rpe" * 2)),
	CONSTRAINT "set_records_e1rm_ck" CHECK ("set_records"."e1rm_kg" is null or ("set_records"."e1rm_kg" > 0 and not "set_records"."is_warmup" and not "set_records"."is_skipped"))
);
--> statement-breakpoint
CREATE TABLE "training_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "training_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"actor" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_audit_action_ck" CHECK (action in ('update', 'delete', 'restore')),
	CONSTRAINT "training_audit_actor_ck" CHECK (actor in ('owner', 'coach', 'rules'))
);
--> statement-breakpoint
CREATE TABLE "workout_substitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"workout_id" uuid NOT NULL,
	"planned_exercise_lineage_id" uuid,
	"from_exercise_id" uuid NOT NULL,
	"to_exercise_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workout_substitutions_exercises_ck" CHECK ("workout_substitutions"."from_exercise_id" <> "workout_substitutions"."to_exercise_id")
);
--> statement-breakpoint
CREATE TABLE "workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"discipline" text NOT NULL,
	"session_type" text NOT NULL,
	"title" text NOT NULL,
	"planned_session_id" uuid,
	"planned_lineage_id" uuid,
	"program_id" uuid,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_s" integer,
	"session_rpe" numeric(3, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workouts_kind_ck" CHECK (kind in ('strength', 'run', 'other')),
	CONSTRAINT "workouts_status_ck" CHECK (status in ('in_progress', 'completed', 'abandoned')),
	CONSTRAINT "workouts_title_ck" CHECK (char_length("workouts"."title") > 0),
	CONSTRAINT "workouts_plan_ck" CHECK (("workouts"."planned_session_id" is null) = ("workouts"."planned_lineage_id" is null) and ("workouts"."planned_session_id" is null or "workouts"."program_id" is not null)),
	CONSTRAINT "workouts_finished_ck" CHECK (("workouts"."status" = 'in_progress') = ("workouts"."finished_at" is null)),
	CONSTRAINT "workouts_times_ck" CHECK ("workouts"."finished_at" >= "workouts"."started_at"),
	CONSTRAINT "workouts_duration_ck" CHECK ("workouts"."duration_s" >= 1),
	CONSTRAINT "workouts_session_rpe_ck" CHECK ("workouts"."session_rpe" between 1 and 10 and "workouts"."session_rpe" * 2 = trunc("workouts"."session_rpe" * 2))
);
--> statement-breakpoint
ALTER TABLE "other_session_records" ADD CONSTRAINT "other_session_records_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_session_records" ADD CONSTRAINT "other_session_records_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_notes" ADD CONSTRAINT "recovery_notes_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_record_segments" ADD CONSTRAINT "run_record_segments_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_record_segments" ADD CONSTRAINT "run_record_segments_workout_id_run_records_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."run_records"("workout_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_records" ADD CONSTRAINT "run_records_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_records" ADD CONSTRAINT "run_records_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_records" ADD CONSTRAINT "set_records_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_audit" ADD CONSTRAINT "training_audit_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD CONSTRAINT "workout_substitutions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD CONSTRAINT "workout_substitutions_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD CONSTRAINT "workout_substitutions_from_exercise_id_exercises_id_fk" FOREIGN KEY ("from_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_substitutions" ADD CONSTRAINT "workout_substitutions_to_exercise_id_exercises_id_fk" FOREIGN KEY ("to_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_planned_session_id_planned_sessions_id_fk" FOREIGN KEY ("planned_session_id") REFERENCES "public"."planned_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_notes_client_mutation_id_uq" ON "recovery_notes" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_record_segments_client_mutation_id_uq" ON "run_record_segments" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "run_record_segments_run_order_idx" ON "run_record_segments" USING btree ("workout_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "set_records_client_mutation_id_uq" ON "set_records" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "set_records_exercise_history_idx" ON "set_records" USING btree ("owner_id","exercise_id","performed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "set_records"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "set_records_exercise_e1rm_idx" ON "set_records" USING btree ("owner_id","exercise_id","e1rm_kg" DESC NULLS FIRST) WHERE "set_records"."e1rm_kg" is not null and "set_records"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "set_records_exercise_rep_max_idx" ON "set_records" USING btree ("owner_id","exercise_id","reps","weight_kg" DESC NULLS FIRST) WHERE "set_records"."deleted_at" is null and not "set_records"."is_warmup" and not "set_records"."is_skipped" and "set_records"."weight_kg" is not null;--> statement-breakpoint
CREATE INDEX "set_records_owner_performed_idx" ON "set_records" USING btree ("owner_id","performed_at");--> statement-breakpoint
CREATE INDEX "set_records_workout_order_idx" ON "set_records" USING btree ("workout_id","exercise_position","set_index");--> statement-breakpoint
CREATE INDEX "training_audit_row_idx" ON "training_audit" USING btree ("owner_id","table_name","row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_substitutions_client_mutation_id_uq" ON "workout_substitutions" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workouts_client_id_uq" ON "workouts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "workouts_owner_started_idx" ON "workouts" USING btree ("owner_id","started_at" DESC NULLS FIRST) WHERE "workouts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "workouts_owner_kind_started_idx" ON "workouts" USING btree ("owner_id","kind","started_at") WHERE "workouts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "workouts_planned_lineage_idx" ON "workouts" USING btree ("planned_lineage_id");