/**
 * The General dashboard (PRD §10): everything cross-discipline for a period in one call, whether
 * the plan was followed, how much load was carried and how recovery went.
 * - Sessions and training time by week and discipline, adherence by week (planned, completed,
 *   skipped, missed and off plan), weekly sRPE load by discipline with daily loads, monotony and
 *   strain, the acute:chronic ratio with its caveat, Muay Thai load, and recovery with the latest
 *   notes as untrusted text. Every definition is domain/analytics's (adherence.ts, workload.ts):
 *   this file only chooses the days and composes.
 * - Totals, averages, trends and comparisons cover the period's complete weeks (periods.ts). The
 *   week in progress is apart, counted so far, with a like-for-like line against the same days of
 *   last week. 'all' has no previous period.
 * - Each headline figure carries its metric id, kind, method, caveat, availability, its verdict
 *   over trendWindow(period) and its comparison, with display strings in the profile's units
 *   (format.ts). The ratio is shown as of each complete week's Sunday and today.
 * - Only completed, undeleted workouts count (the facts loader), and the facts are read one query
 *   at a time, so `db` may be a transaction.
 */
import {
	periodAdherence,
	trainingTime,
	weeklySessions,
	type PeriodAdherence,
	type SessionCount,
	type TrainingTime,
	type Weekly,
	type Weeks
} from '../../../domain/analytics/adherence';
import { METRICS, type MetricId } from '../../../domain/analytics/metrics';
import {
	kpi,
	soFarLine,
	trendOf,
	type Kpi,
	type MetricTrend,
	type SoFarLine
} from '../../../domain/analytics/overview';
import {
	periodWindow,
	sameDaysLastWeek,
	trendWindow,
	weekStarts,
	type Period,
	type PeriodWindow,
	type TrendWindow,
	type WeekRange
} from '../../../domain/analytics/periods';
import { averageOf, byMonth, soFar, type Timed } from '../../../domain/analytics/series';
import type { Availability, MetricKind, SeriesPoint } from '../../../domain/analytics/types';
import {
	ACWR_PLACEMENT,
	acwr,
	dailyLoads,
	muayThaiLoad,
	recoverySummary,
	sessionLoads,
	weeklyLoad,
	type AcuteChronic,
	type AcwrPlacement,
	type DailyLoad,
	type MuayThaiFigure,
	type PeriodLoad,
	type RecoveryMeasure,
	type RecoverySummary
} from '../../../domain/analytics/workload';
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import type { Executor } from '../../db/types';
import { getAthleteProfile } from '../profile/index';
import { factsSource, type DashboardDeps, type DatedSession } from './facts';
import { displayUnits, formatIn, type DisplayUnits } from './format';

/**
 * The most daily loads a ratio reads, ending on its day: two chronic windows, as the coach's
 * training load reads (M5). Fewer when the first activity is later: days before it would read as
 * rest never taken. An owner's choice: change it here.
 */
export const ACWR_WINDOW_DAYS = 56;

/** The figures the dashboard headlines, in the catalogue's order. */
export const GENERAL_METRICS = [
	'sessions',
	'training_time',
	'adherence',
	'srpe_load',
	'monotony',
	'strain',
	'muay_thai_load',
	'sleep',
	'soreness',
	'energy',
	'stress'
] as const satisfies readonly MetricId[];
export type GeneralMetric = (typeof GENERAL_METRICS)[number];

export interface GeneralQuery {
	period: Period;
	/** The owner's calendar day (ownerToday). */
	today: IsoDate;
}

/** A headline figure over the period's complete weeks, with everything a tile and the coach show. */
export interface GeneralFigure {
	metric: GeneralMetric;
	label: string;
	kind: MetricKind;
	method: string;
	caveat: string | null;
	/** The period's figure (a total, or a mean for ratios and recovery); null: no data. */
	value: number | null;
	shown: string | null;
	/** Weekly points (monthly once the period buckets by month), the week in progress last. */
	series: SeriesPoint[];
	comparison: Kpi;
	trend: MetricTrend;
	/** This week so far against the same days of last week; null for rates and means. */
	soFar: SoFarLine | null;
	availability: Availability;
}

export interface GeneralDashboard {
	period: Period;
	window: PeriodWindow;
	trendWindow: TrendWindow;
	/** As many complete weeks before the period; null for 'all'. */
	previous: WeekRange | null;
	units: DisplayUnits;
	sessions: Weekly<SessionCount>;
	time: Weekly<TrainingTime>;
	adherence: PeriodAdherence;
	load: PeriodLoad;
	/** Each day from the period's first day (or this week's Monday) through today. */
	daily: DailyLoad[];
	acwr: {
		/** As of today; null before CHRONIC_DAYS days of history. */
		current: AcuteChronic | null;
		/** The ratio as of each complete week's Sunday, then today (in progress). */
		series: SeriesPoint[];
		placement: AcwrPlacement;
	};
	muayThai: Weekly<MuayThaiFigure>;
	recovery: RecoverySummary;
	figures: Record<GeneralMetric, GeneralFigure>;
}

