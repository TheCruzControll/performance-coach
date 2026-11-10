/**
 * The running dashboard (PRD §10, §11): every running figure for a period in one call, read by
 * Progress's Running view and the coach.
 * - Weekly mileage with the planned mileage alongside, the average week against the previous
 *   period, the distance trend and the 'so far' line for the week in progress.
 * - Pace by run type, long-run progression, best efforts and reported races, runs per week, and
 *   heart rate when it was tracked.
 *
 * Rules (m6-plan): totals, means, comparisons and trends use complete weeks only; the week in
 * progress is shown apart and never in a mean (TREND_MIN_WEEKS and sameDaysLastWeek in
 * periods.ts hold the owner's choices). Verdicts read trendWindow(period), so 4w judges the last
 * 12 complete weeks and says so. Values stay canonical (metres, seconds, s/km); every display
 * string comes through format.ts in the profile's units (UNITS_FROM). Every figure carries its
 * metric id, kind and method (about), and its verdict carries the weeks it read.
 *
 * The facts are loaded once, over the period, its previous weeks and its trend window, so
 * segments are read only for those runs, one query at a time: the caller may pass a transaction.
 */
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
	type Period,
	type PeriodWindow,
	type TrendWindow,
	type WeekRange
} from '../../../domain/analytics/periods';
import {
	bestEfforts,
	heartRateByType,
	longRuns,
	paceByType,
	plannedMileage,
	runFrequency,
	weeklyRunning,
	wholeRun,
	type DistanceEfforts,
	type Effort,
	type RunFrequency,
	type TypeHeartRate,
	type WeekLongRun,
	type Weeks
} from '../../../domain/analytics/running';
import { averageOf, byMonth, soFar, type Reduce } from '../../../domain/analytics/series';
import type { MetricKind, SeriesPoint } from '../../../domain/analytics/types';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { SessionType } from '../../../domain/training/vocabulary';
import { formatDuration } from '../../../domain/units';
import type { Executor } from '../../db/types';
import { getAthleteProfile } from '../profile/index';
import { factsSource, type DashboardDeps } from './facts';
import { displayUnits, distance, formatIn, pace, type DisplayUnits, type Shown } from './format';

/** The pace metric each run type is judged by; a type without one is shown and never judged. */
export const PACE_METRIC: Readonly<Partial<Record<SessionType, MetricId>>> = {
	easy_run: 'pace_easy',
	long_run: 'pace_long',
	tempo_run: 'pace_tempo',
	interval_run: 'pace_intervals'
};

/** What the heart-rate section says when no run in the period carries a heart rate, and when some do. */
export const HR_NOT_TRACKED = 'Not tracked';
export const HR_TRACKED = 'Average heart rate by run type, from the runs that carry one';

/** A figure's context from the metric catalogue, which the screen and the coach both show. */
export interface About {
	metric: MetricId;
	label: string;
	kind: MetricKind;
	method: string;
	caveat: string | null;
}

const about = (id: MetricId): About => {
	const { label, kind, method, caveat } = METRICS[id];
	return { metric: id, label, kind, method, caveat };
};

export interface MileageWeek {
	weekStart: IsoDate;
	inProgress: boolean;
	distance: Shown;
	runs: number;
	longest: Shown | null;
	/** The metres planned by distance; null when the week plans none. */
	planned: Shown | null;
	/** Runs planned by time, which the planned distance leaves out. */
	plannedByTime: number;
}

export interface TypePaceFigure {
	sessionType: SessionType;
	/** Null for a type no pace metric judges. */
	about: About | null;
	/** The pace over the period's complete weeks; null without a run in them. */
	period: Shown | null;
	points: SeriesPoint[];
	kpi: Kpi | null;
	trend: MetricTrend | null;
}

export type ShownEffort = Effort & { pace: Shown; time: string };
export type ShownEfforts = Omit<DistanceEfforts, 'best' | 'efforts' | 'reported'> & {
	best: ShownEffort | null;
	efforts: ShownEffort[];
	reported: ShownEffort[];
};

