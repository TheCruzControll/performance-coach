/**
 * The workout history reads (services/workouts/history.ts and GET /api/exercises/[id]/history)
 * on real Postgres. Rows are written straight into their tables through M3's history fixtures,
 * with direct inserts of substitutions, pain reports and run segments, so nothing here needs a
 * sync handler. Planned sessions come from M3's 'workout-day' program fixture.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { ProgramPlan } from '../../../src/lib/domain/training/types';
import { setE1rm } from '../../../src/lib/domain/training/metrics';
import { sessionLoad } from '../../../src/lib/domain/load';
import { paceSecondsPer } from '../../../src/lib/domain/units';
import { project } from '../../../src/lib/domain/workout/project';
import { strengthTable } from '../../../src/lib/domain/workout/reducers/tables';
import { summarizeWorkout } from '../../../src/lib/domain/workout/summary';
import {
	painReports,
	runRecordSegments,
	setRecords,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { createCustomExercise } from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	completedWorkoutIds,
	getExerciseHistory,
	getWorkoutDetail,
	listWorkouts,
	type WorkoutDetail,
	type WorkoutListItem
} from '../../../src/lib/server/services/workouts/history';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { GET as getHistory } from '../../../src/routes/api/exercises/[id]/history/+server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { exerciseIds, logOther, logRun, logStrength, utc } from '../training/fixtures/history';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const KEYS = [
	'back_squat',
	'leg_press',
	'romanian_deadlift',
	'pull_up',
	'plank',
	'hip_thrust',
	'good_morning'
] as const;
const KG_KM = { weight: 'kg', distance: 'km' } as const;

/** A workout's client id, as the device and every read here name it. */
async function clientIdOf(db: Executor, workoutId: string): Promise<string> {
	const [row] = await db
		.select({ clientId: workouts.clientId })
		.from(workouts)
		.where(eq(workouts.id, workoutId));
	return row!.clientId;
}

/** The owner, the 'workout-day' program and today's three sessions (by order in the day). */
async function seedWorkoutDay(db: Executor) {
	const owner = await makeOwner(db);
	const plan: ProgramPlan = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const [strength, run, other] = v1.blocks[0]!.weeks[0]!.sessions as StoredSession[];
	const ids = await exerciseIds(db, KEYS);
	const pin = (s: StoredSession) => ({ sessionId: s.id, lineageId: s.lineage, programId });
	return { owner, strength: strength!, run: run!, other: other!, ids, pin };
}

async function detailOf(db: Executor, owner: string, workoutId: string): Promise<WorkoutDetail> {
	const detail = await getWorkoutDetail(owner, await clientIdOf(db, workoutId), { db });
	if (!detail) throw new Error(`no detail for ${workoutId}`);
	return detail;
}

