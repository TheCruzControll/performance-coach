/**
 * The coach's analytics (PRD §4, §10; the M5 brief's analytics tools): a week's training summary,
 * the training load with its acute:chronic ratio, and performance trends over complete weeks.
 * The get_weekly_training_summary, get_training_load and get_performance_trends tools return
 * them, and the coaching memory reads the trends.
 *
 * - One engine (M6): every figure is read from the dashboards Progress shows (getGeneralDashboard,
 *   getRunningDashboard, getStrengthDashboard), so the coach and the screens never disagree. This
 *   file only picks the week, the ratio or the weeks asked for, and cites the records behind them
 *   from the same counted facts (services/analytics/facts.ts).
 * - Each figure has its value, its unit, how code computed it (method, in words an answer's
 *   `[metric method=…]` repeats), the records it rests on (sources: its period's date first, then
 *   at most SOURCES_MAX records, newest first) and the catalogue's context (about: metric id,
 *   kind, definition and caveat, as the tiles show them). Each result names the dashboard it
 *   comes from, and each trend carries the dashboard's verdict and the weeks it read.
 * - Too little data is a result, never a zero: insufficient_data says what is missing.
 * - Only completed, undeleted workouts count, for every figure (the facts loader's rule).
 * - Dates are explicit, on the owner's calendar: callers pass today (ownerToday). Trends read
 *   complete weeks only, so a Wednesday never looks like a decline.
 * - The services are awaited one at a time, so a caller may pass a transaction.
 */
import { outcomeOf } from '../../../domain/analytics/adherence';
import { METRICS, type MetricId } from '../../../domain/analytics/metrics';
import type { MetricTrend } from '../../../domain/analytics/overview';
import {
	DEFAULT_PERIOD,
	periodWindow,
	type Period,
	type TrendWindow
} from '../../../domain/analytics/periods';
import {
	classifyTrend,
	TREND_METHOD,
	type TrendResult,
	type TrendVerdict
} from '../../../domain/analytics/trend';
import type { AvailabilityUnit, MetricKind, SeriesPoint } from '../../../domain/analytics/types';
import {
	ACUTE_DAYS,
	ACWR_CAVEAT as M6_ACWR_CAVEAT,
	CHRONIC_DAYS,
	sessionLoads,
	type AcwrZone
} from '../../../domain/analytics/workload';
import {
	addDays,
	daysBetween,
	mondayOf,
	parseIsoDate,
	type IsoDate
} from '../../../domain/calendar';
import type { SourceRef } from '../../../domain/coach/sources';
import {
	SERIES_CHANGE_METHOD,
	seriesChange,
	CHANGE_MIN_POINTS,
	type SeriesChange
} from '../../../domain/coach/trends';
import { HARD_SET_CREDIT, HARD_SET_MIN_RPE } from '../../../domain/training/metrics';
import type { MuscleGroup } from '../../../domain/training/vocabulary';
import { fromMetres, roundToIncrement } from '../../../domain/units';
import { getAthleteProfile } from '../profile/index';
import type { LoggedSession, WeeklyMileage } from '../training/history';
import { resolveDeps, TrainingInputError, type TrainingDeps } from '../training/shared';
import { createFactsLoader } from './facts';
import { ACWR_WINDOW_DAYS, getGeneralDashboard } from './general';
import { getRunningDashboard } from './running';
import { getStrengthDashboard } from './strength';

export { ACUTE_DAYS, CHRONIC_DAYS };

/** The most records a figure cites after its period's date, newest first. */
export const SOURCES_MAX = 8;
/** The days a training load reads, ending today: the General view's ratio window. */
export const LOAD_WINDOW_DAYS = ACWR_WINDOW_DAYS;
/** The complete weeks a trend reads unless asked otherwise, and the fewest and most it may. */
export const TREND_WEEKS = 8;
export const MIN_TREND_WEEKS = CHANGE_MIN_POINTS;
export const MAX_TREND_WEEKS = 26;

