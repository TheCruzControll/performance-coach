/**
 * The coach's analytics services on real Postgres (src/lib/server/services/analytics/index.ts):
 * a week's training summary, the training load with its acute:chronic ratio, and performance
 * trends over complete weeks, each figure with its method and the records it rests on.
 * - Expected values are worked out by hand from the logged rows (each comment shows the sum);
 *   the ACWR from the closed form of M1's moving averages for a step from 200 to 400 AU a day.
 * - Too little data is insufficient_data, never a zero, and another owner reads nothing.
 * - Since M6's coach-analytics-repoint the figures are the dashboards' (one engine): each also
 *   carries its catalogue context (about) and its Progress view (dashboard), every load counts a
 *   class's own RPE when the session has none (M6's sessionLoads), and the ratio reads from the
 *   later of the first activity and 56 days ago, as the General view does.
 * - The services run inside the test's transaction, so the integration setup proves they send
 *   one query at a time.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { METHOD_MAX } from '../../../src/lib/domain/coach/answer';
import type { SourceRef } from '../../../src/lib/domain/coach/sources';
import { TREND_METHOD } from '../../../src/lib/domain/analytics/trend';
import { SERIES_CHANGE_METHOD } from '../../../src/lib/domain/coach/trends';
import type { Executor } from '../../../src/lib/server/db';
import {
	ACWR_CAVEAT,
	dashboardPath,
	getPerformanceTrends,
	getTrainingLoad,
	getWeeklyTrainingSummary,
	metricAbout,
	SOURCES_MAX
} from '../../../src/lib/server/services/analytics/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import { TrainingInputError } from '../../../src/lib/server/services/training/shared';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';
import { exerciseIds, logOther, logRun, logStrength, utc } from '../training/fixtures/history';

/** A Wednesday: its week (Monday 9 November) is in progress. */
const TODAY = '2026-11-11';
const WEEK = '2026-11-09';

const dateRef = (date: string, label: string): SourceRef => ({
	type: 'date',
	id: date,
	label,
	date
});
const weekRef = (monday: string) => dateRef(monday, `Week of ${monday}`);
const workoutRef = (id: string, label: string, date: string): SourceRef => ({
	type: 'workout',
	id,
	label,
	date
});

/** The field errors a call was refused with (fails the test unless it was a TrainingInputError). */
async function inputErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!(error instanceof TrainingInputError)) throw new Error(`expected a TrainingInputError`);
	return error.errors;
}

/** Every object in `value` that carries a method: the figures and trends of a result. */
function methodsOf(value: unknown): { method: unknown; sources: unknown }[] {
	if (Array.isArray(value)) return value.flatMap(methodsOf);
	if (!value || typeof value !== 'object') return [];
	const own = 'method' in value ? [value as { method: unknown; sources: unknown }] : [];
	return [...own, ...Object.values(value).flatMap(methodsOf)];
}

