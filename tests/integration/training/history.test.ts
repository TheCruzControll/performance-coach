/**
 * The history queries on real Postgres (src/lib/server/db/queries/history.ts) through the
 * history services (src/lib/server/services/training/history.ts), as the screens and the coach's
 * tools (M4–M6) read them: an exercise's sets newest first, page by page; its last performances;
 * PRs and best e1RM; weekly hard sets per muscle; weekly mileage; and the sessions planned and
 * logged in a date range.
 * - Each aggregate is the domain metric (hardSets, weeklyDistance, bestE1rm, personalRecords) on
 *   the rows a query returns, so 'hard set', 'PR' and 'week' keep one definition each.
 * - Weeks run Monday to Sunday on the owner's calendar (the profile's time zone), whatever the
 *   UTC date says.
 * - Every read is the owner's: another owner sees nothing, even given the owner's ids.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import {
	bestE1rm,
	hardSets,
	personalRecords,
	weeklyDistance,
	type ExerciseMuscles,
	type LoggedDistance,
	type LoggedSet
} from '../../../src/lib/domain/training/metrics';
import { toMetres } from '../../../src/lib/domain/units';
import {
	athleteProfiles,
	createProfileRepository,
	exercises,
	setRecords,
	type Executor
} from '../../../src/lib/server/db';
import { HISTORY_INDEXES } from '../../../src/lib/server/db/queries/history';
import {
	createCustomExercise,
	retireCustomExercise
} from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import {
	getExerciseHistory,
	getLastPerformances,
	getPersonalRecords,
	getSessionsInRange,
	getWeeklyMileage,
	getWeeklyMuscleVolume,
	HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE,
	MAX_LAST_PERFORMANCES,
	MAX_RANGE_DAYS,
	type HistorySet
} from '../../../src/lib/server/services/training/history';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { exerciseIds, logOther, logRun, logStrength, utc, type SetSpec } from './fixtures/history';

const KEYS = ['back_squat', 'front_squat', 'bench_press', 'barbell_row', 'deadlift'] as const;
const LA = 'America/Los_Angeles';

/** An instant given as Los Angeles wall time in November 2026 (PST, UTC−8: DST ends 1 Nov). */
const pst = (date: string, time: string) => new Date(`${date}T${time}:00-08:00`);

async function setProfile(
	db: Executor,
	owner: string,
	values: { timeZone?: string; distanceUnit?: 'km' | 'mi' }
) {
	await createProfileRepository(db).ensureProfile(owner);
	await db.update(athleteProfiles).set(values).where(eq(athleteProfiles.ownerId, owner));
}

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

/** Every page of an exercise's history, `limit` sets at a time. */
async function allPages(db: Executor, owner: string, exercise: string, limit: number) {
	const pages: HistorySet[][] = [];
	let before: number | undefined;
	for (;;) {
		const page = await getExerciseHistory(owner, exercise, { before, limit }, { db });
		pages.push(page.sets);
		if (page.next === null) return pages;
		expect(page.sets).toHaveLength(limit);
		expect(page.next).toBe(page.sets.at(-1)!.id);
		before = page.next;
	}
}

/** The owner's undeleted sets of one exercise, straight from the table, as the metrics read them. */
async function storedSets(db: Executor, owner: string, exercise: string) {
	return db
		.select()
		.from(setRecords)
		.where(
			and(
				eq(setRecords.ownerId, owner),
				eq(setRecords.exerciseId, exercise),
				isNull(setRecords.deletedAt)
			)
		);
}

const ids = (sets: readonly { id: number }[]) => sets.map((s) => s.id);

