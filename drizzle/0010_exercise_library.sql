CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text,
	"owner_id" uuid,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"pattern" text NOT NULL,
	"primary_muscles" text[] NOT NULL,
	"secondary_muscles" text[] DEFAULT '{}'::text[] NOT NULL,
	"equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"disciplines" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"unilateral" boolean DEFAULT false NOT NULL,
	"skill_level" text NOT NULL,
	"measure" text NOT NULL,
	"load_type" text NOT NULL,
	"rep_min" integer,
	"rep_max" integer,
	"default_seconds" integer,
	"substitution_group" text,
	"baseline_lift" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercises_kind_ck" CHECK (("exercises"."key" is null) = ("exercises"."owner_id" is not null)),
	CONSTRAINT "exercises_name_ck" CHECK (char_length("exercises"."name") > 0),
	CONSTRAINT "exercises_primary_muscles_ck" CHECK (cardinality("exercises"."primary_muscles") > 0),
	CONSTRAINT "exercises_skill_level_ck" CHECK (skill_level in ('beginner', 'intermediate', 'advanced')),
	CONSTRAINT "exercises_measure_ck" CHECK (measure in ('reps', 'time', 'distance')),
	CONSTRAINT "exercises_load_type_ck" CHECK (load_type in ('external', 'bodyweight', 'assisted', 'none')),
	CONSTRAINT "exercises_reps_ck" CHECK (("exercises"."rep_min" is null and "exercises"."rep_max" is null) or ("exercises"."rep_min" is not null and "exercises"."rep_max" is not null and "exercises"."rep_min" between 1 and "exercises"."rep_max")),
	CONSTRAINT "exercises_seconds_ck" CHECK (("exercises"."default_seconds" is null and "exercises"."measure" <> 'time') or ("exercises"."default_seconds" is not null and "exercises"."default_seconds" >= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_key_uq" ON "exercises" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_owner_name_uq" ON "exercises" USING btree ("owner_id",lower("name")) WHERE "exercises"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "exercises_substitution_group_idx" ON "exercises" USING btree ("substitution_group");--> statement-breakpoint
CREATE INDEX "exercises_pattern_idx" ON "exercises" USING btree ("pattern");