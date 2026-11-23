CREATE TABLE "backup_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pathname" text,
	"bytes" bigint,
	"sha256" text,
	"format" text,
	"schema_tag" text,
	"app_version" text,
	"row_counts" jsonb,
	"error_code" text,
	CONSTRAINT "backup_runs_trigger_ck" CHECK (trigger in ('cron', 'manual')),
	CONSTRAINT "backup_runs_status_ck" CHECK (status in ('running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "backup_runs_running_ck" CHECK (("backup_runs"."status" = 'running') = ("backup_runs"."finished_at" is null)),
	CONSTRAINT "backup_runs_error_code_ck" CHECK ("backup_runs"."error_code" is null or "backup_runs"."error_code" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
CREATE INDEX "backup_runs_status_started_idx" ON "backup_runs" USING btree ("status","started_at" DESC NULLS LAST);