describe('exercise history', () => {
	it('lists an exercise newest first, every set once across pages, deleted sets left out', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat, bench_press: bench } = await exerciseIds(db, KEYS);
			const first = await logStrength(db, owner, { startedAt: utc('2026-11-02', '17:00') }, [
				{ exercise: squat, weight: 60, reps: 5, warmup: true },
				{ exercise: squat, weight: 100, reps: 5, rpe: 7 },
				{ exercise: squat, weight: 100, reps: 5, rpe: 8, deleted: true },
				{ exercise: bench, weight: 80, reps: 5, rpe: 8 }
			]);
			// Two sets in the same millisecond, then two at the same instant (ties go by id).
			const lb = (rpe: number, performedAt: Date | string): SetSpec => ({
				exercise: squat,
				weight: 225,
				unit: 'lb',
				rpe,
				performedAt
			});
			const fifteen = utc('2026-11-04', '17:15');
			const second = await logStrength(db, owner, { startedAt: utc('2026-11-04', '17:00') }, [
				lb(8, '2026-11-04T17:10:00.1234Z'),
				lb(8, '2026-11-04T17:10:00.123456Z'),
				lb(8.5, fifteen),
				lb(9, fifteen)
			]);
			const third = await logStrength(db, owner, { startedAt: utc('2026-11-06', '07:00') }, [
				{ exercise: squat, weight: 105, reps: 3, rpe: 8 },
				{ exercise: squat, weight: 105, reps: 3, skipped: true }
			]);
			const [w1, set1, , benchSet] = first.setIds;
			const [a, b, c, d] = second.setIds;
			const expected = [...[...third.setIds].reverse(), d, c, b, a, set1, w1];

			for (const limit of [1, 2, 3, 4, 7, expected.length, MAX_HISTORY_PAGE]) {
				const pages = await allPages(db, owner, squat, limit);
				expect(pages.flat().map((s) => s.id)).toEqual(expected);
			}

			const { sets, next } = await getExerciseHistory(owner, squat, {}, { db });
			expect(next).toBeNull();
			// Warm-ups and skipped sets are history too, flagged; a set keeps the unit it was entered in.
			expect(sets.find((s) => s.id === w1)).toMatchObject({ isWarmup: true, weight: 60 });
			expect(sets.find((s) => s.id === third.setIds[1])).toMatchObject({ isSkipped: true });
			expect(sets.find((s) => s.id === d)).toMatchObject({
				workoutId: second.workoutId,
				exercisePosition: 1,
				setIndex: 4,
				weight: 225,
				unit: 'lb',
				reps: 5,
				rpe: 9
			});
			expect(sets.find((s) => s.id === d)!.weightKg).toBeCloseTo(102.058, 3);
			expect(ids(sets)).not.toContain(benchSet);
			expect((await getExerciseHistory(owner, bench!, {}, { db })).sets.map((s) => s.id)).toEqual([
				benchSet
			]);
		});
	});

	it(`pages ${HISTORY_PAGE_SIZE} sets at a time unless asked for fewer or more`, async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat } = await exerciseIds(db, KEYS);
			const specs: SetSpec[] = Array.from({ length: HISTORY_PAGE_SIZE + 5 }, () => ({
				exercise: squat,
				weight: 100,
				rpe: 7
			}));
			const { setIds } = await logStrength(
				db,
				owner,
				{ startedAt: utc('2026-11-02', '07:00') },
				specs
			);
			const page = await getExerciseHistory(owner, squat, {}, { db });
			expect(ids(page.sets)).toEqual([...setIds].reverse().slice(0, HISTORY_PAGE_SIZE));
			const rest = await getExerciseHistory(owner, squat, { before: page.next! }, { db });
			expect(ids(rest.sets)).toEqual([...setIds].reverse().slice(HISTORY_PAGE_SIZE));
			expect(rest.next).toBeNull();
		});
	});
});

