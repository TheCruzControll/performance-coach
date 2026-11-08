/**
 * The strength dashboard service (src/lib/server/services/analytics/strength.ts) on the M6
 * dataset, today the Wednesday after its 16 weeks: every figure equals SQL written out here over
 * completed, undeleted workouts and the domain functions on the loaded facts; muscle groups read
 * targets.ts; windows, comparisons and the week so far follow periods.ts; reads are counted.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, mondayOf, type IsoDate } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { prTimeline, weeklyTonnage } from '../../../src/lib/domain/analytics/strength';
import {
	exerciseRefKey,
	plannedHardSets,
	setE1rm,
	type ExerciseMuscles
} from '../../../src/lib/domain/training/metrics';
import type { WeekPlan } from '../../../src/lib/domain/training/types';
import { setRecords, workouts, type Executor } from '../../../src/lib/server/db';
import {
	createAnalyticsRepository,
	type AnalyticsRepository
} from '../../../src/lib/server/db/repositories/analytics';
import { createFactsLoader } from '../../../src/lib/server/services/analytics/facts';
import {
	getStrengthDashboard,
	PRS_MAX,
	type StrengthDashboard
} from '../../../src/lib/server/services/analytics/strength';
import {
	getMuscleTargets,
	NO_STORED_TARGET
} from '../../../src/lib/server/services/analytics/targets';
import { getExercisesByIds, resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { LAST_DAY, seedDataset, TODAY, TZ, WEEK_ONE, weekOf } from './fixtures/dataset';

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Live sets of the owner's completed, undeleted workouts, on their local day. */
const SETS = (owner: string) => sql`sets as (
	select s.id, s.exercise_id, e.name, s.workout_id, w.started_at, s.weight_kg, s.reps, s.rpe, s.e1rm_kg,
		e.primary_muscles, e.secondary_muscles, not s.is_warmup and not s.is_skipped as working,
		s.is_extra, w.planned_session_id, s.planned_exercise_lineage_id,
		(s.performed_at at time zone ${TZ})::date as day
	from set_records s
	join workouts w on w.id = s.workout_id
	join exercises e on e.id = s.exercise_id
	where s.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
		and s.deleted_at is null
)`;

async function rows<T>(db: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute(query)).rows as T[];
}

/** The best stored e1RM of each exercise between two days. */
async function bestE1rms(db: Executor, owner: string, from: IsoDate, to: IsoDate) {
	const found = await rows<{ id: string; best: number }>(
		db,
		sql`with ${SETS(owner)} select exercise_id as id, max(e1rm_kg)::float8 as best from sets
			where day between ${from}::date and ${to}::date and e1rm_kg is not null group by exercise_id`
	);
	return new Map(found.map((r) => [r.id, round(r.best)]));
}

/** Σ weight × reps of working, loaded sets between two days. */
async function tonnage(db: Executor, owner: string, from: IsoDate, to: IsoDate) {
	const [row] = await rows<{ kg: number }>(
		db,
		sql`with ${SETS(owner)} select coalesce(sum(weight_kg * reps), 0)::float8 as kg from sets
			where working and weight_kg is not null and reps is not null
				and day between ${from}::date and ${to}::date`
	);
	return round(row!.kg);
}

/**
 * The mean RPE of rated working sets between two days, and the mean of RPE − target over those
 * logged against a planned line (not marked extra), the target being the planned exercise's
 * working line in the version the workout was logged from.
 */
async function rpe(db: Executor, owner: string, from: IsoDate, to: IsoDate) {
	const [row] = await rows<{ mean: number; deviation: number }>(
		db,
		sql`with ${SETS(owner)},
		rated as (
			select s.rpe, s.is_extra, (
				select max(sp.target_rpe) from planned_exercises pe
				join set_prescriptions sp on sp.planned_exercise_id = pe.id
				where pe.session_id = s.planned_session_id
					and pe.lineage_id = s.planned_exercise_lineage_id and sp.role not in ('warm_up', 'ramp')
			) as target
			from sets s where s.working and s.rpe is not null and s.day between ${from}::date and ${to}::date
		)
		select avg(rpe)::float8 as mean,
			avg(rpe - target) filter (where not is_extra)::float8 as deviation from rated`
	);
	return { mean: round(row!.mean), deviation: round(row!.deviation) };
}

