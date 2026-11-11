-- Marks the Strength view's week rollups stale (src/lib/server/db/schema/analytics.ts) when a write
-- may change what a week sums, in a custom migration so a regenerated table migration never drops
-- it. Every write path is covered, the app's sync, the coach and any script alike:
-- - set_records inserted or changed: the weeks of each set's instant, before and after, and of its
--   workout's start (a week summed alone holds its workouts whole, so the week holding the workout
--   is the week of its start).
-- - workouts inserted, or changed in what decides whether and where their sets count (status,
--   deletion, start, kind, planned session): the weeks of the start, before and after, and of
--   every set of the workout.
-- - exercises whose measure, load type or muscles change: every week of the owner's (every owner's
--   for a catalogue exercise), as the catalogue seed may do on a deploy.
-- A week is the owner's, but a trigger does not read the profile's time zone: an instant's day is
-- within a day of its UTC date in every zone (UTC−12 to UTC+14), so the weeks of those three days
-- are marked. Marking a week bumps its generation (a rollup worked out from facts read before the
-- bump never lands) and clears it; an unknown week gets a stale row, which the next write sums.
-- These are statement triggers over transition tables, so a bulk load marks each week once, and
-- weeks are marked in order, as the rollups are written, so two writers never wait on each other.
CREATE FUNCTION strength_weeks_stale(owners uuid[], instants timestamptz[]) RETURNS void
LANGUAGE sql AS $$
	INSERT INTO strength_week_rollups AS r (owner_id, week_start, generation)
	SELECT DISTINCT c.owner_id, date_trunc('week', (c.at AT TIME ZONE 'UTC')::date + shift.days)::date, 1
	FROM unnest(owners, instants) AS c(owner_id, at)
	CROSS JOIN (VALUES (-1), (0), (1)) AS shift(days)
	WHERE c.at IS NOT NULL
	ORDER BY 1, 2
	ON CONFLICT (owner_id, week_start) DO UPDATE
	SET generation = r.generation + 1, written_at = NULL, digest = NULL, split = false
$$;
--> statement-breakpoint
CREATE FUNCTION set_records_stale_weeks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM strength_weeks_stale(array_agg(owner_id), array_agg(at)) FROM (
			SELECT a.owner_id, a.performed_at AS at FROM added a
			UNION ALL
			SELECT w.owner_id, w.started_at FROM workouts w WHERE w.id IN (SELECT workout_id FROM added)
		) AS changed;
	ELSE
		PERFORM strength_weeks_stale(array_agg(owner_id), array_agg(at)) FROM (
			WITH moved AS (
				SELECT a.owner_id, a.performed_at, a.workout_id, b.performed_at AS was_at, b.workout_id AS was_in
				FROM added a JOIN removed b ON b.id = a.id
				WHERE to_jsonb(a) - 'updated_at' IS DISTINCT FROM to_jsonb(b) - 'updated_at'
			)
			SELECT owner_id, performed_at AS at FROM moved
			UNION ALL
			SELECT owner_id, was_at FROM moved
			UNION ALL
			SELECT w.owner_id, w.started_at FROM workouts w
			WHERE w.id IN (SELECT workout_id FROM moved UNION SELECT was_in FROM moved)
		) AS changed;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION workouts_stale_weeks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM strength_weeks_stale(array_agg(owner_id), array_agg(started_at)) FROM added;
	ELSE
		PERFORM strength_weeks_stale(array_agg(owner_id), array_agg(at)) FROM (
			WITH moved AS (
				SELECT a.id, a.owner_id, a.started_at, b.started_at AS was_at
				FROM added a JOIN removed b ON b.id = a.id
				WHERE (a.status, a.deleted_at, a.started_at, a.kind, a.planned_session_id)
					IS DISTINCT FROM (b.status, b.deleted_at, b.started_at, b.kind, b.planned_session_id)
			)
			SELECT owner_id, started_at AS at FROM moved
			UNION ALL
			SELECT owner_id, was_at FROM moved
			UNION ALL
			SELECT s.owner_id, s.performed_at FROM set_records s WHERE s.workout_id IN (SELECT id FROM moved)
		) AS changed;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION exercises_stale_weeks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE strength_week_rollups AS r
	SET generation = r.generation + 1, written_at = NULL, digest = NULL, split = false
	WHERE EXISTS (
		SELECT 1 FROM added a JOIN removed b ON b.id = a.id
		WHERE (a.measure, a.load_type, a.primary_muscles, a.secondary_muscles)
			IS DISTINCT FROM (b.measure, b.load_type, b.primary_muscles, b.secondary_muscles)
			AND (a.owner_id IS NULL OR a.owner_id = r.owner_id)
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER set_records_stale_weeks_insert AFTER INSERT ON set_records REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION set_records_stale_weeks();
CREATE TRIGGER set_records_stale_weeks_update AFTER UPDATE ON set_records REFERENCING OLD TABLE AS removed NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION set_records_stale_weeks();
CREATE TRIGGER workouts_stale_weeks_insert AFTER INSERT ON workouts REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION workouts_stale_weeks();
CREATE TRIGGER workouts_stale_weeks_update AFTER UPDATE ON workouts REFERENCING OLD TABLE AS removed NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION workouts_stale_weeks();
CREATE TRIGGER exercises_stale_weeks AFTER UPDATE ON exercises REFERENCING OLD TABLE AS removed NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION exercises_stale_weeks();