/**
 * Decision: the dashboard period a trend of n weeks takes its figures and verdict from, the
 * shortest that holds the n weeks. Each verdict reads that period's trend window (12 weeks for
 * 4w and 12w, 26 for 26w) and names it, as Progress's tiles do. An owner's choice: change it here.
 */
export const TREND_PERIODS: readonly (readonly [Period, number])[] = [
	['4w', 4],
	['12w', 12],
	['26w', MAX_TREND_WEEKS]
];
/** Decision: the period whose General view the load is read from; today's ratio is the same in each. */
export const LOAD_PERIOD: Period = '4w';

/** Shown with every ratio (PRD §10): what it can and cannot say, in M6's words. */
export const ACWR_CAVEAT = M6_ACWR_CAVEAT.text;

export type DashboardView = 'general' | 'running' | 'strength';

/** Where the owner sees a figure on Progress: the view and the period it was read for. */
export const dashboardPath = (view: DashboardView, period: Period) =>
	`/progress?view=${view}&period=${period}`;

/** A figure's context in the metric catalogue (metrics.ts), as Progress's tiles show it. */
export interface About {
	metric: MetricId;
	kind: MetricKind;
	/** The catalogue's method sentence. */
	definition: string;
	/** Only for a metric that has one (the ratio, an e1RM). */
	caveat?: string;
}

/** A number code computed, as a tool returns it and an answer's metric block cites it. */
export interface Figure {
	value: number;
	unit: string | null;
	method: string;
	sources: SourceRef[];
	about: About;
}

/** Hard sets per muscle group: one figure, a value for each group trained. */
export type GroupFigure = Omit<Figure, 'value'> & { values: Partial<Record<MuscleGroup, number>> };

export interface InsufficientData {
	status: 'insufficient_data';
	reason: 'no_training' | 'too_little_history' | 'no_rated_sessions';
	have: number;
	need: number;
	unit: AvailabilityUnit;
}

export interface WeeklyTrainingSummary {
	status: 'ok';
	/** Monday to Sunday; through is today while the week is in progress. */
	week: { from: IsoDate; to: IsoDate; inProgress: boolean; through: IsoDate };
	planned: Figure;
	completed: Figure;
	skipped: Figure;
	workouts: Figure;
	minutes: Figure;
	sessionLoad: Figure;
	unrated: Figure;
	runningDistance: Figure;
	hardSets: GroupFigure;
	dashboard: string;
}

export interface TrainingLoad {
	status: 'ok';
	/** The days the moving averages read: from the later of the first activity and the window's start. */
	from: IsoDate;
	to: IsoDate;
	days: number;
	acute: Figure;
	chronic: Figure;
	ratio: Figure;
	/** The ratio against the caveat's rules of thumb. */
	zone: AcwrZone | null;
	last7Days: Figure;
	unrated: Figure;
	caveat: string;
	dashboard: string;
}

export type TrendMetric = 'sessions' | 'minutes' | 'session_load' | 'running_distance';

/** The catalogue metric each trend is. */
const TREND_METRIC_ID = {
	sessions: 'sessions',
	minutes: 'training_time',
	session_load: 'srpe_load',
	running_distance: 'mileage'
} as const satisfies Record<TrendMetric, MetricId>;

/** A verdict on a trend (classifyTrend), with the weeks it read. */
export interface TrendCall {
	verdict: TrendVerdict;
	/** A real trend's way, and whether it is the metric's better way (null: neither is); else null. */
	realTrend: { direction: 'up' | 'down'; good: boolean | null } | null;
	window: { from: IsoDate; to: IsoDate; label: string } | null;
	classifier: typeof TREND_METHOD;
}

/**
 * A trend: its verdict is change.verdict, over the weeks its result names (window), and every
 * trend of a result shares that window and classifier, so they are said once, not per trend.
 */
export type Trend = Omit<Figure, 'value'> &
	Pick<TrendCall, 'realTrend'> & {
		metric: TrendMetric;
		/** One per complete week, oldest first; a week with nothing logged is 0. */
		points: SeriesPoint[];
		change: SeriesChange;
		changeMethod: string;
	};