describe('last performances', () => {
	it('gives the last workouts with the exercise, newest first, each with all its working sets', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat, bench_press: bench } = await exerciseIds(db, KEYS);
			const log = (date: string, sets: SetSpec[], title = `Squat day ${date}`) =>
				logStrength(db, owner, { startedAt: utc(date, '17:00'), title }, sets);
			const working = (weight: number, rpe = 8): SetSpec => ({ exercise: squat, weight, rpe });

			await log('2026-11-02', [working(95), working(95)]);
			const older = await log('2026-11-04', [working(97.5), working(97.5), working(97.5)]);
			const middle = await log('2026-11-06', [
				{ exercise: bench, weight: 80, rpe: 8 },
				working(100),
				{ ...working(100), extra: true }
			]);
			// Only warm-ups, a skipped and a deleted set: no performance.
			await log('2026-11-09', [
				{ exercise: squat, weight: 60, warmup: true },
				{ ...working(100), skipped: true },
				{ ...working(100), deleted: true }
			]);
			await log('2026-11-10', [{ exercise: bench, weight: 82.5, rpe: 8 }], 'Bench only');
			const latest = await log('2026-11-11', [
				{ exercise: squat, weight: 60, warmup: true },
				working(102.5),
				{ ...working(102.5), deleted: true },
				working(102.5, 9),
				{ ...working(102.5), skipped: true }
			]);

			const last = await getLastPerformances(owner, squat, { count: 3 }, { db });
			expect(last.map((p) => [p.workoutId, p.title, p.startedAt])).toEqual([
				[latest.workoutId, 'Squat day 2026-11-11', utc('2026-11-11', '17:00')],
				[middle.workoutId, 'Squat day 2026-11-06', utc('2026-11-06', '17:00')],
				[older.workoutId, 'Squat day 2026-11-04', utc('2026-11-04', '17:00')]
			]);
			expect(last.map((p) => ids(p.sets))).toEqual([
				[latest.setIds[1], latest.setIds[3]],
				[middle.setIds[1], middle.setIds[2]],
				older.setIds
			]);
			expect(last[0]!.sets.map((s) => [s.setIndex, s.weight, s.rpe])).toEqual([
				[2, 102.5, 8],
				[4, 102.5, 9]
			]);
			expect(last[1]!.sets.map((s) => [s.exercisePosition, s.isExtra])).toEqual([
				[2, false],
				[2, true]
			]);
			expect(await getLastPerformances(owner, squat, {}, { db })).toEqual(last);
			expect(
				(await getLastPerformances(owner, squat, { count: MAX_LAST_PERFORMANCES }, { db })).length
			).toBe(4);
			expect(ids((await getLastPerformances(owner, bench, { count: 1 }, { db }))[0]!.sets)).toEqual(
				[(await getExerciseHistory(owner, bench, { limit: 1 }, { db })).sets[0]!.id]
			);
		});
	});
});

describe('personal records', () => {
	it('equal the domain metrics on the same rows, for one exercise and for all, retired ones included', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const ex = await exerciseIds(db, KEYS);
			const sandbag = await createCustomExercise(
				owner,
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
			const squat = (weight: number, reps: number, more: Partial<SetSpec> = {}): SetSpec => ({
				exercise: ex.back_squat,
				weight,
				reps,
				...more
			});
			await logStrength(db, owner, { startedAt: utc('2026-11-02', '17:00') }, [
				squat(140, 1, { warmup: true }),
				squat(150, 3, { skipped: true }),
				squat(160, 1, { rpe: 9, deleted: true }),
				squat(100, 5, { rpe: 8 }),
				squat(95, 6, { rpe: 8 }),
				squat(60, 12, { rpe: 7 }),
				{ exercise: ex.bench_press, weight: 80, reps: 5, rpe: 8 },
				{ exercise: ex.front_squat, weight: 90, reps: 3, rpe: 8 },
				{ exercise: ex.deadlift, weight: 100, reps: 5, warmup: true },
				{ exercise: sandbag.id, weight: 70, reps: 3, rpe: 8 }
			]);
			const second = await logStrength(db, owner, { startedAt: utc('2026-11-09', '17:00') }, [
				squat(225, 5, { unit: 'lb', rpe: 8.5 }),
				squat(120, 1, { rpe: 9 }),
				squat(110, 3, { rpe: 9.5 }),
				squat(95, 6, { rpe: 7 }),
				squat(90, 8),
				{ exercise: ex.back_squat, weight: null, reps: 10 },
				{ exercise: ex.bench_press, weight: 185, unit: 'lb', reps: 3, rpe: 9 }
			]);
			// The seed retires a key that leaves the catalogue; the owner retires their own.
			await db
				.update(exercises)
				.set({ retiredAt: new Date('2026-11-12T00:00:00Z') })
				.where(eq(exercises.id, ex.front_squat));
			await retireCustomExercise(owner, sandbag.id, { db });

			const all = await getPersonalRecords(owner, {}, { db });
			const withSets = [ex.back_squat, ex.bench_press, ex.front_squat, sandbag.id];
			expect(all.map((r) => r.exerciseId).sort()).toEqual([...withSets].sort());

			for (const exerciseId of withSets) {
				const rows = await storedSets(db, owner, exerciseId);
				const best = bestE1rm(rows)!;
				const records = personalRecords(rows);
				const found = all.find((r) => r.exerciseId === exerciseId)!;
				expect(found.bestE1rm).toMatchObject({
					kind: 'estimated',
					method: best.method,
					confidence: best.confidence
				});
				expect(found.bestE1rm!.value).toBeCloseTo(best.value, 9);
				expect(found.bestE1rm!.set.id).toBe(best.set.id);
				expect(found.repMaxes.map((r) => [r.reps, r.set.id])).toEqual(
					records.map((r) => [r.reps, r.set.id])
				);
				found.repMaxes.forEach((r, i) => expect(r.weightKg).toBeCloseTo(records[i]!.weightKg, 9));
				expect(await getPersonalRecords(owner, { exerciseId }, { db })).toEqual([found]);
			}

			const squatRecords = all.find((r) => r.exerciseId === ex.back_squat)!;
			expect(squatRecords).toMatchObject({ key: 'back_squat', name: 'Back squat' });
			// Not the warm-up, skipped or deleted sets; 225 lb beats 100 kg; the later 95 kg × 6 wins.
			expect(squatRecords.repMaxes.map((r) => [r.reps, r.set.id])).toEqual([
				[1, second.setIds[1]],
				[3, second.setIds[2]],
				[5, second.setIds[0]],
				[6, second.setIds[3]],
				[8, second.setIds[4]]
			]);
			expect(squatRecords.bestE1rm!.set.id).toBe(second.setIds[1]);
			expect(all.find((r) => r.exerciseId === sandbag.id)).toMatchObject({
				key: null,
				name: 'Sandbag shouldering'
			});
			expect(await getPersonalRecords(owner, { exerciseId: ex.deadlift }, { db })).toEqual([]);
			expect(await getPersonalRecords(owner, { exerciseId: ex.barbell_row }, { db })).toEqual([]);
		});
	});
});

