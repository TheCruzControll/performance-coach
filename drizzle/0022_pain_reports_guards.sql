-- Guards for pain reports (src/lib/server/db/schema/feedback.ts; ADR 0010), in a custom migration
-- so a regenerated table migration can never drop them. They attach the training log's guards
-- (0014_training_log_guards.sql) as every logged table has them:
-- - BEFORE UPDATE stamps updated_at only when the content changed (training_log_touch).
-- - AFTER UPDATE, under the same condition, writes training_audit with the actor from app.actor
--   (training_log_audit, keyed by id); a soft delete is audited as a delete, clearing it as a
--   restore.
-- - DELETE is always refused (0009's history_refuse_delete).
-- TRUNCATE fires no row triggers and stays the one bypass, for test and reset code only.
CREATE TRIGGER pain_reports_touch BEFORE UPDATE ON pain_reports FOR EACH ROW EXECUTE FUNCTION training_log_touch();
CREATE TRIGGER pain_reports_audit AFTER UPDATE ON pain_reports FOR EACH ROW EXECUTE FUNCTION training_log_audit('id');
CREATE TRIGGER pain_reports_refuse_delete BEFORE DELETE ON pain_reports FOR EACH ROW EXECUTE FUNCTION history_refuse_delete();