describe('getWeeklyTrainingSummary', () => {
	/** The hybrid plan from WEEK, its Thursday class skipped, with a week of logging. */
	async function seedWeek(db: Executor, owner: string) {
		const { back_squat } = await exerciseIds(db, ['back_squat']);
		const plan = programFixture('hybrid', { monday: WEEK, today: TODAY });
		const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
		const v1 = await getProgramVersion(owner, programId, 1, { db });
		const [monday, tuesday, wednesday, thursdayRun, thursdayClass] =
			v1.blocks[0]!.weeks[0]!.sessions;
		await skipSession(
			owner,
			{ sessionLineage: thursdayClass!.lineage },
			{ version: 1, today: TODAY },
			{ db }
		);
		const planned = (s: typeof monday) => ({ sessionId: s!.id, lineageId: s!.lineage, programId });
		const working = { exercise: back_squat, weight: 100, reps: 5, rpe: 8 };
		// 50 min at RPE 8: 400 AU. Three hard sets of back squat; the warm-up and the RPE 6 set are not.
		const strength = await logStrength(
			db,
			owner,
			{
				startedAt: utc(WEEK, '07:00'),
				title: 'Full body',
				planned: planned(monday),
				durationSeconds: 3000,
				sessionRpe: 8
			},
			[
				{ exercise: back_squat, weight: 60, reps: 5, warmup: true },
				working,
				working,
				working,
				{ exercise: back_squat, weight: 80, reps: 5, rpe: 6 }
			]
		);
		// 60 min at RPE 7: 420 AU.
		const muayThai = await logOther(db, owner, {
			startedAt: utc('2026-11-10', '19:00'),
			title: 'Muay Thai class',
			planned: planned(tuesday),
			durationSeconds: 3600,
			sessionRpe: 7
		});
		// Off the plan, 30 min and 5 km, with no session RPE: no load.
		const easyRun = await logRun(db, owner, {
			startedAt: utc('2026-11-10', '07:00'),
			title: 'Easy run',
			durationSeconds: 1800,
			sessionRpe: null,
			metres: 5000
		});
		// Neither an abandoned session nor a deleted run is training done.
		await logOther(db, owner, {
			startedAt: utc(TODAY, '08:00'),
			title: 'Mobility',
			kind: 'mobility',
			status: 'abandoned'
		});
		await logRun(db, owner, { startedAt: utc(TODAY, '06:00'), metres: 6000, deleted: true });
		// Last week: 40 min at RPE 6 (240 AU) and 8 km.
		const longRun = await logRun(db, owner, {
			startedAt: utc('2026-11-08', '09:00'),
			title: 'Long run',
			durationSeconds: 2400,
			sessionRpe: 6,
			metres: 8000
		});
		const session = (s: typeof monday): SourceRef => ({
			type: 'session',
			id: s!.lineage,
			date: s!.date
		});
		return {
			sessions: { monday, tuesday, wednesday, thursdayRun, thursdayClass },
			session,
			strength: workoutRef(strength.workoutId, 'Full body', WEEK),
			muayThai: workoutRef(muayThai, 'Muay Thai class', '2026-11-10'),
			easyRun: workoutRef(easyRun, 'Easy run', '2026-11-10'),
			longRun: workoutRef(longRun, 'Long run', '2026-11-08')
		};
	}

	it('sums the week in progress from the plan and the log, each figure with its sources', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { sessions: s, session, strength, muayThai, easyRun } = await seedWeek(db, owner);
			const week = weekRef(WEEK);
			const done = [week, muayThai, easyRun, strength];
			const any = expect.any(String);

			const summary = await getWeeklyTrainingSummary(owner, { today: TODAY }, { db });
			expect(summary).toEqual({
				status: 'ok',
				week: { from: WEEK, to: '2026-11-15', inProgress: true, through: TODAY },
				// Five planned, the Thursday class skipped: newest first after the week itself.
				planned: {
					value: 4,
					unit: 'sessions',
					method: any,
					about: metricAbout('adherence'),
					sources: [
						week,
						session(s.thursdayRun),
						session(s.wednesday),
						session(s.tuesday),
						session(s.monday)
					]
				},
				completed: {
					value: 2,
					unit: 'sessions',
					method: any,
					about: metricAbout('adherence'),
					sources: [week, session(s.tuesday), session(s.monday)]
				},
				skipped: {
					value: 1,
					unit: 'sessions',
					method: any,
					about: metricAbout('adherence'),
					sources: [week, session(s.thursdayClass)]
				},
				workouts: {
					...{ value: 3, unit: 'sessions', method: any, sources: done },
					about: metricAbout('sessions')
				},
				// 50 + 60 + 30.
				minutes: {
					...{ value: 140, unit: 'min', method: any, sources: done },
					about: metricAbout('training_time')
				},
				// 400 + 420; the easy run has no RPE.
				sessionLoad: {
					...{ value: 820, unit: 'AU', method: any, sources: [week, muayThai, strength] },
					about: metricAbout('srpe_load')
				},
				unrated: {
					...{ value: 1, unit: 'sessions', method: any, sources: [week, easyRun] },
					about: metricAbout('srpe_load')
				},
				runningDistance: {
					...{ value: 5, unit: 'km', method: any, sources: [week, easyRun] },
					about: metricAbout('mileage')
				},
				// Back squat: quads and glutes (hips) primary, adductors (hips) and lower back secondary.
				hardSets: {
					values: { quads: 3, hips: 3, back: 1.5 },
					unit: 'hard sets',
					method: any,
					sources: [week, strength],
					about: metricAbout('group_sets')
				},
				dashboard: dashboardPath('general', '4w'),
				// Not reviewed yet.
				review: null
			});
			expect(await getWeeklyTrainingSummary(owner, { today: TODAY, week: WEEK }, { db })).toEqual(
				summary
			);
		});
	});

	it('reads a complete past week through its Sunday, with nothing planned', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { longRun } = await seedWeek(db, owner);
			const week = weekRef('2026-11-02');
			const summary = await getWeeklyTrainingSummary(
				owner,
				{ today: TODAY, week: '2026-11-02' },
				{ db }
			);
			expect(summary).toMatchObject({
				status: 'ok',
				week: { from: '2026-11-02', to: '2026-11-08', inProgress: false, through: '2026-11-08' },
				planned: { value: 0, sources: [week] },
				completed: { value: 0, sources: [week] },
				workouts: { value: 1, sources: [week, longRun] },
				minutes: { value: 40 },
				sessionLoad: { value: 240, sources: [week, longRun] },
				unrated: { value: 0, sources: [week] },
				runningDistance: { value: 8, unit: 'km', sources: [week, longRun] },
				hardSets: { values: {}, sources: [week] }
			});
		});
	});

	it('gives insufficient data for a week with nothing planned or logged, and to another owner', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seedWeek(db, owner);
			const nothing = { status: 'insufficient_data', reason: 'no_training', have: 0, need: 1 };
			expect(
				await getWeeklyTrainingSummary(owner, { today: TODAY, week: '2026-10-26' }, { db })
			).toEqual({ ...nothing, unit: 'sessions' });
			expect(
				await getWeeklyTrainingSummary(await makeSecondOwner(db), { today: TODAY }, { db })
			).toEqual({ ...nothing, unit: 'sessions' });
		});
	});

	it('refuses a week that is not a Monday or has not begun, and a malformed today', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const summary = (input: { today: string; week?: string }) =>
				inputErrors(getWeeklyTrainingSummary(owner, input, { db }));
			expect(await summary({ today: TODAY, week: '2026-11-10' })).toEqual({
				week: 'A Monday: weeks run Monday to Sunday'
			});
			expect(await summary({ today: TODAY, week: '2026-11-16' })).toEqual({
				week: 'Not after this week'
			});
			expect(await summary({ today: '2026-02-30' })).toEqual({
				today: 'Not a calendar date (YYYY-MM-DD)'
			});
		});
	});
});

