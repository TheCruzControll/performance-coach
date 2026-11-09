/**
 * The general dashboard (src/lib/server/services/analytics/general.ts) on the M6 dataset. Every
 * expected figure is independent SQL over completed, undeleted workouts, never app code: adherence
 * from both programs' current versions, sessions, minutes and sRPE load per discipline and week,
 * Muay Thai rounds, recovery means, and the acute:chronic ratio through M1's acuteChronicRatio.
 * Each test seeds the dataset in its own transaction.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ACWR_CAVEAT } from '../../../src/lib/domain/analytics/workload';
import { addDays, daysBetween } from '../../../src/lib/domain/calendar';
import { acuteChronicRatio } from '../../../src/lib/domain/load';
import { workouts, type Executor } from '../../../src/lib/server/db';
import {
	ACWR_WINDOW_DAYS,
	getGeneralDashboard
} from '../../../src/lib/server/services/analytics/general';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { withRollback } from '../helpers';
import { seedDataset, TODAY, TZ, WEEK_ONE, WEEKS, weekOf } from './fixtures/dataset';

/** The owner's counted workouts: completed, undeleted, on their local day, with load inputs. */
const counted = (owner: string) => sql`
	select w.id, w.discipline, w.planned_lineage_id,
		(w.started_at at time zone ${TZ})::date as day,
		w.duration_s::float8 as duration,
		coalesce(w.duration_s, r.duration_s, o.duration_minutes * 60)::float8 / 60
			* coalesce(w.session_rpe, r.rpe, o.rpe)::float8 as load
	from workouts w
	left join run_records r on r.workout_id = w.id
	left join other_session_records o on o.workout_id = w.id
	where w.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null`;

type DisciplineWeek = {
	week: string;
	discipline: string;
	sessions: number;
	seconds: number;
	load: number;
};

async function byDisciplineWeek(db: Executor, owner: string) {
	const { rows } = await db.execute<DisciplineWeek>(sql`
		with c as (${counted(owner)})
		select date_trunc('week', day::timestamp)::date::text as week, discipline,
			count(*)::int as sessions, sum(duration)::float8 as seconds, sum(load)::float8 as load
		from c group by 1, 2 order by 1, 2`);
	return rows;
}

type AdherenceWeek = {
	week: string;
	planned: number;
	completed: number;
	skipped: number;
	missed: number;
	extra: number;
};

/** Each week's planned sessions of every program's current version, judged on `today`. */
async function adherenceWeeks(db: Executor, owner: string, today: string) {
	const { rows } = await db.execute<AdherenceWeek>(sql`
		with s as (
			select date_trunc('week', ps.scheduled_on::timestamp)::date as week, ps.status, ps.scheduled_on,
				ps.status = 'completed' or exists (
					select 1 from workouts w
					where w.owner_id = p.owner_id and w.planned_lineage_id = ps.lineage_id
						and w.status = 'completed' and w.deleted_at is null
				) as done
			from programs p
			join program_version_weeks vw on vw.version_id = p.current_version_id
			join planned_sessions ps on ps.week_id = vw.week_id
			where p.owner_id = ${owner}
		),
		extras as (
			select date_trunc('week', day::timestamp)::date as week, count(*)::int as extra
			from (${counted(owner)}) c where planned_lineage_id is null group by 1
		)
		select s.week::text as week, count(*)::int as planned,
			count(*) filter (where done)::int as completed,
			count(*) filter (where not done and status = 'skipped')::int as skipped,
			count(*) filter (where not done and status <> 'skipped' and scheduled_on < ${today})::int
				as missed,
			coalesce(max(e.extra), 0)::int as extra
		from s left join extras e on e.week = s.week
		group by s.week order by s.week`);
	return rows;
}

async function one<T>(db: Executor, query: ReturnType<typeof sql>): Promise<T> {
	const { rows } = await db.execute<{ v: T }>(query);
	return rows[0]!.v;
}

