/**
 * other.log, mapped from wire format v1 onto M3's other-session services
 * (services/training/log.ts) in the mutation's transaction, by the contract's identity rule.
 *
 * - A workout has one other-session record, so every other.log carries a fresh id and names the
 *   workout. Each carries all its values (kind, minutes, RPE, notes and metrics, which M3's
 *   customMetricsSchema checks): logOtherSession while the workout has no record, then
 *   editOtherSession with the same values when the stored row won.
 * - A planned session takes only its plan's metrics, typed as the plan types them
 *   (domain/workout/other.ts checkMetrics, given planned_session_details.metrics); an ad-hoc
 *   session takes the owner's own. A misfit is refused at payload.metrics.N.key or .value.
 * - An edit that changes nothing writes nothing; a real one writes one training_audit row.
 */
import { checkMetrics } from '../../../../domain/workout/other';
import { createWorkoutSyncRepository } from '../../../db/repositories/workout-sync';
import { editOtherSession, logOtherSession } from '../../training/log';
import { TrainingInputError } from '../../training/shared';
import type { Handlers } from './handler';

export const otherHandlers: Handlers<'other.log'> = {
	async 'other.log'(m, { ownerId, deps }) {
		const template = await createWorkoutSyncRepository(deps.db).plannedMetrics(
			ownerId,
			m.workoutId
		);
		const misfits = Object.entries(checkMetrics(m.payload.metrics, template));
		// checkMetrics names wire paths; the dispatcher puts a service's paths under payload.
		const errors = misfits.map(([path, message]) => [path.replace(/^payload\./, ''), message]);
		if (errors.length > 0) throw new TrainingInputError(Object.fromEntries(errors));
		const input = { workoutClientId: m.workoutId, ...m.payload };
		const logged = await logOtherSession(ownerId, input, deps);
		if (!logged.duplicate) return;
		await editOtherSession(ownerId, m.workoutId, m.payload, deps);
	}
};
