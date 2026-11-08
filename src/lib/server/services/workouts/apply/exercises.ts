/**
 * exercise.create, mapped from wire format v1 onto M3's createCustomExercise in the mutation's
 * transaction (PRD §7 'Add my own exercise'; the offline workout sync ADR's mapping).
 *
 * - The exercise is created under the mutation's id (the device's client id, id === entityId),
 *   so sets logged on it offline name the row it becomes. A repeat that reaches the handler
 *   returns that row and writes nothing; an id another owner's row or the catalogue holds refuses
 *   it ('Already used' at clientId, which the dispatcher answers 'forbidden').
 * - A name the catalogue or one of the owner's live exercises uses is refused at payload.name,
 *   naming that exercise, and a name the owner retired is refused too (removedEarlier), because
 *   restoring it would keep the retired row's old id. Fix renames it under the same id.
 * - It is a library row, not part of the workout: the workout it was created in is not checked.
 *   The canonical rows list it once a set, a substitution or a pain report names it.
 */
import { createCustomExercise } from '../../exercises/index';
import type { Handlers } from './handler';

export const exerciseHandlers: Handlers<'exercise.create'> = {
	async 'exercise.create'(m, { ownerId, deps }) {
		await createCustomExercise(ownerId, m.payload, deps, { id: m.entityId });
	}
};
