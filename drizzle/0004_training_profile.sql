CREATE TABLE "athlete_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"weight_unit" text DEFAULT 'kg' NOT NULL,
	"distance_unit" text DEFAULT 'km' NOT NULL,
	"birth_year" integer,
	"nutrition_phase" text,
	"target_weight" numeric(6, 2),
	"target_weight_unit" text,
	"target_date" date,
	"baselines_unknown" boolean DEFAULT false NOT NULL,
	"onboarding_step" text,
	"onboarding_completed" text[] DEFAULT '{}'::text[] NOT NULL,
	"onboarding_skipped" text[] DEFAULT '{}'::text[] NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_profiles_name_ck" CHECK (char_length("athlete_profiles"."name") between 1 and 64),
	CONSTRAINT "athlete_profiles_weight_unit_ck" CHECK (weight_unit in ('kg', 'lb')),
	CONSTRAINT "athlete_profiles_distance_unit_ck" CHECK (distance_unit in ('km', 'mi')),
	CONSTRAINT "athlete_profiles_birth_year_ck" CHECK ("athlete_profiles"."birth_year" between 1900 and 2100),
	CONSTRAINT "athlete_profiles_nutrition_phase_ck" CHECK (nutrition_phase in ('bulk', 'cut', 'maintenance', 'recomp')),
	CONSTRAINT "athlete_profiles_target_weight_ck" CHECK (("athlete_profiles"."target_weight" is null) = ("athlete_profiles"."target_weight_unit" is null) and ("athlete_profiles"."target_weight" is null or "athlete_profiles"."target_weight" > 0))
);
--> statement-breakpoint
CREATE TABLE "body_weight_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "body_weight_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" uuid NOT NULL,
	"value" numeric(6, 2) NOT NULL,
	"unit" text NOT NULL,
	"measured_on" date NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "body_weight_entries_value_ck" CHECK ("body_weight_entries"."value" > 0),
	CONSTRAINT "body_weight_entries_unit_ck" CHECK (unit in ('kg', 'lb'))
);
--> statement-breakpoint
CREATE TABLE "discipline_experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"custom_label" text DEFAULT '' NOT NULL,
	"level" text NOT NULL,
	"years" numeric(4, 1),
	"sessions_per_week" numeric(4, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discipline_experience_level_ck" CHECK (level in ('new', 'novice', 'intermediate', 'advanced')),
	CONSTRAINT "discipline_experience_years_ck" CHECK ("discipline_experience"."years" is null or "discipline_experience"."years" >= 0),
	CONSTRAINT "discipline_experience_sessions_ck" CHECK ("discipline_experience"."sessions_per_week" is null or "discipline_experience"."sessions_per_week" >= 0)
);
--> statement-breakpoint
CREATE TABLE "equipment_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"gym_type" text,
	"equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"home_equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"exercise" text NOT NULL,
	"sentiment" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_preferences_sentiment_ck" CHECK (sentiment in ('like', 'dislike')),
	CONSTRAINT "exercise_preferences_exercise_ck" CHECK (char_length("exercise_preferences"."exercise") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "injuries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"body_area" text NOT NULL,
	"side" text,
	"severity" text NOT NULL,
	"notes" text,
	"avoid" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"since" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "injuries_side_ck" CHECK (side in ('left', 'right', 'both')),
	CONSTRAINT "injuries_severity_ck" CHECK (severity in ('mild', 'moderate', 'severe'))
);
--> statement-breakpoint
CREATE TABLE "muay_thai_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"sessions_per_week" numeric(4, 1),
	"sparring_per_week" numeric(4, 1),
	"fights" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"distance" text NOT NULL,
	"custom_distance" numeric(5, 1),
	"distance_metres" numeric(8, 1) NOT NULL,
	"time_seconds" integer NOT NULL,
	"raced_on" date,
	"event_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_results_time_ck" CHECK ("race_results"."time_seconds" > 0),
	CONSTRAINT "race_results_distance_ck" CHECK ("race_results"."distance_metres" > 0)
);
--> statement-breakpoint
CREATE TABLE "running_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"unit" text NOT NULL,
	"weekly_distance" numeric(5, 1),
	"runs_per_week" numeric(4, 1),
	"longest_run" numeric(5, 1),
	"easy_pace_seconds" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "running_profiles_unit_ck" CHECK (unit in ('km', 'mi'))
);
--> statement-breakpoint
CREATE TABLE "schedule_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"label" text NOT NULL,
	"days" text[] NOT NULL,
	"time_of_day" text,
	"duration_minutes" integer,
	"intensity" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_commitments_days_ck" CHECK (cardinality("schedule_commitments"."days") >= 1),
	CONSTRAINT "schedule_commitments_intensity_ck" CHECK (intensity in ('light', 'moderate', 'hard'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"days_per_week" integer,
	"available_days" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_times" text[] DEFAULT '{}'::text[] NOT NULL,
	"session_minutes" integer,
	"constraints" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_days_per_week_ck" CHECK ("schedules"."days_per_week" between 1 and 7),
	CONSTRAINT "schedules_session_minutes_ck" CHECK ("schedules"."session_minutes" between 10 and 300)
);
--> statement-breakpoint
CREATE TABLE "strength_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"lift" text NOT NULL,
	"custom_label" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"value" numeric(6, 2) NOT NULL,
	"unit" text NOT NULL,
	"achieved_on" date,
	"set_weight" numeric(6, 2),
	"set_reps" integer,
	"set_rpe" numeric(3, 1),
	"method" text,
	"confidence" text,
	"notes" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "strength_baselines_kind_ck" CHECK (kind in ('measured', 'estimated')),
	CONSTRAINT "strength_baselines_source_ck" CHECK (source in ('tested', 'competition', 'set', 'estimate')),
	CONSTRAINT "strength_baselines_kind_source_ck" CHECK (("strength_baselines"."kind" = 'measured') = ("strength_baselines"."source" in ('tested', 'competition'))),
	CONSTRAINT "strength_baselines_set_ck" CHECK ("strength_baselines"."source" <> 'set' or ("strength_baselines"."set_weight" is not null and "strength_baselines"."set_reps" is not null)),
	CONSTRAINT "strength_baselines_value_ck" CHECK ("strength_baselines"."value" > 0),
	CONSTRAINT "strength_baselines_unit_ck" CHECK (unit in ('kg', 'lb'))
);
--> statement-breakpoint
CREATE TABLE "training_goal_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "training_goal_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"change" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_goal_events_change_ck" CHECK (change in ('created', 'updated', 'reprioritized', 'status_changed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "training_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"disciplines" text[] NOT NULL,
	"custom_discipline" text,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer,
	"event_type" text,
	"event_date" date,
	"weight_class" text,
	"target_performance" text,
	"requirements" text,
	"focus" text,
	"measure" text,
	"target_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "training_goals_kind_ck" CHECK (kind in ('event', 'general')),
	CONSTRAINT "training_goals_status_ck" CHECK (status in ('active', 'paused', 'achieved', 'dropped')),
	CONSTRAINT "training_goals_title_ck" CHECK (char_length("training_goals"."title") between 1 and 80),
	CONSTRAINT "training_goals_disciplines_ck" CHECK (cardinality("training_goals"."disciplines") >= 1),
	CONSTRAINT "training_goals_priority_ck" CHECK (("training_goals"."status" in ('active', 'paused')) = ("training_goals"."priority" is not null) and ("training_goals"."priority" is null or "training_goals"."priority" >= 1)),
	CONSTRAINT "training_goals_event_ck" CHECK ("training_goals"."kind" <> 'event' or ("training_goals"."event_type" is not null and "training_goals"."event_date" is not null)),
	CONSTRAINT "training_goals_general_ck" CHECK ("training_goals"."kind" <> 'general' or "training_goals"."focus" is not null)
);
--> statement-breakpoint
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD CONSTRAINT "body_weight_entries_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discipline_experience" ADD CONSTRAINT "discipline_experience_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_profiles" ADD CONSTRAINT "equipment_profiles_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_preferences" ADD CONSTRAINT "exercise_preferences_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injuries" ADD CONSTRAINT "injuries_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muay_thai_profiles" ADD CONSTRAINT "muay_thai_profiles_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "running_profiles" ADD CONSTRAINT "running_profiles_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_commitments" ADD CONSTRAINT "schedule_commitments_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_baselines" ADD CONSTRAINT "strength_baselines_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_goal_events" ADD CONSTRAINT "training_goal_events_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_goals" ADD CONSTRAINT "training_goals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_weight_entries_owner_idx" ON "body_weight_entries" USING btree ("owner_id","measured_on" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "discipline_experience_owner_discipline_uq" ON "discipline_experience" USING btree ("owner_id","discipline","custom_label");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_preferences_owner_exercise_uq" ON "exercise_preferences" USING btree ("owner_id",lower("exercise"));--> statement-breakpoint
CREATE INDEX "injuries_owner_idx" ON "injuries" USING btree ("owner_id","active");--> statement-breakpoint
CREATE INDEX "race_results_owner_idx" ON "race_results" USING btree ("owner_id","distance_metres");--> statement-breakpoint
CREATE INDEX "schedule_commitments_owner_idx" ON "schedule_commitments" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strength_baselines_current_uq" ON "strength_baselines" USING btree ("owner_id","lift","custom_label") WHERE "strength_baselines"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "strength_baselines_owner_idx" ON "strength_baselines" USING btree ("owner_id","lift","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "training_goal_events_owner_idx" ON "training_goal_events" USING btree ("owner_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "training_goal_events_goal_idx" ON "training_goal_events" USING btree ("goal_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "training_goals_owner_priority_uq" ON "training_goals" USING btree ("owner_id","priority") WHERE "training_goals"."priority" is not null;--> statement-breakpoint
CREATE INDEX "training_goals_owner_status_idx" ON "training_goals" USING btree ("owner_id","status");