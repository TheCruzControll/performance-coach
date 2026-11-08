/**
 * exercise.skip, exercise.substitute and exercise.dislike, mapped from wire format v1 onto M3's
 * services in the mutation's transaction. What each quick action means is domain/workout/
 * substitution.ts's (QUICK_ACTIONS); every row is addressed by the device's ids, so a replay
 * writes nothing new.
 *
 * - exercise.skip: a skipped set for each set the device names (the slot's planned sets not done
 *   yet), as set.skip writes one.
 * - exercise.substitute: today's workout_substitutions row only, with its reason and slot.
 *   Machine unavailable, the owner's choice and pain never write a preference or a version.
 * - exercise.dislike, behind its one ledger row:
 *   1. today's substitution, reason dislike
 *   2. when the program's current version still performs the exercise in this slot
 *      (lockCurrentSlot, under the program lock), M3's never-again swap on that version with the
 *      owner's alternative: the dislike (source 'workout') and one new version with its decision.
 *      A dislike made offline against an older version re-bases onto the current one, so it never
 *      meets ADR 0010's compare-and-set as a conflict; one synced after its session has passed
 *      swaps the sessions from today only.
 *   3. otherwise the dislike alone: the slot is gone (swapped or skipped on Train since, the
 *      program replaced, no session from today still performing it) or was never planned (an
 *      added exercise, an ad-hoc workout). The preference keeps the exercise out of every
 *      generated week.
 *   A refused swap (the alternative is not one of the exercise's) rolls all of it back with the
 *   ledger claim, as one rejected result; the device's Fix offers 'Just swap it today'.
 */
import type { MutationOf } from '../../../../domain/workout/index';
import {
	DISLIKE_REASON,
	QUICK_ACTIONS,
	type QuickActionRule
} from '../../../../domain/workout/substitution';
import type { SubstitutionReason } from '../../../../domain/training/vocabulary';
import { createTrainingLogRepository } from '../../../db/repositories/training-log';
import { ownerToday } from '../../../local-date';
import { lockCurrentSlot, swapExercise } from '../../programs/index';
import { logSet, recordSubstitution } from '../../training/log';
import { recordExercisePreference } from '../../training/preferences';
import { TrainingInputError } from '../../training/shared';
import type { ApplyContext, Handlers } from './handler';
import { NOTHING_DONE } from './sets';

/**
 * Decision (open question on 'I don't like this exercise'): a confirmed dislike also replaces the
 * exercise in the current program from today, while the slot still performs it there
 * ('planned_exercise'). Set QUICK_ACTIONS.dislike.program to 'never' and a dislike only keeps the
 * exercise out of the weeks generated next, recording the preference and today's substitution.
 */
const DISLIKE: QuickActionRule = QUICK_ACTIONS.dislike;

type Swap = MutationOf<'exercise.substitute' | 'exercise.dislike'>;

/** Today's substitution in the slot, under the mutation's id. */
function substitute(m: Swap, reason: SubstitutionReason, { ownerId, deps }: ApplyContext) {
	const { position, plannedLineage, fromExerciseId, toExerciseId } = m.payload;
	const input = {
		clientMutationId: m.id,
		workoutClientId: m.workoutId,
		plannedExerciseLineageId: plannedLineage,
		exercisePosition: position,
		fromExerciseId,
		toExerciseId,
		reason
	};
	return recordSubstitution(ownerId, input, deps);
}

/** A dislike's note is its preference's reason: a refusal of it names payload.note. */
async function asNote<T>(write: Promise<T>): Promise<T> {
	try {
		return await write;
	} catch (err) {
		if (!(err instanceof TrainingInputError) || !('reason' in err.errors)) throw err;
		const { reason, ...rest } = err.errors;
		throw new TrainingInputError({ ...rest, note: reason! });
	}
}

/**
 * Where the dislike's swap goes, with the program locked: the current version and the owner's
 * today, or null when the slot is not the program's (never planned, or gone from the version).
 */
async function swapTarget(m: MutationOf<'exercise.dislike'>, { ownerId, deps }: ApplyContext) {
	const { plannedLineage, fromExerciseId } = m.payload;
	if (DISLIKE.program !== 'planned_exercise' || plannedLineage === null) return null;
	const workout = await createTrainingLogRepository(deps.db).workout(ownerId, m.workoutId);
	if (!workout?.plannedLineageId) return null;
	const today = await ownerToday(ownerId, deps.now(), { db: deps.db });
	const slot = {
		sessionLineage: workout.plannedLineageId,
		plannedExerciseLineage: plannedLineage,
		exerciseId: fromExerciseId
	};
	const version = await lockCurrentSlot(ownerId, slot, today, deps);
	return version === null ? null : { ...slot, at: { version, today } };
}

export const structureHandlers: Handlers<
	'exercise.skip' | 'exercise.substitute' | 'exercise.dislike'
> = {
	async 'exercise.skip'(m, { ownerId, deps }) {
		const { position, plannedLineage, exerciseId, unit } = m.payload;
		for (const { id, setIndex } of m.payload.sets) {
			const input = {
				clientMutationId: id,
				workoutClientId: m.workoutId,
				exerciseId,
				plannedExerciseLineageId: plannedLineage,
				exercisePosition: position,
				setIndex,
				performedAt: m.at,
				...NOTHING_DONE,
				unit,
				isSkipped: true
			};
			await logSet(ownerId, input, deps);
		}
	},

	async 'exercise.substitute'(m, ctx) {
		await substitute(m, m.payload.reason, ctx);
	},

	async 'exercise.dislike'(m, ctx) {
		const { ownerId, deps } = ctx;
		const { fromExerciseId, toExerciseId, note } = m.payload;
		await substitute(m, DISLIKE_REASON, ctx);
		const target = await swapTarget(m, ctx);
		if (!target) {
			const dislike = { sentiment: 'dislike', source: 'workout', reason: note } as const;
			const preference = { ...dislike, exerciseId: fromExerciseId };
			await asNote(recordExercisePreference(ownerId, preference, deps));
			return;
		}
		const swap = {
			sessionLineage: target.sessionLineage,
			plannedExerciseLineage: target.plannedExerciseLineage,
			toExerciseId,
			scope: 'never_again',
			reason: note ?? undefined
		};
		const options = { preferenceSource: 'workout', anchorMayHavePassed: true } as const;
		await asNote(swapExercise(ownerId, swap, target.at, deps, options));
	}
};
