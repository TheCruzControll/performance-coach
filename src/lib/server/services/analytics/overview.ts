/**
 * 'Am I improving?' (PRD §10) in one call: the overview Progress opens on, composed from the
 * strength, running and general dashboards on one shared facts loader (sharedFacts), so the
 * database sees each kind read once per window however many services ask. Every number is a
 * dashboard's own; nothing is recomputed here.
 * - A verdict per discipline (disciplineVerdict) over trendWindow(period), always naming that
 *   window ('Trend over the last 12 weeks' at 4w), and the headline across them. A discipline
 *   with nothing logged in those weeks has none ('not enough data yet').
 * - KPI tiles (OVERVIEW_KPIS) over complete weeks against the previous period, with the week so
 *   far and a sparkline series. 'all' has no previous period.
 * - The headline series, each key lift's e1RM and the weekly load by discipline, by month once
 *   'all' spans more than MONTHLY_AFTER_WEEKS weeks (periods.ts), so a long history stays small.
 * - When each insight appears (SECTIONS), dated from the logged history, the plan and today, so a
 *   new owner sees the day PRs, e1RM lines, verdicts, the load ratio and the reviews arrive.
 * Reads run one at a time, so `db` may be a transaction.
 */
import {
	METRIC_AREAS,
	METRICS,
	type MetricArea,
	type MetricId
} from '../../../domain/analytics/metrics';
import {
	disciplineVerdict,
	headline,
	type DisciplineVerdict,
	type Evidence,
	type Kpi,
	type MetricTrend,
	type SoFarLine,
	type Verdict
} from '../../../domain/analytics/overview';
import {
	periodWindow,
	sameDaysLastWeek,
	trendWindow,
	type Period,
	type PeriodWindow,
	type TrendWindow
} from '../../../domain/analytics/periods';
import { byMonth } from '../../../domain/analytics/series';
import { e1rmSeries } from '../../../domain/analytics/strength';
import { TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS } from '../../../domain/analytics/trend';
import type { MetricKind, SeriesPoint } from '../../../domain/analytics/types';
import { CHRONIC_DAYS, LOAD_STACK, type LoadGroup } from '../../../domain/analytics/workload';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { AnalyticsRepository } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { getExercisesByIds } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { getCurrentProgram, getTrainingWeek } from '../programs/index';
import { createFactsLoader, createQueue, sharedFacts, type FactsSource } from './facts';
import type { DisplayUnits } from './format';
import { ACWR_WINDOW_DAYS, GENERAL_METRICS, getGeneralDashboard } from './general';
import { getRunningDashboard } from './running';
import { getStrengthDashboard } from './strength';

/** The tiles the overview shows, in order: an owner's choice, changed here. */
export const OVERVIEW_KPIS = [
	'tonnage',
	'mileage',
	'sessions',
	'adherence',
	'srpe_load'
] as const satisfies readonly MetricId[];
export type OverviewKpiId = (typeof OVERVIEW_KPIS)[number];

/** A lift draws an e1RM line once this many sessions of it give an estimate. */
export const E1RM_SESSIONS = 2;

/**
 * The days from the first activity whose sets date PRs and e1RM lines; the rest of the history is
 * read for them only when these days do not tell (analytics-explain: reading two years of sets
 * cost more than the rest of a 12-week overview).
 */
export const SECTIONS_FIRST_DAYS = 84;

/** Weeks of the plan read ahead, a week at a time, to date PRs and e1RM lines before any are logged. */
export const PLAN_HORIZON_WEEKS = 4;

/** Weekly points a verdict needs: TREND_MIN_POINTS of them, spanning TREND_MIN_SPAN_DAYS. */
const VERDICT_WEEKS = Math.max(TREND_MIN_POINTS, Math.ceil(TREND_MIN_SPAN_DAYS / 7) + 1);

export const SECTIONS = [
	'prs',
	'e1rm',
	'verdicts',
	'acwr',
	'weekly_review',
	'cycle_review'
] as const;
export type OverviewSection = (typeof SECTIONS)[number];