/** Hard sets (working, RPE 7 or more or none) per week and group: 1 primary, 0.5 secondary. */
async function groupSets(db: Executor, owner: string) {
	const found = await rows<{ week: string; grp: string; n: number }>(
		db,
		sql`with ${SETS(owner)}, groups(muscle, grp) as (values
			('chest', 'chest'), ('front_delts', 'shoulders'), ('side_delts', 'shoulders'),
			('rear_delts', 'shoulders'), ('lats', 'back'), ('upper_back', 'back'), ('traps', 'back'),
			('lower_back', 'back'), ('biceps', 'biceps'), ('triceps', 'triceps'),
			('forearms', 'forearms'), ('abs', 'core'), ('obliques', 'core'), ('glutes', 'hips'),
			('adductors', 'hips'), ('hip_flexors', 'hips'), ('quads', 'quads'),
			('hamstrings', 'hamstrings'), ('calves', 'calves'), ('neck', 'neck')),
		credit as (
			select s.id, date_trunc('week', s.day)::date as week, g.grp, max(c.credit) as credit
			from sets s
			cross join lateral (select unnest(s.primary_muscles) as muscle, 1.0 as credit
				union all select unnest(s.secondary_muscles), 0.5) c
			join groups g on g.muscle = c.muscle
			where s.working and (s.rpe is null or s.rpe >= 7)
			group by s.id, week, g.grp
		)
		select to_char(week, 'YYYY-MM-DD') as week, grp, sum(credit)::float8 as n
		from credit group by week, grp`
	);
	return new Map(found.map((r) => [`${r.week} ${r.grp}`, r.n]));
}

/**
 * Every record each exercise broke from `from` to `to`: per workout its best e1RM, its heaviest weight
 * at each rep count 1–10 and its volume, strictly above every earlier workout's.
 */
async function prRows(db: Executor, owner: string, from: IsoDate, to: IsoDate = TODAY) {
	return rows<{ id: string; name: string; kind: string; reps: number | null; day: string }>(
		db,
		sql`with ${SETS(owner)},
		per as (
			select exercise_id, name, workout_id, min(started_at) as started, min(day) as day,
				max(e1rm_kg) as e1rm, sum(weight_kg * reps) filter
					(where working and weight_kg is not null and reps is not null) as volume
			from sets group by exercise_id, name, workout_id
		),
		reps as (
			select exercise_id, name, min(started_at) as started, min(day) as day, reps,
				max(weight_kg) as value
			from sets where working and weight_kg > 0 and reps between 1 and 10
			group by exercise_id, name, workout_id, reps
		),
		records as (
			select exercise_id, name, 'e1rm' as kind, null::int as reps, day, started, e1rm as value,
				max(e1rm) over (partition by exercise_id order by started
					rows between unbounded preceding and 1 preceding) as previous
			from per where e1rm is not null
			union all
			select exercise_id, name, 'volume', null, day, started, volume,
				max(volume) over (partition by exercise_id order by started
					rows between unbounded preceding and 1 preceding)
			from per where volume is not null
			union all
			select exercise_id, name, 'rep_max', reps, day, started, value,
				max(value) over (partition by exercise_id, reps order by started
					rows between unbounded preceding and 1 preceding)
			from reps
		)
		select exercise_id as id, name, kind, reps, to_char(day, 'YYYY-MM-DD') as day from records
		where previous is not null and value > previous and day between ${from}::date and ${to}::date
		order by day desc, kind, reps nulls first`
	);
}

/** SQL's PR rows in the dashboard's order: newest day first, then exercise name. */
const prOrder = (found: Awaited<ReturnType<typeof prRows>>) =>
	found
		.map((r, i) => ({ ...r, i }))
		.sort((a, b) =>
			a.day === b.day ? a.name.localeCompare(b.name) || a.i - b.i : a.day < b.day ? 1 : -1
		)
		.map(({ id, kind, reps, day }) => ({ exerciseId: id, kind, reps, on: day }));

