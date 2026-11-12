CREATE TABLE "strength_week_rollups" (
	"owner_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"written_at" timestamp with time zone,
	"time_zone" text,
	"analytics_version" integer,
	"digest_version" integer,
	"split" boolean DEFAULT false NOT NULL,
	"digest" json,
	CONSTRAINT "strength_week_rollups_pk" PRIMARY KEY("owner_id","week_start"),
	CONSTRAINT "strength_week_rollups_written_ck" CHECK ("strength_week_rollups"."written_at" is null or ("strength_week_rollups"."time_zone" is not null and "strength_week_rollups"."analytics_version" is not null and "strength_week_rollups"."digest_version" is not null and ("strength_week_rollups"."digest" is null) = "strength_week_rollups"."split"))
);
--> statement-breakpoint
ALTER TABLE "strength_week_rollups" ADD CONSTRAINT "strength_week_rollups_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;