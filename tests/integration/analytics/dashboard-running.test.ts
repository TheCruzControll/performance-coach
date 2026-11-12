/**
 * The running dashboard (src/lib/server/services/analytics/running.ts) on the M6 dataset, with
 * today the Wednesday after week 16. Its figures are checked against SQL written here without app
 * code, over completed, undeleted workouts only, so the abandoned easy run of week 14 (a 5 km
 * effort if it counted) and the discarded workouts never show. Also: km and mi owners, owner
 * scope, a period without heart rate, the 4w trend window and the week in progress.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { runRecords, workouts, type Executor } from '../../../src/lib/server/db';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	getRunningDashboard,
	HR_NOT_TRACKED
} from '../../../src/lib/server/services/analytics/running';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { withRollback } from '../helpers';
import { LAST_DAY, longMetres, seedDataset, TODAY, TZ, weekOf } from './fixtures/dataset';

const counted = sql`w.status = 'completed' and w.deleted_at is null`;
const localDate = sql`(w.started_at at time zone ${TZ})::date`;

/** Metres, runs and the longest run per week, by the owner's Monday. */
async function weeksOracle(db: Executor, owner: string) {
	const { rows } = await db.execute<{
		week: string;
		metres: number;
		runs: number;
		longest: number;
	}>(
		sql`select to_char(date_trunc('week', w.started_at at time zone ${TZ}), 'YYYY-MM-DD') as week,
				sum(r.distance_m)::float8 as metres, count(*)::int as runs,
				max(r.distance_m)::float8 as longest
			from workouts w join run_records r on r.workout_id = w.id
			where w.owner_id = ${owner} and ${counted}
			group by 1 order by 1`
	);
	return new Map(rows.map((r) => [r.week, r]));
}

/**
 * Pace in s/km by run type over `from`–`to`: easy and long runs by the whole run, tempo runs by
 * their tempo segments and intervals by their interval segments.
 */
async function paceOracle(db: Executor, owner: string, from: IsoDate, to: IsoDate) {
	const { rows } = await db.execute<{ type: string; pace: number }>(
		sql`with c as (
				select w.id, w.session_type from workouts w
				where w.owner_id = ${owner} and ${counted} and ${localDate} between ${from} and ${to}
			)
			select c.session_type as type, sum(r.duration_s)::float8 / sum(r.distance_m)::float8 * 1000 as pace
			from c join run_records r on r.workout_id = c.id
			where c.session_type in ('easy_run', 'long_run') group by 1
			union all
			select c.session_type, sum(s.duration_s)::float8 / sum(s.distance_m)::float8 * 1000
			from c join run_record_segments s on s.workout_id = c.id
			where (c.session_type = 'tempo_run' and s.kind = 'tempo')
				or (c.session_type = 'interval_run' and s.kind = 'interval')
			group by 1`
	);
	return Object.fromEntries(rows.map((r) => [r.type, r.pace]));
}