/** One figure's weekly points, the value over the weeks read, and what its minData counts. */
interface Reading {
	points: SeriesPoint[];
	value: number | null;
	have: number;
}

type Week = { weekStart: IsoDate };

/** A domain figure's complete weeks, its week in progress and its total, as one Reading. */
function reading<W extends Week, I extends Week, T>(
	weekly: { weeks: readonly W[]; inProgress: I; total: T },
	week: (w: W | I) => number | null,
	value: (total: T, points: SeriesPoint[]) => number | null,
	have: (total: T) => number
): Reading {
	const points = [
		...weekly.weeks.map((w) => ({ at: w.weekStart, value: week(w), inProgress: false })),
		{ at: weekly.inProgress.weekStart, value: week(weekly.inProgress), inProgress: true }
	];
	return { points, value: value(weekly.total, points), have: have(weekly.total) };
}

/** The earliest of some days. */
const earliest = (...days: IsoDate[]) => days.reduce((a, b) => (b < a ? b : a));

/**
 * The general dashboard for `period` on `today`. `deps.repository` replaces the analytics reads,
 * for a test to count them; `deps.facts` shares them with other services.
 */
export async function getGeneralDashboard(
	db: Executor,
	ownerId: string,
	{ period, today }: GeneralQuery,
	deps: DashboardDeps = {}
): Promise<GeneralDashboard> {
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const units = displayUnits(profile);
	const format = formatIn(units);
	const source = factsSource(db, ownerId, timeZone, deps);

	// The first activity sets 'all''s weeks, so it is read before the range is known.
	const first = await source(today, today).firstActivity();
	const window = periodWindow(today, period, first);
	const trend = trendWindow(window);
	const { inProgress } = window;
	// The complete weeks any figure reads, previous and trend weeks included, to last Sunday.
	const ranges = [window.weeks, window.previous, trend.weeks].flatMap((r) => (r ? [r] : []));
	const spanFrom = ranges.length ? earliest(...ranges.map((r) => r.from)) : null;
	const span: WeekRange | null =
		spanFrom === null
			? null
			: {
					from: spanFrom,
					to: addDays(inProgress.weekStart, -1),
					count: daysBetween(spanFrom, inProgress.weekStart) / 7
				};
	const ratioDays = [...weekStarts(window.weeks).map((monday) => addDays(monday, 6)), today];
	const from = earliest(
		span?.from ?? inProgress.weekStart,
		sameDaysLastWeek(inProgress).from,
		addDays(ratioDays[0]!, 1 - ACWR_WINDOW_DAYS)
	);
	// Read through Sunday so this week's later sessions and advance skips count as planned; what
	// was logged is kept to today.
	const to = addDays(inProgress.weekStart, 6);
	const facts = source(from, to);
	const sessions = (await facts.sessions()).filter((s) => s.date <= today);
	const planned = { ...(await facts.planned()), workouts: sessions };
	const notes = (await facts.recovery()).filter((n) => n.notedOn <= today);

	const loads = sessionLoads(sessions, timeZone);
	const at = (weeks: WeekRange | null): Weeks => ({ weeks, inProgress });
	const weeksTrained = first
		? Math.max(0, daysBetween(mondayOf(first), inProgress.weekStart) / 7)
		: 0;
	// Weeks before the first activity are no history: they stay out of every trend.
	const sinceFirst = (points: SeriesPoint[]) =>
		first ? points.filter((p) => p.at >= mondayOf(first)) : [];
	/** Every headline figure over `weeks`, each domain function run once. */
	const readingsOver = (weeks: WeekRange | null): Record<GeneralMetric, Reading> => {
		const w = at(weeks);
		const load = weeklyLoad(loads, w);
		const recovery = recoverySummary(notes, w);
		const trained = () => weeksTrained;
		const average = (_total: unknown, points: SeriesPoint[]) => averageOf(points);
		const means = (m: RecoveryMeasure) =>
			reading(
				recovery,
				(x) => x[m].mean,
				(t) => t[m].mean,
				(t) => t[m].count
			);
		const muayThai = muayThaiLoad(sessions, timeZone, w);
		return {
			sessions: reading(
				weeklySessions(sessions, w),
				(x) => x.sessions,
				(t) => t.sessions,
				trained
			),
			training_time: reading(
				trainingTime(sessions, w),
				(x) => x.seconds,
				(t) => t.seconds,
				trained
			),
			adherence: reading(
				periodAdherence(planned, w),
				(x) => x.pct,
				(t) => t.pct,
				trained
			),
			srpe_load: reading(
				load,
				(x) => x.load,
				(t) => t.load,
				(t) => t.sessions
			),
			monotony: reading(load, (x) => x.monotony, average, trained),
			strain: reading(load, (x) => x.strain, average, trained),
			muay_thai_load: reading(
				muayThai,
				(x) => x.load,
				(t) => t.load,
				(t) => t.sessions
			),
			sleep: means('sleepHours'),
			soreness: means('soreness'),
			energy: means('energy'),
			stress: means('stress')
		};
	};
	const current = readingsOver(window.weeks);
	const before = window.previous && readingsOver(window.previous);
	const spanned = readingsOver(span);

	// What 'this week so far' adds up, by when it happened.
	const timed = (keep: (s: DatedSession, n: number) => number | null): Timed[] =>
		sessions.flatMap((s, n) => {
			const value = keep(s, n);
			return value === null ? [] : [{ at: s.startedAt, value }];
		});
	const SO_FAR: Partial<Record<GeneralMetric, Timed[]>> = {
		sessions: timed(() => 1),
		training_time: timed((s) => s.durationSeconds),
		srpe_load: timed((_s, n) => loads[n]!.load),
		muay_thai_load: timed((_s, n) => (loads[n]!.group === 'combat' ? loads[n]!.load : null))
	};

	const figureOf = (id: GeneralMetric): GeneralFigure => {
		const metric = METRICS[id];
		const { value, points, have } = current[id];
		const so = SO_FAR[id];
		const { need, unit } = metric.minData;
		return {
			metric: id,
			label: metric.label,
			kind: metric.kind,
			method: metric.method,
			caveat: metric.caveat,
			value,
			shown: value === null ? null : format(metric, value, 'value'),
			series: window.bucket === 'month' ? byMonth(points) : points,
			comparison: kpi(
				id,
				{ value, weeks: window.weeks },
				before && { value: before[id].value, weeks: window.previous },
				format
			),
			trend: trendOf(id, sinceFirst(spanned[id].points), window),
			soFar: so
				? soFarLine(id, soFar(so, inProgress, { timeZone, direction: metric.direction }), format)
				: null,
			availability: have >= need ? { ready: true } : { ready: false, have, need, unit }
		};
	};

	// The ratio on a day: daily loads from the later of the window's start and the first activity.
	const startOf = (day: IsoDate, since: IsoDate) =>
		since > addDays(day, 1 - ACWR_WINDOW_DAYS) ? since : addDays(day, 1 - ACWR_WINDOW_DAYS);
	// Every day a ratio reads, worked out once: each ratio reads its own window of them.
	const lastRatioDay = ratioDays.at(-1)!;
	const ratioFrom = first && first <= lastRatioDay ? startOf(ratioDays[0]!, first) : null;
	const ratioLoads = ratioFrom ? dailyLoads(loads, ratioFrom, lastRatioDay) : [];
	const ratioOn = (day: IsoDate) => {
		if (!first || !ratioFrom || day < first) return null;
		const offset = (date: IsoDate) => daysBetween(ratioFrom, date);
		return acwr(ratioLoads.slice(offset(startOf(day, first)), offset(day) + 1));
	};
	const ratios = ratioDays.map((day) => ({ day, ratio: ratioOn(day) }));

	return {
		period,
		window,
		trendWindow: trend,
		previous: window.previous,
		units,
		sessions: weeklySessions(sessions, at(window.weeks)),
		time: trainingTime(sessions, at(window.weeks)),
		adherence: periodAdherence(planned, at(window.weeks)),
		load: weeklyLoad(loads, at(window.weeks)),
		daily: dailyLoads(loads, window.weeks?.from ?? inProgress.weekStart, today),
		acwr: {
			current: ratios.at(-1)!.ratio,
			series: ratios.map(({ day, ratio }) => ({
				at: mondayOf(day),
				value: ratio?.ratio ?? null,
				inProgress: day === today
			})),
			placement: ACWR_PLACEMENT
		},
		muayThai: muayThaiLoad(sessions, timeZone, at(window.weeks)),
		recovery: recoverySummary(notes, at(window.weeks)),
		figures: Object.fromEntries(GENERAL_METRICS.map((id) => [id, figureOf(id)])) as Record<
			GeneralMetric,
			GeneralFigure
		>
	};
}