export interface PerformanceTrends extends Pick<TrendCall, 'window' | 'classifier'> {
	status: 'ok';
	/** The complete weeks read: from the first with anything logged, to last Sunday. */
	weeks: { from: IsoDate; to: IsoDate; count: number };
	/** Only what was trained: a trend no record contributes to is left out. */
	trends: Trend[];
	dashboard: string;
}

const METHOD = {
	planned: 'sessions your programs plan this week, skipped ones left out',
	completed: 'planned sessions with a completed workout logged against them',
	skipped: 'planned sessions marked skipped',
	workouts: 'completed workouts, planned or not',
	minutes: 'sum of the durations of completed workouts',
	sessionLoad: 'sRPE load: minutes × session RPE of each completed workout (Foster), summed',
	unrated: 'completed workouts with no session RPE or duration, so no load',
	runningDistance: 'sum of the distances of completed runs, in your distance unit',
	hardSets:
		`working sets at RPE ${HARD_SET_MIN_RPE}+ or with no RPE: ${HARD_SET_CREDIT.primary} per ` +
		`primary muscle group, ${HARD_SET_CREDIT.secondary} per secondary`,
	acute: `exponentially weighted average of daily sRPE load over ${ACUTE_DAYS} days (Williams 2017)`,
	chronic: `exponentially weighted average of daily sRPE load over ${CHRONIC_DAYS} days (Williams 2017)`,
	ratio: `acute ÷ chronic load (${ACUTE_DAYS}- and ${CHRONIC_DAYS}-day weighted averages); a rough guide`,
	last7Days: `sum of the sRPE load of completed workouts in the last ${ACUTE_DAYS} days`,
	trend: {
		sessions: 'completed workouts per week',
		minutes: 'minutes of completed workouts per week',
		session_load: 'sRPE load (minutes × session RPE) of completed workouts per week',
		running_distance: 'distance of completed runs per week, in your distance unit'
	} satisfies Record<TrendMetric, string>
};

const isDate = (value: unknown): value is IsoDate =>
	typeof value === 'string' && parseIsoDate(value) !== null;

function checkToday(today: unknown): IsoDate {
	if (!isDate(today)) throw new TrainingInputError({ today: 'Not a calendar date (YYYY-MM-DD)' });
	return today;
}

const insufficient = (
	reason: InsufficientData['reason'],
	have: number,
	need: number,
	unit: AvailabilityUnit
): InsufficientData => ({ status: 'insufficient_data', reason, have, need, unit });

const noTraining = () => insufficient('no_training', 0, 1, 'sessions');

const round = (value: number, step: number) => roundToIncrement(value, step) + 0;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const completed = (logged: readonly LoggedSession[]) =>
	logged.filter((workout) => workout.status === 'completed');
const rated = (workouts: readonly LoggedSession[]) => workouts.filter((w) => w.load !== null);
const minutesOf = (workouts: readonly LoggedSession[]) =>
	sum(workouts.map((w) => (w.durationSeconds ?? 0) / 60));
const loadOf = (workouts: readonly LoggedSession[]) => sum(workouts.map((w) => w.load ?? 0));

/** A catalogue metric's context, as a figure carries it. */
export const metricAbout = (id: MetricId): About => {
	const { kind, method, caveat } = METRICS[id];
	return { metric: id, kind, definition: method, ...(caveat !== null && { caveat }) };
};

type Recorded = { id: string; title: string; date: IsoDate };

const dateRef = (date: IsoDate, label: string): SourceRef => ({
	type: 'date',
	id: date,
	label,
	date
});
const workoutRef = (w: Recorded): SourceRef => ({
	type: 'workout',
	id: w.id,
	label: w.title,
	date: w.date
});

/** The period's date, then the newest SOURCES_MAX of `records` (given oldest first). */
const sourcesOf = (period: SourceRef, records: readonly SourceRef[]) => [
	period,
	...records.slice(-SOURCES_MAX).reverse()
];

