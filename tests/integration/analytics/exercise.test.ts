/**
 * The exercise analytics service (src/lib/server/services/analytics/exercise.ts) on the M6
 * dataset, today the Wednesday after its 16 weeks: rep maxes, the e1RM series and PRs, RPE against
 * target and recent sessions equal SQL written out here over completed, undeleted workouts; the
 * profile's tested bench max stays a marker; retired and custom exercises read, foreign ones not.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { setE1rm } from '../../../src/lib/domain/training/metrics';
import { exercises, setRecords, workouts, type Executor } from '../../../src/lib/server/db';
import {
	getExerciseAnalytics,
	RECENT_SESSIONS
} from '../../../src/lib/server/services/analytics/exercise';
import {
	createCustomExercise,
	retireCustomExercise
} from '../../../src/lib/server/services/exercises/index';
import { TrainingNotFoundError } from '../../../src/lib/server/services/training/shared';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { withRollback } from '../helpers';
import { LAST_DAY, seedDataset, TODAY, TZ, WEEK_ONE, weekOf } from './fixtures/dataset';

const round = (value: number) => Math.round(value * 1000) / 1000;
const ALL = { period: 'all', today: TODAY } as const;

/** One exercise's live sets of the owner's completed, undeleted workouts, with its session's day. */
const SETS = (owner: string, exercise: string) => sql`sets as (
	select s.id, s.workout_id, s.performed_at, s.weight_kg, s.reps, s.rpe, s.e1rm_kg, s.is_extra,
		not s.is_warmup and not s.is_skipped as working, w.planned_session_id,
		s.planned_exercise_lineage_id
	from set_records s join workouts w on w.id = s.workout_id
	where s.owner_id = ${owner} and s.exercise_id = ${exercise} and w.status = 'completed'
		and w.deleted_at is null and s.deleted_at is null
),
sess as (
	select workout_id, min(performed_at) as first_at,
		(min(performed_at) at time zone ${TZ})::date as day
	from sets group by workout_id
)`;

async function rows<T>(db: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute(query)).rows as T[];
}

/**
 * For each rep count 1–10: the heaviest working load, the day of the first session that lifted it,
 * and the heaviest load at that count in the sessions before it (null for none).
 */
async function repMaxes(db: Executor, owner: string, exercise: string) {
	return rows<{ reps: number; value: number; day: string; previous: number | null }>(
		db,
		sql`with ${SETS(owner, exercise)},
		r as (
			select s.reps, s.weight_kg, sess.first_at, sess.day from sets s join sess using (workout_id)
			where s.working and s.weight_kg > 0 and s.reps between 1 and 10
		),
		firsts as (
			select distinct on (r.reps) r.reps, r.weight_kg as value, r.first_at, r.day from r
			order by r.reps, r.weight_kg desc, r.first_at
		)
		select f.reps, f.value::float8 as value, to_char(f.day, 'YYYY-MM-DD') as day,
			(select max(p.weight_kg) from r p where p.reps = f.reps and p.first_at < f.first_at)::float8
				as previous
		from firsts f order by f.reps`
	);
}

/** Each week's best stored e1RM, by the Monday of its session's day. */
async function weeklyE1rm(db: Executor, owner: string, exercise: string) {
	const found = await rows<{ week: string; best: number }>(
		db,
		sql`with ${SETS(owner, exercise)}
		select to_char(date_trunc('week', sess.day), 'YYYY-MM-DD') as week, max(s.e1rm_kg)::float8 as best
		from sets s join sess using (workout_id) where s.e1rm_kg is not null group by 1`
	);
	return new Map(found.map((r) => [r.week, round(r.best)]));
}

/** The sessions whose best stored e1RM beat every earlier session's, oldest first. */
async function e1rmPrs(db: Executor, owner: string, exercise: string) {
	return rows<{ day: string; value: number }>(
		db,
		sql`with ${SETS(owner, exercise)},
		per as (
			select sess.first_at, sess.day, max(s.e1rm_kg) as best
			from sets s join sess using (workout_id) where s.e1rm_kg is not null
			group by sess.first_at, sess.day
		),
		held as (
			select *, max(best) over (order by first_at
				rows between unbounded preceding and 1 preceding) as previous from per
		)
		select to_char(day, 'YYYY-MM-DD') as day, best::float8 as value from held
		where previous is not null and best > previous order by first_at`
	);
}