const prKeys = (d: StrengthDashboard) =>
	d.prs.items.map(({ exerciseId, kind, reps, on }) => ({ exerciseId, kind, reps, on }));

/** A completed strength workout at `date` `time`, with its sets in order. */
async function logStrength(
	db: Executor,
	owner: string,
	at: { date: IsoDate; time: string },
	lifts: { exerciseId: string; weight: number; reps: number; rpe: number }[]
) {
	const startedAt = atLocal(at.date, at.time, TZ);
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
			...{ exerciseId: lift.exerciseId, exercisePosition: 1, setIndex: i + 1, ...set },
			...{ isWarmup: false, isSkipped: false, isExtra: false },
			e1rmKg: setE1rm({ ...set, isWarmup: false, isSkipped: false })?.value ?? null,
			performedAt: new Date(startedAt.getTime() + 300_000 * (i + 1))
		});
	}
}

/** The repository with each method's calls counted, and the most ever running at once. */
function counting(db: Executor) {
	const repo = createAnalyticsRepository(db);
	const calls: Record<string, number> = {};
	let running = 0;
	const seen = { most: 0 };
	const wrapped = Object.fromEntries(
		Object.entries(repo).map(([name, method]) => [
			name,
			async (...args: unknown[]) => {
				calls[name] = (calls[name] ?? 0) + 1;
				seen.most = Math.max(seen.most, ++running);
				try {
					return await (method as (...a: unknown[]) => Promise<unknown>)(...args);
				} finally {
					running -= 1;
				}
			}
		])
	) as AnalyticsRepository;
	return { repository: wrapped, calls, seen };
}

