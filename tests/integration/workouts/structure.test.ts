/**
 * exercise.skip, exercise.substitute and exercise.dislike through the sync dispatcher
 * (services/workouts/apply/structure.ts) on real Postgres, from M3's 'workout-day' program with
 * today's strength session also planned on Monday, a session already past:
 * - situational swaps (machine unavailable, the owner's choice, pain) stay in the session: one
 *   workout_substitutions row, never a preference or a program version
 * - a confirmed dislike persists: the preference, the never-again swap from today on whatever
 *   version is current, and today's substitution, in one transaction behind one ledger row; a
 *   slot gone from the program records the preference and the substitution only, never a conflict
 *
 * Batches go through applySyncBatch as the endpoint calls it, at 08:00 UTC on Wednesday
 * 11 November 2026 (the owner's time zone is UTC).
 */
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import {
	createMutation,
	type MutationPayloads,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import { syncMutations, workoutSubstitutions, type Executor } from '../../../src/lib/server/db';
import { createTrainingLogRepository } from '../../../src/lib/server/db/repositories/training-log';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveExercisePreferences } from '../../../src/lib/server/services/profile';
import { programmingInputFor } from '../../../src/lib/server/services/programs/alternatives';
import {
	alternativesFor,
	createProgramFromPlan,
	getProgramVersion,
	getVersionHistory,
	moveSession,
	skipSession,
	swapExercise,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { listExercisePreferences } from '../../../src/lib/server/services/training/preferences';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(`${TODAY}T08:00:00Z`);
/** An instant `minute` minutes after 07:00 UTC today. */
const at = (minute = 0) => new Date(Date.UTC(2026, 10, 11, 7, minute)).toISOString();

const sync = (db: Executor, owner: string, mutations: readonly unknown[], now = NOW) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db,
		now: () => now
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** workout-day, with today's strength session also planned on Monday. */
function plan() {
	const fixture = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	const week = fixture.blocks[0]!.weeks[0]!;
	const strength = week.sessions.find((s) => s.kind === 'strength')!;
	week.sessions.unshift({ ...structuredClone(strength), date: MONDAY });
	return fixture;
}

const KEYS = ['leg_press', 'romanian_deadlift', 'goblet_squat', 'bench_press'] as const;

/** The strength session on `date` in version `v`, and its planned exercises. */
function strengthOn(v: ProgramVersion, date: string) {
	const sessions = v.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));
	const session = sessions.find((s) => s.date === date && s.kind === 'strength');
	if (session?.kind !== 'strength') throw new Error(`no strength session on ${date}`);
	return session;
}

/** Position 3 of a strength session: the Romanian deadlift as planned. */
const rdlIn = (v: ProgramVersion, date: string) => strengthOn(v, date).exercises[2]!;

/** The owner, the program (version 1), today's strength session and the exercise ids. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const { programId } = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const found = await resolveKeys(KEYS, { db });
	const id = (key: (typeof KEYS)[number]) => found.get(key)!.id;
	const session = strengthOn(v1, TODAY);
	const rdl = { sessionLineage: session.lineage, plannedExerciseLineage: rdlIn(v1, TODAY).lineage };
	const { alternatives } = await alternativesFor(owner, rdl, { db });
	expect(alternatives.length).toBeGreaterThanOrEqual(2);
	return {
		owner,
		programId,
		v1,
		session,
		ids: {
			legPress: id('leg_press'),
			rdl: id('romanian_deadlift'),
			goblet: id('goblet_squat'),
			bench: id('bench_press')
		},
		/** RDL's alternatives, as the kit offers them. */
		alternatives
	};
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** A strength workout started from `session` (pinned to its row), or ad hoc: its client id. */
async function started(db: Executor, { owner, programId }: Seeded, session?: StoredSession) {
	const workoutId = crypto.randomUUID();
	const start = createMutation('workout.start', {
		workoutId,
		at: at(),
		payload: {
			kind: 'strength',
			title: session?.title ?? 'Lower body & pull',
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: session?.id ?? null,
			plannedLineage: session?.lineage ?? null,
			programId: session ? programId : null
		}
	});
	expect(statuses((await sync(db, owner, [start])).results)).toEqual(['applied']);
	return workoutId;
}