/** The last `n` completed, undeleted workouts with a working set of the exercise, newest first. */
async function recent(db: Executor, owner: string, exercise: string, n: number) {
	const found = await rows<{ id: string }>(
		db,
		sql`with ${SETS(owner, exercise)}
		select workout_id as id from sets where working group by workout_id
		order by max(performed_at) desc, workout_id desc limit ${n}`
	);
	return found.map((r) => r.id);
}

/** The mean of RPE − target over the rated working sets logged against a planned line. */
async function rpeDeviation(db: Executor, owner: string, exercise: string) {
	const [row] = await rows<{ deviation: number }>(
		db,
		sql`with ${SETS(owner, exercise)},
		rated as (
			select s.rpe, (
				select max(sp.target_rpe) from planned_exercises pe
				join set_prescriptions sp on sp.planned_exercise_id = pe.id
				where pe.session_id = s.planned_session_id
					and pe.lineage_id = s.planned_exercise_lineage_id and sp.role not in ('warm_up', 'ramp')
			) as target
			from sets s join sess using (workout_id)
			where s.working and s.rpe is not null and not s.is_extra
				and sess.day between ${WEEK_ONE}::date and ${LAST_DAY}::date
		)
		select avg(rpe - target)::float8 as deviation from rated`
	);
	return round(row!.deviation);
}

/** A completed strength workout at `date` 18:00 with one exercise's sets in order. */
async function logStrength(
	db: Executor,
	owner: string,
	date: IsoDate,
	exerciseId: string,
	lifts: { weight: number; reps: number; rpe: number }[]
) {
	const startedAt = atLocal(date, '18:00', TZ);
	const [row] = await db
		.insert(workouts)
		.values({
			...{ ownerId: owner, clientId: crypto.randomUUID(), kind: 'strength' },
			...{ discipline: 'strength', sessionType: 'strength', title: 'Extra', status: 'completed' },
			...{ startedAt, finishedAt: new Date(startedAt.getTime() + 3_600_000) },
			...{ durationSeconds: 3600, sessionRpe: 7 }
		})
		.returning({ id: workouts.id });
	for (const [i, lift] of lifts.entries()) {
		const set = { weight: lift.weight, unit: 'kg' as const, reps: lift.reps, rpe: lift.rpe };
		await db.insert(setRecords).values({
			...{ ownerId: owner, clientMutationId: crypto.randomUUID(), workoutId: row!.id },
			...{ exerciseId, exercisePosition: 1, setIndex: i + 1, ...set },
			...{ isWarmup: false, isSkipped: false, isExtra: false },
			e1rmKg: setE1rm({ ...set, isWarmup: false, isSkipped: false })?.value ?? null,
			performedAt: new Date(startedAt.getTime() + 300_000 * (i + 1))
		});
	}
	return row!.id;
}

const sandbag = {
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
};