describe('weekly muscle volume', () => {
	it("equals the domain's hard sets, weeks split on Monday in the owner's time zone", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await setProfile(db, owner, { timeZone: LA });
			const ex = await exerciseIds(db, KEYS);
			const inRange: LoggedSet[] = [];
			/** One set per workout, so each can sit on its own instant. */
			const log = async (at: Date, spec: SetSpec, counts: boolean) => {
				await logStrength(db, owner, { startedAt: at }, [{ ...spec, performedAt: at }]);
				if (!counts) return;
				inRange.push({
					exercise: spec.exercise,
					weight: spec.weight ?? null,
					unit: spec.unit ?? 'kg',
					reps: spec.reps ?? 5,
					rpe: spec.rpe ?? null,
					isWarmup: spec.warmup ?? false,
					isSkipped: spec.skipped ?? false,
					performedAt: at
				});
			};
			const squat = { exercise: ex.back_squat, weight: 100, rpe: 8 };
			const row = { exercise: ex.barbell_row, weight: 70, rpe: 7 };
			const bench = { exercise: ex.bench_press, weight: 80 };

			// Sunday night in LA is Monday in UTC: still the week before, so out of range.
			await log(pst('2026-11-01', '23:30'), squat, false);
			await log(pst('2026-11-02', '00:15'), squat, true);
			await log(pst('2026-11-03', '18:00'), { ...squat, warmup: true }, true);
			await log(pst('2026-11-03', '18:05'), { ...squat, rpe: 6 }, true);
			await log(pst('2026-11-03', '18:10'), { ...row, skipped: true }, true);
			await log(pst('2026-11-03', '18:15'), { ...row, deleted: true }, false);
			await log(pst('2026-11-08', '22:00'), row, true);
			await log(pst('2026-11-09', '18:00'), bench, true);
			await log(pst('2026-11-09', '18:05'), { ...bench, unit: 'lb', weight: 185, rpe: 9 }, true);
			await log(pst('2026-11-15', '23:00'), row, true);
			await log(pst('2026-11-16', '00:30'), squat, false);

			const weeks = await getWeeklyMuscleVolume(
				owner,
				{ from: '2026-11-02', to: '2026-11-15' },
				{ db }
			);
			const byKey = new Map(CATALOGUE.map((e) => [e.key, e]));
			const muscles = new Map<string, ExerciseMuscles>(
				KEYS.map((key) => [ex[key], byKey.get(key)!])
			);
			expect(weeks).toEqual(hardSets(inRange, muscles, LA));
			expect(weeks).toEqual([
				{
					weekStart: '2026-11-02',
					muscles: {
						quads: 1,
						glutes: 1,
						adductors: 0.5,
						lower_back: 1,
						upper_back: 1,
						lats: 1,
						rear_delts: 0.5,
						biceps: 0.5,
						forearms: 0.5
					},
					groups: expect.any(Object)
				},
				{ weekStart: '2026-11-09', muscles: expect.any(Object), groups: expect.any(Object) }
			]);
			expect(weeks[1]!.muscles).toMatchObject({ chest: 2, triceps: 1, upper_back: 1 });

			// The first week alone still has its Sunday night, which UTC dates on the Monday.
			const firstWeek = await getWeeklyMuscleVolume(
				owner,
				{ from: '2026-11-02', to: '2026-11-08' },
				{ db }
			);
			expect(firstWeek).toEqual([weeks[0]]);
		});
	});
});

