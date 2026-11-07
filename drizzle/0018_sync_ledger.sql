CREATE TABLE "sync_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"workout_client_id" uuid,
	"client_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text
);
--> statement-breakpoint
ALTER TABLE "sync_mutations" ADD CONSTRAINT "sync_mutations_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_mutations_owner_workout_idx" ON "sync_mutations" USING btree ("owner_id","workout_client_id");