describe('the strength dashboard against SQL', () => {
	it('gives best e1RMs, tonnage, group hard sets and PRs as SQL and the domain functions do', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const d = await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY });
			expect(d.window.weeks).toEqual({ from: WEEK_ONE, to: LAST_DAY, count: 16 });

			const best = await bestE1rms(db, data.owner, WEEK_ONE, LAST_DAY);
			const { back_squat, bench_press, deadlift } = data.exercises;
			expect(d.keyLifts.map((l) => l.exerciseId)).toEqual(
				expect.arrayContaining([back_squat, bench_press, deadlift])
			);
			for (const lift of d.keyLifts) {
				expect(lift).toMatchObject({ metric: 'e1rm', kind: 'estimated' });
				expect(round(lift.value!.value)).toBe(best.get(lift.exerciseId));
			}
			// The abandoned 250 kg deadlift and the 200 kg squat in progress never count.
			const dl = d.keyLifts.find((l) => l.exerciseId === deadlift)!;
			expect(dl.value!.text).toMatch(/^\d{3}(\.\d)? kg$/);
			expect(Math.max(...d.keyLifts.map((l) => l.value!.value))).toBeLessThan(250);

			for (const point of d.tonnage.series) {
				const sunday = addDays(point.at, 6);
				const end = point.inProgress ? TODAY : sunday;
				expect(round(point.value!), point.at).toBe(await tonnage(db, data.owner, point.at, end));
			}
			expect(d.tonnage.series).toHaveLength(17);
			expect(d.tonnage.value!.value).toBe(await tonnage(db, data.owner, WEEK_ONE, LAST_DAY));

			const groups = await groupSets(db, data.owner);
			const shown = d.muscleGroups.weeks.flatMap((w) =>
				w.groups
					.filter((g) => g.sets > 0)
					.map((g) => [`${w.weekStart} ${g.group}`, g.sets] as const)
			);
			expect(new Map(shown)).toEqual(groups);

			expect(await rpe(db, data.owner, WEEK_ONE, LAST_DAY)).toEqual({
				mean: round(d.rpe.average.value!.value),
				deviation: round(d.rpe.deviation.value!.value)
			});
			expect(d.rpe.deviation.value!.text).toMatch(/^[+−]?[\d.]+ RPE$/);

			const prs = prOrder(await prRows(db, data.owner, WEEK_ONE));
			expect(d.prs.total).toBe(prs.length);
			expect(prKeys(d)).toEqual(prs.slice(0, PRS_MAX));
			expect(d.prs.items).toHaveLength(PRS_MAX);

			// The same figures from the domain functions on the loaded facts.
			const all = await createFactsLoader(db, data.owner, {
				...{ from: WEEK_ONE, to: TODAY, timeZone: TZ }
			}).sets();
			const exercises = await getExercisesByIds(
				data.owner,
				all.map((s) => s.exercise),
				{ db }
			);
			const window = { weeks: d.window.weeks, inProgress: d.window.inProgress };
			expect(d.tonnage.series.map(({ text: _t, ...p }) => p)).toEqual(
				weeklyTonnage(all, exercises, TZ, window)
			);
			const squat = prTimeline(
				all.filter((s) => s.exercise === back_squat),
				exercises.get(back_squat)!,
				TZ
			);
			const listed = d.prs.items.filter((pr) => pr.exerciseId === back_squat);
			expect(listed.length).toBeGreaterThan(0);
			for (const pr of listed) {
				const { exerciseId: _e, name: _n, text: _t, previousText: _p, ...own } = pr;
				expect(squat).toContainEqual(own);
			}
		});
	});

	it("lists no PR from the abandoned workout's heavy deadlift or the workout in progress", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			// The Wednesday after week 12, whose Wednesday's 250 kg deadlifts were abandoned.
			const after = addDays(weekOf(13), 2);
			const d = await getStrengthDashboard(db, data.owner, { period: '4w', today: after });
			const prs = prOrder(await prRows(db, data.owner, weekOf(9), after));
			expect(d.prs.total).toBe(prs.length);
			expect(prKeys(d)).toEqual(prs.slice(0, PRS_MAX));
			expect(d.prs.items.some((pr) => pr.on === weekOf(12))).toBe(true);
			expect(d.prs.items.every((pr) => pr.on !== addDays(weekOf(12), 2))).toBe(true);
			const loads = d.prs.items.filter((pr) => pr.kind !== 'volume');
			expect(loads.length).toBeGreaterThan(0);
			expect(loads.every((pr) => pr.value < 200)).toBe(true);

			// Week 16's Sunday squats at 200 kg are still in progress.
			const all = await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY });
			expect(all.prs.items.some((pr) => pr.on === weekOf(16))).toBe(true);
			expect(all.prs.items.every((pr) => pr.on !== LAST_DAY)).toBe(true);
		});
	});
});

describe('PRs against older records', () => {
	it('judges a PR against every earlier workout, not only the weeks the figures read', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const curl = (weight: number) => ({
				...{ exerciseId: data.exercises.dumbbell_curl, weight, reps: 10, rpe: 8 }
			});
			// Week 2's 18 kg curls are older than the 12 weeks a 4w view reads; 16 kg beats only 14.
			await logStrength(db, data.owner, { date: addDays(weekOf(2), 4), time: '18:00' }, [curl(18)]);
			await logStrength(db, data.owner, { date: weekOf(15), time: '18:00' }, [curl(16)]);

			const d = await getStrengthDashboard(db, data.owner, { period: '4w', today: TODAY });
			expect(d.trendWindow.weeks!.from).toBe(weekOf(5));
			const curls = d.prs.items.filter((pr) => pr.exerciseId === data.exercises.dumbbell_curl);
			expect(curls).toEqual([]);
			const prs = prOrder(await prRows(db, data.owner, weekOf(13)));
			expect(d.prs.total).toBe(prs.length);
			expect(prKeys(d)).toEqual(prs.slice(0, PRS_MAX));
		});
	});
});