describe('weekly mileage', () => {
	it('adds km and mi runs per Monday-to-Sunday week on local dates, in the unit asked for', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await setProfile(db, owner, { timeZone: LA, distanceUnit: 'mi' });
			const { back_squat: squat } = await exerciseIds(db, KEYS);
			const counted: LoggedDistance[] = [];
			const run = async (at: Date, distance: number, unit: 'km' | 'mi', counts = true) => {
				await logRun(db, owner, { startedAt: at, metres: toMetres(distance, unit) });
				if (counts) counted.push({ distance, unit, startedAt: at });
			};

			await run(pst('2026-11-01', '23:00'), 5, 'km', false);
			await run(pst('2026-11-02', '06:00'), 10, 'km');
			await run(pst('2026-11-04', '06:00'), 5, 'mi');
			// 21:00 on Sunday in LA is Monday 05:00 UTC: the first week's.
			await run(pst('2026-11-08', '21:00'), 3, 'mi');
			await run(pst('2026-11-10', '06:00'), 13.1, 'mi');
			await run(pst('2026-11-16', '00:30'), 8, 'km', false);
			await logRun(db, owner, {
				startedAt: pst('2026-11-11', '06:00'),
				metres: 12_000,
				deleted: true
			});
			await logRun(db, owner, {
				startedAt: pst('2026-11-12', '06:00'),
				metres: null,
				status: 'in_progress'
			});
			await logStrength(db, owner, { startedAt: pst('2026-11-03', '18:00') }, [
				{ exercise: squat, weight: 100, rpe: 8 }
			]);

			const weeks = { from: '2026-11-02', to: '2026-11-15' };
			const km = await getWeeklyMileage(owner, weeks, { unit: 'km' }, { db });
			expect(km).toEqual({ unit: 'km', weeks: weeklyDistance(counted, 'km', LA) });
			expect(km.weeks).toEqual([
				{ weekStart: '2026-11-02', metres: 22_874.752, distance: 22.874752 },
				{ weekStart: '2026-11-09', metres: 21_082.4064, distance: 21.082406 }
			]);
			const mi = await getWeeklyMileage(owner, weeks, {}, { db });
			expect(mi).toEqual({ unit: 'mi', weeks: weeklyDistance(counted, 'mi', LA) });
			expect(mi.weeks[1]!.distance).toBe(13.1);
		});
	});
});