describe('getTrainingLoad', () => {
	const FIRST = '2026-10-15'; // 28 days to TODAY, both included

	/** 21 days at 200 AU (40 min at RPE 5), then 7 days at 400 AU (RPE 10), to today. */
	async function seedLoad(
		db: Executor,
		owner: string,
		rpe: (day: number) => number | null = (day) => (day < 21 ? 5 : 10)
	) {
		const ids: string[] = [];
		// Strength sessions: a class's own RPE would rate a session with none (M6's sessionLoads).
		for (let day = 0; day < 28; day += 1) {
			const spec = {
				startedAt: utc(addDays(FIRST, day), '18:00'),
				title: `Session ${day + 1}`,
				durationSeconds: 2400,
				sessionRpe: rpe(day)
			};
			ids.push((await logStrength(db, owner, spec, [])).workoutId);
		}
		return ids.map((id, day) => workoutRef(id, `Session ${day + 1}`, addDays(FIRST, day)));
	}

	it("is M1's moving averages over the daily sRPE loads, with the ratio's caveat", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const sessions = await seedLoad(db, owner);
			const { workoutId: unrated } = await logStrength(
				db,
				owner,
				{ startedAt: utc('2026-11-10', '07:00'), title: 'Open mat', sessionRpe: null },
				[]
			);
			await logOther(db, owner, {
				startedAt: utc('2026-11-09', '07:00'),
				title: 'Sparring',
				status: 'abandoned',
				sessionRpe: 9
			});

			// Both averages start at 200 and hold it for 21 days; 7 days at 400 then close a share
			// of the gap: (1 − 2 / (7 + 1))^7 of it stays for the acute, (1 − 2 / (28 + 1))^7 for the
			// chronic.
			const acute = 400 - 200 * 0.75 ** 7;
			const chronic = 400 - 200 * (27 / 29) ** 7;
			expect([acute, chronic, acute / chronic]).toEqual([
				expect.closeTo(373.3, 1),
				expect.closeTo(278.72, 2),
				expect.closeTo(1.339, 3)
			]);
			const asOf = dateRef(TODAY, `As of ${TODAY}`);
			const newest = (n: number) => [asOf, ...sessions.slice(-n).reverse()];
			const any = expect.any(String);
			expect(await getTrainingLoad(owner, { today: TODAY }, { db })).toEqual({
				status: 'ok',
				from: FIRST,
				to: TODAY,
				days: 28,
				acute: {
					...{ value: 373.3, unit: 'AU/day', method: any, sources: newest(7) },
					about: metricAbout('acwr')
				},
				chronic: {
					...{ value: 278.7, unit: 'AU/day', method: any, sources: newest(SOURCES_MAX) },
					about: metricAbout('acwr')
				},
				ratio: {
					...{ value: 1.34, unit: null, method: any, sources: newest(SOURCES_MAX) },
					about: metricAbout('acwr')
				},
				zone: 'raised',
				// 7 × 400.
				last7Days: {
					...{ value: 2800, unit: 'AU', method: any, sources: newest(7) },
					about: metricAbout('srpe_load')
				},
				unrated: {
					value: 1,
					unit: 'sessions',
					method: any,
					sources: [asOf, workoutRef(unrated, 'Open mat', '2026-11-10')],
					about: metricAbout('srpe_load')
				},
				caveat: ACWR_CAVEAT,
				dashboard: dashboardPath('general', '4w')
			});
		});
	});

	it('gives insufficient data before 28 days, without a rated session and to another owner', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const load = (who = owner) => getTrainingLoad(who, { today: TODAY }, { db });
			expect(await load()).toEqual({
				status: 'insufficient_data',
				reason: 'no_training',
				have: 0,
				need: 1,
				unit: 'sessions'
			});
			await logOther(db, owner, { startedAt: utc('2026-10-16', '18:00') });
			await logOther(db, owner, { startedAt: utc(TODAY, '18:00') });
			expect(await load()).toEqual({
				status: 'insufficient_data',
				reason: 'too_little_history',
				have: 27,
				need: 28,
				unit: 'days'
			});
		});
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seedLoad(db, owner, () => null);
			expect(await getTrainingLoad(owner, { today: TODAY }, { db })).toEqual({
				status: 'insufficient_data',
				reason: 'no_rated_sessions',
				have: 0,
				need: 1,
				unit: 'sessions'
			});
			expect(
				await getTrainingLoad(await makeSecondOwner(db), { today: TODAY }, { db })
			).toMatchObject({
				status: 'insufficient_data',
				reason: 'no_training'
			});
		});
	});
});

