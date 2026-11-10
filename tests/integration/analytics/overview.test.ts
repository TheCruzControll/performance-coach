/**
 * The overview (src/lib/server/services/analytics/overview.ts) on the M6 dataset and on a sparse
 * three-year owner: its figures are the dashboards' own and the database's, the three dashboards
 * share one loader (reads counted), verdicts name their window at every period, a Wednesday never
 * reads as a decline, a new owner gets dated availability and 'all' stays small past two years.
 * Each test seeds in its own transaction.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SeriesPoint } from '../../../src/lib/domain/analytics/types';
import { addDays, mondayOf } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import {
	createAnalyticsRepository,
	type AnalyticsRepository
} from '../../../src/lib/server/db/repositories/analytics';
import {
	createFactsLoader,
	sharedFacts,
	type FactsLoader
} from '../../../src/lib/server/services/analytics/facts';
import { getGeneralDashboard } from '../../../src/lib/server/services/analytics/general';
import {
	getProgressOverview,
	type ProgressOverview
} from '../../../src/lib/server/services/analytics/overview';
import { getRunningDashboard } from '../../../src/lib/server/services/analytics/running';
import { getStrengthDashboard } from '../../../src/lib/server/services/analytics/strength';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { LAST_DAY, seedDataset, TODAY, TZ, WEEK_ONE, weekOf } from './fixtures/dataset';
import { seedThreeYears, THREE_YEARS_FROM, THREE_YEARS_TODAY } from './fixtures/three-years';

const PERIODS = ['4w', '12w', 'all'] as const;
const point = ({ at, value, inProgress }: SeriesPoint) => ({ at, value, inProgress });
const kpiOf = (o: ProgressOverview, id: string) => o.kpis.find((k) => k.metric === id)!;
const verdictOf = (o: ProgressOverview, area: string) => o.verdicts.find((v) => v.area === area)!;

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

/** Σ weight × reps of working, loaded sets of completed, undeleted workouts between two days. */
async function tonnage(db: Executor, owner: string, from: string, to: string) {
	const { rows } = await db.execute<{ kg: number }>(sql`
		select coalesce(sum(s.weight_kg * s.reps), 0)::float8 as kg
		from set_records s join workouts w on w.id = s.workout_id
		where s.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
			and s.deleted_at is null and not s.is_warmup and not s.is_skipped
			and s.weight_kg is not null and s.reps is not null
			and (s.performed_at at time zone ${TZ})::date between ${from}::date and ${to}::date`);
	return rows[0]!.kg;
}

