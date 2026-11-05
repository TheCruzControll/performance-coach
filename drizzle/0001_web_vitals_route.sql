ALTER TABLE "web_vitals" ADD COLUMN "route_id" text;--> statement-breakpoint
CREATE INDEX "web_vitals_route_name_idx" ON "web_vitals" USING btree ("route_id","name","recorded_at" DESC NULLS LAST);