describe('listWorkouts', () => {
	it('lists completed workouts newest first, paged without gaps or duplicates', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat } = await exerciseIds(db, KEYS);
			const tie = utc('2026-11-05', '18:00');
			const logged = [
				await logStrength(db, owner, { startedAt: utc('2026-11-02', '17:00') }, [
					{ exercise: squat, weight: 60, reps: 5, warmup: true },
					{ exercise: squat, weight: 100, reps: 5 },
					{ exercise: squat, weight: 100, reps: 5, skipped: true }
				]).then((w) => w.workoutId),
				await logRun(db, owner, { startedAt: utc('2026-11-03', '07:00'), metres: 8000 }),
				await logOther(db, owner, { startedAt: tie, minutes: 90 }),
				await logOther(db, owner, { startedAt: tie }),
				await logRun(db, owner, { startedAt: utc('2026-11-07', '07:00'), metres: 12000 })
			];
			// None of these is history.
			await logRun(db, owner, {
				startedAt: utc('2026-11-08', '07:00'),
				metres: 5000,
				status: 'in_progress'
			});
			await logRun(db, owner, {
				startedAt: utc('2026-11-08', '08:00'),
				metres: 5000,
				status: 'abandoned'
			});
			await logRun(db, owner, {
				startedAt: utc('2026-11-08', '09:00'),
				metres: 5000,
				deleted: true
			});

			const rows = await db
				.select({ id: workouts.id, clientId: workouts.clientId, startedAt: workouts.startedAt })
				.from(workouts);
			const expected = rows
				.filter((r) => logged.includes(r.id))
				.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1))
				.map((r) => r.clientId);

			const seen: WorkoutListItem[] = [];
			let before: string | undefined;
			for (let page = 0; page < 5; page++) {
				const {
					v,
					workouts: items,
					next
				} = await listWorkouts(owner, { before, limit: 2 }, { db });
				expect(v).toBe(1);
				expect(items.length).toBeLessThanOrEqual(2);
				seen.push(...items);
				if (next === null) break;
				expect(next).toBe(items.at(-1)!.id);
				before = next;
			}
			expect(seen.map((w) => w.id)).toEqual(expected);

			const byKind = Object.groupBy(seen, (w) => w.kind);
			expect(byKind.strength).toEqual([
				expect.objectContaining({
					kind: 'strength',
					planned: false,
					durationSeconds: 3600,
					sessionRpe: 7,
					sessionLoad: sessionLoad(60, 7),
					startedAt: '2026-11-02T17:00:00.000Z',
					strength: { sets: 1, exercises: 1 },
					run: null,
					other: null
				})
			]);
			expect(byKind.run!.map((w) => [w.run?.distanceMetres, w.strength, w.other])).toEqual([
				[12000, null, null],
				[8000, null, null]
			]);
			expect(byKind.other!.map((w) => w.other?.kind)).toEqual(['class', 'class']);
			expect(byKind.other!.map((w) => w.other?.durationMinutes).sort()).toEqual([60, 90]);
		});
	});

	it('gives an empty page for a cursor that is not one of the owner’s, and refuses a malformed one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = await logRun(db, owner, { startedAt: utc('2026-11-03', '07:00'), metres: 8000 });
			expect(await listWorkouts(owner, {}, { db })).toMatchObject({ workouts: [{}], next: null });
			const stranger = crypto.randomUUID();
			expect(await listWorkouts(stranger, {}, { db })).toEqual({ v: 1, workouts: [], next: null });
			const cursor = await clientIdOf(db, run);
			expect((await listWorkouts(stranger, { before: cursor }, { db })).workouts).toEqual([]);
			await expect(listWorkouts(owner, { before: 'nope' }, { db })).rejects.toMatchObject({
				errors: { before: expect.any(String) }
			});
			await expect(listWorkouts(owner, { limit: 0 }, { db })).rejects.toMatchObject({
				errors: { limit: expect.any(String) }
			});
		});
	});
});

describe('completedWorkoutIds', () => {
	it('names each session’s newest completed workout by client id, and nothing else', async () => {
		await withRollback(async (db) => {
			const { owner, strength, run, other, pin } = await seedWorkoutDay(db);
			const at = (time: string) => ({ startedAt: utc(TODAY, time) });
			const strengthAt = async (time: string) =>
				(await logStrength(db, owner, { ...at(time), planned: pin(strength) }, [])).workoutId;
			// Logged out of order: the newest start wins, not the newest row.
			const newest = await strengthAt('07:00');
			await strengthAt('06:00');
			// None of these is done: in progress, abandoned or deleted.
			await logRun(db, owner, {
				...at('08:00'),
				planned: pin(run),
				metres: 1,
				status: 'in_progress'
			});
			await logRun(db, owner, {
				...at('09:00'),
				planned: pin(run),
				metres: 1,
				status: 'abandoned'
			});
			await logOther(db, owner, { ...at('10:00'), planned: pin(other), deleted: true });
			// An ad-hoc workout names no session.
			await logRun(db, owner, { ...at('12:00'), metres: 5000 });

			const lineages = [strength.lineage, run.lineage, other.lineage, 'not-a-lineage'];
			expect(await completedWorkoutIds(owner, lineages, { db })).toEqual({
				[strength.lineage]: await clientIdOf(db, newest)
			});
			expect(await completedWorkoutIds(owner, [], { db })).toEqual({});
		});
	});
});

