CREATE TABLE "coach_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subjects" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_notes_kind_ck" CHECK (char_length("coach_notes"."kind") > 0),
	CONSTRAINT "coach_notes_subjects_ck" CHECK (jsonb_typeof("coach_notes"."subjects") = 'array'),
	CONSTRAINT "coach_notes_summary_ck" CHECK (char_length("coach_notes"."summary") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "coach_proposals" DROP CONSTRAINT "coach_proposals_status_ck";--> statement-breakpoint
ALTER TABLE "coach_proposals" DROP CONSTRAINT "coach_proposals_applied_ck";--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "applied_ref" jsonb;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "tool_use_id" text;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "payload_version" integer;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "diff" jsonb;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "impact" jsonb;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "revision_of" uuid;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "superseded_reason" text;--> statement-breakpoint
ALTER TABLE "coach_notes" ADD CONSTRAINT "coach_notes_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_notes" ADD CONSTRAINT "coach_notes_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_notes_owner_kind_idx" ON "coach_notes" USING btree ("owner_id","kind","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "coach_notes_run_idx" ON "coach_notes" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_thread_id_coach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_revision_of_coach_proposals_id_fk" FOREIGN KEY ("revision_of") REFERENCES "public"."coach_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_proposal_id_coach_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."coach_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_proposals_thread_idx" ON "coach_proposals" USING btree ("thread_id","created_at");--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_applied_ref_ck" CHECK ("coach_proposals"."applied_ref" is null or (jsonb_typeof("coach_proposals"."applied_ref") = 'object' and "coach_proposals"."applied_ref" ->> 'kind' in ('goal', 'preference', 'substitution', 'program') and jsonb_typeof("coach_proposals"."applied_ref" -> 'id') = 'string' and char_length("coach_proposals"."applied_ref" ->> 'id') > 0) is true);--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_superseded_ck" CHECK (("coach_proposals"."status" = 'superseded') = ("coach_proposals"."superseded_reason" is not null));--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_superseded_reason_ck" CHECK (superseded_reason in ('program_changed', 'revised'));--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_closed_ck" CHECK (("coach_proposals"."status" = 'proposed') = ("coach_proposals"."closed_at" is null) or not (status in ('proposed', 'accepted', 'rejected', 'applied', 'superseded')));--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_decision_ck" CHECK ("coach_proposals"."decision_note" is null or "coach_proposals"."status" <> 'proposed');--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_decision_note_ck" CHECK (char_length("coach_proposals"."decision_note") between 1 and 500);--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_payload_version_ck" CHECK ("coach_proposals"."payload_version" >= 1);--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_payload_hash_ck" CHECK ("coach_proposals"."payload_hash" ~ '^[0-9a-f]{16}$');--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_tool_use_ck" CHECK (char_length("coach_proposals"."tool_use_id") > 0);--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_status_ck" CHECK (status in ('proposed', 'accepted', 'rejected', 'applied', 'superseded'));--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_applied_ck" CHECK (("coach_proposals"."status" = 'applied') = ("coach_proposals"."applied_version_id" is not null or "coach_proposals"."applied_ref" is not null));