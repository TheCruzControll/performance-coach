CREATE TABLE "weight_goal_milestones" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weight_goal_milestones_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"goal_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"weight" numeric(6, 2) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weight_goal_milestones_weight_ck" CHECK ("weight_goal_milestones"."weight" > 0),
	CONSTRAINT "weight_goal_milestones_source_ck" CHECK (source in ('generated', 'edited'))
);
--> statement-breakpoint
CREATE TABLE "weight_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"start_on" date NOT NULL,
	"start_weight" numeric(6, 2) NOT NULL,
	"target_weight" numeric(6, 2) NOT NULL,
	"target_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"ended_at" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weight_goals_unit_ck" CHECK (unit in ('kg', 'lb')),
	CONSTRAINT "weight_goals_status_ck" CHECK (status in ('active', 'ended')),
	CONSTRAINT "weight_goals_ended_reason_ck" CHECK (ended_reason in ('replaced', 'cleared')),
	CONSTRAINT "weight_goals_source_ck" CHECK (source in ('onboarding', 'profile', 'log', 'coach')),
	CONSTRAINT "weight_goals_start_weight_ck" CHECK ("weight_goals"."start_weight" > 0),
	CONSTRAINT "weight_goals_target_weight_ck" CHECK ("weight_goals"."target_weight" > 0),
	CONSTRAINT "weight_goals_target_on_ck" CHECK ("weight_goals"."target_on" > "weight_goals"."start_on"),
	CONSTRAINT "weight_goals_ended_at_ck" CHECK (("weight_goals"."status" = 'active') = ("weight_goals"."ended_at" is null)),
	CONSTRAINT "weight_goals_ended_reason_pair_ck" CHECK (("weight_goals"."ended_at" is null) = ("weight_goals"."ended_reason" is null))
);
--> statement-breakpoint
DROP INDEX "body_weight_entries_owner_idx";--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD COLUMN "replaced" jsonb;--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "weight_goal_milestones" ADD CONSTRAINT "weight_goal_milestones_goal_id_weight_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."weight_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_goal_milestones" ADD CONSTRAINT "weight_goal_milestones_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_goals" ADD CONSTRAINT "weight_goals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weight_goal_milestones_goal_day_uq" ON "weight_goal_milestones" USING btree ("goal_id","on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_goals_owner_active_uq" ON "weight_goals" USING btree ("owner_id") WHERE "weight_goals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "weight_goals_owner_idx" ON "weight_goals" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "body_weight_entries_owner_day_uq" ON "body_weight_entries" USING btree ("owner_id","measured_on");--> statement-breakpoint
CREATE INDEX "body_weight_entries_run_idx" ON "body_weight_entries" USING btree ("run_id") WHERE "body_weight_entries"."run_id" is not null;--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD CONSTRAINT "body_weight_entries_source_ck" CHECK (source in ('onboarding', 'profile', 'log', 'coach'));--> statement-breakpoint
ALTER TABLE "body_weight_entries" ADD CONSTRAINT "body_weight_entries_run_ck" CHECK (("body_weight_entries"."run_id" is null or "body_weight_entries"."source" = 'coach') and ("body_weight_entries"."replaced" is null or "body_weight_entries"."run_id" is not null));