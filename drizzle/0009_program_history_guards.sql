-- History guards for the program tables (ADR 0010), in a custom migration so a regenerated table
-- migration can never drop them. Every UPDATE and DELETE of stored history is refused, with no
-- session flag; a program head may change only its status, archived_at and a forward
-- current_version_id. TRUNCATE fires no row triggers: it is the one bypass, for test and reset
-- code only, so there is deliberately no BEFORE TRUNCATE trigger. Each refusal is a
-- restrict_violation (23001) naming its table and guard, never a value.
CREATE FUNCTION history_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are history and never change: revise the program instead', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'history_refuse_update';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION history_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are history and are never deleted', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'history_refuse_delete';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION program_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	mutable constant text[] := ARRAY['current_version_id', 'status', 'archived_at'];
	head_program uuid;
	head_number integer;
	old_number integer;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.current_version_id IS NOT NULL THEN
			RAISE EXCEPTION 'a new program has no version yet: point it at version 1 once that exists'
				USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'program_head_guard';
		END IF;
		RETURN NEW;
	END IF;
	-- Any other column, including one added later, is immutable.
	IF to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable THEN
		RAISE EXCEPTION 'a program changes only its status, archived_at and current version'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'program_head_guard';
	END IF;
	IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
		SELECT program_id, number INTO head_program, head_number
			FROM program_versions WHERE id = NEW.current_version_id;
		SELECT number INTO old_number FROM program_versions WHERE id = OLD.current_version_id;
		IF head_program IS DISTINCT FROM NEW.id OR (old_number IS NOT NULL AND head_number <= old_number) THEN
			RAISE EXCEPTION 'a program''s current version moves only forward, to one of its own versions'
				USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'program_head_guard';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER programs_head_guard BEFORE INSERT OR UPDATE ON programs FOR EACH ROW EXECUTE FUNCTION program_head_guard();
CREATE TRIGGER programs_refuse_delete BEFORE DELETE ON programs FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER program_versions_refuse_update BEFORE UPDATE ON program_versions FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER program_versions_refuse_delete BEFORE DELETE ON program_versions FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER program_blocks_refuse_update BEFORE UPDATE ON program_blocks FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER program_blocks_refuse_delete BEFORE DELETE ON program_blocks FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER program_version_blocks_refuse_update BEFORE UPDATE ON program_version_blocks FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER program_version_blocks_refuse_delete BEFORE DELETE ON program_version_blocks FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER program_weeks_refuse_update BEFORE UPDATE ON program_weeks FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER program_weeks_refuse_delete BEFORE DELETE ON program_weeks FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER program_version_weeks_refuse_update BEFORE UPDATE ON program_version_weeks FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER program_version_weeks_refuse_delete BEFORE DELETE ON program_version_weeks FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER planned_sessions_refuse_update BEFORE UPDATE ON planned_sessions FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER planned_sessions_refuse_delete BEFORE DELETE ON planned_sessions FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER programming_decisions_refuse_update BEFORE UPDATE ON programming_decisions FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER programming_decisions_refuse_delete BEFORE DELETE ON programming_decisions FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