/** Each section's name and what it waits for. */
export const SECTION_RULES: Readonly<Record<OverviewSection, { label: string; rule: string }>> = {
	prs: { label: 'Personal records', rule: 'After your first strength session' },
	e1rm: { label: 'Estimated 1RM lines', rule: `After ${E1RM_SESSIONS} sessions of a lift` },
	verdicts: {
		label: 'Trend verdicts',
		rule: `Once ${TREND_MIN_POINTS} weekly points span ${TREND_MIN_SPAN_DAYS} days`
	},
	acwr: { label: 'Acute:chronic load ratio', rule: `After ${CHRONIC_DAYS} days of training` },
	weekly_review: { label: 'First weekly review', rule: "On your first week's Sunday" },
	cycle_review: { label: 'First cycle review', rule: 'At the end of your first block' }
};

/** When a section appears: `on` is the day it did or will (null: not known yet), ready from then. */
export interface SectionAvailability {
	section: OverviewSection;
	label: string;
	rule: string;
	on: IsoDate | null;
	ready: boolean;
}

export interface OverviewKpi {
	metric: OverviewKpiId;
	label: string;
	kind: MetricKind;
	method: string;
	caveat: string | null;
	/** Over the period's complete weeks; null: no data. */
	value: number | null;
	shown: string | null;
	comparison: Kpi;
	trend: MetricTrend;
	soFar: SoFarLine | null;
	/** The sparkline: complete weeks (or months), then the week in progress, flagged. */
	series: SeriesPoint[];
}

export interface ProgressOverview {
	period: Period;
	window: PeriodWindow;
	trendWindow: TrendWindow;
	units: DisplayUnits;
	headline: { verdict: Verdict; text: string };
	/** One per discipline (METRIC_AREAS), each naming the weeks it read. */
	verdicts: (DisciplineVerdict & { window: TrendWindow })[];
	kpis: OverviewKpi[];
	series: {
		keyLifts: { exerciseId: string; name: string; points: SeriesPoint[] }[];
		/** Groups that carried load in the period only. */
		load: { group: LoadGroup; points: SeriesPoint[] }[];
	};
	availability: Record<OverviewSection, SectionAvailability>;
	/** The same sections by the day they appear, undated ones last. */
	timeline: SectionAvailability[];
}

