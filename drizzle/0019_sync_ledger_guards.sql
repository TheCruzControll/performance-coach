-- Guards for the sync ledger (src/lib/server/db/schema/sync.ts; ADR 0010, ADR 0012), in a custom
-- migration so a regenerated table migration can never drop them. They attach the program tables'
-- history_refuse_update() and history_refuse_delete() (0009_program_history_guards.sql): a ledger
-- row records that a mutation was applied, so it is never changed or deleted, with no session
-- flag. A claim's INSERT … ON CONFLICT DO NOTHING updates nothing, so it never meets them.
-- TRUNCATE fires no row triggers and stays the one bypass, for test and reset code only.
CREATE TRIGGER sync_mutations_refuse_update BEFORE UPDATE ON sync_mutations FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER sync_mutations_refuse_delete BEFORE DELETE ON sync_mutations FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