function figure(
	id: MetricId,
	value: number,
	unit: string | null,
	step: number,
	method: string,
	period: SourceRef,
	records: readonly SourceRef[]
): Figure {
	const sources = sourcesOf(period, records);
	return { value: round(value, step), unit, method, sources, about: metricAbout(id) };
}

/** A verdict as a trend carries it: classifyTrend's call and the weeks it read. */
function callOf(result: TrendResult, window: TrendCall['window']): TrendCall {
	const real = result.verdict === 'real_trend';
	return {
		verdict: result.verdict,
		realTrend: real ? { direction: result.direction, good: result.good } : null,
		window,
		classifier: TREND_METHOD
	};
}

/** The weeks a dashboard's verdicts read, with the words its tiles show; null with none. */
const weeksOf = (window: TrendWindow): TrendCall['window'] =>
	window.weeks && { from: window.weeks.from, to: window.weeks.to, label: window.label };

/** A dashboard's verdict (MetricTrend) as a figure carries it, naming the weeks it read. */
export const trendCall = ({ result, window }: MetricTrend): TrendCall =>
	callOf(result, weeksOf(window));

/** The shortest period whose complete weeks, or week in progress, hold `monday`; else 'all'. */
function periodHolding(monday: IsoDate, today: IsoDate): Period {
	for (const period of ['4w', '12w', '26w', '52w'] as const) {
		const { weeks, inProgress } = periodWindow(today, period, null);
		if (monday === inProgress.weekStart || (weeks && monday >= weeks.from)) return period;
	}
	return 'all';
}

/**
 * The week from `week` (a Monday; today's week unless given) to its Sunday, as the General,
 * Running and Strength views give it for the shortest period that holds it. Insufficient data
 * when nothing was planned or logged. Refuses a week that has not begun.
 */
