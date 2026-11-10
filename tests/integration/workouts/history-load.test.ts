/**
 * Workout History's load (src/routes/(app)/progress/workouts/[[id]]/history.server.ts) on real
 * Postgres: the completed workouts newest first, 20 at a time, each row in words; with an id, that
 * workout's detail in words (every set with its RPE, skipped, extra and missed; the best e1RM
 * labelled as an estimate; substitutions, pain, run segments and session metrics; notes). A
 * malformed or unknown id is the 404 page; a read that fails is the designed error, recorded.
 * Rows are written straight into their tables through M3's history fixtures.
 */
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	otherSessionRecords,
	painReports,
	runRecordSegments,
	runRecords,
	setRecords,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	loadWorkoutHistory,
	type WorkoutHistoryData
} from '../../../src/routes/(app)/progress/workouts/[[id]]/history.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { exerciseIds, logOther, logRun, logStrength, utc } from '../training/fixtures/history';

const ROUTE = '/(app)/progress/workouts/[[id]]';
const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/progress/workouts',
	routeId: ROUTE,
	appVersion: '0.1.0+test'
});

const load = (db: Executor, owner: string, id?: string, before: string | null = null) =>
	loadWorkoutHistory(owner, { id, before, origin: origin() }, { db });

async function ready(promise: Promise<WorkoutHistoryData>) {
	const data = await promise;
	if (data.state !== 'ready') throw new Error(`expected History, got ${data.state}`);
	return data;
}

async function status(promise: Promise<unknown>): Promise<number> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!isHttpError(error)) throw new Error(`expected an HTTP error, got ${String(error)}`);
	return error.status;
}

async function clientIdOf(db: Executor, workoutId: string): Promise<string> {
	const [row] = await db
		.select({ clientId: workouts.clientId })
		.from(workouts)
		.where(eq(workouts.id, workoutId));
	return row!.clientId;
}

