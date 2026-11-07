/**
 * Exercise likes and dislikes as structured memory, on real Postgres: a Profile save links the
 * owner's words to the library and keeps the source, link and reason of what it leaves in place;
 * two names for one exercise are a field error, never a unique violation; and a swap dislike
 * (recordExercisePreference) and a Profile save serialise on the same per-owner lock.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ExercisePreference } from '../../../src/lib/domain/profile/types';
import type { Executor } from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveExercisePreferences } from '../../../src/lib/server/services/profile';
import {
	listExercisePreferences,
	recordExercisePreference
} from '../../../src/lib/server/services/training/preferences';
import { TrainingNotFoundError } from '../../../src/lib/server/services/training/shared';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { clock, fieldErrors, makeOwner } from '../profile/fixtures';

const TWICE = 'You’ve listed Romanian deadlift twice (as “RDL” and “Romanian deadlift”)';

/** Catalogue ids by key. */
async function ids(db: Executor, ...keys: string[]): Promise<string[]> {
	const found = await resolveKeys(keys, { db });
	return keys.map((key) => found.get(key)!.id);
}

/** What a preference holds, without its id and timestamps. */
const held = ({ exercise, exerciseId, sentiment, reason, source }: ExercisePreference) => ({
	exercise,
	exerciseId,
	sentiment,
	reason,
	source
});

/** Preferences of one sentiment can share created_at (one save): order them by name. */
const byExercise = (a: { exercise: string }, b: { exercise: string }) =>
	a.exercise.localeCompare(b.exercise);

const swapDislike = (exerciseId: string, reason: string | null = 'Hamstrings cramp') => ({
	exerciseId,
	sentiment: 'dislike' as const,
	reason,
	source: 'swap' as const
});

describe('a Profile save links the owner’s words to the library', () => {
	it('links a catalogue name or alias, keeps unknown text unlinked, and records the source', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [bulgarian, rdl] = await ids(db, 'bulgarian_split_squat', 'romanian_deadlift');
			await saveExercisePreferences(
				owner,
				{
					items: [
						{ exercise: 'Bulgarian split squat', sentiment: 'like' },
						{ exercise: 'RDL', sentiment: 'like' },
						{ exercise: 'Sandbag shouldering', sentiment: 'dislike', reason: 'No sandbag' }
					]
				},
				{ db, source: 'onboarding' }
			);
			expect((await listExercisePreferences(owner, { db })).map(held).sort(byExercise)).toEqual([
				{
					exercise: 'Bulgarian split squat',
					exerciseId: bulgarian,
					sentiment: 'like',
					reason: null,
					source: 'onboarding'
				},
				{ exercise: 'RDL', exerciseId: rdl, sentiment: 'like', reason: null, source: 'onboarding' },
				{
					exercise: 'Sandbag shouldering',
					exerciseId: null,
					sentiment: 'dislike',
					reason: 'No sandbag',
					source: 'onboarding'
				}
			]);
		});
	});

	it('refuses two names for one exercise at `items`, before writing anything', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Front squat', sentiment: 'like' }] },
				{ db }
			);
			const before = await listExercisePreferences(owner, { db });
			expect(
				await fieldErrors(
					saveExercisePreferences(
						owner,
						{
							items: [
								{ exercise: 'RDL', sentiment: 'like' },
								{ exercise: 'Romanian deadlift', sentiment: 'like' }
							]
						},
						{ db }
					)
				)
			).toEqual({ items: TWICE });
			expect(await listExercisePreferences(owner, { db })).toEqual(before);
		});
	});

	it('lets a new name take over the exercise of one the same save removes', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'RDL', sentiment: 'like' }] },
				{ db }
			);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Romanian deadlift', sentiment: 'like' }] },
				{ db }
			);
			expect((await listExercisePreferences(owner, { db })).map(held)).toEqual([
				{
					exercise: 'Romanian deadlift',
					exerciseId: rdl,
					sentiment: 'like',
					reason: null,
					source: 'profile'
				}
			]);
		});
	});

	it('counts a kept preference’s stored link: a new name for its exercise is refused', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			await recordExercisePreference(owner, swapDislike(rdl!), { db });
			const before = await listExercisePreferences(owner, { db });
			expect(
				await fieldErrors(
					saveExercisePreferences(
						owner,
						{
							items: [
								{ exercise: 'RDL', sentiment: 'like' },
								{ exercise: 'Romanian deadlift', sentiment: 'dislike' }
							]
						},
						{ db }
					)
				)
			).toEqual({ items: TWICE });
			expect(await listExercisePreferences(owner, { db })).toEqual(before);
		});
	});
});