describe('muscle groups', () => {
	it("are judged against targets.ts for each week, B1's deload scaled, beside plannedHardSets", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const d = await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY });
			const targets = await getMuscleTargets(data.owner, { from: WEEK_ONE, to: TODAY }, { db });
			const muscles = new Map<string, ExerciseMuscles>(
				CATALOGUE.map((e) => [exerciseRefKey({ key: e.key }), e])
			);
			const versions = [
				await getProgramVersion(data.owner, data.programs.a, 2, { db }),
				await getProgramVersion(data.owner, data.programs.b, 2, { db })
			];
			const planned = new Map(
				versions
					.flatMap((v) => v.blocks.flatMap((b) => b.weeks))
					.filter((w) => w.sessions.length > 0)
					.map((w) => [w.startsOn, plannedHardSets(w as unknown as WeekPlan, muscles)])
			);
			expect(d.muscleGroups.weeks).toHaveLength(17);
			for (const week of d.muscleGroups.weeks) {
				const target = targets.find((t) => t.weekStart === week.weekStart)!;
				expect(week).toMatchObject({ source: target.source, label: target.label });
				for (const g of week.groups) {
					expect(g.target, `${week.weekStart} ${g.group}`).toEqual(target.targets[g.group] ?? null);
					const plan = planned.get(week.weekStart)?.groups[g.group] ?? null;
					expect(g.planned, `${week.weekStart} ${g.group}`).toBe(plan);
				}
			}
			const deload = d.muscleGroups.weeks.find((w) => w.weekStart === weekOf(11))!;
			expect(deload.volumeFactor).toBe(0.6);
			const chest = deload.groups.find((g) => g.group === 'chest')!;
			expect(chest).toMatchObject({ target: [6, 12], sets: 3, planned: 3, status: 'below' });
			expect(chest.goodness).toEqual({ level: 'low', words: 'Below the target range' });
			const weekTwelve = d.muscleGroups.weeks.find((w) => w.weekStart === weekOf(12))!;
			expect(weekTwelve.groups.find((g) => g.group === 'chest')!.target).toEqual([10, 20]);
		});
	});

	it('keep every planned group of an unlogged week with no stored target, arms included', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const basics = { name: 'New', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ } as const;
			await saveBasics(owner, basics, { db });
			const monday = '2026-11-02';
			const plan = programFixture('hybrid', { monday, today: monday });
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const [target] = await getMuscleTargets(owner, { from: monday, to: monday }, { db });
			const planned = Object.entries(target!.planned!.groups).filter(([, n]) => n! > 0);
			expect(planned.map(([g]) => g)).toEqual(expect.arrayContaining(['biceps']));

			const d = await getStrengthDashboard(db, owner, { period: '4w', today: monday });
			const week = d.muscleGroups.weeks.at(-1)!;
			expect(week).toMatchObject({ weekStart: monday, label: NO_STORED_TARGET });
			expect(Object.fromEntries(week.groups.map((g) => [g.group, g.planned]))).toEqual(
				Object.fromEntries(planned)
			);
			for (const g of week.groups) {
				expect(g).toMatchObject({ sets: 0, target: null, status: 'no_target', goodness: null });
			}
		});
	});
});