export async function getWeeklyTrainingSummary(
	ownerId: string,
	{ today, week }: { today: IsoDate; week?: IsoDate },
	deps: TrainingDeps = {}
): Promise<WeeklyTrainingSummary | InsufficientData> {
	const day = checkToday(today);
	const from = week ?? mondayOf(day);
	if (!isDate(from) || mondayOf(from) !== from) {
		throw new TrainingInputError({ week: 'A Monday: weeks run Monday to Sunday' });
	}
	if (from > mondayOf(day)) throw new TrainingInputError({ week: 'Not after this week' });
	const { db } = resolveDeps(deps);
	const to = addDays(from, 6);
	const inProgress = from === mondayOf(day);
	const period = periodHolding(from, day);
	const query = { period, today: day };
	type Dated = { weekStart: IsoDate };
	const pick = <W extends Dated, I extends Dated>(w: { weeks: readonly W[]; inProgress: I }) =>
		inProgress ? w.inProgress : w.weeks.find((each) => each.weekStart === from);

	const general = await getGeneralDashboard(db, ownerId, query);
	const adherence = pick(general.adherence);
	const count = pick(general.sessions);
	if (!adherence || !count || (adherence.planned === 0 && count.sessions === 0)) {
		return noTraining();
	}
	const time = pick(general.time)!;
	const load = pick(general.load)!;
	const mileage = pick((await getRunningDashboard(db, ownerId, query)).mileage)!;
	const strength = await getStrengthDashboard(db, ownerId, query);
	const groups = strength.muscleGroups.weeks.find((w) => w.weekStart === from)?.groups ?? [];

	// The records behind the figures, from the same counted facts.
	const { timeZone, distanceUnit } = await getAthleteProfile(ownerId, { db });
	const facts = createFactsLoader(db, ownerId, { from, to, timeZone });
	const sessions = (await facts.sessions()).filter((s) => s.date <= day);
	const plan = await facts.planned();
	const outcomes = plan.planned
		.filter((s) => s.date >= from && s.date <= to)
		.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
		.map((s) => ({ s, outcome: outcomeOf(s, plan.completed, day) }));
	const sessionsWhere = (keep: (outcome: string) => boolean) =>
		outcomes.flatMap(({ s, outcome }): SourceRef[] =>
			keep(outcome) ? [{ type: 'session', id: s.lineage, date: s.date }] : []
		);
	const unknown = new Set(load.unknown.map((u) => u.id));
	const workouts = sessions.map(workoutRef);
	const where = (keep: (s: (typeof sessions)[number]) => boolean) =>
		sessions.filter(keep).map(workoutRef);
	const weekRef = dateRef(from, `Week of ${from}`);
	const sessionFigure = (value: number, method: string, keep: (outcome: string) => boolean) =>
		figure('adherence', value, 'sessions', 1, method, weekRef, sessionsWhere(keep));
	return {
		status: 'ok',
		week: { from, to, inProgress, through: inProgress ? day : to },
		planned: sessionFigure(
			adherence.planned - adherence.skipped,
			METHOD.planned,
			(o) => o !== 'skipped'
		),
		completed: sessionFigure(adherence.completed, METHOD.completed, (o) => o === 'completed'),
		skipped: sessionFigure(adherence.skipped, METHOD.skipped, (o) => o === 'skipped'),
		workouts: figure('sessions', count.sessions, 'sessions', 1, METHOD.workouts, weekRef, workouts),
		minutes: figure(
			'training_time',
			(time.seconds ?? 0) / 60,
			'min',
			0.1,
			METHOD.minutes,
			weekRef,
			workouts
		),
		sessionLoad: figure(
			'srpe_load',
			load.load ?? 0,
			'AU',
			0.1,
			METHOD.sessionLoad,
			weekRef,
			where((s) => !unknown.has(s.id))
		),
		unrated: figure(
			'srpe_load',
			unknown.size,
			'sessions',
			1,
			METHOD.unrated,
			weekRef,
			where((s) => unknown.has(s.id))
		),
		runningDistance: figure(
			'mileage',
			fromMetres(mileage.distance.value, distanceUnit),
			distanceUnit,
			0.01,
			METHOD.runningDistance,
			weekRef,
			where((s) => s.run !== null)
		),
		hardSets: {
			values: Object.fromEntries(groups.flatMap((g) => (g.sets > 0 ? [[g.group, g.sets]] : []))),
			unit: 'hard sets',
			method: METHOD.hardSets,
			sources: sourcesOf(
				weekRef,
				where((s) => s.kind === 'strength')
			),
			about: metricAbout('group_sets')
		},
		dashboard: dashboardPath('general', period)
	};
}

/**
 * The acute and chronic loads and their ratio as of today: the General view's ratio (M6's acwr
 * over the daily sRPE loads of completed workouts, from the later of the first activity and
 * LOAD_WINDOW_DAYS days ago). Insufficient data with nothing completed in that window, under
 * CHRONIC_DAYS days of history, and with no known load at all.
 */
