/**
 * pain.report, mapped from wire format v1 onto pain_reports in the mutation's transaction
 * (PRD §7 'This hurts'; QUICK_ACTIONS.pain in domain/workout/substitution.ts).
 *
 * - The report is written under its id (the device's client id, its primary key), with its slot,
 *   exercise, area, severity, note, action and when it happened. A replay that reaches the
 *   handler writes nothing; another owner's report under the id refuses it ('Already used').
 * - It writes only itself, as the contract says (domain/workout/mutations.ts PainReport): the
 *   device sends the owner's choice beside it, in its place in the outbox, and the slot's order
 *   keeps them together.
 *   - 'stopped': an exercise.skip of the slot's sets not done yet (apply/structure.ts)
 *   - 'substituted': the gentler option's exercise.substitute, reason pain, whose client id the
 *     report names in substitutionId (the contract's dependsOn sends that one first)
 *   - 'ended_workout': nothing more; the finish follows as its own workout.finish
 * - A pain report is never a preference: it writes no exercise_preferences row and changes no
 *   program, whatever its action, area or severity. The coach (M5) reads it as pain memory.
 * - The workout must be the owner's (missing: deferred until it arrives; another owner's:
 *   forbidden) and the exercise in the owner's library, or it is refused at payload.exerciseId.
 */
import { createPainReportsRepository } from '../../../db/repositories/pain-reports';
import { createTrainingLogRepository } from '../../../db/repositories/training-log';
import { getExercisesByIds } from '../../exercises/index';
import { TrainingInputError, TrainingNotFoundError } from '../../training/shared';
import type { Handlers } from './handler';

export const painHandlers: Handlers<'pain.report'> = {
	async 'pain.report'(m, { ownerId, deps }) {
		const { db } = deps;
		const workout = await createTrainingLogRepository(db).workout(ownerId, m.workoutId);
		if (!workout || workout.deletedAt) throw new TrainingNotFoundError('workout');
		const { position, plannedLineage, exerciseId, area, severity, action, substitutionId, note } =
			m.payload;
		const found = await getExercisesByIds(ownerId, [exerciseId], { db });
		if (!found.has(exerciseId)) throw new TrainingInputError({ exerciseId: 'Not in your library' });
		const stored = await createPainReportsRepository(db).insertReport({
			id: m.id,
			ownerId,
			workoutId: workout.id,
			exerciseId,
			plannedExerciseLineageId: plannedLineage,
			exercisePosition: position,
			bodyArea: area,
			severity,
			action,
			substitutionClientId: substitutionId,
			note,
			reportedAt: new Date(m.at)
		});
		// clientId is the envelope's id on the wire: the dispatcher answers it 'forbidden'.
		if (!stored) throw new TrainingInputError({ clientId: 'Already used' });
	}
};
