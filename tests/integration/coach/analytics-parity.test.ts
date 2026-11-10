/**
 * One engine (M6's coach-analytics-repoint): the coach's analytics, PR and exercise-trend tools
 * read the functions Progress reads, so on the M6 dataset, at 4, 12 and 26 weeks:
 * - get_performance_trends' points and verdicts, get_weekly_training_summary's week and
 *   get_training_load's ratio equal the General and Running views' figures and the overview's
 * - get_personal_records lists exactly the strength dashboard's PRs, and no record comes from a
 *   workout that was abandoned, left in progress or deleted (M3's history reads still count them)
 * - get_exercise_history's e1RM trend and verdict equal the exercise detail's (getExerciseAnalytics)
 * - thin data gives insufficient data, and another owner reads nothing of the owner's
 * Every call runs as a turn runs it, on the test's transaction, and validates against its schema.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import type { Period } from '../../../src/lib/domain/analytics/periods';
import type { SeriesPoint } from '../../../src/lib/domain/analytics/types';
import { addDays } from '../../../src/lib/domain/calendar';
import { ANALYTICS_TOOLS } from '../../../src/lib/server/agent/tools/analytics';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { HISTORY_TOOLS, PRS_PER_EXERCISE } from '../../../src/lib/server/agent/tools/history';
import type { Executor } from '../../../src/lib/server/db';
import { getExerciseAnalytics } from '../../../src/lib/server/services/analytics/exercise';
import { getGeneralDashboard } from '../../../src/lib/server/services/analytics/general';
import { TREND_PERIODS } from '../../../src/lib/server/services/analytics/index';
import { getProgressOverview } from '../../../src/lib/server/services/analytics/overview';
import { getStrengthRecords } from '../../../src/lib/server/services/analytics/records';
import { getRunningDashboard } from '../../../src/lib/server/services/analytics/running';
import { getStrengthDashboard, PRS_MAX } from '../../../src/lib/server/services/analytics/strength';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { getPersonalRecords } from '../../../src/lib/server/services/training/history';
import { seedDataset, TODAY, TZ, weekOf, type Dataset } from '../analytics/fixtures/dataset';
import { withRollback } from '../helpers';
import { TURN_NOW } from './harness';

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = [...ANALYTICS_TOOLS, ...HISTORY_TOOLS] as Tools;
const PERIODS = [
	['4w', 4],
	['12w', 12],
	['26w', 26]
] as const satisfies readonly (readonly [Period, number])[];

/** A successful call of a coach tool, as a turn runs it, checked against its output schema. */
async function output<T>(db: Executor, ownerId: string, name: string, input: object = {}) {
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: TZ },
		runtime: toolRuntime({ db, now: () => new Date(TURN_NOW) }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: 'toolu_01Parity', name, input }], ctx, {
		tools: TOOLS
	});
	const [outcome] = outcomes;
	expect(outcome!.error, `${name} ${JSON.stringify(input)}`).toBeNull();
	const tool = TOOLS.find((t) => t.name === name)!;
	expect(z.safeParse(tool.outputSchema, outcome!.output).success, name).toBe(true);
	return outcome!.output as T;
}

interface Ref {
	type: string;
	id: string;
}
interface Call {
	verdict: string;
	realTrend: { direction: string; good: boolean | null } | null;
	window: { from: string; to: string; label: string } | null;
}
interface TrendOut {
	metric: string;
	points: SeriesPoint[];
	change: { verdict: string };
	realTrend: Call['realTrend'];
	about: { metric: string; kind: string };
}
interface TrendsOut {
	status: string;
	weeks: { from: string; to: string };
	window: Call['window'];
	trends: TrendOut[];
}
interface FigureOut {
	value: number;
	about: { metric: string };
	sources: Ref[];
}
interface SummaryOut {
	status: string;
	[figure: string]: unknown;
}
interface PrOut {
	kind: string;
	reps: number | null;
	value: number;
	previous: { value: number; date: string };
	source: Ref & { date: string };
}
interface RecordsOut {
	items: {
		exercise: Ref;
		bestE1rm: { value: number; sources: Ref[] } | null;
		repMaxes: { reps: number; weightKg: number; source: Ref }[];
		prs: PrOut[];
		prCount: number;
	}[];
	more: boolean;
	next: number | null;
}
interface HistoryOut {
	records: RecordsOut['items'][number];
	e1rmTrend: Call & { value: number | null; comparison: string; about: { kind: string } };
}