describe('records against SQL', () => {
	it("the rep-max table equals SQL's maximum per rep count, its first day and the record it beat", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			for (const key of ['bench_press', 'back_squat', 'deadlift', 'dumbbell_curl'] as const) {
				const id = data.exercises[key];
				const a = await getExerciseAnalytics(db, data.owner, id, ALL);
				const expected = await repMaxes(db, data.owner, id);
				expect(expected.length, key).toBeGreaterThan(0);
				expect(a.repMaxes.map((r) => r.reps)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
				const shown = a.repMaxes
					.filter((r) => r.record !== null)
					.map((r) => ({
						reps: r.reps,
						value: round(r.record!.value),
						day: r.record!.on,
						previous: r.previous && round(r.previous.value)
					}));
				expect(shown, key).toEqual(
					expected.map((r) => ({
						...r,
						value: round(r.value),
						previous: r.previous && round(r.previous)
					}))
				);
			}
			const bench = await getExerciseAnalytics(db, data.owner, data.exercises.bench_press, ALL);
			expect(bench.repMaxes[4]).toMatchObject({
				record: { value: 85, text: '85\u00a0kg', on: weekOf(5) },
				previous: { value: 82.5, text: '82.5\u00a0kg', on: weekOf(2) }
			});
			// At 4w the figures read from week 5, yet records still weigh every earlier workout.
			const short = { period: '4w', today: TODAY } as const;
			const recentBench = await getExerciseAnalytics(db, data.owner, bench.exercise.id, short);
			expect(recentBench.window.weeks!.from).toBe(weekOf(13));
			expect(recentBench.repMaxes).toEqual(bench.repMaxes);
			expect(recentBench.prs).toEqual(bench.prs);
		});
	});

	it("leaves the abandoned workout's set out of rep maxes and recent sessions, and discarded ones too", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const dl = await getExerciseAnalytics(db, data.owner, data.exercises.deadlift, ALL);
			// Week 12's abandoned Strength B lifted 250 kg for 3, the only triple ever.
			expect(dl.repMaxes[2]).toEqual({ reps: 3, record: null, previous: null });
			expect(dl.repMaxes[4]!.record).toMatchObject({ value: 190, on: addDays(weekOf(8), 2) });
			expect(dl.recent.map((s) => s.workoutId)).toEqual(
				await recent(db, data.owner, data.exercises.deadlift, RECENT_SESSIONS)
			);
			expect(dl.recent).toHaveLength(RECENT_SESSIONS);
			expect(dl.recent.map((s) => s.workoutId)).not.toContain(data.workouts.abandoned);
			for (const session of dl.recent) {
				expect(session.status).toBe('completed');
				expect(session.sets.every((set) => set.exerciseId === data.exercises.deadlift)).toBe(true);
			}

			// The squats in progress on week 16's Sunday and the soft-deleted week 13 curls.
			const squat = await getExerciseAnalytics(db, data.owner, data.exercises.back_squat, ALL);
			expect(squat.recent.map((s) => s.workoutId)).not.toContain(data.workouts.inProgress);
			expect(squat.recent[0]!.on).toBe(weekOf(16));
			expect(squat.repMaxes[4]!.record!.value).toBeLessThan(200);
			const curl = await getExerciseAnalytics(db, data.owner, data.exercises.dumbbell_curl, ALL);
			expect(curl.recent.map((s) => s.workoutId)).toEqual(
				await recent(db, data.owner, data.exercises.dumbbell_curl, RECENT_SESSIONS)
			);
			expect(curl.recent.map((s) => s.workoutId)).not.toContain(data.workouts.deleted);
			expect(curl.repMaxes[9]!.record!.value).toBe(14);
		});
	});

	it('gives an e1RM PR timeline that only rises, as SQL finds it, and volume PRs', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			for (const key of ['back_squat', 'bench_press', 'deadlift'] as const) {
				const id = data.exercises[key];
				const a = await getExerciseAnalytics(db, data.owner, id, ALL);
				const expected = await e1rmPrs(db, data.owner, id);
				expect(
					a.prs.e1rm.map((pr) => ({ day: pr.on, value: round(pr.value) })),
					key
				).toEqual(expected.map((r) => ({ ...r, value: round(r.value) })));
				for (const [i, pr] of a.prs.e1rm.entries()) {
					expect(pr).toMatchObject({ kind: 'e1rm', estimated: true });
					expect(pr.value).toBeGreaterThan(pr.previous.value);
					if (i > 0) expect(pr.value).toBeGreaterThan(a.prs.e1rm[i - 1]!.value);
				}
				expect(
					a.prs.volume.every((pr) => pr.kind === 'volume' && pr.value > pr.previous.value)
				).toBe(true);
			}
			// The rising squat beats its e1RM every week after the first.
			const squat = await getExerciseAnalytics(db, data.owner, data.exercises.back_squat, ALL);
			expect(squat.prs.e1rm).toHaveLength(15);
			expect(squat.prs.volume.length).toBeGreaterThan(0);
		});
	});
});

