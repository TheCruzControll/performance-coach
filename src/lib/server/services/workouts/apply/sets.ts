/**
 * set.log, set.skip, set.edit and set.delete, mapped from wire format v1 onto M3's log service
 * (services/training/log.ts) in the mutation's transaction. M3 checks the exercise's load type
 * with logging-rules' checkSet and stores the e1RM where one applies; its field errors come back
 * at its input's paths, which ../sync.ts puts under the payload's.
 *
 * - A set's client id is its set.log's or set.skip's id; edits and deletes name it as entityId.
 * - A skip is a skipped row in its place, recording nothing.
 * - An edit carries every value; it never un-skips (the contract: delete the skip, log the set).
 */
import type { MutationOf } from '../../../../domain/workout/index';
import { deleteSet, editSet, logSet } from '../../training/log';
import type { Handlers } from './handler';

type SetType = 'set.log' | 'set.skip' | 'set.edit' | 'set.delete';

const NOTHING_DONE = {
	weight: null,
	assistance: null,
	reps: null,
	missedReps: 0,
	seconds: null,
	metres: null,
	rpe: null,
	isWarmup: false,
	isExtra: false
} as const;

/** M3's logSet input for a set in its place, under the mutation's id. */
function placed(m: MutationOf<'set.log' | 'set.skip'>) {
	const { position, plannedLineage, setIndex, exerciseId } = m.payload;
	return {
		clientMutationId: m.id,
		workoutClientId: m.workoutId,
		exerciseId,
		plannedExerciseLineageId: plannedLineage,
		exercisePosition: position,
		setIndex,
		performedAt: m.at
	};
}

export const setHandlers: Handlers<SetType> = {
	async 'set.log'(m, { ownerId, deps }) {
		const { position: _p, plannedLineage: _l, setIndex: _i, exerciseId: _e, ...done } = m.payload;
		await logSet(ownerId, { ...placed(m), ...done, isSkipped: false }, deps);
	},

	async 'set.skip'(m, { ownerId, deps }) {
		const input = { ...placed(m), ...NOTHING_DONE, unit: m.payload.unit, isSkipped: true };
		await logSet(ownerId, input, deps);
	},

	async 'set.edit'(m, { ownerId, deps }) {
		await editSet(ownerId, m.entityId, { ...m.payload, isSkipped: false }, deps);
	},

	async 'set.delete'(m, { ownerId, deps }) {
		await deleteSet(ownerId, m.entityId, deps);
	}
};
