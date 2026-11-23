-- Guards for the backup run log (src/lib/server/db/schema/backups.ts; M9 'backup-runs-db'), in a
-- custom migration so a regenerated table migration can never drop them. Each refusal is a
-- restrict_violation (23001) naming its table and guard, never a value.
-- - A finished run never changes: an UPDATE is refused once the row's status is not 'running'.
-- - A running run finishes once: its one UPDATE must set a final status (succeeded, failed or
--   skipped), so a second finish of the same row is refused. Only the finishing columns may
--   change; id, trigger, started_at and any column a later migration adds are immutable.
-- - DELETE is refused for a run started within the last 400 days (backup_runs_delete_guard).
-- Inserts are not guarded: the CHECKs hold a new row coherent. TRUNCATE fires no row triggers and
-- stays the one bypass, for test and reset code only, as for the other history tables.
CREATE FUNCTION backup_runs_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	finishing constant text[] := ARRAY[
		'status', 'finished_at', 'pathname', 'bytes', 'sha256', 'format', 'schema_tag',
		'app_version', 'row_counts', 'error_code'
	];
BEGIN
	IF OLD.status <> 'running' THEN
		RAISE EXCEPTION 'a finished backup run never changes'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'backup_runs_update_guard';
	END IF;
	IF NEW.status = 'running' OR to_jsonb(NEW) - finishing IS DISTINCT FROM to_jsonb(OLD) - finishing THEN
		RAISE EXCEPTION 'a running backup run finishes once, and only its finishing columns change'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'backup_runs_update_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION backup_runs_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.started_at >= now() - interval '400 days' THEN
		RAISE EXCEPTION 'a backup run is deleted only once it is older than 400 days'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'backup_runs_delete_guard';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER backup_runs_update_trigger BEFORE UPDATE ON backup_runs FOR EACH ROW EXECUTE FUNCTION backup_runs_update_guard();
--> statement-breakpoint
CREATE TRIGGER backup_runs_delete_trigger BEFORE DELETE ON backup_runs FOR EACH ROW EXECUTE FUNCTION backup_runs_delete_guard();
