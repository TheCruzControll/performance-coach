CREATE TABLE "coach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"segment" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"api_visible" boolean NOT NULL,
	"content" json NOT NULL,
	"display" jsonb,
	"status" text DEFAULT 'complete' NOT NULL,
	"client_message_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_messages_seq_ck" CHECK ("coach_messages"."seq" >= 1 and "coach_messages"."segment" >= 1),
	CONSTRAINT "coach_messages_role_ck" CHECK (role in ('user', 'assistant', 'system')),
	CONSTRAINT "coach_messages_kind_ck" CHECK (kind in ('owner_message', 'segment_preamble', 'context', 'assistant', 'tool_results', 'display_only')),
	CONSTRAINT "coach_messages_role_kind_ck" CHECK ((kind = 'owner_message' and role = 'user') or (kind = 'segment_preamble' and role = 'user') or (kind = 'context' and role = 'system') or (kind = 'assistant' and role = 'assistant') or (kind = 'tool_results' and role = 'user') or (kind = 'display_only' and role = 'assistant')),
	CONSTRAINT "coach_messages_api_visible_ck" CHECK ("coach_messages"."api_visible" = ("coach_messages"."kind" <> 'display_only')),
	CONSTRAINT "coach_messages_status_ck" CHECK (status in ('complete', 'stopped', 'interrupted', 'failed')),
	CONSTRAINT "coach_messages_client_message_ck" CHECK ("coach_messages"."client_message_id" is null or "coach_messages"."kind" = 'owner_message')
);
--> statement-breakpoint
CREATE TABLE "coach_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"title_source" text NOT NULL,
	"entry" jsonb,
	"segment" integer DEFAULT 1 NOT NULL,
	"segment_prompt_version" text NOT NULL,
	"segment_program_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "coach_threads_title_ck" CHECK (char_length("coach_threads"."title") between 1 and 120),
	CONSTRAINT "coach_threads_title_source_ck" CHECK (title_source in ('first_message', 'owner')),
	CONSTRAINT "coach_threads_segment_ck" CHECK ("coach_threads"."segment" >= 1),
	CONSTRAINT "coach_threads_prompt_version_ck" CHECK (char_length("coach_threads"."segment_prompt_version") > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_index" integer NOT NULL,
	"request_id" text,
	"model" text,
	"stop_reason" text,
	"refusal_category" text,
	"error" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"cap_cost_micros" bigint NOT NULL,
	"ttft_ms" integer,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_calls_usage_ck" CHECK (input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0 and cache_write_tokens >= 0 and (cost_micros is null or cost_micros >= 0) and cap_cost_micros >= 0 and (ttft_ms is null or ttft_ms >= 0) and (latency_ms is null or latency_ms >= 0) and call_index >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"served_model" text,
	"effort" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stop_reason" text,
	"refusal_category" text,
	"error" text,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0,
	"cap_cost_micros" bigint DEFAULT 0 NOT NULL,
	"ttft_ms" integer,
	"latency_ms" integer,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_status_ck" CHECK (status in ('running', 'completed', 'refused', 'budget_exhausted', 'cancelled', 'interrupted', 'timed_out', 'failed', 'expired')),
	CONSTRAINT "agent_runs_finished_ck" CHECK (("agent_runs"."status" = 'running') = ("agent_runs"."finished_at" is null)),
	CONSTRAINT "agent_runs_usage_ck" CHECK (input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0 and cache_write_tokens >= 0 and (cost_micros is null or cost_micros >= 0) and cap_cost_micros >= 0 and (ttft_ms is null or ttft_ms >= 0) and (latency_ms is null or latency_ms >= 0) and model_calls >= 0 and tool_calls >= 0),
	CONSTRAINT "agent_runs_text_ck" CHECK (char_length("agent_runs"."kind") > 0 and char_length("agent_runs"."provider") > 0 and char_length("agent_runs"."model") > 0 and char_length("agent_runs"."effort") > 0 and char_length("agent_runs"."prompt_version") > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_index" integer NOT NULL,
	"tool_use_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"proposal_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_calls_status_ck" CHECK (status in ('succeeded', 'failed', 'invalid_input', 'timed_out', 'cancelled', 'intervened')),
	CONSTRAINT "agent_tool_calls_size_ck" CHECK (octet_length("agent_tool_calls"."input"::text) <= 16384 and ("agent_tool_calls"."output" is null or octet_length("agent_tool_calls"."output"::text) <= 16384)),
	CONSTRAINT "agent_tool_calls_text_ck" CHECK (char_length("agent_tool_calls"."tool_use_id") > 0 and char_length("agent_tool_calls"."name") > 0),
	CONSTRAINT "agent_tool_calls_numbers_ck" CHECK ("agent_tool_calls"."call_index" >= 0 and "agent_tool_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_thread_id_coach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_threads" ADD CONSTRAINT "coach_threads_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_threads" ADD CONSTRAINT "coach_threads_segment_program_version_id_program_versions_id_fk" FOREIGN KEY ("segment_program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_coach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_message_id_coach_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."coach_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_messages_thread_seq_uq" ON "coach_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_messages_client_message_uq" ON "coach_messages" USING btree ("client_message_id");--> statement-breakpoint
CREATE INDEX "coach_messages_thread_segment_seq_idx" ON "coach_messages" USING btree ("thread_id","segment","seq");--> statement-breakpoint
CREATE INDEX "coach_threads_owner_recent_idx" ON "coach_threads" USING btree ("owner_id","last_message_at" DESC NULLS FIRST) WHERE "coach_threads"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "coach_threads_owner_archived_idx" ON "coach_threads" USING btree ("owner_id","archived_at" DESC NULLS FIRST) WHERE "coach_threads"."archived_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_model_calls_run_call_uq" ON "agent_model_calls" USING btree ("run_id","call_index");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_thread_running_uq" ON "agent_runs" USING btree ("thread_id") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "agent_runs_owner_started_idx" ON "agent_runs" USING btree ("owner_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "agent_tool_calls_run_idx" ON "agent_tool_calls" USING btree ("run_id","call_index");