export interface RunningDashboard {
	period: Period;
	window: PeriodWindow;
	/** The weeks every verdict reads, with the words a tile shows when they differ from the period. */
	trendWindow: TrendWindow;
	units: DisplayUnits;
	mileage: {
		about: About;
		weeks: MileageWeek[];
		inProgress: MileageWeek;
		/** Metres per complete week (by month for a long 'all'), the week in progress last, flagged. */
		points: SeriesPoint[];
		/** The average complete week; null without one. */
		mean: Shown | null;
		/** The period's longest run; null without one. */
		longestRun: Shown | null;
		kpi: Kpi;
		soFar: SoFarLine;
		trend: MetricTrend;
	};
	pace: TypePaceFigure[];
	longRuns: {
		about: About;
		weeks: (WeekLongRun & { distance: Shown | null })[];
		points: SeriesPoint[];
		trend: MetricTrend;
	};
	efforts: ShownEfforts[];
	frequency: RunFrequency & { about: About; points: SeriesPoint[]; kpi: Kpi; trend: MetricTrend };
	heartRate: { tracked: boolean; text: string; byType: TypeHeartRate[] };
}

const earliest = (dates: (IsoDate | undefined)[]) =>
	dates.filter((d): d is IsoDate => d !== undefined).sort()[0]!;

const largest: Reduce = (values) => (values.length ? Math.max(...values) : null);