/** A dislike of the Romanian deadlift at position 3, for `toExerciseId`. */
function dislikeOf(
	workoutId: string,
	toExerciseId: string,
	over: Partial<MutationPayloads['exercise.dislike']> = {}
) {
	return createMutation('exercise.dislike', {
		workoutId,
		at: at(20),
		payload: {
			position: 3,
			plannedLineage: null,
			fromExerciseId: '',
			toExerciseId,
			note: 'Hamstrings cramp',
			...over
		}
	});
}

/** The dislike the device sends for today's Romanian deadlift. */
const plannedDislike = (s: Seeded, workoutId: string, toExerciseId = s.alternatives[0]!.id) =>
	dislikeOf(workoutId, toExerciseId, {
		plannedLineage: rdlIn(s.v1, TODAY).lineage,
		fromExerciseId: s.ids.rdl
	});

const substitutionsOf = (db: Executor, owner: string) =>
	db
		.select({
			id: workoutSubstitutions.clientMutationId,
			position: workoutSubstitutions.exercisePosition,
			lineage: workoutSubstitutions.plannedExerciseLineageId,
			from: workoutSubstitutions.fromExerciseId,
			to: workoutSubstitutions.toExerciseId,
			reason: workoutSubstitutions.reason
		})
		.from(workoutSubstitutions)
		.where(eq(workoutSubstitutions.ownerId, owner));

/** The program's version numbers, newest first, and which one is current. */
async function versions(db: Executor, owner: string) {
	const history = (await getVersionHistory(owner, {}, { db }))!;
	return {
		numbers: history.versions.map((v) => v.number),
		current: history.versions.find((v) => v.current)!.number
	};
}

const ledgerHas = async (db: Executor, mutationId: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(syncMutations)
		.where(eq(syncMutations.mutationId, mutationId));
	return row!.n === 1;
};

/** What a preference holds, without its id, words and timestamps. */
const heldPreferences = async (db: Executor, owner: string) =>
	(await listExercisePreferences(owner, { db })).map(
		({ exerciseId, sentiment, reason, source }) => ({ exerciseId, sentiment, reason, source })
	);

describe('situational swaps stay in the session', () => {
	it.each(['equipment_unavailable', 'owner_choice', 'pain'] as const)(
		'%s on leg press: one substitution with its slot, no preference, version 1 still current',
		async (reason) => {
			await withRollback(async (db) => {
				const s = await seed(db);
				const workoutId = await started(db, s, s.session);
				const lineage = strengthOn(s.v1, TODAY).exercises[1]!.lineage;
				const swap = createMutation('exercise.substitute', {
					workoutId,
					at: at(10),
					payload: {
						position: 2,
						plannedLineage: lineage,
						fromExerciseId: s.ids.legPress,
						toExerciseId: s.ids.goblet,
						reason
					}
				});

				expect(statuses((await sync(db, s.owner, [swap])).results)).toEqual(['applied']);

				expect(await substitutionsOf(db, s.owner)).toEqual([
					{ id: swap.id, position: 2, lineage, from: s.ids.legPress, to: s.ids.goblet, reason }
				]);
				expect(await listExercisePreferences(s.owner, { db })).toEqual([]);
				expect(await versions(db, s.owner)).toEqual({ numbers: [1], current: 1 });
			});
		}
	);

	it('sets on the substitute carry its exercise id and the planned lineage', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const lineage = strengthOn(s.v1, TODAY).exercises[1]!.lineage;
			const slot = { position: 2, plannedLineage: lineage };
			const swap = createMutation('exercise.substitute', {
				workoutId,
				at: at(10),
				payload: {
					...slot,
					fromExerciseId: s.ids.legPress,
					toExerciseId: s.ids.goblet,
					reason: 'equipment_unavailable'
				}
			});
			const log = createMutation('set.log', {
				workoutId,
				at: at(12),
				payload: {
					...slot,
					setIndex: 1,
					exerciseId: s.ids.goblet,
					reps: 10,
					seconds: null,
					metres: null,
					weight: 24,
					assistance: null,
					unit: 'kg',
					rpe: 7,
					missedReps: 0,
					isWarmup: false,
					isExtra: false
				}
			});

			expect(statuses((await sync(db, s.owner, [swap, log])).results)).toEqual([
				'applied',
				'applied'
			]);
			const set = await createTrainingLogRepository(db).set(s.owner, log.id);
			expect(set).toMatchObject({
				exerciseId: s.ids.goblet,
				plannedExerciseLineageId: lineage,
				exercisePosition: 2,
				setIndex: 1
			});
		});
	});

	it('skip: a skipped row for each remaining planned set, once however often it is sent', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const lineage = rdlIn(s.v1, TODAY).lineage;
			const rest = [2, 3].map((setIndex) => ({ id: crypto.randomUUID(), setIndex }));
			const skip = createMutation('exercise.skip', {
				workoutId,
				at: at(30),
				payload: {
					position: 3,
					plannedLineage: lineage,
					exerciseId: s.ids.rdl,
					unit: 'kg',
					sets: rest
				}
			});

			expect(statuses((await sync(db, s.owner, [skip])).results)).toEqual(['applied']);
			expect(statuses((await sync(db, s.owner, [skip])).results)).toEqual(['duplicate']);

			const { sets } = (await createTrainingLogRepository(db).workoutWithSets(s.owner, workoutId))!;
			expect(
				sets.map((set) => [set.clientMutationId, set.setIndex, set.isSkipped, set.reps])
			).toEqual(rest.map(({ id, setIndex }) => [id, setIndex, true, null]));
			for (const set of sets) {
				expect(set).toMatchObject({
					exerciseId: s.ids.rdl,
					plannedExerciseLineageId: lineage,
					exercisePosition: 3,
					performedAt: new Date(skip.at)
				});
			}
		});
	});
});