export async function getTrainingLoad(
	ownerId: string,
	{ today }: { today: IsoDate },
	deps: TrainingDeps = {}
): Promise<TrainingLoad | InsufficientData> {
	const to = checkToday(today);
	const { db } = resolveDeps(deps);
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const from = addDays(to, 1 - LOAD_WINDOW_DAYS);
	const facts = createFactsLoader(db, ownerId, { from, to, timeZone });
	const sessions = await facts.sessions();
	if (sessions.length === 0) return noTraining();
	const first = (await facts.firstActivity()) ?? sessions[0]!.date;
	const days = daysBetween(first > from ? first : from, to) + 1;
	if (days < CHRONIC_DAYS) return insufficient('too_little_history', days, CHRONIC_DAYS, 'days');
	const current = (await getGeneralDashboard(db, ownerId, { period: LOAD_PERIOD, today: to })).acwr
		.current;
	if (current?.ratio == null) return insufficient('no_rated_sessions', 0, 1, 'sessions');

	const period = dateRef(to, `As of ${to}`);
	const loads = sessionLoads(sessions, timeZone);
	const known = new Set(loads.flatMap((l) => (l.load === null ? [] : [l.id])));
	const recentLoads = loads.filter((l) => daysBetween(l.date, to) < ACUTE_DAYS);
	const all = sessions.filter((s) => known.has(s.id));
	const recent = all.filter((s) => daysBetween(s.date, to) < ACUTE_DAYS).map(workoutRef);
	const unrated = sessions.filter((s) => !known.has(s.id)).map(workoutRef);
	const acwr = (
		value: number,
		unit: string | null,
		step: number,
		method: string,
		refs: SourceRef[]
	) => figure('acwr', value, unit, step, method, period, refs);
	return {
		status: 'ok',
		from: current.from,
		to,
		days: current.days,
		acute: acwr(current.acute, 'AU/day', 0.1, METHOD.acute, recent),
		chronic: acwr(current.chronic, 'AU/day', 0.1, METHOD.chronic, all.map(workoutRef)),
		ratio: acwr(current.ratio, null, 0.01, METHOD.ratio, all.map(workoutRef)),
		zone: current.zone,
		last7Days: figure(
			'srpe_load',
			sum(recentLoads.map((l) => l.load ?? 0)),
			'AU',
			0.1,
			METHOD.last7Days,
			period,
			recent
		),
		unrated: figure('srpe_load', unrated.length, 'sessions', 1, METHOD.unrated, period, unrated),
		caveat: ACWR_CAVEAT,
		dashboard: dashboardPath('general', LOAD_PERIOD)
	};
}

/**
 * Weekly sessions, minutes, sRPE load and running distance over the last `weeks` complete weeks
 * (TREND_WEEKS by default), from the first week with anything logged, as the General and Running
 * views give them for the shortest period that holds those weeks (TREND_PERIODS), each with that
 * view's verdict over its trend window. Insufficient data when nothing was logged in them.
 */
export async function getPerformanceTrends(
	ownerId: string,
	{ today, weeks = TREND_WEEKS }: { today: IsoDate; weeks?: number },
	deps: TrainingDeps = {}
): Promise<PerformanceTrends | InsufficientData> {
	const day = checkToday(today);
	if (!Number.isInteger(weeks) || weeks < MIN_TREND_WEEKS || weeks > MAX_TREND_WEEKS) {
		throw new TrainingInputError({ weeks: `From ${MIN_TREND_WEEKS} to ${MAX_TREND_WEEKS}` });
	}
	const { db } = resolveDeps(deps);
	const to = addDays(mondayOf(day), -1);
	const { timeZone, distanceUnit } = await getAthleteProfile(ownerId, { db });
	const facts = createFactsLoader(db, ownerId, { from: addDays(to, 1 - 7 * weeks), to, timeZone });
	const logged = await facts.sessions();
	if (logged.length === 0) return noTraining();
	const from = mondayOf(logged[0]!.date);
	const count = (daysBetween(from, to) + 1) / 7;
	const period = TREND_PERIODS.find(([, n]) => n >= weeks)![0];
	const query = { period, today: day };
	const general = await getGeneralDashboard(db, ownerId, query);
	const runs = logged.filter((s) => s.run !== null);
	// No run, no running trend: the Running view is left unread.
	const running = runs.length ? await getRunningDashboard(db, ownerId, query) : null;

	const label = `${count} week${count === 1 ? '' : 's'} from ${from}`;
	const periodRef = dateRef(from, label);
	const known = new Set(
		sessionLoads(logged, timeZone).flatMap((l) => (l.load === null ? [] : [l.id]))
	);
	const trend = (
		metric: TrendMetric,
		unit: string,
		step: number,
		records: readonly Recorded[],
		{ series, trend: verdict }: { series: readonly SeriesPoint[]; trend: MetricTrend },
		scale: (value: number) => number = (value) => value
	): Trend[] => {
		if (records.length === 0) return [];
		const points = series
			.filter((p) => !p.inProgress && p.at >= from && p.at <= to)
			.map((p) => ({
				at: p.at,
				value: p.value === null ? null : round(scale(p.value), step),
				inProgress: false
			}));
		return [
			{
				metric,
				unit,
				method: METHOD.trend[metric],
				sources: sourcesOf(periodRef, records.map(workoutRef)),
				about: metricAbout(TREND_METRIC_ID[metric]),
				points,
				change: seriesChange(points, { trend: verdict.result }),
				changeMethod: SERIES_CHANGE_METHOD,
				realTrend: trendCall(verdict).realTrend
			}
		];
	};
	const { figures } = general;
	return {
		status: 'ok',
		weeks: { from, to, count },
		window: weeksOf(general.trendWindow),
		classifier: TREND_METHOD,
		trends: [
			...trend('sessions', 'sessions', 1, logged, figures.sessions),
			...trend('minutes', 'min', 0.1, logged, figures.training_time, (s) => s / 60),
			...trend(
				'session_load',
				'AU',
				0.1,
				logged.filter((s) => known.has(s.id)),
				figures.srpe_load
			),
			...(running
				? trend(
						'running_distance',
						distanceUnit,
						0.01,
						runs,
						{ series: running.mileage.points, trend: running.mileage.trend },
						(metres) => fromMetres(metres, distanceUnit)
					)
				: [])
		],
		dashboard: dashboardPath('general', period)
	};
}