export async function getRunningDashboard(
	db: Executor,
	ownerId: string,
	{ period, today }: { period: Period; today: IsoDate },
	deps: DashboardDeps = {}
): Promise<RunningDashboard> {
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const units = displayUnits(profile);
	const format = formatIn(units);
	const facts = factsSource(db, ownerId, timeZone, deps);

	const firstActivity = period === 'all' ? await facts(today, today).firstActivity() : null;
	const window = periodWindow(today, period, firstActivity);
	const trend = trendWindow(window);
	const { inProgress } = window;
	const from = earliest([
		window.weeks?.from,
		window.previous?.from,
		trend.weeks?.from,
		sameDaysLastWeek(inProgress).from
	]);
	const loader = facts(from, today);
	const runs = await loader.runs();
	// The plan is read through the week in progress's Sunday: its target is the whole week's.
	const planned = await facts(from, addDays(inProgress.weekStart, 6)).plannedRuns();
	const races = await loader.races();

	const periodWeeks: Weeks = window;
	const trendWeeks: Weeks = { weeks: trend.weeks, inProgress };
	const previousWeeks: Weeks = { weeks: window.previous, inProgress };
	const bucketed = (points: SeriesPoint[], reduce?: Reduce) =>
		window.bucket === 'month' ? byMonth(points, reduce) : points;
	const figure = (value: number | null, weeks: WeekRange | null) => ({ value, weeks });

	// ---- Mileage
	const mileage = weeklyRunning(runs, periodWeeks, units.distance, timeZone);
	const plannedWeeks = new Map(plannedMileage(planned, periodWeeks).map((w) => [w.weekStart, w]));
	const shownWeek = (w: (typeof mileage.weeks)[number]): MileageWeek => {
		const plan = plannedWeeks.get(w.weekStart)!;
		return {
			weekStart: w.weekStart,
			inProgress: w.inProgress,
			distance: distance(w.metres, units),
			runs: w.runs,
			longest: w.longestMetres === null ? null : distance(w.longestMetres, units),
			planned: plan.metres === null ? null : distance(plan.metres, units),
			plannedByTime: plan.byTime
		};
	};
	const mean = averageOf(mileage.points);
	const previousMean = averageOf(
		weeklyRunning(runs, previousWeeks, units.distance, timeZone).points
	);
	const longest = mileage.weeks.flatMap((w) => w.longestMetres ?? []);
	const metresSoFar = runs.flatMap((run) => {
		const metres = wholeRun(run).distanceMetres;
		return metres === null ? [] : [{ at: run.startedAt, value: metres }];
	});
	const trendMileage = weeklyRunning(runs, trendWeeks, units.distance, timeZone).points;

	// ---- Pace by type
	const previousPace = paceByType(runs, previousWeeks, timeZone);
	const trendPace = paceByType(runs, trendWeeks, timeZone);
	const paces = paceByType(runs, periodWeeks, timeZone).map((type): TypePaceFigure => {
		const id = PACE_METRIC[type.sessionType];
		const before = previousPace.find((p) => p.sessionType === type.sessionType)?.period ?? null;
		const judged = trendPace.find((p) => p.sessionType === type.sessionType)?.points ?? [];
		return {
			sessionType: type.sessionType,
			about: id ? about(id) : null,
			period: type.period === null ? null : pace(type.period, units),
			points: bucketed(type.points),
			kpi: id
				? kpi(id, figure(type.period, window.weeks), figure(before, window.previous), format)
				: null,
			trend: id ? trendOf(id, bucketed(judged), window) : null
		};
	});

	// ---- Long runs
	const longPoints = (weeks: Weeks) =>
		longRuns(runs, weeks, timeZone).map((w) => ({
			at: w.weekStart,
			value: w.run?.metres ?? null,
			inProgress: w.inProgress
		}));
	const longWeeks = longRuns(runs, periodWeeks, timeZone).map((w) => ({
		...w,
		distance: w.run ? distance(w.run.metres, units) : null
	}));

	// ---- Best efforts and reported races, the week in progress included. A reported race counts
	// in a period when it is dated in it; 'all' lists every one, an undated race included.
	const periodFrom = window.weeks?.from ?? inProgress.weekStart;
	const inPeriod = (day: IsoDate | null) => day !== null && day >= periodFrom && day <= today;
	const effortRuns = runs.filter((run) => inPeriod(localDay(run.startedAt, timeZone)));
	const periodRaces = period === 'all' ? races : races.filter((race) => inPeriod(race.racedOn));
	const shownEffort = (e: Effort): ShownEffort => ({
		...e,
		pace: pace(e.paceSecondsPerKm, units),
		time: formatDuration(e.durationSeconds)
	});
	const efforts = bestEfforts(effortRuns, periodRaces).map((d) => ({
		...d,
		best: d.best && shownEffort(d.best),
		efforts: d.efforts.map(shownEffort),
		reported: d.reported.map(shownEffort)
	}));

	// ---- Frequency
	const runsPerWeek = (weeks: Weeks) =>
		weeklyRunning(runs, weeks, units.distance, timeZone).weeks.map((w) => ({
			at: w.weekStart,
			value: w.runs,
			inProgress: false
		}));
	const frequency = runFrequency(runs, periodWeeks, timeZone);
	const countPoints = [
		...runsPerWeek(periodWeeks),
		{ at: inProgress.weekStart, value: frequency.inProgress, inProgress: true }
	];

	// ---- Heart rate
	const hr = heartRateByType(runs, periodWeeks, timeZone);

	return {
		period,
		window,
		trendWindow: trend,
		units,
		mileage: {
			about: about('mileage'),
			weeks: mileage.weeks.map(shownWeek),
			inProgress: shownWeek(mileage.inProgress),
			points: bucketed(mileage.points),
			mean: mean === null ? null : distance(mean, units),
			longestRun: longest.length ? distance(Math.max(...longest), units) : null,
			kpi: kpi(
				'mileage',
				figure(mean, window.weeks),
				figure(previousMean, window.previous),
				format
			),
			soFar: soFarLine(
				'mileage',
				soFar(metresSoFar, inProgress, { timeZone, direction: 'up' }),
				format
			),
			trend: trendOf('mileage', bucketed(trendMileage), window)
		},
		pace: paces,
		longRuns: {
			about: about('long_run'),
			weeks: longWeeks,
			points: bucketed(longPoints(periodWeeks), largest),
			trend: trendOf('long_run', bucketed(longPoints(trendWeeks), largest), window)
		},
		efforts,
		frequency: {
			...frequency,
			about: about('run_frequency'),
			points: bucketed(countPoints),
			kpi: kpi(
				'run_frequency',
				figure(frequency.perWeek, window.weeks),
				figure(runFrequency(runs, previousWeeks, timeZone).perWeek, window.previous),
				format
			),
			trend: trendOf('run_frequency', bucketed(runsPerWeek(trendWeeks)), window)
		},
		heartRate: {
			tracked: hr.length > 0,
			text: hr.length ? HR_TRACKED : HR_NOT_TRACKED,
			byType: hr
		}
	};
}