describe('sessions in a range', () => {
	it('lists the planned and the logged sessions: strength, a run and Muay Thai', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const week = { from: '2026-11-09', to: '2026-11-15' };
			const mobility = await logOther(db, owner, {
				startedAt: utc('2026-11-14', '09:00'),
				title: 'Mobility',
				discipline: 'athletic',
				sessionType: 'mobility',
				kind: 'mobility',
				minutes: 30
			});

			// With no program, only what was logged.
			expect(await getSessionsInRange(owner, week, { db })).toEqual({
				...week,
				planned: [],
				logged: [expect.objectContaining({ id: mobility, kind: 'other', date: '2026-11-14' })]
			});

			const plan = programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-11' });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const stored = await getProgramVersion(owner, programId, 1, { db });
			const [monday, tuesday, wednesday] = stored.blocks[0]!.weeks[0]!.sessions;
			const planned = (s: typeof monday) => ({
				sessionId: s!.id,
				lineageId: s!.lineage,
				programId
			});
			const strength = await logStrength(
				db,
				owner,
				{
					startedAt: utc('2026-11-09', '07:00'),
					title: 'Full body',
					planned: planned(monday),
					durationSeconds: 3000,
					sessionRpe: 8
				},
				[]
			);
			const muayThai = await logOther(db, owner, {
				startedAt: utc('2026-11-10', '19:00'),
				title: 'Muay Thai class',
				planned: planned(tuesday)
			});
			const intervals = await logRun(db, owner, {
				startedAt: utc('2026-11-11', '07:00'),
				title: 'Intervals',
				sessionType: 'interval_run',
				planned: planned(wednesday),
				status: 'abandoned',
				metres: 4000
			});
			await logRun(db, owner, {
				startedAt: utc('2026-11-12', '07:00'),
				metres: 6000,
				deleted: true
			});
			await logRun(db, owner, { startedAt: utc('2026-11-16', '07:00'), metres: 6000 });

			const range = await getSessionsInRange(owner, week, { db });
			expect(
				range.planned.map((s) => [s.scheduledOn, s.discipline, s.sessionType, s.title, s.status])
			).toEqual([
				['2026-11-09', 'strength', 'strength', 'Full body', 'completed'],
				['2026-11-10', 'muay_thai', 'muay_thai', 'Muay Thai class', 'completed'],
				['2026-11-11', 'running', 'interval_run', 'Intervals', 'planned'],
				['2026-11-12', 'running', 'easy_run', 'Easy run', 'planned'],
				['2026-11-12', 'muay_thai', 'muay_thai', 'Muay Thai class', 'planned']
			]);
			expect(range.planned[0]).toMatchObject({ id: monday!.id, lineageId: monday!.lineage });
			expect(range.logged.map((s) => [s.id, s.kind, s.discipline, s.date, s.status])).toEqual([
				[strength.workoutId, 'strength', 'strength', '2026-11-09', 'completed'],
				[muayThai, 'other', 'muay_thai', '2026-11-10', 'completed'],
				[intervals, 'run', 'running', '2026-11-11', 'abandoned'],
				[mobility, 'other', 'athletic', '2026-11-14', 'completed']
			]);
			expect(range.logged[0]).toMatchObject({
				title: 'Full body',
				durationSeconds: 3000,
				sessionRpe: 8,
				load: 400,
				plannedLineageId: monday!.lineage
			});

			// One day, and a range before the program starts.
			const tuesdayOnly = await getSessionsInRange(
				owner,
				{ from: '2026-11-10', to: '2026-11-10' },
				{ db }
			);
			expect(tuesdayOnly.planned.map((s) => s.title)).toEqual(['Muay Thai class']);
			expect(tuesdayOnly.logged.map((s) => s.id)).toEqual([muayThai]);
			const before = await getSessionsInRange(
				owner,
				{ from: '2026-11-02', to: '2026-11-08' },
				{ db }
			);
			expect(before).toEqual({ from: '2026-11-02', to: '2026-11-08', planned: [], logged: [] });
		});
	});

	it("dates a logged session by the owner's calendar", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await setProfile(db, owner, { timeZone: LA });
			const late = await logRun(db, owner, { startedAt: pst('2026-11-08', '21:00'), metres: 5000 });
			await logRun(db, owner, { startedAt: pst('2026-11-09', '00:30'), metres: 5000 });
			const sunday = await getSessionsInRange(
				owner,
				{ from: '2026-11-08', to: '2026-11-08' },
				{ db }
			);
			expect(sunday.logged.map((s) => [s.id, s.date])).toEqual([[late, '2026-11-08']]);
		});
	});
});

describe('owners', () => {
	it("shows another owner nothing, even given the owner's ids", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat } = await exerciseIds(db, KEYS);
			const plan = programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-11' });
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const { setIds } = await logStrength(db, owner, { startedAt: utc('2026-11-09', '07:00') }, [
				{ exercise: squat, weight: 100, rpe: 8 },
				{ exercise: squat, weight: 100, rpe: 8 }
			]);
			await logRun(db, owner, { startedAt: utc('2026-11-10', '07:00'), metres: 5000 });
			const weeks = { from: '2026-11-09', to: '2026-11-15' };

			const reads = async (who: string) => ({
				history: await getExerciseHistory(who, squat, {}, { db }),
				page: await getExerciseHistory(who, squat, { before: setIds[1] }, { db }),
				last: await getLastPerformances(who, squat, {}, { db }),
				records: await getPersonalRecords(who, {}, { db }),
				one: await getPersonalRecords(who, { exerciseId: squat }, { db }),
				volume: await getWeeklyMuscleVolume(who, weeks, { db }),
				mileage: await getWeeklyMileage(who, weeks, {}, { db }),
				sessions: await getSessionsInRange(who, weeks, { db })
			});

			const mine = await reads(owner);
			expect(ids(mine.history.sets)).toEqual([...setIds].reverse());
			expect(ids(mine.page.sets)).toEqual([setIds[0]]);
			expect(mine.last).toHaveLength(1);
			expect(mine.records).toHaveLength(1);
			expect(mine.one).toHaveLength(1);
			expect(mine.volume).toHaveLength(1);
			expect(mine.mileage.weeks).toHaveLength(1);
			expect(mine.sessions.planned).toHaveLength(5);
			expect(mine.sessions.logged).toHaveLength(2);

			expect(await reads(crypto.randomUUID())).toEqual({
				history: { sets: [], next: null },
				page: { sets: [], next: null },
				last: [],
				records: [],
				one: [],
				volume: [],
				mileage: { unit: 'km', weeks: [] },
				sessions: { ...weeks, planned: [], logged: [] }
			});
		});
	});
});