export interface OverviewDeps {
	/** The fact reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
}

const point = ({ at, value, inProgress }: SeriesPoint): SeriesPoint => ({ at, value, inProgress });

/**
 * Every day the three dashboards read for `window`: from the earliest of its weeks, the previous
 * weeks, the trend weeks, last week's same days and the first load ratio's window, to this week's
 * Sunday (the plan's whole week). Days before it (records before the period) are read apart.
 */
function sharedRange(window: PeriodWindow, trend: TrendWindow, today: IsoDate) {
	const { weeks, previous, inProgress } = window;
	const firstRatioDay = weeks ? addDays(weeks.from, 6) : today;
	const days = [
		weeks?.from,
		previous?.from,
		trend.weeks?.from,
		sameDaysLastWeek(inProgress).from,
		addDays(firstRatioDay, 1 - ACWR_WINDOW_DAYS)
	];
	const from = days.filter((day) => day !== undefined).sort()[0]!;
	return { from, to: addDays(inProgress.weekStart, 6) };
}

export async function getProgressOverview(
	db: Executor,
	ownerId: string,
	{ period, today }: { period: Period; today: IsoDate },
	{ repository }: OverviewDeps = {}
): Promise<ProgressOverview> {
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const queue = createQueue();
	const everyDay = createFactsLoader(
		db,
		ownerId,
		{ from: today, to: today, timeZone },
		{ repository, queue }
	);
	const first = await everyDay.firstActivity();
	const window = periodWindow(today, period, first);
	const trend = trendWindow(window);
	const range = { ...sharedRange(window, trend, today), timeZone };
	const facts = sharedFacts(db, ownerId, range, { repository, queue, everyDay });
	const query = { period, today };
	const strength = await getStrengthDashboard(db, ownerId, { ...query, headline: true }, { facts });
	const running = await getRunningDashboard(db, ownerId, query, { facts });
	const general = await getGeneralDashboard(db, ownerId, query, { facts });

	// ---- a verdict per discipline
	const evidenceOf = (id: MetricId, metricTrend: MetricTrend | null): Evidence[] =>
		metricTrend ? [{ subject: METRICS[id].label, trend: metricTrend }] : [];
	const generalIn = (area: MetricArea) =>
		GENERAL_METRICS.filter((id) => METRICS[id].area === area).flatMap((id) =>
			evidenceOf(id, general.figures[id].trend)
		);
	const evidence: Record<MetricArea, Evidence[]> = {
		strength: strength.keyLifts.map((lift) => ({ subject: lift.name, trend: lift.trend })),
		running: [
			...evidenceOf('mileage', running.mileage.trend),
			...running.pace.flatMap((p) => (p.about ? evidenceOf(p.about.metric, p.trend) : [])),
			...evidenceOf('long_run', running.longRuns.trend),
			...evidenceOf('run_frequency', running.frequency.trend)
		],
		general: generalIn('general'),
		recovery: generalIn('recovery')
	};
	// Nothing logged in the weeks a verdict reads is no history: twelve weeks without a run are
	// not a steady running trend.
	const judged = trend.weeks && facts(trend.weeks.from, trend.weeks.to);
	const sessions = judged ? await judged.sessions() : [];
	const logged: Record<MetricArea, boolean> = {
		strength: sessions.some((s) => s.kind === 'strength'),
		running: sessions.some((s) => s.run !== null),
		general: sessions.length > 0,
		recovery: judged ? (await judged.recovery()).length > 0 : false
	};
	const verdicts = METRIC_AREAS.map((area) => ({
		...disciplineVerdict(area, logged[area] ? evidence[area] : []),
		window: trend
	}));
	const { verdict, text } = headline(verdicts);

	// ---- KPI tiles, as the dashboards give them
	const tile = (
		id: OverviewKpiId,
		parts: Pick<OverviewKpi, 'value' | 'shown' | 'comparison' | 'trend' | 'soFar'> & {
			series: SeriesPoint[];
		}
	): OverviewKpi => {
		const { label, kind, method, caveat } = METRICS[id];
		return { metric: id, label, kind, method, caveat, ...parts, series: parts.series.map(point) };
	};
	const fromGeneral = (id: 'sessions' | 'adherence' | 'srpe_load') => {
		const { value, shown, comparison, trend: figureTrend, soFar, series } = general.figures[id];
		return tile(id, { value, shown, comparison, trend: figureTrend, soFar, series });
	};
	const { tonnage } = strength;
	const { mileage } = running;
	const tiles: Record<OverviewKpiId, OverviewKpi> = {
		tonnage: tile('tonnage', {
			...{ value: tonnage.value?.value ?? null, shown: tonnage.value?.text ?? null },
			...{ comparison: tonnage.comparison, trend: tonnage.trend, soFar: tonnage.soFar },
			series: tonnage.series
		}),
		mileage: tile('mileage', {
			...{ value: mileage.kpi.value, shown: mileage.mean?.text ?? null },
			...{ comparison: mileage.kpi, trend: mileage.trend, soFar: mileage.soFar },
			series: mileage.points
		}),
		sessions: fromGeneral('sessions'),
		adherence: fromGeneral('adherence'),
		srpe_load: fromGeneral('srpe_load')
	};

	// ---- the headline series
	const weeks = [...general.load.weeks, general.load.inProgress];
	const load = LOAD_STACK.map((group) => {
		const points = weeks.map((w) => ({
			at: w.weekStart,
			value: w.byGroup.find((g) => g.group === group)!.load,
			inProgress: w.inProgress
		}));
		return { group, points: window.bucket === 'month' ? byMonth(points) : points };
	}).filter(({ points }) => points.some((p) => (p.value ?? 0) > 0));

	const judgedAny = verdicts.some((v) => v.verdict !== 'not_enough_data');
	const availability = await sectionsOf(db, ownerId, { today, first, timeZone, facts, judgedAny });
	const timeline = SECTIONS.map((section) => availability[section]).sort((a, b) =>
		a.on === b.on ? 0 : a.on === null ? 1 : b.on === null ? -1 : a.on < b.on ? -1 : 1
	);

	return {
		period,
		window,
		trendWindow: trend,
		units: strength.units,
		headline: { verdict, text },
		verdicts,
		kpis: OVERVIEW_KPIS.map((id) => tiles[id]),
		series: {
			keyLifts: strength.keyLifts.map(({ exerciseId, name, series }) => ({
				...{ exerciseId, name },
				points: series.map(point)
			})),
			load
		},
		availability,
		timeline
	};
}

/**
 * The day each section appears. Logged history dates PRs and e1RM lines (the sets of the first
 * SECTIONS_FIRST_DAYS days from the first activity, or of every day when those do not); until then the plan's next strength sessions
 * (up to PLAN_HORIZON_WEEKS weeks of it) date them, or nothing does. Verdicts and the ratio count from
 * the first activity, or from the plan's first day or today before any, and so does the first
 * weekly review (that week's Sunday); the first cycle review comes at the current program's first
 * block's end.
 */
async function sectionsOf(
	db: Executor,
	ownerId: string,
	{
		today,
		first,
		timeZone,
		facts,
		judgedAny
	}: {
		today: IsoDate;
		first: IsoDate | null;
		timeZone: string;
		facts: FactsSource;
		/** Whether any verdict in the response has a trend: verdicts are ready only then. */
		judgedAny: boolean;
	}
): Promise<Record<OverviewSection, SectionAvailability>> {
	const program = await getCurrentProgram(ownerId, today, { db });
	/** The first logged day and the first e1RM line's, from the sets of `first` to `to`. */
	const loggedTo = async (to: IsoDate) => {
		const sets = first === null || first > today ? [] : await facts(first, to).sets();
		const exercises = await getExercisesByIds(ownerId, [...new Set(sets.map((s) => s.exercise))], {
			db
		});
		const days = sets.map((set) => localDay(set.performedAt, timeZone)).sort();
		const lifts = [...Map.groupBy(sets, (set) => set.exercise)].flatMap(([id, facts]) => {
			const lift = exercises.get(id);
			return lift
				? [
						e1rmSeries(facts, lift, timeZone)
							.map((p) => p.on)
							.sort()
					]
				: [];
		});
		const most = Math.max(0, ...lifts.map((dates) => dates.length));
		const logged: Partial<Record<OverviewSection, IsoDate>> = {};
		if (days[0]) logged.prs = days[0];
		const e1rmOn = lifts.flatMap((dates) => dates[E1RM_SESSIONS - 1] ?? []).sort()[0];
		if (e1rmOn) logged.e1rm = e1rmOn;
		return { logged, most };
	};
	// Both are the earliest of something, so the first SECTIONS_FIRST_DAYS days hold them on a long
	// history. Their last day's sessions may run on past it, so an e1RM date on it is read again.
	const cut = first && addDays(first, SECTIONS_FIRST_DAYS - 1);
	const early = cut && cut < today ? await loggedTo(cut) : null;
	const { logged, most } =
		early?.logged.prs && early.logged.e1rm && early.logged.e1rm < cut!
			? early
			: await loggedTo(today);

	// Logged e1RM lines imply logged PRs; until then the plan's next strength sessions date both.
	const planned: IsoDate[] = [];
	const from = program && program.firstPlannedDay > today ? program.firstPlannedDay : today;
	for (let n = 0; program && !logged.e1rm && n < PLAN_HORIZON_WEEKS; n++) {
		if (planned.length >= E1RM_SESSIONS - most) break;
		const week = await getTrainingWeek(ownerId, { date: addDays(from, 7 * n) }, {}, { db });
		if (!week?.planned) break;
		for (const s of week.days.flatMap((d) => d.sessions)) {
			if (s.kind === 'strength' && s.status === 'planned' && s.date >= today) planned.push(s.date);
		}
	}

	const start = first ?? from;
	const on: Record<OverviewSection, IsoDate | null> = {
		prs: logged.prs ?? planned[0] ?? null,
		e1rm: logged.e1rm ?? planned[E1RM_SESSIONS - most - 1] ?? null,
		verdicts: addDays(mondayOf(start), 7 * VERDICT_WEEKS),
		acwr: addDays(start, CHRONIC_DAYS - 1),
		weekly_review: addDays(mondayOf(start), 6),
		cycle_review: program?.blocks[0]?.endsOn ?? null
	};
	// PRs and e1RM lines are ready once logged; a planned session dates them, never readies them.
	// Verdicts are dated by the calendar but ready only once one has a trend (a lapsed or sparse
	// history passes the date with nothing to judge).
	const ready = (section: OverviewSection, day: IsoDate | null) =>
		section === 'prs' || section === 'e1rm'
			? logged[section] !== undefined
			: day !== null && day <= today && (section !== 'verdicts' || judgedAny);
	const entry = (section: OverviewSection): SectionAvailability => {
		const day = on[section];
		return { section, ...SECTION_RULES[section], on: day, ready: ready(section, day) };
	};
	return Object.fromEntries(SECTIONS.map((s) => [s, entry(s)])) as Record<
		OverviewSection,
		SectionAvailability
	>;
}
