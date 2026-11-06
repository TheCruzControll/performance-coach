-- Guards for the training log (src/lib/server/db/schema/training-log.ts; ADR 0010), in a custom
-- migration so a regenerated table migration can never drop them. Logged rows are append-only
-- except for owner edits, and every edit that changes a row is audited:
-- - BEFORE UPDATE stamps updated_at with the statement's time when the content changed, and keeps
--   the old updated_at when it did not, whatever the statement set.
-- - AFTER UPDATE, under the same condition, writes training_audit: the row before and after, its
--   owner, and the actor from the app.actor setting ('owner' when unset). A service acting for
--   the coach sets it for its transaction only: select set_config('app.actor', 'coach', true).
-- - DELETE is always refused (0009's history_refuse_delete); workouts and sets are deleted
--   softly, and the audit records that as a delete, or clearing it as a restore.
-- - training_audit refuses UPDATE and DELETE.
-- Content leaves out updated_at and the generated columns: a BEFORE trigger sees those as null in
-- NEW, and they follow from the other columns. TRUNCATE fires no row triggers and stays the one
-- bypass, for test and reset code only, so there is deliberately no TRUNCATE trigger.
CREATE FUNCTION training_log_changed(old_row jsonb, new_row jsonb, rel oid) RETURNS boolean
LANGUAGE sql STABLE AS $$
	SELECT old_row - ignored IS DISTINCT FROM new_row - ignored
	FROM (
		SELECT array_append(coalesce(array_agg(attname::text), '{}'), 'updated_at') AS ignored
		FROM pg_attribute
		WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped AND attgenerated <> ''
	) AS ignored_columns
$$;
--> statement-breakpoint
CREATE FUNCTION training_log_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF training_log_changed(to_jsonb(OLD), to_jsonb(NEW), TG_RELID) THEN
		NEW.updated_at := statement_timestamp();
	ELSE
		NEW.updated_at := OLD.updated_at;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- TG_ARGV[0] names the row's key column: id, or workout_id for a workout's 1:1 record.
CREATE FUNCTION training_log_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	old_row constant jsonb := to_jsonb(OLD);
	new_row constant jsonb := to_jsonb(NEW);
BEGIN
	IF NOT training_log_changed(old_row, new_row, TG_RELID) THEN
		RETURN NULL;
	END IF;
	INSERT INTO training_audit (owner_id, table_name, row_id, action, before, after, actor, changed_at)
	VALUES (
		NEW.owner_id,
		TG_TABLE_NAME,
		new_row ->> TG_ARGV[0],
		CASE
			WHEN old_row ->> 'deleted_at' IS NULL AND new_row ->> 'deleted_at' IS NOT NULL THEN 'delete'
			WHEN old_row ->> 'deleted_at' IS NOT NULL AND new_row ->> 'deleted_at' IS NULL THEN 'restore'
			ELSE 'update'
		END,
		old_row,
		new_row,
		coalesce(nullif(current_setting('app.actor', true), ''), 'owner'),
		NEW.updated_at
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION training_audit_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'training_audit rows record past edits and never change'
		USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'training_audit_refuse_update';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workouts_touch BEFORE UPDATE ON workouts FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER workouts_audit AFTER UPDATE ON workouts FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER workouts_refuse_delete BEFORE DELETE ON workouts FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER set_records_touch BEFORE UPDATE ON set_records FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER set_records_audit AFTER UPDATE ON set_records FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER set_records_refuse_delete BEFORE DELETE ON set_records FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER run_records_touch BEFORE UPDATE ON run_records FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER run_records_audit AFTER UPDATE ON run_records FOR EACH ROW EXECUTE FUNCTION training_log_audit('workout_id');
CREATE TRIGGER run_records_refuse_delete BEFORE DELETE ON run_records FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER run_record_segments_touch BEFORE UPDATE ON run_record_segments FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER run_record_segments_audit AFTER UPDATE ON run_record_segments FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER run_record_segments_refuse_delete BEFORE DELETE ON run_record_segments FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER other_session_records_touch BEFORE UPDATE ON other_session_records FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER other_session_records_audit AFTER UPDATE ON other_session_records FOR EACH ROW EXECUTE FUNCTION training_log_audit('workout_id');
CREATE TRIGGER other_session_records_refuse_delete BEFORE DELETE ON other_session_records FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER recovery_notes_touch BEFORE UPDATE ON recovery_notes FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER recovery_notes_audit AFTER UPDATE ON recovery_notes FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER recovery_notes_refuse_delete BEFORE DELETE ON recovery_notes FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER workout_substitutions_touch BEFORE UPDATE ON workout_substitutions FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER workout_substitutions_audit AFTER UPDATE ON workout_substitutions FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER workout_substitutions_refuse_delete BEFORE DELETE ON workout_substitutions FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER training_audit_refuse_update BEFORE UPDATE ON training_audit FOR EACH ROW EXECUTE FUNCTION training_audit_refuse_update();
CREATE TRIGGER training_audit_refuse_delete BEFORE DELETE ON training_audit FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