describe('a swap dislike through later Profile saves', () => {
	it('keeps its source, link and reason while the save keeps it; removing it deletes it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl, front] = await ids(db, 'romanian_deadlift', 'front_squat');
			const time = clock();
			const swapped = await recordExercisePreference(owner, swapDislike(rdl!), {
				db,
				now: time.now
			});
			expect(held(swapped)).toEqual({
				exercise: 'Romanian deadlift',
				exerciseId: rdl,
				sentiment: 'dislike',
				reason: 'Hamstrings cramp',
				source: 'swap'
			});

			// A Profile save that keeps it, sending no reason (as an API caller may), adds a like.
			time.advanceDays(1);
			await saveExercisePreferences(
				owner,
				{
					items: [
						{ exercise: 'Front squat', sentiment: 'like' },
						{ exercise: 'romanian deadlift', sentiment: 'dislike', reason: null }
					]
				},
				{ db, now: time.now }
			);
			const kept = await listExercisePreferences(owner, { db });
			expect(kept.map((p) => [p.id === swapped.id, held(p)])).toEqual([
				[
					true,
					{
						exercise: 'romanian deadlift',
						exerciseId: rdl,
						sentiment: 'dislike',
						reason: 'Hamstrings cramp',
						source: 'swap'
					}
				],
				[
					false,
					{
						exercise: 'Front squat',
						exerciseId: front,
						sentiment: 'like',
						reason: null,
						source: 'profile'
					}
				]
			]);

			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Front squat', sentiment: 'like' }] },
				{ db, now: time.now }
			);
			expect((await listExercisePreferences(owner, { db })).map((p) => p.exercise)).toEqual([
				'Front squat'
			]);
		});
	});

	it('becomes the owner’s own Profile like when they move it to the other list', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			const swapped = await recordExercisePreference(owner, swapDislike(rdl!), { db });
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Romanian deadlift', sentiment: 'like' }] },
				{ db }
			);
			const [moved] = await listExercisePreferences(owner, { db });
			expect(moved!.id).toBe(swapped.id);
			expect(held(moved!)).toEqual({
				exercise: 'Romanian deadlift',
				exerciseId: rdl,
				sentiment: 'like',
				reason: null,
				source: 'profile'
			});
		});
	});
});

describe('recordExercisePreference', () => {
	it('keeps one row per exercise, recorded twice', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			const first = await recordExercisePreference(owner, swapDislike(rdl!), { db });
			const second = await recordExercisePreference(owner, swapDislike(rdl!, 'Grip gives out'), {
				db
			});
			expect(second.id).toBe(first.id);
			expect((await listExercisePreferences(owner, { db })).map(held)).toEqual([
				{
					exercise: 'Romanian deadlift',
					exerciseId: rdl,
					sentiment: 'dislike',
					reason: 'Grip gives out',
					source: 'swap'
				}
			]);
		});
	});

	it('updates the row the owner named it by: by link, or by words with no link yet', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [rdl, front] = await ids(db, 'romanian_deadlift', 'front_squat');
			// By link: 'RDL' from Profile is the Romanian deadlift, and keeps the owner's words.
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'RDL', sentiment: 'like' }] },
				{ db }
			);
			// By words: an M2 row recorded before preferences were linked.
			await db.execute(sql`
				insert into exercise_preferences (owner_id, exercise, sentiment)
				values (${owner}, 'front squat', 'like')`);
			await recordExercisePreference(owner, swapDislike(rdl!), { db });
			await recordExercisePreference(owner, swapDislike(front!, null), { db });
			expect((await listExercisePreferences(owner, { db })).map(held).sort(byExercise)).toEqual([
				{
					exercise: 'front squat',
					exerciseId: front,
					sentiment: 'dislike',
					reason: null,
					source: 'swap'
				},
				{
					exercise: 'RDL',
					exerciseId: rdl,
					sentiment: 'dislike',
					reason: 'Hamstrings cramp',
					source: 'swap'
				}
			]);
		});
	});

	it('refuses an exercise that is not in the owner’s library', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			for (const exerciseId of [crypto.randomUUID(), 'not-a-uuid']) {
				await expect(
					recordExercisePreference(owner, swapDislike(exerciseId), { db })
				).rejects.toBeInstanceOf(TrainingNotFoundError);
			}
			expect(await listExercisePreferences(owner, { db })).toEqual([]);
		});
	});
});

describe('a swap dislike and a Profile save at once, on two connections', () => {
	it('waits for a held swap dislike: no unique violation, one row, the Profile save last', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			const swap = await holdTransaction((tx) =>
				recordExercisePreference(owner, swapDislike(rdl!), { db: tx })
			);
			const save = saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Romanian deadlift', sentiment: 'like' }] },
				{ db }
			);
			await lockWaiters(1);
			await swap.commit();
			await save;
			expect((await listExercisePreferences(owner, { db })).map(held)).toEqual([
				{
					exercise: 'Romanian deadlift',
					exerciseId: rdl,
					sentiment: 'like',
					reason: null,
					source: 'profile'
				}
			]);
		});
	});

	it('waits for a held Profile save: no unique violation, one row, the swap last', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const [rdl] = await ids(db, 'romanian_deadlift');
			const save = await holdTransaction((tx) =>
				saveExercisePreferences(
					owner,
					{ items: [{ exercise: 'Romanian deadlift', sentiment: 'like' }] },
					{ db: tx }
				)
			);
			const swap = recordExercisePreference(owner, swapDislike(rdl!), { db });
			await lockWaiters(1);
			await save.commit();
			await swap;
			expect((await listExercisePreferences(owner, { db })).map(held)).toEqual([
				{
					exercise: 'Romanian deadlift',
					exerciseId: rdl,
					sentiment: 'dislike',
					reason: 'Hamstrings cramp',
					source: 'swap'
				}
			]);
		});
	});
});