describe('a confirmed dislike persists and leaves the current plan', () => {
	it('records the preference, swaps from today as version 2 with its decision, and records today’s substitution', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const alternative = s.alternatives[0]!;
			const dislike = plannedDislike(s, workoutId);

			const { results } = await sync(db, s.owner, [dislike]);

			expect(statuses(results)).toEqual(['applied']);
			expect(await heldPreferences(db, s.owner)).toEqual([
				{
					exerciseId: s.ids.rdl,
					sentiment: 'dislike',
					reason: 'Hamstrings cramp',
					source: 'workout'
				}
			]);
			expect(await versions(db, s.owner)).toEqual({ numbers: [2, 1], current: 2 });
			const v2 = await getProgramVersion(s.owner, s.programId, 2, { db });
			// Today's session and next week's take the alternative; Monday's, already past, keeps it.
			for (const date of [TODAY, addDays(TODAY, 7)]) {
				expect(rdlIn(v2, date), date).toMatchObject({
					lineage: rdlIn(s.v1, date).lineage,
					exercise: { key: alternative.key },
					substitutedFrom: { key: 'romanian_deadlift' },
					substitutionReason: 'dislike'
				});
			}
			expect(rdlIn(v2, MONDAY).exercise).toEqual({ key: 'romanian_deadlift' });
			expect(await getProgramVersion(s.owner, s.programId, 1, { db })).toEqual({
				...s.v1,
				version: { ...s.v1.version, current: false }
			});
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'preference_recorded',
					summary: 'Romanian deadlift is never prescribed again',
					decidedBy: 'owner'
				})
			]);
			expect(await substitutionsOf(db, s.owner)).toEqual([
				{
					id: dislike.id,
					position: 3,
					lineage: rdlIn(s.v1, TODAY).lineage,
					from: s.ids.rdl,
					to: alternative.id,
					reason: 'dislike'
				}
			]);
			expect(await ledgerHas(db, dislike.id)).toBe(true);

			// The generator's input now rules it out.
			expect((await programmingInputFor(s.owner, { db })).dislikes).toContain('romanian_deadlift');
		});
	});

	it('replayed, it is a duplicate: still one preference, one substitution and one new version', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const dislike = plannedDislike(s, workoutId);

			expect(statuses((await sync(db, s.owner, [dislike])).results)).toEqual(['applied']);
			expect(statuses((await sync(db, s.owner, [dislike, dislike])).results)).toEqual([
				'duplicate',
				'duplicate'
			]);

			expect(await listExercisePreferences(s.owner, { db })).toHaveLength(1);
			expect(await substitutionsOf(db, s.owner)).toHaveLength(1);
			expect(await versions(db, s.owner)).toEqual({ numbers: [2, 1], current: 2 });
		});
	});

	it('made against version 1 and synced after a move on Train made version 2: applied on 2, giving 3', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const thursday = addDays(TODAY, 1);
			await moveSession(
				s.owner,
				{ sessionLineage: s.session.lineage, toDate: thursday },
				{ version: 1, today: TODAY },
				{ db }
			);

			const { results } = await sync(db, s.owner, [plannedDislike(s, workoutId)]);

			expect(results).toEqual([expect.objectContaining({ status: 'applied' })]);
			expect(await versions(db, s.owner)).toEqual({ numbers: [3, 2, 1], current: 3 });
			const v2 = await getProgramVersion(s.owner, s.programId, 2, { db });
			const v3 = await getProgramVersion(s.owner, s.programId, 3, { db });
			// The move stays (the session is on Thursday in both), and only version 3 swaps it out.
			expect(rdlIn(v2, thursday).exercise).toEqual({ key: 'romanian_deadlift' });
			expect(rdlIn(v3, thursday)).toMatchObject({
				lineage: rdlIn(s.v1, TODAY).lineage,
				substitutedFrom: { key: 'romanian_deadlift' },
				substitutionReason: 'dislike'
			});
			expect(v3.decisions.map((d) => d.kind)).toEqual(['preference_recorded']);
		});
	});

	it('made offline and synced the next day: swaps the upcoming sessions only, as version 2', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const alternative = s.alternatives[0]!;
			const nextDay = new Date(`${addDays(TODAY, 1)}T08:00:00Z`);

			const { results } = await sync(db, s.owner, [plannedDislike(s, workoutId)], nextDay);

			expect(statuses(results)).toEqual(['applied']);
			expect(await versions(db, s.owner)).toEqual({ numbers: [2, 1], current: 2 });
			const v2 = await getProgramVersion(s.owner, s.programId, 2, { db });
			expect(rdlIn(v2, addDays(TODAY, 7))).toMatchObject({
				exercise: { key: alternative.key },
				substitutedFrom: { key: 'romanian_deadlift' },
				substitutionReason: 'dislike'
			});
			// Monday's and the workout's own session, both passed, keep it.
			for (const date of [MONDAY, TODAY]) {
				expect(rdlIn(v2, date).exercise, date).toEqual({ key: 'romanian_deadlift' });
			}
			expect(v2.decisions.map((d) => d.kind)).toEqual(['preference_recorded']);
			expect(await heldPreferences(db, s.owner)).toEqual([
				expect.objectContaining({ exerciseId: s.ids.rdl, source: 'workout' })
			]);
		});
	});

	it.each([
		{
			edit: 'swapped for this session',
			onTrain: (s: Seeded, db: Executor) =>
				swapExercise(
					s.owner,
					{
						sessionLineage: s.session.lineage,
						plannedExerciseLineage: rdlIn(s.v1, TODAY).lineage,
						toExerciseId: s.alternatives[1]!.id,
						scope: 'once'
					},
					{ version: 1, today: TODAY },
					{ db }
				)
		},
		{
			edit: 'skipped',
			onTrain: (s: Seeded, db: Executor) =>
				skipSession(
					s.owner,
					{ sessionLineage: s.session.lineage },
					{ version: 1, today: TODAY },
					{ db }
				)
		}
	])(
		'a slot $edit on Train since: the preference and today’s substitution, no version, applied',
		async ({ onTrain }) => {
			await withRollback(async (db) => {
				const s = await seed(db);
				const workoutId = await started(db, s, s.session);
				await onTrain(s, db);
				const dislike = plannedDislike(s, workoutId);

				expect(statuses((await sync(db, s.owner, [dislike])).results)).toEqual(['applied']);

				expect(await heldPreferences(db, s.owner)).toEqual([
					{
						exerciseId: s.ids.rdl,
						sentiment: 'dislike',
						reason: 'Hamstrings cramp',
						source: 'workout'
					}
				]);
				expect(await substitutionsOf(db, s.owner)).toEqual([
					expect.objectContaining({ id: dislike.id, reason: 'dislike' })
				]);
				expect(await versions(db, s.owner)).toEqual({ numbers: [2, 1], current: 2 });
			});
		}
	);

	it('whose swap fails rolls back its preference, its substitution and its ledger claim together', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const dislike = plannedDislike(s, workoutId, s.ids.bench);

			const { results } = await sync(db, s.owner, [dislike]);

			expect(results).toEqual([
				{
					id: dislike.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.toExerciseId': 'Not an alternative to romanian deadlift' }
				}
			]);
			expect(await listExercisePreferences(s.owner, { db })).toEqual([]);
			expect(await substitutionsOf(db, s.owner)).toEqual([]);
			expect(await ledgerHas(db, dislike.id)).toBe(false);
			expect(await versions(db, s.owner)).toEqual({ numbers: [1], current: 1 });
		});
	});

	it('with a note longer than a preference keeps, is refused at payload.note', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const planned = plannedDislike(s, workoutId);
			const dislike = { ...planned, payload: { ...planned.payload, note: 'x'.repeat(201) } };

			const { results } = await sync(db, s.owner, [dislike]);

			expect(results[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
			expect(Object.keys(results[0]!.errors!)).toEqual(['payload.note']);
			expect(await ledgerHas(db, dislike.id)).toBe(false);
		});
	});

	it.each([
		{ of: 'an added exercise', planned: true },
		{ of: 'an exercise in an ad-hoc workout', planned: false }
	])('of $of records the preference and the substitution, and no version', async ({ planned }) => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, planned ? s.session : undefined);
			const dislike = dislikeOf(workoutId, s.ids.goblet, {
				position: planned ? 6 : 1,
				fromExerciseId: s.ids.rdl
			});

			expect(statuses((await sync(db, s.owner, [dislike])).results)).toEqual(['applied']);

			expect(await heldPreferences(db, s.owner)).toEqual([
				{
					exerciseId: s.ids.rdl,
					sentiment: 'dislike',
					reason: 'Hamstrings cramp',
					source: 'workout'
				}
			]);
			expect(await substitutionsOf(db, s.owner)).toEqual([
				expect.objectContaining({ id: dislike.id, lineage: null, reason: 'dislike' })
			]);
			expect(await versions(db, s.owner)).toEqual({ numbers: [1], current: 1 });
		});
	});

	it('racing a move on Train on another connection, waits for it and swaps on the version it made', async () => {
		await withCommitted(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const move = await holdTransaction((tx) =>
				moveSession(
					s.owner,
					{ sessionLineage: s.session.lineage, toDate: addDays(TODAY, 1) },
					{ version: 1, today: TODAY },
					{ db: tx }
				)
			);
			const dislike = sync(db, s.owner, [plannedDislike(s, workoutId)]);
			await lockWaiters(1);
			await move.commit();

			expect(statuses((await dislike).results)).toEqual(['applied']);
			expect(await versions(db, s.owner)).toEqual({ numbers: [3, 2, 1], current: 3 });
		});
	});

	it('racing a Profile save of preferences on another connection, finishes without a unique violation', async () => {
		await withCommitted(async (db) => {
			const s = await seed(db);
			const workoutId = await started(db, s, s.session);
			const save = await holdTransaction((tx) =>
				saveExercisePreferences(
					s.owner,
					{ items: [{ exercise: 'Romanian deadlift', sentiment: 'like' }] },
					{ db: tx }
				)
			);
			const dislike = sync(db, s.owner, [plannedDislike(s, workoutId)]);
			await lockWaiters(1);
			await save.commit();

			expect(statuses((await dislike).results)).toEqual(['applied']);
			expect(await heldPreferences(db, s.owner)).toEqual([
				{
					exerciseId: s.ids.rdl,
					sentiment: 'dislike',
					reason: 'Hamstrings cramp',
					source: 'workout'
				}
			]);
			expect((await versions(db, s.owner)).current).toBe(2);
		});
	});
});
