-- Guards for coach proposals and notes (src/lib/server/db/schema/coaching.ts and coach.ts; ADR
-- 0010 and the coach memory and proposals ADR), in a custom migration so a regenerated table
-- migration can never drop them. Each refusal is a restrict_violation (23001) naming its table
-- and guard, never a value.
-- BEFORE triggers run before CHECKs, so these police only what a CHECK cannot see: the status a
-- row is inserted with, what an update changes, and where its status moves. The lifecycle columns
-- (applied_version_id, applied_ref, closed_at, decision_note, superseded_reason) are left to
-- coach_proposals' CHECKs, and an unknown status to coach_proposals_status_ck, which names it.
-- - A proposal is inserted 'proposed' (coach_proposals_insert_guard): the owner decides it later.
-- - Its content never changes (coach_proposals_content_guard): only the lifecycle columns,
--   status and updated_at may. program_id may go from null to a program only on the move to
--   applied of a new_program, which is when its program first exists.
-- - Its status moves only forward (coach_proposals_transition_guard): proposed to accepted,
--   rejected, applied or superseded; accepted to applied or superseded. Leaving proposed stamps
--   closed_at with the decision time when the update does not set it.
-- - An applied, rejected or superseded proposal never changes (coach_proposals_frozen_guard).
-- - coach_notes are insert-only (0024's coach_insert_only).
-- - DELETE is refused on both (0009's history_refuse_delete), so deleting the owner is refused
--   once they have a proposal or a note.
-- Update triggers fire in name order (content, frozen, transition), so the guard that names a
-- refusal is the first that applies. Columns a later migration adds are content, so immutable,
-- unless it adds them to the content guard's lifecycle list.
-- TRUNCATE fires no row triggers and stays the one bypass, for test and reset code only; the
-- backup restore loads rows with user triggers disabled.
CREATE FUNCTION coach_proposals_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status IN ('accepted', 'rejected', 'applied', 'superseded') THEN
		RAISE EXCEPTION 'a proposal is stored as proposed; the owner decides it afterwards'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_proposals_insert_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION coach_proposals_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	lifecycle constant text[] := ARRAY[
		'status', 'program_id', 'applied_version_id', 'applied_ref', 'closed_at', 'decision_note',
		'superseded_reason', 'updated_at'
	];
BEGIN
	IF to_jsonb(NEW) - lifecycle IS DISTINCT FROM to_jsonb(OLD) - lifecycle
		OR (NEW.program_id IS DISTINCT FROM OLD.program_id AND NOT (
			OLD.program_id IS NULL AND OLD.kind = 'new_program'
			AND OLD.status <> 'applied' AND NEW.status = 'applied'
		)) THEN
		RAISE EXCEPTION 'a proposal''s content never changes: propose a revision instead'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_proposals_content_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION coach_proposals_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status
		AND NEW.status IN ('proposed', 'accepted', 'rejected', 'applied', 'superseded')
		AND NOT (
			(OLD.status = 'proposed' AND NEW.status IN ('accepted', 'rejected', 'applied', 'superseded'))
			OR (OLD.status = 'accepted' AND NEW.status IN ('applied', 'superseded'))
		) THEN
		RAISE EXCEPTION 'a proposal moves only forward: from proposed to accepted, rejected, applied or superseded, and from accepted to applied or superseded'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_proposals_transition_guard';
	END IF;
	IF OLD.status = 'proposed' AND NEW.status IS DISTINCT FROM 'proposed' AND NEW.closed_at IS NULL THEN
		NEW.closed_at := now();
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION coach_proposals_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('applied', 'rejected', 'superseded') THEN
		RAISE EXCEPTION 'an applied, rejected or superseded proposal never changes'
			USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'coach_proposals_frozen_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coach_proposals_insert_guard BEFORE INSERT ON coach_proposals FOR EACH ROW EXECUTE FUNCTION coach_proposals_insert_guard();
CREATE TRIGGER coach_proposals_content_guard BEFORE UPDATE ON coach_proposals FOR EACH ROW EXECUTE FUNCTION coach_proposals_content_guard();
CREATE TRIGGER coach_proposals_frozen_guard BEFORE UPDATE ON coach_proposals FOR EACH ROW EXECUTE FUNCTION coach_proposals_frozen_guard();
CREATE TRIGGER coach_proposals_transition_guard BEFORE UPDATE ON coach_proposals FOR EACH ROW EXECUTE FUNCTION coach_proposals_transition_guard();
CREATE TRIGGER coach_proposals_refuse_delete BEFORE DELETE ON coach_proposals FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER coach_notes_refuse_update BEFORE UPDATE ON coach_notes FOR EACH ROW EXECUTE FUNCTION coach_insert_only();
CREATE TRIGGER coach_notes_refuse_delete BEFORE DELETE ON coach_notes FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
