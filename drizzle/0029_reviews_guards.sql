-- Guards for weekly and cycle reviews (src/lib/server/db/schema/coaching.ts; ADR 0010 and the M6
-- plan's 'Reviews are completed, not replaced'), in a custom migration so a regenerated table
-- migration can never drop them. Each refusal is a restrict_violation (23001) naming its table
-- and guard, never a value.
-- - superseded_by is DEFERRABLE INITIALLY DEFERRED: a refresh marks the live row superseded
--   first, naming the next revision's pre-generated id, then inserts that revision, in one
--   transaction, so the partial live unique index never sees two live rows.
-- - Identity and content never change (reviews_content_guard): only the columns M6 fills in
--   later may, and updated_at.
-- - A superseded row never changes (reviews_frozen_guard), so supersession is set once.
-- - The narrative, its run, thread and time, proposal_id and next_version_id are set once, from
--   null (reviews_once_guard).
-- - A cycle review whose next block is planned is never superseded
--   (cycle_reviews_supersede_guard): the plan was made from it.
-- - updated_at is stamped when anything changed (0014's training_log_touch; it fires after the
--   guards, by name).
-- - DELETE is refused (0009's history_refuse_delete), so deleting the owner is refused once they
--   have a review.
-- Update triggers fire in name order (content, frozen, once, supersede, touch), so the guard that
-- names a refusal is the first that applies. Columns a later migration adds are content, so
-- immutable, unless it adds them to the content guard's list. Inserts are not guarded: the
-- CHECKs hold a new row coherent, and rows written before M6 (snapshot_version 0) stay valid.
-- TRUNCATE fires no row triggers and stays the one bypass, for test and reset code only; the
-- backup restore loads rows with user triggers disabled.
-- Postgres checks a row's unique indexes in creation order, and the generated migration created
-- the revision indexes before the live ones it recreated as partial. Recreating the revision
-- indexes here puts the live ones first, so a second live review is refused by the index that
-- says so (weekly_reviews_owner_week_uq, cycle_reviews_block_uq), as M3's tests pin.
DROP INDEX weekly_reviews_owner_week_revision_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX weekly_reviews_owner_week_revision_uq ON weekly_reviews USING btree (owner_id, week_starts_on, revision);
--> statement-breakpoint
DROP INDEX cycle_reviews_block_revision_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX cycle_reviews_block_revision_uq ON cycle_reviews USING btree (program_id, block_lineage_id, revision);
--> statement-breakpoint
ALTER TABLE weekly_reviews ALTER CONSTRAINT weekly_reviews_superseded_by_weekly_reviews_id_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE cycle_reviews ALTER CONSTRAINT cycle_reviews_superseded_by_cycle_reviews_id_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION reviews_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	later constant text[] := ARRAY[
		'narrative', 'narrative_run_id', 'narrative_thread_id', 'narrated_at', 'proposal_id',
		'next_version_id', 'superseded_at', 'superseded_by', 'updated_at'
	];
BEGIN
	IF to_jsonb(NEW) - later IS DISTINCT FROM to_jsonb(OLD) - later THEN
		RAISE EXCEPTION 'a review''s content never changes: store a new revision instead'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = TG_TABLE_NAME || '_content_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reviews_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.superseded_at IS NOT NULL THEN
		RAISE EXCEPTION 'a superseded review never changes'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = TG_TABLE_NAME || '_frozen_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reviews_once_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	once constant text[] := ARRAY[
		'narrative', 'narrative_run_id', 'narrative_thread_id', 'narrated_at', 'proposal_id',
		'next_version_id'
	];
	old_row constant jsonb := to_jsonb(OLD);
	new_row constant jsonb := to_jsonb(NEW);
	col text;
BEGIN
	FOREACH col IN ARRAY once LOOP
		IF old_row -> col <> 'null'::jsonb AND new_row -> col IS DISTINCT FROM old_row -> col THEN
			RAISE EXCEPTION 'a review''s write-up, proposal and next version are each set once'
				USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = TG_TABLE_NAME || '_once_guard';
		END IF;
	END LOOP;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION cycle_reviews_supersede_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.superseded_at IS NOT NULL AND NEW.next_version_id IS NOT NULL THEN
		RAISE EXCEPTION 'a cycle review whose next block is planned is never superseded'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'cycle_reviews_supersede_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER weekly_reviews_content_guard BEFORE UPDATE ON weekly_reviews FOR EACH ROW EXECUTE FUNCTION reviews_content_guard();
CREATE TRIGGER weekly_reviews_frozen_guard BEFORE UPDATE ON weekly_reviews FOR EACH ROW EXECUTE FUNCTION reviews_frozen_guard();
CREATE TRIGGER weekly_reviews_once_guard BEFORE UPDATE ON weekly_reviews FOR EACH ROW EXECUTE FUNCTION reviews_once_guard();
CREATE TRIGGER weekly_reviews_touch BEFORE UPDATE ON weekly_reviews FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER weekly_reviews_refuse_delete BEFORE DELETE ON weekly_reviews FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER cycle_reviews_content_guard BEFORE UPDATE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION reviews_content_guard();
CREATE TRIGGER cycle_reviews_frozen_guard BEFORE UPDATE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION reviews_frozen_guard();
CREATE TRIGGER cycle_reviews_once_guard BEFORE UPDATE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION reviews_once_guard();
CREATE TRIGGER cycle_reviews_supersede_guard BEFORE UPDATE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION cycle_reviews_supersede_guard();
CREATE TRIGGER cycle_reviews_touch BEFORE UPDATE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER cycle_reviews_refuse_delete BEFORE DELETE ON cycle_reviews FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