/** A dashboard verdict as the tools carry it. */
const callOf = ({ result }: { result: { verdict: string; direction?: string; good?: unknown } }) =>
	result.verdict === 'real_trend' ? { direction: result.direction, good: result.good } : null;
const windowOf = (w: { weeks: { from: string; to: string } | null; label: string }) =>
	w.weeks && { from: w.weeks.from, to: w.weeks.to, label: w.label };
const complete = (points: readonly SeriesPoint[], from: string, scale = (v: number) => v) =>
	points
		.filter((p) => !p.inProgress && p.at >= from)
		.map((p) => ({ at: p.at, value: p.value === null ? null : scale(p.value), inProgress: false }));

/** The set ids of the workouts that never count: abandoned, in progress and soft-deleted. */
async function discardedSets(db: Executor, { workouts }: Dataset) {
	const ids = [workouts.abandoned, workouts.inProgress, workouts.deleted];
	const { rows } = await db.execute<{ id: string }>(sql`
		select id::text as id from set_records
		where workout_id in (${sql.join(
			ids.map((id) => sql`${id}::uuid`),
			sql`, `
		)}) and deleted_at is null`);
	return new Set(rows.map((r) => r.id));
}

describe('the coach reads the dashboards’ engine', () => {
	it.each(PERIODS)(
		'gives the General and Running views’ trends and verdicts, and the overview’s, at %s',
		async (period, weeks) => {
			await withRollback(async (db) => {
				const { owner } = await seedDataset(db);
				expect(TREND_PERIODS.find(([, n]) => n >= weeks)![0]).toBe(period);
				const query = { period, today: TODAY };
				const general = await getGeneralDashboard(db, owner, query);
				const running = await getRunningDashboard(db, owner, query);
				const overview = await getProgressOverview(db, owner, query);
				const out = await output<TrendsOut>(db, owner, 'get_performance_trends', { weeks });
				expect(out.status).toBe('ok');
				expect(out.window).toEqual(windowOf(general.trendWindow));
				const views = {
					sessions: { figure: general.figures.sessions, scale: (v: number) => v },
					minutes: { figure: general.figures.training_time, scale: (s: number) => s / 60 },
					session_load: { figure: general.figures.srpe_load, scale: (v: number) => v },
					running_distance: {
						figure: { series: running.mileage.points, trend: running.mileage.trend },
						scale: (m: number) => m / 1000
					}
				};
				expect(out.trends.map((t) => t.metric)).toEqual(Object.keys(views));
				for (const trend of out.trends) {
					const { figure, scale } = views[trend.metric as keyof typeof views];
					const expected = complete(figure.series, out.weeks.from, scale);
					expect(
						trend.points.map((p) => p.at),
						trend.metric
					).toEqual(expected.map((p) => p.at));
					trend.points.forEach((p, i) =>
						expect(p.value, `${trend.metric} ${p.at}`).toBeCloseTo(expected[i]!.value!, 1)
					);
					expect(trend.change.verdict, trend.metric).toBe(figure.trend.result.verdict);
					expect(trend.realTrend, trend.metric).toEqual(callOf(figure.trend));
				}
				// The overview's tiles carry the same verdicts.
				const kpi = (id: string) => overview.kpis.find((k) => k.metric === id)!.trend;
				const named = (metric: string) => out.trends.find((t) => t.metric === metric)!;
				expect(named('sessions').change.verdict).toBe(kpi('sessions').result.verdict);
				expect(named('session_load').change.verdict).toBe(kpi('srpe_load').result.verdict);
				expect(named('running_distance').change.verdict).toBe(kpi('mileage').result.verdict);
			});
		}
	);

	it('gives a week as the views give it, at the period that holds it, and their load ratio', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedDataset(db);
			// Week 16 is in the last 4 weeks, week 10 in the last 12, week 1 in the last 26.
			for (const [period, n] of [
				['4w', 16],
				['12w', 10],
				['26w', 1]
			] as const) {
				const monday = weekOf(n);
				const query = { period, today: TODAY };
				const general = await getGeneralDashboard(db, owner, query);
				const running = await getRunningDashboard(db, owner, query);
				const strength = await getStrengthDashboard(db, owner, query);
				const at = <T extends { weekStart: string }>(weeks: readonly T[]) =>
					weeks.find((w) => w.weekStart === monday)!;
				const out = await output<SummaryOut>(db, owner, 'get_weekly_training_summary', {
					week: addDays(monday, 3)
				});
				const value = (key: string) => (out[key] as FigureOut).value;
				const adherence = at(general.adherence.weeks);
				expect(out.status, period).toBe('ok');
				expect(out.dashboard).toBe(`/progress?view=general&period=${period}`);
				expect(value('planned'), period).toBe(adherence.planned - adherence.skipped);
				expect(value('completed'), period).toBe(adherence.completed);
				expect(value('skipped'), period).toBe(adherence.skipped);
				expect(value('workouts'), period).toBe(at(general.sessions.weeks).sessions);
				expect(value('minutes'), period).toBeCloseTo(at(general.time.weeks).seconds! / 60, 1);
				expect(value('sessionLoad'), period).toBeCloseTo(at(general.load.weeks).load!, 1);
				expect(value('unrated'), period).toBe(at(general.load.weeks).unknown.length);
				expect(value('runningDistance'), period).toBeCloseTo(
					at(running.mileage.weeks).distance.value / 1000,
					2
				);
				const groups = at(strength.muscleGroups.weeks).groups.filter((g) => g.sets > 0);
				expect((out.hardSets as { values: object }).values, period).toEqual(
					Object.fromEntries(groups.map((g) => [g.group, g.sets]))
				);
				expect((out.planned as FigureOut).about.metric).toBe('adherence');
			}
			const ratio = (await getGeneralDashboard(db, owner, { period: '12w', today: TODAY })).acwr
				.current!;
			const load = await output<Record<string, FigureOut & { value: number }>>(
				db,
				owner,
				'get_training_load'
			);
			expect(load.ratio!.value).toBeCloseTo(ratio.ratio!, 2);
			expect(load.acute!.value).toBeCloseTo(ratio.acute, 1);
			expect(load.chronic!.value).toBeCloseTo(ratio.chronic, 1);
			expect(load).toMatchObject({ from: ratio.from, days: ratio.days, zone: ratio.zone });
		});
	});

	it.each(PERIODS)(
		'lists exactly the strength dashboard’s PRs at %s, none from a discarded workout',
		async (period) => {
			await withRollback(async (db) => {
				const dataset = await seedDataset(db);
				const { owner, exercises } = dataset;
				const discarded = await discardedSets(db, dataset);
				expect(discarded.size).toBeGreaterThan(0);
				const strength = await getStrengthDashboard(db, owner, { period, today: TODAY });
				const records = await getStrengthRecords(db, owner, { today: TODAY });
				const from = strength.window.weeks!.from;
				const prs = records
					.flatMap((r) => r.prs.map((pr) => ({ ...pr, exerciseId: r.exerciseId, name: r.name })))
					.filter((pr) => pr.on >= from)
					.sort((a, b) => (a.on === b.on ? a.name.localeCompare(b.name) : a.on < b.on ? 1 : -1));
				const key = (pr: { kind: string; reps: number | null; on: string; setId: string | null }) =>
					`${pr.on} ${pr.kind}:${pr.reps ?? ''} ${pr.setId ?? 'session'}`;
				expect(prs.length, period).toBe(strength.prs.total);
				expect(prs.slice(0, PRS_MAX).map(key)).toEqual(strength.prs.items.map(key));
				expect(prs.slice(0, PRS_MAX).map((pr) => pr.value)).toEqual(
					strength.prs.items.map((pr) => pr.value)
				);

				// The tool pages the same records, each with its newest PRs.
				const items: RecordsOut['items'] = [];
				for (let from: number | null = 0; from !== null;) {
					const page: RecordsOut = await output<RecordsOut>(db, owner, 'get_personal_records', {
						from
					});
					items.push(...page.items);
					from = page.next;
				}
				expect(items.map((i) => i.exercise.id)).toEqual(records.map((r) => r.exerciseId));
				items.forEach((item, i) => {
					const own = records[i]!;
					expect(item.prCount).toBe(own.prs.length);
					expect(item.prs.map((pr) => `${pr.source.date} ${pr.kind}:${pr.reps ?? ''}`)).toEqual(
						own.prs.slice(0, PRS_PER_EXERCISE).map((pr) => `${pr.on} ${pr.kind}:${pr.reps ?? ''}`)
					);
					const cited = [
						...(item.bestE1rm?.sources ?? []),
						...item.repMaxes.map((r) => r.source),
						...item.prs.map((pr) => pr.source)
					];
					for (const ref of cited) expect(discarded.has(ref.id), ref.id).toBe(false);
				});

				// M3's history read, which the start kit's prior bests use, still counts the
				// discarded workouts' heavy sets; the coach's records never do.
				const [m3] = await getPersonalRecords(owner, { exerciseId: exercises.back_squat }, { db });
				expect(discarded.has(String(m3!.bestE1rm!.set.id))).toBe(true);
				const squat = items.find((i) => i.exercise.id === exercises.back_squat)!;
				expect(squat.bestE1rm!.value).toBeLessThan(m3!.bestE1rm!.value);
			});
		}
	);

	it.each(PERIODS)(
		"gives get_exercise_history the exercise detail's e1RM trend and verdict at %s",
		async (period) => {
			await withRollback(async (db) => {
				const { owner, exercises } = await seedDataset(db);
				for (const key of ['back_squat', 'bench_press'] as const) {
					const id = exercises[key];
					const detail = await getExerciseAnalytics(db, owner, id, { period, today: TODAY });
					const out = await output<HistoryOut>(db, owner, 'get_exercise_history', {
						exercise: id,
						period
					});
					expect(out.e1rmTrend, `${key} ${period}`).toMatchObject({
						value: detail.e1rm.value?.value ?? null,
						comparison: detail.e1rm.comparison.words,
						verdict: detail.e1rm.trend.result.verdict,
						realTrend: callOf(detail.e1rm.trend),
						window: windowOf(detail.e1rm.trend.window),
						about: { metric: 'e1rm', kind: 'estimated' }
					});
				}
				// The steady squat is a real rise; the noisy bench is normal variation.
				const verdict = async (key: 'back_squat' | 'bench_press') =>
					(
						await output<HistoryOut>(db, owner, 'get_exercise_history', {
							exercise: exercises[key],
							period
						})
					).e1rmTrend.verdict;
				expect(await verdict('back_squat')).toBe('real_trend');
				expect(await verdict('bench_press')).toBe('normal_variation');
			});
		}
	);

	it('gives insufficient data on thin data, and another owner reads nothing of the owner’s', async () => {
		await withRollback(async (db) => {
			const { owner, other, exercises, workouts } = await seedDataset(db);
			// The second owner logged one workout, a run and a note, all in week 5.
			expect(await output(db, other, 'get_training_load')).toMatchObject({
				status: 'insufficient_data',
				reason: 'no_training'
			});
			expect(await output(db, other, 'get_performance_trends', { weeks: 4 })).toMatchObject({
				status: 'insufficient_data',
				reason: 'no_training'
			});
			// Over 26 weeks their one week of training is judged as their General view judges it.
			const sparse = await output<TrendsOut>(db, other, 'get_performance_trends', { weeks: 26 });
			const theirView = await getGeneralDashboard(db, other, { period: '26w', today: TODAY });
			expect(sparse.trends.find((t) => t.metric === 'sessions')!.change.verdict).toBe(
				theirView.figures.sessions.trend.result.verdict
			);
			expect(
				await output(db, other, 'get_weekly_training_summary', { week: weekOf(16) })
			).toMatchObject({ status: 'insufficient_data', reason: 'no_training' });
			const theirSquat = await output<HistoryOut>(db, other, 'get_exercise_history', {
				exercise: exercises.back_squat
			});
			expect(theirSquat.e1rmTrend).toMatchObject({ value: null, verdict: 'insufficient_data' });

			// Their records are their own 300 kg squat, never the owner's sets, and the reverse.
			const theirs = await output<RecordsOut>(db, other, 'get_personal_records');
			const ours = await output<RecordsOut>(db, owner, 'get_personal_records', {
				exercise: exercises.back_squat
			});
			const ownerSets = new Set(
				(
					await db.execute<{ id: string }>(
						sql`select id::text as id from set_records where owner_id = ${owner}`
					)
				).rows.map((r) => r.id)
			);
			const cited = (records: RecordsOut) =>
				records.items.flatMap((i) => [
					...(i.bestE1rm?.sources ?? []),
					...i.repMaxes.map((r) => r.source),
					...i.prs.map((pr) => pr.source)
				]);
			expect(theirs.items.map((i) => i.exercise.id)).toEqual([exercises.back_squat]);
			expect(theirs.items[0]!.repMaxes).toEqual([
				expect.objectContaining({ reps: 5, weightKg: 300 })
			]);
			for (const ref of cited(theirs)) expect(ownerSets.has(ref.id)).toBe(false);
			const theirWorkouts = new Set(workouts.other);
			for (const ref of cited(ours)) {
				expect(ownerSets.has(ref.id) || ref.type === 'workout').toBe(true);
				expect(theirWorkouts.has(ref.id)).toBe(false);
			}
			expect(ours.items[0]!.repMaxes.every((r) => r.weightKg < 300)).toBe(true);
		});
	});
});