/**
 * Performance trends from workouts already read: `logged` (by start, none after `to`, a Sunday)
 * and the weekly mileage of their weeks, or null for no running trend. Pure, so the coaching
 * memory states trends from the workouts it read already; each verdict is classifyTrend's over
 * the weeks given, with the catalogue metric's direction and minimal practical change.
 */
export function trendsOf(
	logged: readonly LoggedSession[],
	to: IsoDate,
	mileage: WeeklyMileage | null
): PerformanceTrends | InsufficientData {
	if (logged.length === 0) return noTraining();
	const from = mondayOf(logged[0]!.date);
	const count = (daysBetween(from, to) + 1) / 7;
	const runs = logged.filter((w) => w.kind === 'run');

	const mondays = Array.from({ length: count }, (_, n) => addDays(from, 7 * n));
	const label = `${count} week${count === 1 ? '' : 's'} from ${from}`;
	const period = dateRef(from, label);
	const trend = (
		metric: TrendMetric,
		unit: string,
		step: number,
		records: readonly LoggedSession[],
		valueOf: (week: IsoDate) => number
	): Trend[] => {
		if (records.length === 0) return [];
		const points = mondays.map((at) => ({
			at,
			value: round(valueOf(at), step),
			inProgress: false
		}));
		const id = TREND_METRIC_ID[metric];
		const { direction, mpc } = METRICS[id];
		const result = classifyTrend(points, { direction, mpc });
		return [
			{
				metric,
				unit,
				method: METHOD.trend[metric],
				sources: sourcesOf(period, records.map(workoutRef)),
				about: metricAbout(id),
				points,
				change: seriesChange(points, { trend: result }),
				changeMethod: SERIES_CHANGE_METHOD,
				realTrend: callOf(result, null).realTrend
			}
		];
	};
	const done = completed(logged);
	const weekOf = (rows: readonly LoggedSession[], at: IsoDate) =>
		rows.filter((w) => mondayOf(w.date) === at);
	return {
		status: 'ok',
		weeks: { from, to, count },
		window: { from, to, label: `Trend over ${label}` },
		classifier: TREND_METHOD,
		trends: [
			...trend('sessions', 'sessions', 1, done, (at) => weekOf(done, at).length),
			...trend('minutes', 'min', 0.1, done, (at) => minutesOf(weekOf(done, at))),
			...trend('session_load', 'AU', 0.1, rated(done), (at) => loadOf(weekOf(done, at))),
			...(mileage
				? trend(
						'running_distance',
						mileage.unit,
						0.01,
						runs,
						(at) => mileage.weeks.find((w) => w.weekStart === at)?.distance ?? 0
					)
				: [])
		],
		dashboard: dashboardPath('general', DEFAULT_PERIOD)
	};
}