describe('the e1RM figure', () => {
	it('labels the measured bench max as measured and keeps it out of the series', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const id = data.exercises.bench_press;
			const a = await getExerciseAnalytics(db, data.owner, id, ALL);
			expect(a.e1rm).toMatchObject({ metric: 'e1rm', kind: 'estimated' });
			expect(a.e1rm.markers).toMatchObject([
				{ kind: 'measured', kg: 100, label: 'Measured', text: '100\u00a0kg' }
			]);
			const weekly = await weeklyE1rm(db, data.owner, id);
			expect(a.e1rm.series).toHaveLength(17);
			for (const point of a.e1rm.series.filter((p) => !p.inProgress)) {
				expect(point.value === null ? null : round(point.value), point.at).toBe(
					weekly.get(point.at) ?? null
				);
			}
			expect(a.e1rm.series.every((p) => p.value !== 100)).toBe(true);
			expect(round(a.e1rm.value!.value)).toBe(Math.max(...weekly.values()));
			expect(a.availability).toEqual({ ready: true });
			expect(a.topSets.sessions).toHaveLength(16);
			expect(a.topSets.sessions[4]).toMatchObject({
				on: weekOf(5),
				kg: 85,
				text: '85\u00a0kg × 5'
			});
		});
	});

	it('takes the squat verdict from 12 weeks at 4w and RPE against target from SQL', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const squat = await getExerciseAnalytics(db, data.owner, data.exercises.back_squat, {
				period: '4w',
				today: TODAY
			});
			expect(squat.e1rm.trend.window.label).toBe('Trend over the last 12 weeks');
			expect(squat.e1rm.trend.result).toMatchObject({ verdict: 'real_trend', direction: 'up' });
			expect(squat.topSets.sessions.map((s) => s.on)).toEqual([13, 14, 15, 16].map(weekOf));

			const bench = await getExerciseAnalytics(db, data.owner, data.exercises.bench_press, ALL);
			const expected = await rpeDeviation(db, data.owner, data.exercises.bench_press);
			expect(round(bench.rpeDeviation.value!.value)).toBe(expected);
			expect(bench.rpeDeviation).toMatchObject({ metric: 'rpe_deviation' });
		});
	});
});

describe('which exercises read', () => {
	it('reads a retired catalogue exercise and a retired custom one of the owner', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const bench = data.exercises.bench_press;
			await db.update(exercises).set({ retiredAt: new Date() }).where(eq(exercises.id, bench));
			const a = await getExerciseAnalytics(db, data.owner, bench, ALL);
			expect(a.exercise).toMatchObject({
				id: bench,
				key: 'bench_press',
				custom: false,
				retired: true
			});
			expect(a.repMaxes[4]!.record!.value).toBe(85);

			const bag = await createCustomExercise(data.owner, sandbag, { db });
			await logStrength(db, data.owner, weekOf(15), bag.id, [{ weight: 100, reps: 5, rpe: 8 }]);
			await logStrength(db, data.owner, weekOf(16), bag.id, [{ weight: 110, reps: 5, rpe: 8 }]);
			await retireCustomExercise(data.owner, bag.id, { db });
			const own = await getExerciseAnalytics(db, data.owner, bag.id, ALL);
			expect(own.exercise).toMatchObject({
				name: 'Sandbag shouldering',
				key: null,
				custom: true,
				retired: true
			});
			expect(own.repMaxes[4]).toMatchObject({ record: { value: 110 }, previous: { value: 100 } });
			expect(own.recent).toHaveLength(2);
			expect(own.prs.e1rm).toHaveLength(1);
			expect(own.e1rm.markers).toEqual([]);
		});
	});

	it("gives a new lift its availability and another owner's custom exercise or a malformed id not found", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const theirs = await createCustomExercise(data.other, sandbag, { db });
			await logStrength(db, data.other, weekOf(15), theirs.id, [{ weight: 100, reps: 5, rpe: 8 }]);
			expect((await getExerciseAnalytics(db, data.other, theirs.id, ALL)).recent).toHaveLength(1);
			for (const id of [theirs.id, 'not-a-uuid', crypto.randomUUID()]) {
				await expect(getExerciseAnalytics(db, data.owner, id, ALL), id).rejects.toBeInstanceOf(
					TrainingNotFoundError
				);
			}

			const mine = await createCustomExercise(data.owner, sandbag, { db });
			await logStrength(db, data.owner, weekOf(16), mine.id, [{ weight: 100, reps: 5, rpe: 8 }]);
			const fresh = await getExerciseAnalytics(db, data.owner, mine.id, ALL);
			expect(fresh.availability).toEqual({ ready: false, have: 1, need: 2, unit: 'sessions' });
			expect(fresh.e1rm.value).toBeNull();
			expect(fresh.prs).toEqual({ e1rm: [], volume: [] });
		});
	});
});