describe('getProgressOverview', () => {
	it.each(PERIODS)(
		"gives the discipline services' figures, and the database's, at %s",
		async (period) => {
			await withRollback(async (db) => {
				const { owner } = await seedDataset(db);
				const query = { period, today: TODAY };
				const o = await getProgressOverview(db, owner, query);
				const strength = await getStrengthDashboard(db, owner, query);
				const running = await getRunningDashboard(db, owner, query);
				const general = await getGeneralDashboard(db, owner, query);
				expect(o.window, period).toEqual(strength.window);
				expect(o.trendWindow, period).toEqual(general.trendWindow);

				const t = kpiOf(o, 'tonnage');
				expect(t.value, period).toBe(strength.tonnage.value!.value);
				expect(t.shown).toBe(strength.tonnage.value!.text);
				expect(t.comparison).toEqual(strength.tonnage.comparison);
				expect(t.trend).toEqual(strength.tonnage.trend);
				expect(t.soFar).toEqual(strength.tonnage.soFar);
				expect(t.series).toEqual(strength.tonnage.series.map(point));

				const m = kpiOf(o, 'mileage');
				expect(m.value, period).toBe(running.mileage.kpi.value);
				expect(m.shown).toBe(running.mileage.mean!.text);
				expect(m.comparison).toEqual(running.mileage.kpi);
				expect(m.trend).toEqual(running.mileage.trend);
				expect(m.soFar).toEqual(running.mileage.soFar);
				expect(m.series).toEqual(running.mileage.points);

				for (const id of ['sessions', 'adherence', 'srpe_load'] as const) {
					const { value, shown, comparison, trend, soFar, series } = general.figures[id];
					expect(kpiOf(o, id), `${period} ${id}`).toMatchObject({
						...{ value, shown, comparison, trend, soFar, series }
					});
				}

				const lifts = strength.keyLifts.map((l) => ({
					...{ exerciseId: l.exerciseId, name: l.name },
					points: l.series.map(point)
				}));
				expect(o.series.keyLifts).toEqual(lifts);
				const evidence = verdictOf(o, 'strength').evidence.map((e) => e.trend);
				expect(evidence).toEqual(expect.arrayContaining(strength.keyLifts.map((l) => l.trend)));
				expect(evidence).toHaveLength(strength.keyLifts.length);
				const pace = running.pace.flatMap((p) => (p.trend ? [p.trend] : []));
				const runningTrends = verdictOf(o, 'running').evidence.map((e) => e.trend);
				expect(runningTrends).toEqual(
					expect.arrayContaining([running.mileage.trend, running.longRuns.trend, ...pace])
				);
				expect(verdictOf(o, 'recovery').evidence.map((e) => e.trend)).toEqual(
					expect.arrayContaining([general.figures.sleep.trend, general.figures.stress.trend])
				);
				const load = general.load.weeks.map((w) => w.byGroup);
				const strengthLoad = o.series.load.find((s) => s.group === 'strength');
				if (o.window.bucket === 'week') {
					expect(strengthLoad!.points.slice(0, -1).map((p) => p.value)).toEqual(
						load.map((groups) => groups.find((g) => g.group === 'strength')!.load)
					);
				}
				// And the database's: the period's tonnage is the SQL total over its complete weeks.
				const weeks = o.window.weeks!;
				expect(kpiOf(o, 'tonnage').value).toBeCloseTo(
					await tonnage(db, owner, weeks.from, weeks.to),
					6
				);
			});
		}
	);

	it('reads each kind once per window for all three services, one query at a time', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedDataset(db);
			const once = {
				...{ firstActivity: 1, sets: 1, sessions: 1, segments: 1 },
				...{ prescriptions: 1, planned: 1, recovery: 1 }
			};
			for (const period of ['12w', 'all'] as const) {
				const { repository, calls, seen } = counting(db);
				await getProgressOverview(db, owner, { period, today: TODAY }, { repository });
				expect(calls, period).toEqual(once);
				expect(seen.most).toBe(1);
			}
			// At 4w the records before the days read are one more window of sets, read once.
			const { repository, calls } = counting(db);
			await getProgressOverview(db, owner, { period: '4w', today: TODAY }, { repository });
			expect(calls).toEqual({ ...once, sets: 2 });
		});
	});

	it('reads a history past two years in two windows, each kind once in each', async () => {
		await withRollback(async (db) => {
			const steady = await seedThreeYears(db);
			const three = counting(db);
			const query = { period: 'all', today: THREE_YEARS_TODAY } as const;
			await getProgressOverview(db, steady.owner, query, { repository: three.repository });
			// More than two years: two windows (MAX_RANGE_DAYS), each kind read once in each.
			expect(three.calls).toEqual({
				...{ firstActivity: 1, sets: 2, sessions: 2, segments: 2 },
				...{ prescriptions: 2, planned: 2, recovery: 2 }
			});
			expect(three.seen.most).toBe(1);
		});
	});

	it('finds the known trends: squat improving, bench within normal variation', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const o = await getProgressOverview(db, data.owner, { period: '12w', today: TODAY });
			const name = (id: string) => o.series.keyLifts.find((l) => l.exerciseId === id)!.name;
			const strength = verdictOf(o, 'strength');
			const call = (id: string) => strength.evidence.find((e) => e.subject === name(id))!.call;
			expect(call(data.exercises.back_squat)).toBe('better');
			expect(call(data.exercises.bench_press)).toBe('steady');
			expect(strength.sentence).toMatch(/main lifts/);
			expect(o.headline.text).toMatch(/^Strength /);
		});
	});

	it('at 4w gives every discipline a verdict that names the 12-week window', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedDataset(db);
			const o = await getProgressOverview(db, owner, { period: '4w', today: TODAY });
			expect(o.window.weeks).toEqual({ from: weekOf(13), to: LAST_DAY, count: 4 });
			const window = {
				weeks: { from: weekOf(5), to: LAST_DAY, count: 12 },
				sameAsPeriod: false,
				label: 'Trend over the last 12 weeks'
			};
			expect(o.verdicts.map((v) => v.area)).toEqual(['strength', 'running', 'general', 'recovery']);
			for (const verdict of o.verdicts) expect(verdict.window, verdict.area).toEqual(window);
			for (const area of ['strength', 'running', 'general']) {
				expect(verdictOf(o, area).verdict, area).not.toBe('not_enough_data');
			}
			expect(kpiOf(o, 'tonnage').comparison.words).toMatch(/the previous 4 weeks/);
		});
	});

	it('on a Wednesday never reads a steady history as declining', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedThreeYears(db);
			for (const period of PERIODS) {
				const o = await getProgressOverview(db, owner, { period, today: THREE_YEARS_TODAY });
				expect(o.window.inProgress).toMatchObject({ through: THREE_YEARS_TODAY, days: 3 });
				expect(o.window.weeks!.to).toBe(addDays(mondayOf(THREE_YEARS_TODAY), -1));
				for (const verdict of o.verdicts) {
					expect(['declining', 'mixed'], `${period} ${verdict.area}`).not.toContain(
						verdict.verdict
					);
				}
				// The squat never changes: within normal variation, whatever this week holds so far.
				expect(verdictOf(o, 'strength').verdict, period).toBe('holding');
				const tonnageTile = kpiOf(o, 'tonnage');
				expect(tonnageTile.series.at(-1)).toMatchObject({ inProgress: true, value: 1500 });
				expect(tonnageTile.soFar!.value).toBe(1500);
			}
		});
	});

	it('gives a new owner the day each insight appears, from the plan and today', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const basics = { name: 'New', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ } as const;
			await saveBasics(owner, basics, { db });
			const today = '2026-11-05';
			const bare = await getProgressOverview(db, owner, { period: '12w', today });
			expect(bare.headline.verdict).toBe('not_enough_data');
			// Nothing to total is no number; a count of nothing is 0, as the dashboards give it.
			expect(bare.kpis.map((k) => k.value)).toEqual([null, 0, 0, null, 0]);
			expect(bare.verdicts.every((v) => v.verdict === 'not_enough_data')).toBe(true);
			// With nothing to judge, each verdict still names the weeks it would read.
			const short = await getProgressOverview(db, owner, { period: '4w', today });
			for (const verdict of short.verdicts) {
				expect(verdict.window, verdict.area).toMatchObject({
					weeks: { count: 12, to: addDays(mondayOf(today), -1) },
					label: 'Trend over the last 12 weeks'
				});
			}
			expect(bare.availability).toMatchObject({
				prs: { on: null, ready: false, rule: 'After your first strength session' },
				e1rm: { on: null, ready: false },
				verdicts: { on: addDays(mondayOf(today), 42), ready: false },
				acwr: { on: addDays(today, 27), ready: false },
				weekly_review: { on: '2026-11-08', ready: false },
				cycle_review: { on: null, ready: false }
			});

			const monday = '2026-11-09';
			await createProgramFromPlan(
				owner,
				programFixture('hybrid', { monday, today }),
				{ source: 'rules' },
				{ db }
			);
			const o = await getProgressOverview(db, owner, { period: '12w', today });
			expect(o.availability).toMatchObject({
				prs: { on: monday, ready: false },
				// The plan's second strength Monday, a week past the next few sessions.
				e1rm: { on: addDays(monday, 7), ready: false },
				verdicts: { on: addDays(monday, 42), ready: false },
				acwr: { on: addDays(monday, 27), ready: false },
				weekly_review: { on: '2026-11-15', ready: false },
				cycle_review: { on: '2026-11-15', ready: false }
			});
			expect(o.timeline.map((s) => s.section)).toEqual([
				'prs',
				'weekly_review',
				'cycle_review',
				'e1rm',
				'acwr',
				'verdicts'
			]);
		});
	});

	it('dates what a logged history already shows, and readies it', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedDataset(db);
			const o = await getProgressOverview(db, owner, { period: '12w', today: TODAY });
			expect(o.availability).toMatchObject({
				prs: { on: WEEK_ONE, ready: true },
				// The squat's second session.
				e1rm: { on: weekOf(2), ready: true },
				verdicts: { on: weekOf(7), ready: true },
				acwr: { on: addDays(WEEK_ONE, 27), ready: true },
				weekly_review: { on: addDays(WEEK_ONE, 6), ready: true }
			});
			expect(o.availability.cycle_review.ready).toBe(true);
			// Twenty weeks after the last session nothing is left to judge: past the date, not ready.
			const lapsed = { period: '12w', today: addDays(LAST_DAY, 140) } as const;
			const later = await getProgressOverview(db, owner, lapsed);
			expect(later.verdicts.every((v) => v.verdict === 'not_enough_data')).toBe(true);
			expect(later.availability.verdicts).toMatchObject({ on: weekOf(7), ready: false });
		});
	});

	it("has no previous period at 'all'", async () => {
		await withRollback(async (db) => {
			const { owner } = await seedDataset(db);
			const o = await getProgressOverview(db, owner, { period: 'all', today: TODAY });
			expect(o.window.previous).toBeNull();
			for (const tile of o.kpis) {
				expect(tile.comparison, tile.metric).toMatchObject({ previous: null, delta: null });
				expect(tile.comparison.words).toBe('No earlier weeks like these to compare with');
			}
		});
	});

	it("buckets the three-year owner's 'all' by month, at most 40 points a series", async () => {
		await withRollback(async (db) => {
			const { owner } = await seedThreeYears(db);
			const o = await getProgressOverview(db, owner, { period: 'all', today: THREE_YEARS_TODAY });
			expect(o.window.weeks).toMatchObject({ from: THREE_YEARS_FROM, count: 156 });
			expect(o.window.bucket).toBe('month');
			const series = [
				...o.kpis.map((k) => k.series),
				...o.series.keyLifts.map((l) => l.points),
				...o.series.load.map((l) => l.points)
			];
			expect(o.series.keyLifts).toHaveLength(1);
			expect(o.series.load.map((l) => l.group)).toEqual(['strength', 'running']);
			for (const points of series) {
				expect(points.length).toBeGreaterThan(30);
				expect(points.length).toBeLessThanOrEqual(40);
				expect(points.filter((p) => !p.inProgress).every((p) => p.at.endsWith('-01'))).toBe(true);
			}
		});
	});

	it("reads only the owner's own training", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const theirs = await getProgressOverview(db, data.other, { period: 'all', today: TODAY });
			expect(kpiOf(theirs, 'tonnage').value).toBe(4500);
			expect(theirs.series.keyLifts.map((l) => l.exerciseId)).toEqual([data.exercises.back_squat]);
			const prs = theirs.availability.prs;
			expect(prs.ready).toBe(true);
			expect(prs.on! >= weekOf(5) && prs.on! < weekOf(6)).toBe(true);
			const mine = await getProgressOverview(db, data.owner, { period: 'all', today: TODAY });
			expect(kpiOf(mine, 'tonnage').value).toBeCloseTo(
				await tonnage(db, data.owner, WEEK_ONE, LAST_DAY),
				6
			);
		});
	});

	describe('sharedFacts', () => {
		/** Every kind a loader gives, comparable. */
		async function everything(loader: FactsLoader) {
			const planned = await loader.planned();
			return {
				sets: (await loader.sets()).map((s) => s.id),
				sessions: (await loader.sessions()).map((s) => s.id),
				runs: await loader.runs(),
				planned: planned.planned,
				workouts: planned.workouts.map((w) => w.id),
				plannedRuns: await loader.plannedRuns(),
				recovery: await loader.recovery(),
				first: await loader.firstActivity()
			};
		}

		it("gives a range's rows as its own loader does, inside, before and across its days", async () => {
			await withRollback(async (db) => {
				const { owner } = await seedDataset(db);
				const range = { from: weekOf(6), to: addDays(weekOf(12), 6), timeZone: TZ };
				const facts = sharedFacts(db, owner, range);
				const own = (from: string, to: string) =>
					createFactsLoader(db, owner, { from, to, timeZone: TZ });
				for (const [from, to] of [
					[weekOf(8), addDays(weekOf(9), 3)],
					[WEEK_ONE, addDays(weekOf(3), 6)],
					[weekOf(2), addDays(weekOf(10), 2)]
				] as const) {
					const shared = await everything(facts(from, to));
					expect(shared.sessions.length, from).toBeGreaterThan(0);
					expect(shared, `${from}–${to}`).toEqual(await everything(own(from, to)));
				}
				expect(() => facts(weekOf(8), addDays(weekOf(13), 0))).toThrow(RangeError);
			});
		});
	});
});