describe('windows and comparisons', () => {
	it('at 4w compares 4 weeks with the 4 before and takes the squat verdict from 12 weeks', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const d = await getStrengthDashboard(db, data.owner, { period: '4w', today: TODAY });
			expect(d.window.weeks).toEqual({ from: weekOf(13), to: LAST_DAY, count: 4 });
			expect(d.window.previous).toEqual({ from: weekOf(9), to: addDays(weekOf(12), 6), count: 4 });
			const squat = d.keyLifts.find((l) => l.exerciseId === data.exercises.back_squat)!;
			expect(squat.trend.window).toEqual({
				weeks: { from: weekOf(5), to: LAST_DAY, count: 12 },
				sameAsPeriod: false,
				label: 'Trend over the last 12 weeks'
			});
			expect(squat.trend.result).toMatchObject({
				verdict: 'real_trend',
				direction: 'up',
				good: true,
				n: 12
			});
			expect(squat.series.map((p) => p.at)).toEqual([13, 14, 15, 16, 17].map(weekOf));
			const now = await bestE1rms(db, data.owner, weekOf(13), LAST_DAY);
			const before = await bestE1rms(db, data.owner, weekOf(9), addDays(weekOf(12), 6));
			const id = data.exercises.back_squat;
			expect(round(squat.comparison.value!)).toBe(now.get(id));
			expect(round(squat.comparison.previous!)).toBe(before.get(id));
			expect(squat.comparison.change).toBe('better');
			expect(squat.comparison.words).toMatch(/^Up .+ kg on the previous 4 weeks$/);
			expect(d.tonnage.trend.window.label).toBe('Trend over the last 12 weeks');
		});
	});

	it('at 12w compares tonnage with the 12 weeks before, and its verdict reads the period', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const d = await getStrengthDashboard(db, data.owner, { period: '12w', today: TODAY });
			expect(d.window.weeks).toEqual({ from: weekOf(5), to: LAST_DAY, count: 12 });
			expect(d.trendWindow).toMatchObject({
				sameAsPeriod: true,
				label: 'Trend over the last 12 weeks'
			});
			const previous = d.window.previous!;
			expect(d.tonnage.comparison).toMatchObject({
				value: await tonnage(db, data.owner, weekOf(5), LAST_DAY),
				previous: await tonnage(db, data.owner, previous.from, previous.to),
				change: 'better'
			});
			expect(d.tonnage.comparison.words).toMatch(/on the previous 12 weeks$/);
			expect(d.tonnage).toMatchObject({ metric: 'tonnage', kind: 'calculated' });
			expect(d.tonnage.trend.window.weeks).toEqual(d.window.weeks);
		});
	});

	it("at 'all' reads every week from the first, with nothing before to compare with", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const d = await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY });
			expect(d.window.previous).toBeNull();
			expect(d.trendWindow).toMatchObject({ label: 'Trend over all your training' });
			expect(d.tonnage.comparison).toMatchObject({ previous: null, delta: null });
			expect(d.tonnage.comparison.words).toBe('No earlier weeks like these to compare with');
			const bench = d.keyLifts.find((l) => l.exerciseId === data.exercises.bench_press)!;
			expect(bench.markers).toMatchObject([
				{ kind: 'measured', kg: 100, label: 'Measured', text: '100 kg' }
			]);
			expect(bench.kind).toBe('estimated');
		});
	});
});

describe('trends', () => {
	it('reads 12 weeks for an e1RM trend at 4w, though the 4 weeks lack the data for a value', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const basics = { name: 'New', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ } as const;
			await saveBasics(owner, basics, { db });
			const squat = (await resolveKeys(['back_squat'], { db })).get('back_squat')!.id;
			// Eight rising weeks before the period, then one session in it.
			for (const [i, n] of [5, 6, 7, 8, 9, 10, 11, 12, 14].entries()) {
				const lift = { exerciseId: squat, weight: 100 + 5 * i, reps: 5, rpe: 8 };
				await logStrength(db, owner, { date: weekOf(n), time: '07:00' }, [lift]);
			}
			const d = await getStrengthDashboard(db, owner, { period: '4w', today: TODAY });
			const [lift] = d.keyLifts;
			expect(lift!.availability).toEqual({ ready: false, have: 1, need: 2, unit: 'sessions' });
			expect(lift!.value).toBeNull();
			expect(lift!.trend.result).toMatchObject({ verdict: 'real_trend', direction: 'up', n: 9 });
		});
	});
});