describe('getPerformanceTrends', () => {
	/** Five active weeks from 5 October, with nothing in the week of 19 October. */
	async function seedWeeks(db: Executor, owner: string) {
		// 50 min at RPE 6: 300 AU each.
		const lift = (date: string) =>
			logOther(db, owner, {
				startedAt: utc(date, '07:00'),
				title: `Lift ${date}`,
				durationSeconds: 3000,
				sessionRpe: 6
			});
		// 30 min with no RPE: a session and its minutes, but no load.
		const run = (date: string, metres: number) =>
			logRun(db, owner, {
				startedAt: utc(date, '07:00'),
				title: `Run ${date}`,
				durationSeconds: 1800,
				sessionRpe: null,
				metres
			});
		await lift('2026-09-01'); // before the 8 weeks
		const ids = {
			l1: await lift('2026-10-06'),
			l2: await lift('2026-10-13'),
			r1: await run('2026-10-15', 6000),
			l3: await lift('2026-10-27'),
			l4: await lift('2026-10-29'),
			l5: await lift('2026-11-03'),
			l6: await lift('2026-11-05'),
			r2: await run('2026-11-06', 4000)
		};
		await logOther(db, owner, { startedAt: utc('2026-10-20', '07:00'), status: 'abandoned' });
		await lift('2026-11-10'); // the week in progress
		const ref = (key: keyof typeof ids, date: string) =>
			workoutRef(ids[key], `${key.startsWith('r') ? 'Run' : 'Lift'} ${date}`, date);
		return {
			lifts: [
				ref('l6', '2026-11-05'),
				ref('l5', '2026-11-03'),
				ref('l4', '2026-10-29'),
				ref('l3', '2026-10-27'),
				ref('l2', '2026-10-13'),
				ref('l1', '2026-10-06')
			],
			runs: [ref('r2', '2026-11-06'), ref('r1', '2026-10-15')]
		};
	}

	const MONDAYS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
	const points = (values: number[], mondays = MONDAYS) =>
		values.map((value, n) => ({ at: mondays[n], value, inProgress: false }));

	it('follows each weekly total over the complete weeks since training began', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { lifts, runs } = await seedWeeks(db, owner);
			const period = dateRef('2026-10-05', '5 weeks from 2026-10-05');
			// Newest first: the lifts and runs interleave by date.
			const [l6, l5, l4, l3, l2, l1] = lifts;
			const [r2, r1] = runs;
			const all = [period, r2, l6, l5, l4, l3, r1, l2, l1];
			const change = (earlier: number, later: number, delta: number, pct: number) => ({
				enoughData: true,
				// The General and Running views' verdicts over their last 12 weeks.
				verdict: 'normal_variation',
				points: 5,
				from: '2026-10-05',
				to: '2026-11-02',
				earlier,
				later,
				delta,
				pct,
				direction: delta > 0 ? 'up' : 'down'
			});
			const any = expect.any(String);
			const judged = { realTrend: null };
			expect(await getPerformanceTrends(owner, { today: TODAY }, { db })).toEqual({
				status: 'ok',
				weeks: { from: '2026-10-05', to: '2026-11-08', count: 5 },
				window: { from: '2026-08-17', to: '2026-11-08', label: 'Trend over the last 12 weeks' },
				classifier: TREND_METHOD,
				dashboard: dashboardPath('general', '12w'),
				trends: [
					{
						metric: 'sessions',
						unit: 'sessions',
						method: any,
						sources: all,
						// 1, 1 + 1, 0, 2, 2 + 1 → (1 + 2) / 2 against (2 + 3) / 2.
						points: points([1, 2, 0, 2, 3]),
						change: change(1.5, 2.5, 1, 66.666667),
						changeMethod: SERIES_CHANGE_METHOD,
						about: metricAbout('sessions'),
						...judged
					},
					{
						metric: 'minutes',
						unit: 'min',
						method: any,
						sources: all,
						// 50, 50 + 30, 0, 100, 100 + 30.
						points: points([50, 80, 0, 100, 130]),
						change: change(65, 115, 50, 76.923077),
						changeMethod: SERIES_CHANGE_METHOD,
						about: metricAbout('training_time'),
						...judged
					},
					{
						metric: 'session_load',
						unit: 'AU',
						method: any,
						sources: [period, ...lifts],
						points: points([300, 300, 0, 600, 600]),
						change: change(300, 600, 300, 100),
						changeMethod: SERIES_CHANGE_METHOD,
						about: metricAbout('srpe_load'),
						...judged
					},
					{
						metric: 'running_distance',
						unit: 'km',
						method: any,
						sources: [period, r2, r1],
						points: points([0, 6, 0, 0, 4]),
						change: change(3, 2, -1, -33.333333),
						changeMethod: SERIES_CHANGE_METHOD,
						about: metricAbout('mileage'),
						...judged
					}
				]
			});
			const four = await getPerformanceTrends(owner, { today: TODAY, weeks: 4 }, { db });
			expect(four).toMatchObject({
				weeks: { from: '2026-10-12', to: '2026-11-08', count: 4 },
				trends: [
					{
						metric: 'sessions',
						points: points([2, 0, 2, 3], MONDAYS.slice(1)),
						change: { earlier: 1, later: 2.5, delta: 1.5, pct: 150, direction: 'up' }
					},
					{ metric: 'minutes' },
					{ metric: 'session_load' },
					{ metric: 'running_distance' }
				]
			});
		});
	});

	it('flags too few weeks for a change, and leaves out what was never trained', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logOther(db, owner, { startedAt: utc('2026-10-27', '07:00') });
			await logOther(db, owner, { startedAt: utc('2026-11-04', '07:00') });
			const trends = await getPerformanceTrends(owner, { today: TODAY }, { db });
			expect(trends).toMatchObject({
				status: 'ok',
				weeks: { from: '2026-10-26', to: '2026-11-08', count: 2 }
			});
			if (trends.status !== 'ok') throw new Error('expected trends');
			const few = { enoughData: false, points: 2, need: 4, verdict: 'insufficient_data' };
			expect(trends.trends.map((trend) => [trend.metric, trend.change])).toEqual([
				['sessions', few],
				['minutes', few],
				['session_load', few]
			]);
		});
	});

	it('gives insufficient data with nothing logged, also to another owner, and refuses odd windows', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const nothing = {
				status: 'insufficient_data',
				reason: 'no_training',
				have: 0,
				need: 1,
				unit: 'sessions'
			};
			expect(await getPerformanceTrends(owner, { today: TODAY }, { db })).toEqual(nothing);
			await seedWeeks(db, owner);
			expect(
				await getPerformanceTrends(await makeSecondOwner(db), { today: TODAY }, { db })
			).toEqual(nothing);
			for (const weeks of [3, 27, 4.5]) {
				expect(
					await inputErrors(getPerformanceTrends(owner, { today: TODAY, weeks }, { db }))
				).toEqual({ weeks: 'From 4 to 26' });
			}
		});
	});
});

describe('every figure', () => {
	it('says how it was computed, in words a metric block can carry, and cites a record', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			for (let day = 0; day < 35; day += 1) {
				await logRun(db, owner, {
					startedAt: utc(addDays('2026-10-07', day), '07:00'),
					durationSeconds: 1800,
					sessionRpe: day % 7 === 0 ? null : 6,
					metres: 5000
				});
			}
			const results = [
				await getWeeklyTrainingSummary(owner, { today: TODAY }, { db }),
				await getTrainingLoad(owner, { today: TODAY }, { db }),
				await getPerformanceTrends(owner, { today: TODAY }, { db })
			];
			expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
			const figures = methodsOf(results);
			expect(figures.length).toBeGreaterThan(15);
			for (const { method, sources } of figures) {
				expect(method).toEqual(expect.stringMatching(/^[^[\]]+$/));
				expect((method as string).length).toBeLessThanOrEqual(METHOD_MAX);
				expect((sources as SourceRef[]).length).toBeGreaterThan(0);
				expect((sources as SourceRef[]).length).toBeLessThanOrEqual(SOURCES_MAX + 1);
			}
		});
	});
});