/** An owner in London, who logs in kg and km. */
async function owner(db: Executor) {
	const id = await makeOwner(db);
	await saveBasics(
		id,
		{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Europe/London' },
		{ db }
	);
	return id;
}

describe('workout History', () => {
	it('with nothing finished, the first page is empty and there is no detail', async () => {
		await withRollback(async (db) => {
			const data = await ready(load(db, await owner(db)));
			expect(data).toEqual({ state: 'ready', rows: [], next: null, empty: true, detail: null });
		});
	});

	it('lists each completed workout in words, newest first, with the number for its kind', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const { back_squat: squat } = await exerciseIds(db, ['back_squat']);
			await logStrength(db, me, { startedAt: utc('2026-11-02', '17:00'), title: 'Lower A' }, [
				{ exercise: squat, weight: 100, reps: 5 },
				{ exercise: squat, weight: 100, reps: 5 }
			]);
			await logRun(db, me, {
				startedAt: utc('2026-11-03', '07:00'),
				title: 'Easy run',
				metres: 8020,
				durationSeconds: 2700
			});
			await logOther(db, me, {
				startedAt: utc('2026-11-04', '18:30'),
				title: 'Muay Thai',
				durationSeconds: null,
				sessionRpe: 8,
				minutes: 90
			});

			const data = await ready(load(db, me));
			expect(data.rows.map(({ title, tone, meta, figure }) => [title, tone, meta, figure])).toEqual(
				[
					['Muay Thai', 'combat', 'Wed 4 Nov · 1 h 30 min', 'RPE 8'],
					['Easy run', 'running', 'Tue 3 Nov · 45 min', '8.02 km'],
					['Lower A', 'strength', 'Mon 2 Nov · 1 h 00 min', '2 sets']
				]
			);
			expect(data).toMatchObject({ next: null, empty: false, detail: null });
		});
	});

	it('a strength workout shows every set with its RPE and marks, the estimated e1RM, swaps, pain and notes', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const ids = await exerciseIds(db, ['back_squat', 'romanian_deadlift', 'hip_thrust']);
			const { workoutId } = await logStrength(
				db,
				me,
				{ startedAt: utc('2026-11-05', '18:00'), title: 'Lower B' },
				[
					{ exercise: ids.back_squat, weight: 60, reps: 5, warmup: true },
					{ exercise: ids.back_squat, weight: 100, reps: 5, rpe: 8 },
					{ exercise: ids.back_squat, weight: 100, reps: 5, skipped: true },
					{ exercise: ids.back_squat, weight: 90, reps: 8, rpe: 9.5, extra: true },
					{ exercise: ids.hip_thrust, weight: 120, reps: 10, rpe: 7 }
				]
			);
			// The fixtures write no missed reps: the squat's working set missed one of six.
			await db.update(setRecords).set({ missedReps: 1 }).where(eq(setRecords.rpe, 8));
			await db.update(workouts).set({ notes: 'Felt strong' }).where(eq(workouts.id, workoutId));
			await db.insert(workoutSubstitutions).values({
				ownerId: me,
				clientMutationId: crypto.randomUUID(),
				workoutId,
				exercisePosition: 2,
				fromExerciseId: ids.romanian_deadlift,
				toExerciseId: ids.hip_thrust,
				reason: 'equipment_unavailable'
			});
			await db.insert(painReports).values({
				id: crypto.randomUUID(),
				ownerId: me,
				workoutId,
				exerciseId: ids.back_squat,
				exercisePosition: 1,
				bodyArea: 'knee',
				severity: 'mild',
				action: 'stopped',
				note: 'Twinge at the bottom',
				reportedAt: utc('2026-11-05', '18:40')
			});
			const id = await clientIdOf(db, workoutId);

			const { detail, rows } = await ready(load(db, me, id));
			expect(rows.map((r) => r.id)).toEqual([id]); // the list comes with the detail
			expect(detail).toMatchObject({
				id,
				tone: 'strength',
				title: 'Lower B',
				eyebrow: 'Strength · Thursday 5 November · 18:00',
				notes: ['Felt strong'],
				substitutions: ['Romanian deadlift → Hip thrust · Equipment busy or missing'],
				pain: [
					{
						title: 'Back squat · Knee · Mild · Stopped the exercise',
						note: 'Twinge at the bottom'
					}
				],
				segments: [],
				metrics: [],
				planned: null
			});
			expect(detail!.stats).toEqual(
				expect.arrayContaining([
					{ label: 'Duration', value: '1 h 00 min' },
					{ label: 'Working sets', value: '3' },
					{ label: 'Session RPE', value: '7' }
				])
			);
			const [squat, thrust] = detail!.exercises;
			expect(squat!.name).toBe('Back squat');
			// What the exercise-history sheet asks for.
			expect([squat!.exerciseId, thrust!.exerciseId]).toEqual([ids.back_squat, ids.hip_thrust]);
			expect(squat!.best).toMatch(/^Estimated 1RM · \d+(\.\d+)? kg$/);
			expect(squat!.sets.map(({ label, value, rpe, mark }) => [label, value, rpe, mark])).toEqual([
				['Warm-up', '60 kg × 5', null, null],
				['Set 2', '100 kg × 5', 'RPE 8', '1 missed'],
				['Set 3', 'Not done', null, 'Skipped'],
				['Set 4', '90 kg × 8', 'RPE 9.5', 'Extra set']
			]);
			expect(thrust!.sets.map((s) => [s.label, s.value, s.rpe])).toEqual([
				['Set 1', '120 kg × 10', 'RPE 7']
			]);
		});
	});

	it("a run shows its segments with pace, and a Muay Thai class its metrics, in the owner's units", async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const runId = await logRun(db, me, {
				startedAt: utc('2026-11-06', '07:00'),
				title: 'Intervals',
				metres: 5000,
				durationSeconds: 1500
			});
			await db.update(runRecords).set({ avgHr: 152 }).where(eq(runRecords.workoutId, runId));
			for (const [position, kind, metres, seconds] of [
				[1, 'warm_up', 1000, 360],
				[2, 'interval', 400, 96]
			] as const) {
				await db.insert(runRecordSegments).values({
					ownerId: me,
					clientMutationId: crypto.randomUUID(),
					workoutId: runId,
					position,
					kind,
					distanceMetres: metres,
					durationSeconds: seconds
				});
			}
			const classId = await logOther(db, me, {
				startedAt: utc('2026-11-06', '19:00'),
				title: 'Muay Thai class',
				minutes: 60
			});
			await db
				.update(otherSessionRecords)
				.set({
					metrics: [
						{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
						{ key: 'sparred', label: 'Sparred', unit: null, value: true }
					]
				})
				.where(eq(otherSessionRecords.workoutId, classId));

			const ran = (await ready(load(db, me, await clientIdOf(db, runId)))).detail!;
			expect(ran.segments.map(({ label, value }) => [label, value])).toEqual([
				['1. Warm-up', '1 km · 6:00 · 6:00 /km'],
				['2. Interval', '0.4 km · 1:36 · 4:00 /km']
			]);
			expect(ran.stats).toEqual(
				expect.arrayContaining([
					{ label: 'Distance', value: '5 km' },
					{ label: 'Pace', value: '5:00 /km' },
					{ label: 'Avg HR', value: '152 bpm' }
				])
			);

			const thai = (await ready(load(db, me, await clientIdOf(db, classId)))).detail!;
			expect(thai.eyebrow).toBe('Class · Friday 6 November · 19:00');
			expect(thai.metrics.map(({ label, value }) => [label, value])).toEqual([
				['Rounds', '6'],
				['Sparred', 'Yes']
			]);
			expect(thai.exercises).toEqual([]);
		});
	});

	it("a planned interval run counts the plan's segments as they are run, each repeat apart", async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const plan = programFixture('workout-day', { monday: '2026-11-09', today: '2026-11-11' });
			const { programId } = await createProgramFromPlan(me, plan, { source: 'rules' }, { db });
			const v1 = await getProgramVersion(me, programId, 1, { db });
			const run = (v1.blocks[0]!.weeks[0]!.sessions as StoredSession[])[1]!;
			const runId = await logRun(db, me, {
				startedAt: utc('2026-11-11', '07:00'),
				metres: null,
				planned: { sessionId: run.id, lineageId: run.lineage, programId },
				discipline: 'running'
			});

			const ran = (await ready(load(db, me, await clientIdOf(db, runId)))).detail!;
			// Warm-up, 6 × (interval + recovery), cool-down.
			expect(ran.planned!.lines).toEqual([{ key: 'run', label: 'Run', value: '14 segments' }]);
		});
	});

	it('pages 22 workouts as 20 and 2; a malformed cursor is the first page', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			for (let day = 1; day <= 22; day++) {
				await logRun(db, me, {
					startedAt: new Date(Date.UTC(2026, 9, day, 7)),
					title: `Run ${day}`,
					metres: 5000
				});
			}
			const first = await ready(load(db, me));
			expect(first.rows).toHaveLength(20);
			expect(first.rows[0]!.title).toBe('Run 22');
			expect(first.next).toBe(first.rows[19]!.id);

			const second = await ready(load(db, me, undefined, first.next));
			expect(second.rows.map((r) => r.title)).toEqual(['Run 2', 'Run 1']);
			expect(second).toMatchObject({ next: null, empty: false });

			const malformed = await ready(load(db, me, undefined, 'not-a-cursor'));
			expect(malformed.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
		});
	});

	it('a malformed, unknown or unfinished id is the 404 page', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const open = await logRun(db, me, {
				startedAt: utc('2026-11-06', '07:00'),
				metres: 5000,
				status: 'in_progress'
			});
			for (const id of ['sample', '1', crypto.randomUUID(), await clientIdOf(db, open)]) {
				expect(await status(load(db, me, id)), id).toBe(404);
			}
		});
		// A malformed id never reaches the database.
		const broken = unreachableDb();
		try {
			expect(await status(load(broken.db, crypto.randomUUID(), 'sample'))).toBe(404);
		} finally {
			await broken.close();
		}
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				for (const id of [undefined, crypto.randomUUID()]) {
					const request = origin();
					const data = await loadWorkoutHistory(
						crypto.randomUUID(),
						{ id, before: null, origin: request },
						{ db: broken.db, errorsDb: tx }
					);
					expect(data).toEqual({ state: 'error' });
					const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
					expect(recorded).toHaveLength(1);
					expect(recorded[0]).toMatchObject({
						kind: 'load',
						status: 500,
						routeId: ROUTE,
						context: expect.objectContaining({ load: 'workout-history' })
					});
				}
			});
		} finally {
			await broken.close();
		}
	});
});