describe('getWorkoutDetail', () => {
	it('summarises a planned strength workout against the bests from before it, with the plan against what was done', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids, pin } = await seedWorkoutDay(db);
			const before = [
				{ exercise: ids.back_squat, weight: 110, reps: 3, rpe: 9 },
				{ exercise: ids.back_squat, weight: 80, reps: 12, rpe: 8.5 }
			];
			await logStrength(db, owner, { startedAt: utc(addDays(TODAY, -7), '17:00') }, before);
			// Heavier, but after the workout: never a best it had to beat.
			await logStrength(db, owner, { startedAt: utc(addDays(TODAY, 2), '17:00') }, [
				{ exercise: ids.back_squat, weight: 150, reps: 3, rpe: 9 }
			]);
			const { workoutId } = await logStrength(
				db,
				owner,
				{ startedAt: utc(TODAY, '17:00'), planned: pin(strength), title: strength.title },
				[
					{ exercise: ids.back_squat, weight: 120, reps: 3, rpe: 9 },
					{ exercise: ids.back_squat, weight: 100, reps: 5, rpe: 8 },
					{ exercise: ids.leg_press, weight: 200, reps: 8, skipped: true },
					{ exercise: ids.leg_press, weight: 200, reps: 8, skipped: true },
					{ exercise: ids.hip_thrust, weight: 100, reps: 10, rpe: 8 },
					{ exercise: ids.pull_up, reps: 8, rpe: 8 }
				]
			);
			await db.insert(workoutSubstitutions).values({
				ownerId: owner,
				clientMutationId: crypto.randomUUID(),
				workoutId,
				exercisePosition: 3,
				fromExerciseId: ids.romanian_deadlift,
				toExerciseId: ids.hip_thrust,
				reason: 'equipment_unavailable'
			});
			// Added on top of the plan, after its five slots.
			await db.insert(setRecords).values({
				ownerId: owner,
				clientMutationId: crypto.randomUUID(),
				workoutId,
				exerciseId: ids.good_morning,
				exercisePosition: 6,
				setIndex: 1,
				weight: 60,
				unit: 'kg',
				reps: 8,
				performedAt: utc(TODAY, '17:50')
			});
			const pain = crypto.randomUUID();
			await db.insert(painReports).values({
				id: pain,
				ownerId: owner,
				workoutId,
				exerciseId: ids.pull_up,
				exercisePosition: 4,
				action: 'stopped',
				note: 'Elbow twinge',
				reportedAt: utc(TODAY, '17:40')
			});

			const detail = await detailOf(db, owner, workoutId);
			expect(detail.v).toBe(1);
			expect(detail.workout.workout).toMatchObject({ status: 'completed', title: strength.title });
			expect(detail.workout.substitutions).toEqual([
				expect.objectContaining({ position: 3, toExerciseId: ids.hip_thrust })
			]);
			expect(detail.workout.pain).toEqual([
				expect.objectContaining({ id: pain, note: 'Elbow twinge' })
			]);

			// The domain's summary on the same rows, against the bests written out by hand.
			const priorE1rm = Math.max(
				...before.map(
					(s) => setE1rm({ ...s, unit: 'kg', isWarmup: false, isSkipped: false })!.value
				)
			);
			const view = project(strengthTable, {
				workoutId: detail.workout.workout.id,
				kit: null,
				canonical: detail.workout,
				pending: []
			})!;
			const prior = {
				[ids.back_squat]: {
					e1rmKg: priorE1rm,
					repMaxes: [{ reps: 3, weightKg: 110 }],
					mostReps: null
				},
				[ids.hip_thrust]: null,
				[ids.pull_up]: null,
				[ids.good_morning]: null
			};
			expect(detail.summary).toEqual(summarizeWorkout(view, prior, KG_KM));
			expect(detail.summary.prs.map((pr) => [pr.kind, pr.reps, pr.previous])).toEqual([
				['e1rm', null, priorE1rm],
				['rep_max', 3, 110]
			]);
			expect(detail.summary.exercises.map((e) => [e.exerciseId, e.firstTime])).toEqual([
				[ids.back_squat, false],
				[ids.leg_press, false],
				[ids.hip_thrust, true],
				[ids.pull_up, true],
				[ids.good_morning, true]
			]);

			const plannedSets =
				strength.kind === 'strength'
					? strength.exercises.map((e) => e.sets.reduce((n, l) => n + l.sets, 0))
					: [];
			expect(detail.planned).toMatchObject({
				sessionId: strength.id,
				lineage: strength.lineage,
				title: strength.title,
				date: TODAY,
				run: null,
				other: null,
				added: [{ position: 6, exerciseId: ids.good_morning, done: 1 }]
			});
			expect(
				detail.planned!.exercises.map((e) => [
					e.position,
					e.exerciseId,
					e.sets,
					e.state,
					e.performedId,
					e.done,
					e.skipped
				])
			).toEqual([
				[1, ids.back_squat, plannedSets[0], 'planned', ids.back_squat, 2, 0],
				[2, ids.leg_press, plannedSets[1], 'skipped', ids.leg_press, 0, 2],
				[3, ids.romanian_deadlift, plannedSets[2], 'swapped', ids.hip_thrust, 1, 0],
				[4, ids.pull_up, plannedSets[3], 'stopped', ids.pull_up, 1, 0],
				[5, ids.plank, plannedSets[4], 'missed', null, 0, 0]
			]);
			expect(detail.planned!.exercises.map((e) => e.name)).toEqual([
				'Back squat',
				'Leg press',
				'Romanian deadlift',
				'Pull-up',
				'Plank'
			]);
		});
	});

	it('reads a planned slot that pain ended before any set as stopped, not missed', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids, pin } = await seedWorkoutDay(db);
			const { workoutId } = await logStrength(
				db,
				owner,
				{ startedAt: utc(TODAY, '17:00'), planned: pin(strength), title: strength.title },
				[{ exercise: ids.back_squat, weight: 100, reps: 5 }]
			);
			await db.insert(painReports).values({
				id: crypto.randomUUID(),
				ownerId: owner,
				workoutId,
				exerciseId: ids.leg_press,
				exercisePosition: 2,
				action: 'ended_workout',
				reportedAt: utc(TODAY, '17:20')
			});
			const detail = await detailOf(db, owner, workoutId);
			expect(detail.planned!.exercises.slice(0, 3).map((e) => [e.position, e.state])).toEqual([
				[1, 'planned'],
				[2, 'stopped'],
				[3, 'missed']
			]);
		});
	});

	it('shows a run with its segments and pace, and a Muay Thai class with its load, each against its plan', async () => {
		await withRollback(async (db) => {
			const { owner, run, other, pin } = await seedWorkoutDay(db);
			const runId = await logRun(db, owner, {
				startedAt: utc(TODAY, '07:00'),
				metres: 10000,
				durationSeconds: 3000,
				planned: pin(run),
				discipline: 'running'
			});
			for (const [position, kind, metres] of [
				[1, 'warm_up', 2000],
				[2, 'steady', 8000]
			] as const) {
				await db.insert(runRecordSegments).values({
					ownerId: owner,
					clientMutationId: crypto.randomUUID(),
					workoutId: runId,
					position,
					kind,
					distanceMetres: metres,
					durationSeconds: metres * 0.3
				});
			}
			const ran = await detailOf(db, owner, runId);
			expect(
				ran.workout.run!.segments.map((s) => [s.position, s.kind, s.paceSecondsPerKm])
			).toEqual([
				[1, 'warm_up', 300],
				[2, 'steady', 300]
			]);
			expect(ran.summary).toMatchObject({
				kind: 'run',
				run: {
					distanceMetres: 10000,
					durationSeconds: 3000,
					pace: paceSecondsPer(3000, 10000, 'km')
				},
				exercises: [],
				prs: []
			});
			expect(ran.planned).toMatchObject({ sessionId: run.id, exercises: [], other: null });
			expect(ran.planned!.run!.segments).toEqual(run.kind === 'run' ? run.segments : null);

			const classId = await logOther(db, owner, {
				startedAt: utc(TODAY, '19:00'),
				minutes: 75,
				planned: pin(other)
			});
			const trained = await detailOf(db, owner, classId);
			expect(trained.summary).toMatchObject({
				kind: 'other',
				sessionLoad: sessionLoad(60, 7),
				other: { kind: 'class', durationMinutes: 75, rpe: 7, load: sessionLoad(75, 7) }
			});
			expect(trained.planned).toMatchObject({
				sessionId: other.id,
				run: null,
				other:
					other.kind === 'other'
						? { kind: other.details.kind, durationMinutes: other.details.durationMinutes }
						: {}
			});

			// Off plan: no plan to hold it against.
			const offPlan = await logRun(db, owner, { startedAt: utc(TODAY, '06:00'), metres: 5000 });
			expect((await detailOf(db, owner, offPlan)).planned).toBeNull();
		});
	});

	it('reads anything but the owner’s completed, undeleted workout as nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const done = await logRun(db, owner, { startedAt: utc(TODAY, '07:00'), metres: 5000 });
			const id = await clientIdOf(db, done);
			expect(await getWorkoutDetail(owner, id, { db })).not.toBeNull();
			expect(await getWorkoutDetail(crypto.randomUUID(), id, { db })).toBeNull();
			for (const malformed of ['not-a-uuid', '', crypto.randomUUID()]) {
				expect(await getWorkoutDetail(owner, malformed, { db }), malformed).toBeNull();
			}
			for (const spec of [
				{ status: 'in_progress' },
				{ status: 'abandoned' },
				{ deleted: true }
			] as const) {
				const hidden = await logRun(db, owner, {
					startedAt: utc(TODAY, '09:00'),
					metres: 5000,
					...spec
				});
				expect(await getWorkoutDetail(owner, await clientIdOf(db, hidden), { db })).toBeNull();
			}
		});
	});
});

