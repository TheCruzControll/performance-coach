-- Guards for coach conversations and runs (src/lib/server/db/schema/coach.ts and agent-runs.ts;
-- ADR 0010), in a custom migration so a regenerated table migration can never drop them. Each
-- refusal is a restrict_violation (23001) naming its table and guard, never a value.
-- - coach_messages, agent_model_calls and agent_tool_calls are insert-only: a transcript replays
--   byte for byte, and a call is recorded once (coach_insert_only).
-- - A thread changes only its title and title_source (rename), archived_at (archive, unarchive),
--   last_message_at (forward only), and its segment: forward by one, and only then its
--   segment_prompt_version and segment_program_version_id (coach_thread_guard). updated_at is
--   stamped when anything changed (0014's training_log_touch; it fires after the guard, by name).
-- - A run changes only while it is running; its identity never changes, its usage and cost only
--   grow, an unpriced cost stays unpriced and a cancel request is never withdrawn
--   (agent_run_guard). Any status may be inserted, so a backup restore can load finished runs;
--   agent_runs_finished_ck keeps finished_at coherent with it.
-- - DELETE is refused on all five tables (0009's history_refuse_delete), so deleting the owner is
--   refused once they have a conversation. Owner decision (M5 plan, 'Deleting conversations'):
--   conversations are archived, never deleted.
-- Columns a later migration adds are immutable unless it adds them to a guard's mutable list.
-- TRUNCATE fires no row triggers and stays the one bypass, for test and reset code only.
CREATE FUNCTION coach_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are a record and never change', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_insert_only';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION coach_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	mutable constant text[] := ARRAY[
		'title', 'title_source', 'archived_at', 'last_message_at', 'updated_at',
		'segment', 'segment_prompt_version', 'segment_program_version_id'
	];
	problem text;
BEGIN
	IF to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable THEN
		problem := 'a conversation changes only its title, archive state, last message time and segment';
	ELSIF NEW.segment = OLD.segment THEN
		IF NEW.segment_prompt_version IS DISTINCT FROM OLD.segment_prompt_version
			OR NEW.segment_program_version_id IS DISTINCT FROM OLD.segment_program_version_id THEN
			problem := 'a segment keeps the prompt and program versions it started with: start a new segment';
		END IF;
	ELSIF NEW.segment <> OLD.segment + 1 THEN
		problem := 'a conversation moves forward one segment at a time';
	END IF;
	IF problem IS NULL AND NEW.last_message_at < OLD.last_message_at THEN
		problem := 'a conversation''s last message time moves only forward';
	END IF;
	IF problem IS NOT NULL THEN
		RAISE EXCEPTION '%', problem
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_thread_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION agent_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	mutable constant text[] := ARRAY[
		'status', 'served_model', 'stop_reason', 'refusal_category', 'error',
		'model_calls', 'tool_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens',
		'cache_write_tokens', 'cost_micros', 'cap_cost_micros', 'ttft_ms', 'latency_ms',
		'cancel_requested_at', 'finished_at'
	];
	problem text;
BEGIN
	IF OLD.status <> 'running' THEN
		problem := 'a finished run never changes';
	ELSIF to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable THEN
		problem := 'a run''s thread, message, model, effort, prompt version and start never change';
	ELSIF NEW.model_calls < OLD.model_calls OR NEW.tool_calls < OLD.tool_calls
		OR NEW.input_tokens < OLD.input_tokens OR NEW.output_tokens < OLD.output_tokens
		OR NEW.cache_read_tokens < OLD.cache_read_tokens
		OR NEW.cache_write_tokens < OLD.cache_write_tokens
		OR NEW.cap_cost_micros < OLD.cap_cost_micros
		OR NEW.cost_micros < OLD.cost_micros
		OR (OLD.cost_micros IS NULL AND NEW.cost_micros IS NOT NULL) THEN
		problem := 'a run''s calls, tokens and costs only grow, and an unpriced cost stays unpriced';
	ELSIF OLD.cancel_requested_at IS NOT NULL
		AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
		problem := 'a cancel request is never withdrawn or moved';
	END IF;
	IF problem IS NOT NULL THEN
		RAISE EXCEPTION '%', problem
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'agent_run_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coach_threads_guard BEFORE UPDATE ON coach_threads FOR EACH ROW EXECUTE FUNCTION coach_thread_guard();
CREATE TRIGGER coach_threads_touch BEFORE UPDATE ON coach_threads FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER coach_threads_refuse_delete BEFORE DELETE ON coach_threads FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER coach_messages_refuse_update BEFORE UPDATE ON coach_messages FOR EACH ROW EXECUTE FUNCTION coach_insert_only();
CREATE TRIGGER coach_messages_refuse_delete BEFORE DELETE ON coach_messages FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER agent_runs_guard BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_run_guard();
CREATE TRIGGER agent_runs_refuse_delete BEFORE DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER agent_model_calls_refuse_update BEFORE UPDATE ON agent_model_calls FOR EACH ROW EXECUTE FUNCTION coach_insert_only();
CREATE TRIGGER agent_model_calls_refuse_delete BEFORE DELETE ON agent_model_calls FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER agent_tool_calls_refuse_update BEFORE UPDATE ON agent_tool_calls FOR EACH ROW EXECUTE FUNCTION coach_insert_only();
CREATE TRIGGER agent_tool_calls_refuse_delete BEFORE DELETE ON agent_tool_calls FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
