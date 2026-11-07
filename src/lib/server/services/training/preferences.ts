/**
 * Exercise likes and dislikes as the coach's structured memory: each linked to the library
 * exercise it names, with where it was recorded and why. Profile → Exercises saves the whole
 * list (services/profile/sections.ts); this records one at a time, as 'Never prescribe this
 * again' on a swap (m3/39) and the coach's tools (M5) do. Callers import this module by path.
 *
 * Every writer takes the same per-owner lock (the profile repository's
 * lockSection('exercisePreferences')), so a swap dislike and a Profile save never race into a
 * unique violation: the one that waited is applied to what the other stored.
 */
import * as z from 'zod/mini';
import { SENTIMENTS } from '../../../domain/profile/catalog';
import type { ExercisePreference } from '../../../domain/profile/types';
import { PREFERENCE_SOURCES } from '../../../domain/training/vocabulary';
import { createProfileRepository, type ExercisePreferenceRow } from '../../db';
import { measure } from '../../observability/timing';
import { getExercisesByIds } from '../exercises/index';
import { parseWith, resolveDeps, TrainingNotFoundError, type TrainingDeps } from './shared';

/** One explicit preference for a library exercise. */
const recordSchema = z.object({
	exerciseId: z.string('Pick an exercise'),
	sentiment: z.enum(SENTIMENTS, 'Like or dislike?'),
	reason: z.pipe(
		z.nullish(z.string().check(z.trim(), z.maxLength(200, 'Keep it under 200 characters'))),
		z.transform((v) => (v ? v : null))
	),
	source: z.enum(PREFERENCE_SOURCES, 'Unknown source')
});
export type ExercisePreferenceRecord = z.input<typeof recordSchema>;

function toLinkedPreference(row: ExercisePreferenceRow): ExercisePreference {
	return {
		id: row.id,
		exercise: row.exercise,
		sentiment: row.sentiment,
		reason: row.reason,
		exerciseId: row.exerciseId,
		source: row.source
	};
}

/** The owner's preferences with their links and sources, dislikes first, oldest first. */
export async function listExercisePreferences(
	ownerId: string,
	deps: TrainingDeps = {}
): Promise<ExercisePreference[]> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () =>
		createProfileRepository(db).listExercisePreferences(ownerId)
	);
	return rows.map(toLinkedPreference);
}

/**
 * Like or dislike one exercise of the owner's library, with a reason and where it was said.
 * Upserts: the preference that already names the exercise (by link, else by its name) takes the
 * new sentiment, reason and source and keeps the owner's words. `deps.db` may be an open
 * transaction, such as the program revision that swaps the exercise out.
 */
export async function recordExercisePreference(
	ownerId: string,
	input: ExercisePreferenceRecord,
	deps: TrainingDeps = {}
): Promise<ExercisePreference> {
	const { exerciseId, sentiment, reason, source } = parseWith(recordSchema, input);
	const { db, now } = resolveDeps(deps);
	const exercise = (await getExercisesByIds(ownerId, [exerciseId], { db })).get(exerciseId);
	if (!exercise) throw new TrainingNotFoundError('exercise');
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'exercisePreferences');
			const row = await repo.upsertExercisePreference(
				ownerId,
				{ exercise: exercise.name, exerciseId, sentiment, reason, source },
				now()
			);
			return toLinkedPreference(row);
		})
	);
}