describe('the week in progress', () => {
	it('on a Wednesday keeps totals to complete weeks and compares the week so far like for like', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const squat = data.exercises.back_squat;
			const monday = mondayOf(TODAY);
			const heavy = { exerciseId: squat, weight: 140, reps: 5, rpe: 8 };
			await logStrength(db, data.owner, { date: monday, time: '07:00' }, [heavy, heavy, heavy]);
			// Last Friday's sets fall after the days compared, so they never count.
			const curl = { exerciseId: data.exercises.dumbbell_curl, weight: 20, reps: 10, rpe: 8 };
			await logStrength(db, data.owner, { date: addDays(monday, -3), time: '18:00' }, [curl]);

			const d = await getStrengthDashboard(db, data.owner, { period: '4w', today: TODAY });
			expect(d.tonnage.value!.value).toBe(await tonnage(db, data.owner, weekOf(13), LAST_DAY));
			expect(d.tonnage.series.at(-1)).toMatchObject({ at: monday, value: 2100, inProgress: true });
			const lastWeek = await tonnage(db, data.owner, weekOf(16), addDays(weekOf(16), 2));
			expect(lastWeek).not.toBe(await tonnage(db, data.owner, weekOf(16), LAST_DAY));
			expect(d.tonnage.soFar).toMatchObject({ value: 2100, lastWeek });
			expect(d.tonnage.soFar.text).toBe(
				`This week so far: 2,100 kg · ${lastWeek.toLocaleString('en-US')} kg by Wednesday last week`
			);
			expect(d.hardSets.soFar).toMatchObject({ value: 3 });
			// The week in progress keeps its PRs.
			expect(d.prs.items[0]).toMatchObject({ exerciseId: squat, on: monday, kind: 'e1rm' });
		});
	});
});

describe('availability and scope', () => {
	it('gives a new owner what each figure needs, and no number', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(
				owner,
				{ name: 'New', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ },
				{ db }
			);
			const d = await getStrengthDashboard(db, owner, { period: '12w', today: TODAY });
			expect(d.keyLifts).toEqual([]);
			expect(d.prs).toEqual({ items: [], total: 0 });
			const need = (n: number, unit: string) => ({ ready: false, have: 0, need: n, unit });
			expect(d.tonnage.availability).toEqual(need(1, 'weeks'));
			expect(d.hardSets.availability).toEqual(need(1, 'weeks'));
			expect(d.muscleGroups.availability).toEqual(need(1, 'weeks'));
			expect(d.rpe.average.availability).toEqual(need(1, 'sets'));
			expect(d.rpe.deviation.availability).toEqual(need(2, 'sets'));
			for (const figure of [d.tonnage, d.hardSets, d.rpe.average, d.rpe.deviation]) {
				expect(figure.value).toBeNull();
				expect(figure.comparison.words).toBe('Nothing logged in these weeks yet');
				expect(figure.trend.result.verdict).toBe('insufficient_data');
			}
			expect(d.tonnage.soFar.text).toBe(
				'This week so far: nothing yet · nothing by Wednesday last week'
			);
		});
	});

	it("reads only the owner's own training", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const mine = await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY });
			const theirs = await getStrengthDashboard(db, data.other, { period: 'all', today: TODAY });
			expect(theirs.window.weeks).toMatchObject({ from: weekOf(5), count: 12 });
			expect(theirs.tonnage.value!.value).toBe(4500);
			expect(theirs.keyLifts.map((l) => l.exerciseId)).toEqual([data.exercises.back_squat]);
			expect(theirs.prs.total).toBe(0);
			expect(mine.tonnage.value!.value).toBe(await tonnage(db, data.owner, WEEK_ONE, LAST_DAY));
			const squat = mine.keyLifts.find((l) => l.exerciseId === data.exercises.back_squat)!;
			expect(squat.value!.value).toBeLessThan(200);
		});
	});

	it('reads each kind once, one query at a time', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			for (const period of ['12w', 'all'] as const) {
				const { repository, calls, seen } = counting(db);
				await getStrengthDashboard(db, data.owner, { period, today: TODAY }, { repository });
				expect(calls, period).toEqual({ firstActivity: 1, sets: 1, sessions: 1, prescriptions: 1 });
				expect(seen.most).toBe(1);
			}
			// At 4w the records before the 12 weeks read are one more read of sets, in its own window.
			const { repository, calls } = counting(db);
			await getStrengthDashboard(db, data.owner, { period: '4w', today: TODAY }, { repository });
			expect(calls).toEqual({ firstActivity: 1, sets: 2, sessions: 1, prescriptions: 1 });
		});
	});
});
