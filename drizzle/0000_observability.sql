CREATE TABLE "app_errors" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_errors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"kind" text NOT NULL,
	"status" integer,
	"method" text,
	"path" text,
	"route_id" text,
	"message" text NOT NULL,
	"stack" text,
	"app_version" text,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "web_vitals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_vitals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metric_id" text NOT NULL,
	"name" text NOT NULL,
	"value" double precision NOT NULL,
	"delta" double precision,
	"rating" text NOT NULL,
	"navigation_type" text,
	"path" text NOT NULL,
	"app_version" text,
	"effective_connection_type" text,
	"user_agent" text,
	CONSTRAINT "web_vitals_name_ck" CHECK (name in ('LCP', 'INP', 'CLS', 'TTFB', 'FCP')),
	CONSTRAINT "web_vitals_rating_ck" CHECK (rating in ('good', 'needs-improvement', 'poor')),
	CONSTRAINT "web_vitals_value_ck" CHECK ("web_vitals"."value" >= 0)
);
--> statement-breakpoint
CREATE INDEX "app_errors_occurred_at_idx" ON "app_errors" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_errors_request_id_idx" ON "app_errors" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_vitals_metric_uq" ON "web_vitals" USING btree ("metric_id","name");--> statement-breakpoint
CREATE INDEX "web_vitals_name_recorded_at_idx" ON "web_vitals" USING btree ("name","recorded_at" DESC NULLS LAST);