/** The fastest run within ±2 % of each standard distance, ever. */
async function effortsOracle(db: Executor, owner: string) {
	const { rows } = await db.execute<{ label: string; id: string | null }>(
		sql`select d.label, b.id from (values ('5k', 5000), ('10k', 10000),
				('half_marathon', 21097.5), ('marathon', 42195)) as d(label, m)
			left join lateral (
				select w.id from workouts w join run_records r on r.workout_id = w.id
				where w.owner_id = ${owner} and ${counted} and abs(r.distance_m - d.m) <= d.m * 0.02
				order by r.duration_s / r.distance_m, w.started_at limit 1
			) b on true`
	);
	return Object.fromEntries(rows.map((r) => [r.label, r.id]));
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const weeksOf = (first: number, last: number) =>
	Array.from({ length: last - first + 1 }, (_, i) => weekOf(first + i));

describe('getRunningDashboard', () => {
	it('gives weekly metres, the longest run and pace by type as SQL over completed runs', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const board = await getRunningDashboard(db, data.owner, { period: '12w', today: TODAY });
			const oracle = await weeksOracle(db, data.owner);
			const mondays = weeksOf(5, 16);

			expect(board.mileage.weeks.map((w) => w.weekStart)).toEqual(mondays);
			for (const w of board.mileage.weeks) {
				const row = oracle.get(w.weekStart)!;
				expect(w.distance.value, w.weekStart).toBeCloseTo(row.metres, 6);
				expect(w.runs, w.weekStart).toBe(row.runs);
				expect(w.longest?.value, w.weekStart).toBeCloseTo(row.longest, 6);
			}
			const metres = mondays.map((m) => oracle.get(m)!.metres);
			expect(board.mileage.mean!.value).toBeCloseTo(mean(metres), 6);
			expect(board.mileage.longestRun!.value).toBe(longMetres(16));
			expect(board.mileage.longestRun!.text).toBe('17\u00a0km');
			expect(board.mileage.about).toMatchObject({ metric: 'mileage', kind: 'calculated' });
			const previous = weeksOf(1, 4).map((m) => oracle.get(m)?.metres ?? 0);
			// 12 weeks before week 5 hold only weeks 1–4: zero-filled, so the mean is of 12 weeks.
			expect(board.mileage.kpi.previous).toBeCloseTo(mean([...Array(8).fill(0), ...previous]), 6);

			const paces = await paceOracle(db, data.owner, weekOf(5), LAST_DAY);
			expect(board.pace.map((p) => p.sessionType)).toEqual([
				'long_run',
				'tempo_run',
				'interval_run'
			]);
			for (const p of board.pace) {
				expect(p.period!.value, p.sessionType).toBeCloseTo(paces[p.sessionType]!, 6);
				expect(p.trend!.window).toEqual(board.trendWindow);
			}
			expect(board.pace.find((p) => p.sessionType === 'long_run')!.period!.text).toBe(
				'5:30\u00a0/km'
			);

			// Planned: the tempo run (5 mi as 1609 + 4828 + 1609 m) and the long run; the intervals
			// are planned by time. Week 9's tempo run was skipped; week 10's long run was missed.
			const planned = (n: number) => board.mileage.weeks.find((w) => w.weekStart === weekOf(n))!;
			expect(planned(5)).toMatchObject({
				planned: { value: 8046 + longMetres(5) },
				plannedByTime: 1
			});
			expect(planned(9).planned!.value).toBe(longMetres(9));
			expect(planned(10).planned!.value).toBe(8046 + longMetres(10));
			expect(board.mileage.inProgress.planned).toBeNull();

			// Long runs: each week's long_run session, the missed week 10 without one.
			expect(board.longRuns.weeks.find((w) => w.weekStart === weekOf(16))!.run!.metres).toBe(
				longMetres(16)
			);
			expect(board.longRuns.weeks.find((w) => w.weekStart === weekOf(10))!.run).toBeNull();
			expect(board.frequency.runs).toBe(mondays.reduce((n, m) => n + oracle.get(m)!.runs, 0));
			expect(board.heartRate).toMatchObject({ tracked: true });
			// Week 8's reported 10K is in these 12 weeks, and not in the last 4 (below).
			const tenK = board.efforts.find((d) => d.distance === '10k')!;
			expect(tenK.reported.map((r) => r.on)).toEqual([addDays(weekOf(8), 6)]);
		});
	});

	it('plans the week in progress through its Sunday, its runs so far through today', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const wednesday = addDays(weekOf(16), 2);
			const board = await getRunningDashboard(db, data.owner, { period: '4w', today: wednesday });
			const week = board.mileage.inProgress;

			// Thursday's tempo run and Saturday's long run are still to come.
			expect(week.weekStart).toBe(weekOf(16));
			expect(week.planned!.value).toBe(8046 + longMetres(16));
			expect(week.runs).toBeLessThan((await weeksOracle(db, data.owner)).get(weekOf(16))!.runs);
		});
	});

	it('gives best efforts as SQL does and lists the reported race, at all time', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const board = await getRunningDashboard(db, data.owner, { period: 'all', today: TODAY });
			const oracle = await effortsOracle(db, data.owner);
			expect(board.window.weeks!.count).toBe(16);
			for (const d of board.efforts)
				expect(d.best?.id ?? null, d.distance).toBe(oracle[d.distance]);
			const tenK = board.efforts.find((d) => d.distance === '10k')!;
			// Week 2's 10 km long run; the abandoned 5 km run is no effort.
			expect(tenK.best).toMatchObject({ distanceMetres: longMetres(2), time: '55:00' });
			// Each effort's day is the owner's: the Saturday run's start, the race's own date.
			expect(tenK.best!.day).toBe(addDays(weekOf(2), 5));
			expect(tenK.reported.map((r) => r.day)).toEqual([addDays(weekOf(8), 6)]);
			expect(board.efforts.find((d) => d.distance === '5k')!.best).toBeNull();
			expect(tenK.reported).toMatchObject([
				{
					label: 'reported',
					eventName: 'Riverside 10K',
					time: '48:00',
					pace: { text: '4:48\u00a0/km' }
				}
			]);
		});
	});

	it("shows the same canonical figures in a mi owner's miles", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const km = await getRunningDashboard(db, data.owner, { period: '12w', today: TODAY });
			const basics = { name: 'Niko', weightUnit: 'kg', distanceUnit: 'mi', timeZone: TZ };
			await saveBasics(data.owner, basics, { db });
			const mi = await getRunningDashboard(db, data.owner, { period: '12w', today: TODAY });

			expect(mi.units.distance).toBe('mi');
			expect(mi.mileage.weeks.map((w) => w.distance.value)).toEqual(
				km.mileage.weeks.map((w) => w.distance.value)
			);
			expect(mi.mileage.longestRun).toEqual({ text: '10.6\u00a0mi', value: longMetres(16) });
			const long = mi.pace.find((p) => p.sessionType === 'long_run')!;
			expect(long.period!.text).toBe('8:51\u00a0/mi');
			expect(long.period!.value).toBe(
				km.pace.find((p) => p.sessionType === 'long_run')!.period!.value
			);
			expect(mi.mileage.soFar.text).toMatch(/\d\u00a0mi by Wednesday last week$/);
		});
	});

	it('takes its verdicts at 4w from the last 12 complete weeks and says so', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const board = await getRunningDashboard(db, data.owner, { period: '4w', today: TODAY });
			expect(board.mileage.weeks.map((w) => w.weekStart)).toEqual(weeksOf(13, 16));
			expect(board.trendWindow).toMatchObject({
				weeks: { from: weekOf(5), to: LAST_DAY, count: 12 },
				sameAsPeriod: false,
				label: 'Trend over the last 12 weeks'
			});
			expect(board.mileage.trend.result.n).toBe(12);
			expect(board.frequency.trend.result.n).toBe(12);
			// Week 10 has no long run, so 11 weeks give a long-run point; week 9 has no tempo run.
			expect(board.longRuns.trend.result.n).toBe(11);
			expect(board.pace.find((p) => p.sessionType === 'tempo_run')!.trend!.result.n).toBe(11);
			const oracle = await weeksOracle(db, data.owner);
			const sum = (first: number) => weeksOf(first, first + 3).map((m) => oracle.get(m)!.metres);
			expect(board.mileage.kpi.value).toBeCloseTo(mean(sum(13)), 6);
			expect(board.mileage.kpi.previous).toBeCloseTo(mean(sum(9)), 6);
			expect(board.efforts.find((d) => d.distance === '10k')!.reported).toEqual([]);
		});
	});

	it('keeps the week in progress out of the weekly mean and shows it so far', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const before = await getRunningDashboard(db, data.owner, { period: '12w', today: TODAY });
			const monday = addDays(TODAY, -2);
			const at = atLocal(monday, '07:00', TZ);
			const [row] = await db
				.insert(workouts)
				.values({
					...{ ownerId: data.owner, clientId: crypto.randomUUID(), kind: 'run' as const },
					...{ discipline: 'running' as const, sessionType: 'easy_run' as const, title: 'Run' },
					...{ status: 'completed' as const, startedAt: at, finishedAt: new Date(+at + 9e6) },
					durationSeconds: 9000
				})
				.returning({ id: workouts.id });
			await db.insert(runRecords).values({
				...{
					ownerId: data.owner,
					workoutId: row!.id,
					distanceMetres: 30000,
					durationSeconds: 9000
				},
				avgHr: 150
			});
			const after = await getRunningDashboard(db, data.owner, { period: '12w', today: TODAY });

			expect(after.mileage.mean).toEqual(before.mileage.mean);
			expect(after.mileage.kpi).toEqual(before.mileage.kpi);
			expect(after.mileage.trend).toEqual(before.mileage.trend);
			expect(after.frequency.perWeek).toBe(before.frequency.perWeek);
			expect(after.heartRate).toEqual(before.heartRate);
			expect(after.mileage.inProgress).toMatchObject({ inProgress: true, runs: 1 });
			expect(after.mileage.inProgress.distance.value).toBe(30000);
			expect(after.mileage.points.at(-1)).toEqual({ at: monday, value: 30000, inProgress: true });
			expect(after.frequency.inProgress).toBe(1);
			// Last week's Monday to Wednesday: week 16's intervals on Tuesday.
			expect(after.mileage.soFar.text).toBe(
				'This week so far: 30\u00a0km · 7.5\u00a0km by Wednesday last week'
			);
		});
	});

	it("reads only the owner's own runs, and says 'not tracked' without a heart rate", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			await db.update(runRecords).set({ avgHr: null }).where(eq(runRecords.ownerId, data.other));
			const theirs = await getRunningDashboard(db, data.other, { period: 'all', today: TODAY });
			const oracle = await weeksOracle(db, data.other);

			expect([...oracle.values()]).toMatchObject([{ week: weekOf(5), runs: 1 }]);
			const ran = theirs.mileage.weeks.filter((w) => w.runs > 0);
			expect(ran).toMatchObject([
				{ weekStart: weekOf(5), runs: 1, distance: { value: oracle.get(weekOf(5))!.metres } }
			]);
			expect(theirs.mileage.weeks.find((w) => w.weekStart === weekOf(5))!.planned).toBeNull();
			expect(theirs.efforts.every((d) => d.best === null && d.reported.length === 0)).toBe(true);
			expect(theirs.heartRate).toEqual({ tracked: false, text: HR_NOT_TRACKED, byType: [] });

			const mine = await getRunningDashboard(db, data.owner, { period: 'all', today: TODAY });
			const week5 = (await weeksOracle(db, data.owner)).get(weekOf(5))!;
			expect(mine.mileage.weeks.find((w) => w.weekStart === weekOf(5))!.distance.value).toBeCloseTo(
				week5.metres,
				6
			);
		});
	});
});