describe('input', () => {
	it('refuses what the owner or the coach can fix, and answers a malformed exercise as not found', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat: squat } = await exerciseIds(db, KEYS);
			const deps = { db };
			const invalid = async (promise: Promise<unknown>, field: string) => {
				const error = await refusal(promise);
				expect(error).toBeInstanceOf(TrainingInputError);
				expect(Object.keys((error as TrainingInputError).errors)).toEqual([field]);
			};

			for (const read of [
				getExerciseHistory(owner, 'squat', {}, deps),
				getLastPerformances(owner, 'squat', {}, deps),
				getPersonalRecords(owner, { exerciseId: 'squat' }, deps)
			]) {
				expect(await refusal(read)).toBeInstanceOf(TrainingNotFoundError);
			}
			for (const limit of [0, 1.5, MAX_HISTORY_PAGE + 1]) {
				await invalid(getExerciseHistory(owner, squat, { limit }, deps), 'limit');
			}
			for (const before of [0, -3, 2.5, Number.MAX_SAFE_INTEGER + 2]) {
				await invalid(getExerciseHistory(owner, squat, { before }, deps), 'before');
			}
			for (const count of [0, MAX_LAST_PERFORMANCES + 1]) {
				await invalid(getLastPerformances(owner, squat, { count }, deps), 'count');
			}

			const sunday = '2026-11-15';
			await invalid(getSessionsInRange(owner, { from: '2026-11-31', to: sunday }, deps), 'from');
			await invalid(getSessionsInRange(owner, { from: '2026-11-09', to: 'sunday' }, deps), 'to');
			await invalid(getSessionsInRange(owner, { from: sunday, to: '2026-11-09' }, deps), 'to');
			const far = new Date(Date.parse('2026-11-09T00:00:00Z') + MAX_RANGE_DAYS * 86_400_000);
			await invalid(
				getSessionsInRange(owner, { from: '2026-11-09', to: far.toISOString().slice(0, 10) }, deps),
				'to'
			);
			// Weekly reads take whole weeks: from a Monday to a Sunday.
			await invalid(getWeeklyMuscleVolume(owner, { from: '2026-11-10', to: sunday }, deps), 'from');
			await invalid(
				getWeeklyMileage(owner, { from: '2026-11-09', to: '2026-11-14' }, {}, deps),
				'to'
			);
			await invalid(
				getWeeklyMileage(owner, { from: '2026-11-09', to: sunday }, { unit: 'm' as 'km' }, deps),
				'unit'
			);
		});
	});
});

describe('indexes', () => {
	it('names an index that exists for every history builder', async () => {
		await withRollback(async (db) => {
			const { rows } = await db.execute<{ indexname: string }>(
				sql`select indexname from pg_indexes where schemaname = current_schema()`
			);
			const existing = new Set(rows.map((r) => r.indexname));
			expect(Object.keys(HISTORY_INDEXES).sort()).toEqual([
				'activeWorkouts',
				'bestE1rms',
				'completedWorkoutsPage',
				'exerciseHistory',
				'lastPerformances',
				'lastSessionSets',
				'mostReps',
				'repMaxes',
				'runsInRange',
				'sessionsInRange',
				'setsInRange',
				'workoutsInRange'
			]);
			const named = Object.values(HISTORY_INDEXES).flatMap((v) =>
				typeof v === 'string' ? [v] : Object.values(v)
			);
			for (const name of named) expect(existing, name).toContain(name);
		});
	});
});