describe('getGeneralDashboard', () => {
	it('counts adherence from both programs, with skipped, missed and off plan apart', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const dash = await getGeneralDashboard(db, data.owner, { period: 'all', today: TODAY });
			expect(dash.window.weeks).toMatchObject({ from: WEEK_ONE, count: WEEKS });

			const expected = await adherenceWeeks(db, data.owner, TODAY);
			const shown = dash.adherence.weeks.map((w) => ({
				...{ week: w.weekStart, planned: w.planned, completed: w.completed },
				...{ skipped: w.skipped, missed: w.missed, extra: w.extra }
			}));
			expect(shown).toEqual(expected);
			// Program A (weeks 1–6) and program B (weeks 7–16) both count.
			expect(shown.every((w) => w.planned === 6)).toBe(true);

			const week = (n: number) => dash.adherence.weeks[n - 1]!;
			expect(week(9)).toMatchObject({ skipped: 1, missed: 0, completed: 5 });
			expect(week(10)).toMatchObject({ skipped: 0, missed: 1, completed: 5 });
			// The abandoned Strength B neither completes its session nor counts as a workout.
			expect(week(12)).toMatchObject({ skipped: 0, missed: 1, completed: 5 });
			expect(week(4).extra).toBe(1);
			expect(week(13).extra).toBe(0);
			expect(dash.adherence.total).toMatchObject({ planned: 96, skipped: 1, missed: 2 });
			expect(dash.figures.adherence.value).toBeCloseTo((93 / 96) * 100, 6);
		});
	});

	it('gives sessions, minutes and sRPE load per discipline and week as SQL does', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const dash = await getGeneralDashboard(db, data.owner, { period: 'all', today: TODAY });
			const rows = await byDisciplineWeek(db, data.owner);
			const of = (week: string) => rows.filter((r) => r.week === week);

			expect(dash.sessions.weeks).toHaveLength(WEEKS);
			for (const [i, w] of dash.sessions.weeks.entries()) {
				const theirs = of(w.weekStart);
				const sessions = Object.fromEntries(theirs.map((r) => [r.discipline, r.sessions]));
				const seconds = Object.fromEntries(theirs.map((r) => [r.discipline, r.seconds]));
				expect(w.byDiscipline, w.weekStart).toEqual(sessions);
				expect(dash.time.weeks[i]!.byDiscipline, w.weekStart).toEqual(seconds);

				const load = dash.load.weeks[i]!;
				const total = theirs.reduce((sum, r) => sum + r.load, 0);
				expect(load.load, w.weekStart).toBeCloseTo(total, 6);
				const group = (g: string) => load.byGroup.find((x) => x.group === g)!.load;
				const muayThai = theirs.find((r) => r.discipline === 'muay_thai')?.load ?? 0;
				expect(group('combat'), w.weekStart).toBeCloseTo(muayThai, 6);
				expect(dash.muayThai.weeks[i]!.load, w.weekStart).toBeCloseTo(muayThai, 6);
			}

			// Week 12's abandoned Strength B is no load: only Strength A's 65 min at RPE 7.5.
			const week12 = dash.load.weeks[11]!;
			expect(week12.byGroup.find((x) => x.group === 'strength')!.load).toBe(65 * 7.5);
			expect(dash.sessions.weeks[11]!.byDiscipline.strength).toBe(1);
			// Week 14's abandoned easy run is no session.
			expect(dash.sessions.weeks[13]!.byDiscipline.running).toBe(3);
			expect(dash.figures.srpe_load.value).toBeCloseTo(
				rows.reduce((sum, r) => sum + r.load, 0),
				6
			);
		});
	});

	it('adds Muay Thai rounds and recovery over the period as SQL does', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const dash = await getGeneralDashboard(db, data.owner, { period: '12w', today: TODAY });
			const [from, to] = [weekOf(5), addDays(weekOf(WEEKS), 6)];
			expect(dash.window.weeks).toMatchObject({ from, to, count: 12 });

			const rounds = await one<number>(
				db,
				sql`select sum((m->>'value')::int)::int as v
					from (${counted(data.owner)}) c
					join other_session_records o on o.workout_id = c.id
					cross join jsonb_array_elements(o.metrics) m
					where m->>'key' in ('rounds', 'sparring_rounds') and c.day between ${from} and ${to}`
			);
			expect(dash.muayThai.total.rounds.total).toBe(rounds);
			expect(dash.muayThai.total.sessions).toBe(12);

			const sleep = await one<number>(
				db,
				sql`select avg(sleep_hours)::float8 as v from recovery_notes
					where owner_id = ${data.owner} and noted_on between ${from} and ${to}`
			);
			expect(dash.figures.sleep.value).toBeCloseTo(sleep, 6);
			expect(dash.recovery.latest[0]).toMatchObject({
				notedOn: weekOf(WEEKS),
				text: { untrusted_text: 'Legs heavy after the long run' }
			});
		});
	});

	it('gives the ratio as M1 computes it, with its caveat, and none before 28 days', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const dash = await getGeneralDashboard(db, data.owner, { period: 'all', today: TODAY });
			const start = addDays(TODAY, 1 - ACWR_WINDOW_DAYS);
			const { rows } = await db.execute<{ day: string; load: number | null }>(sql`
				select day::text as day, sum(load)::float8 as load from (${counted(data.owner)}) c
				where day between ${start} and ${TODAY} group by 1`);
			const byDay = new Map(rows.map((r) => [r.day, r.load ?? 0]));
			const loads = Array.from(
				{ length: daysBetween(start, TODAY) + 1 },
				(_, n) => byDay.get(addDays(start, n)) ?? 0
			);
			const m1 = acuteChronicRatio(loads, 7, 28)!;
			expect(dash.acwr.current!.ratio).toBeCloseTo(m1.ratio!, 10);
			expect(dash.acwr.current!.acute).toBeCloseTo(m1.acute, 10);
			expect(dash.acwr.current!.caveat).toBe(ACWR_CAVEAT);
			expect(dash.acwr.placement).toBe('shown');
			expect(dash.figures.srpe_load.method).toMatch(/Minutes × session RPE/);

			// Weeks 1–3 end before 28 days of history; week 4's Sunday is the 28th day.
			const series = dash.acwr.series;
			expect(series).toHaveLength(WEEKS + 1);
			expect(series.slice(0, 3).map((p) => p.value)).toEqual([null, null, null]);
			expect(series[3]!.value).not.toBeNull();
			expect(series.at(-1)).toMatchObject({ at: weekOf(WEEKS + 1), inProgress: true });
			expect(series.at(-1)!.value).toBeCloseTo(m1.ratio!, 10);

			const early = { period: '4w' as const, today: addDays(WEEK_ONE, 26) };
			expect((await getGeneralDashboard(db, data.owner, early)).acwr.current).toBeNull();
			const day28 = { period: '4w' as const, today: addDays(WEEK_ONE, 27) };
			expect((await getGeneralDashboard(db, data.owner, day28)).acwr.current).not.toBeNull();
		});
	});

	it("compares with the previous weeks, except for 'all', and keeps this week apart", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const twelve = await getGeneralDashboard(db, data.owner, { period: '12w', today: TODAY });
			expect(twelve.previous).toEqual({
				from: addDays(weekOf(5), -84),
				to: addDays(weekOf(5), -1),
				count: 12
			});
			const before = await one<number>(
				db,
				sql`select count(*)::int as v from (${counted(data.owner)}) c where day < ${weekOf(5)}`
			);
			expect(twelve.figures.sessions.comparison).toMatchObject({
				previous: before,
				value: await one<number>(
					db,
					sql`select count(*)::int as v from (${counted(data.owner)}) c
						where day between ${weekOf(5)} and ${addDays(weekOf(WEEKS), 6)}`
				)
			});

			const all = await getGeneralDashboard(db, data.owner, { period: 'all', today: TODAY });
			expect(all.previous).toBeNull();
			expect(all.figures.sessions.comparison).toMatchObject({ previous: null, delta: null });

			// Today is week 17's Wednesday: nothing yet, against week 16's Monday to Wednesday.
			const lastWeek = await one<number>(
				db,
				sql`select count(*)::int as v from (${counted(data.owner)}) c
					where day between ${weekOf(WEEKS)} and ${addDays(weekOf(WEEKS), 2)}`
			);
			expect(all.figures.sessions.soFar).toMatchObject({ value: null, lastWeek });
			expect(all.sessions.inProgress).toMatchObject({ weekStart: weekOf(WEEKS + 1), sessions: 0 });
		});
	});

	it("counts this week's later sessions and advance skips as planned, logged work to today", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			// Week 9's Wednesday: Thursday's tempo run is skipped ahead, Saturday's long run is to come.
			const today = addDays(weekOf(9), 2);
			await db.execute(sql`update workouts set deleted_at = now()
				where owner_id = ${data.owner} and (started_at at time zone ${TZ})::date > ${today}`);
			const dash = await getGeneralDashboard(db, data.owner, { period: '4w', today });
			expect(dash.adherence.inProgress).toMatchObject({
				...{ planned: 6, completed: 4, skipped: 1, missed: 0, pending: 1 },
				...{ pct: 80, noRate: null }
			});
		});
	});

	it('leaves the weeks before the first activity out of every trend', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			// The second owner's first activity is week 5's Monday: a first-week owner that Wednesday.
			const firstWeek = { period: '4w' as const, today: addDays(weekOf(5), 2) };
			const early = await getGeneralDashboard(db, data.other, firstWeek);
			expect(early.figures.sessions.trend.result).toMatchObject({
				verdict: 'insufficient_data',
				n: 0
			});

			// Four complete weeks of 2, 3, 4 and 5 sessions: four points, short of the six needed.
			for (const n of [6, 7, 8]) {
				for (let d = 0; d < n - 3; d++) {
					const at = atLocal(addDays(weekOf(n), d), '07:00', TZ);
					await db.insert(workouts).values({
						...{ ownerId: data.other, clientId: crypto.randomUUID(), title: 'Run' },
						...{ kind: 'run', discipline: 'running', sessionType: 'easy_run' },
						...{ status: 'completed', startedAt: at, finishedAt: new Date(+at + 1_800_000) },
						...{ durationSeconds: 1800, sessionRpe: 5 }
					});
				}
			}
			const later = { period: '12w' as const, today: addDays(weekOf(9), 2) };
			const four = await getGeneralDashboard(db, data.other, later);
			expect(four.figures.sessions.trend.result).toMatchObject({
				verdict: 'insufficient_data',
				n: 4
			});
		});
	});

	it("reads only the owner's own rows", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const theirs = await getGeneralDashboard(db, data.other, { period: 'all', today: TODAY });
			expect(theirs.window.weeks).toMatchObject({ from: weekOf(5) });
			expect(theirs.sessions.total.sessions).toBe(2);
			expect(theirs.recovery.total.notes).toBe(1);
			expect(theirs.adherence.total).toMatchObject({ planned: 0, noRate: 'no_plan' });
			expect(theirs.muayThai.total.sessions).toBe(0);
		});
	});
});
