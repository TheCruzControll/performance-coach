-- History guards for the prescription tables (ADR 0010), in a custom migration so a regenerated
-- table migration can never drop them. They attach the program tables' history_refuse_update()
-- and history_refuse_delete() (0009_program_history_guards.sql): a planned exercise, set
-- prescription, run segment or other-session detail is never changed or deleted, with no session
-- flag; an edit copies its week into a new version instead. TRUNCATE fires no row triggers and
-- stays the one bypass, for test and reset code only.
CREATE TRIGGER planned_exercises_refuse_update BEFORE UPDATE ON planned_exercises FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER planned_exercises_refuse_delete BEFORE DELETE ON planned_exercises FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER set_prescriptions_refuse_update BEFORE UPDATE ON set_prescriptions FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER set_prescriptions_refuse_delete BEFORE DELETE ON set_prescriptions FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER planned_run_segments_refuse_update BEFORE UPDATE ON planned_run_segments FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER planned_run_segments_refuse_delete BEFORE DELETE ON planned_run_segments FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
CREATE TRIGGER planned_session_details_refuse_update BEFORE UPDATE ON planned_session_details FOR EACH ROW EXECUTE FUNCTION history_refuse_update();
CREATE TRIGGER planned_session_details_refuse_delete BEFORE DELETE ON planned_session_details FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