describe('getExerciseHistory', () => {
	it('pages an exercise’s sets from its last session, with its records and previous session', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat, leg_press: press } = await exerciseIds(db, KEYS);
			await logStrength(db, owner, { startedAt: utc('2026-11-02', '17:00') }, [
				{ exercise: squat, weight: 100, reps: 5, rpe: 8 },
				{ exercise: squat, weight: 105, reps: 5, rpe: 9 }
			]);
			const last = await logStrength(db, owner, { startedAt: utc('2026-11-06', '17:00') }, [
				{ exercise: squat, weight: 60, reps: 5, warmup: true },
				{ exercise: press, weight: 200, reps: 8 },
				{ exercise: squat, weight: 110, reps: 3, rpe: 9 },
				{ exercise: squat, weight: 110, reps: 3, skipped: true }
			]);
			const now = () => new Date('2026-11-11T08:00:00Z');

			const first = await getExerciseHistory(owner, squat, { limit: 3 }, { db, now });
			expect(first).toMatchObject({
				v: 1,
				exercise: { id: squat, name: 'Back squat', measure: 'reps', loadType: 'external' }
			});
			// Newest first: the last session's sets lead the first page.
			const [warmup, , top, skipped] = last.setIds;
			expect(first!.sets.map((s) => s.id)).toEqual([skipped, top, warmup]);
			expect(first!.next).toBe(warmup);
			const second = await getExerciseHistory(
				owner,
				squat,
				{ before: first!.next!, limit: 3 },
				{ db, now }
			);
			expect(second!.sets.map((s) => [s.weight, s.reps])).toEqual([
				[105, 5],
				[100, 5]
			]);
			expect(second!.next).toBeNull();

			// The previous session is the last completed one, in workout order, skipped sets left out.
			expect(first!.previous).toEqual({
				date: '2026-11-06',
				sets: [
					expect.objectContaining({ weight: 60, reps: 5, isWarmup: true }),
					expect.objectContaining({ weight: 110, reps: 3, isWarmup: false })
				]
			});
			expect(first!.records.bestE1rm).toMatchObject({
				kind: 'estimated',
				value: expect.any(Number)
			});
			expect(first!.records.repMaxes.map((r) => [r.reps, r.weightKg])).toEqual([
				[3, 110],
				[5, 105]
			]);

			// A workout still in progress is in the sets, never the previous session.
			await logStrength(
				db,
				owner,
				{ startedAt: utc('2026-11-10', '17:00'), status: 'in_progress' },
				[{ exercise: squat, weight: 120, reps: 2 }]
			);
			const again = await getExerciseHistory(owner, squat, {}, { db, now });
			expect(again!.sets[0]).toMatchObject({ weight: 120, reps: 2 });
			expect(again!.previous?.date).toBe('2026-11-06');
		});
	});

	it('keeps an assisted set’s assistance on every page and in the previous session', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { pull_up: pullUp } = await exerciseIds(db, KEYS);
			for (const day of ['2026-11-02', '2026-11-06']) {
				const { setIds } = await logStrength(db, owner, { startedAt: utc(day, '17:00') }, [
					{ exercise: pullUp, reps: 8 }
				]);
				await db.update(setRecords).set({ assistance: 30 }).where(eq(setRecords.id, setIds[0]!));
			}
			const now = () => new Date('2026-11-11T08:00:00Z');
			const first = await getExerciseHistory(owner, pullUp, { limit: 1 }, { db, now });
			const older = await getExerciseHistory(
				owner,
				pullUp,
				{ before: first!.next!, limit: 1 },
				{ db, now }
			);
			for (const page of [first!, older!]) {
				expect(page.sets).toEqual([
					expect.objectContaining({ weight: null, reps: 8, assistance: 30 })
				]);
			}
			expect(first!.previous!.sets).toEqual([expect.objectContaining({ assistance: 30 })]);
		});
	});

	it('reads a malformed id, or another owner’s exercise, as nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const stranger = crypto.randomUUID();
			const theirs = await createCustomExercise(
				stranger,
				{
					name: 'Sandbag shouldering',
					aliases: [],
					pattern: 'hinge',
					primaryMuscles: ['glutes', 'hamstrings'],
					secondaryMuscles: ['lower_back'],
					substitutionGroup: 'hip_hinge_ballistic',
					measure: 'reps',
					loadType: 'external',
					repMin: 3,
					repMax: 5
				},
				{ db }
			);
			expect(await getExerciseHistory(stranger, theirs.id, {}, { db })).not.toBeNull();
			for (const id of [theirs.id, 'not-a-uuid', crypto.randomUUID()]) {
				expect(await getExerciseHistory(owner, id, {}, { db }), id).toBeNull();
			}
		});
	});

	describe('GET /api/exercises/[id]/history', () => {
		const event = (ownerId: string, id: string, search = '') =>
			({
				params: { id },
				url: new URL(`http://localhost/api/exercises/${id}/history${search}`),
				locals: { session: { ownerId } }
			}) as never;

		it('answers the owner’s history, never cached; a foreign or malformed id is a 404, a malformed page a 400', async () => {
			await withCommitted(async (db) => {
				const owner = await makeOwner(db);
				const { back_squat: squat } = await exerciseIds(db, KEYS);
				await logStrength(db, owner, { startedAt: utc('2026-11-02', '17:00') }, [
					{ exercise: squat, weight: 100, reps: 5, rpe: 8 }
				]);

				const found = await getHistory(event(owner, squat));
				expect(found.status).toBe(200);
				expect(found.headers.get('cache-control')).toBe('no-store');
				expect(await found.json()).toMatchObject({
					v: 1,
					exercise: { id: squat },
					sets: [{ weight: 100, reps: 5 }],
					next: null,
					records: { bestE1rm: { kind: 'estimated' } }
				});

				for (const id of ['not-a-uuid', crypto.randomUUID()]) {
					const missing = await getHistory(event(owner, id));
					expect(missing.status, id).toBe(404);
					expect(missing.headers.get('cache-control')).toBe('no-store');
					expect(await missing.json()).toEqual({ error: 'not_found' });
				}
				for (const search of ['?before=abc', '?before=0', '?before=-1']) {
					const invalid = await getHistory(event(owner, squat, search));
					expect(invalid.status, search).toBe(400);
					expect(invalid.headers.get('cache-control')).toBe('no-store');
					expect(await invalid.json()).toMatchObject({
						error: 'invalid',
						errors: { before: expect.any(String) }
					});
				}
			});
		});
	});
});
