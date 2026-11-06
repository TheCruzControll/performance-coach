/**
 * The coach's analytics (PRD §4, §10; the M5 brief's analytics tools): a week's training summary,
 * the training load with its acute:chronic ratio, and performance trends over complete weeks.
 * The get_weekly_training_summary, get_training_load and get_performance_trends tools return
 * them, and the coaching memory reads the trends.
 *
 * - Every figure comes from tested functions: M3's history services (sessions in a range, weekly
 *   hard sets, weekly mileage) with M3's sessionLoadOf, M1's acuteChronicRatio, and seriesChange
 *   (domain/coach/trends.ts). Nothing here redefines a metric.
 * - Each figure has its value, its unit, how code computed it (method, in words an answer's
 *   `[metric method=…]` repeats) and the records it rests on (sources: its period's date first,
 *   then at most SOURCES_MAX records, newest first).
 * - Too little data is a result, never a zero: insufficient_data says what is missing.
 * - Counts, minutes and loads are of completed workouts: an abandoned or unfinished one is no
 *   training done. Distances and hard sets are M3's reads, which count every logged run and set.
 * - Dates are explicit, on the owner's calendar: callers pass today (ownerToday). Trends read
 *   complete weeks only, so a Wednesday never looks like a decline.
 * - No verdicts: 'real trend' and 'normal variation' are M6's. M6's coach-analytics-repoint
 *   moves these functions onto its engine, and their results only gain fields.
 * - The services are awaited one at a time, so a caller may pass a transaction.
 */
import type { AvailabilityUnit, SeriesPoint } from '../../../domain/analytics/types';
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
import { acuteChronicRatio } from '../../../domain/load';
import { HARD_SET_CREDIT, HARD_SET_MIN_RPE } from '../../../domain/training/metrics';
import type { MuscleGroup } from '../../../domain/training/vocabulary';
import { roundToIncrement } from '../../../domain/units';
import {
	getSessionsInRange,
	getWeeklyMileage,
	getWeeklyMuscleVolume,
	type LoggedSession,
	type PlannedSessionInRange
} from '../training/history';
import { TrainingInputError, type TrainingDeps } from '../training/shared';

/** The most records a figure cites after its period's date, newest first. */
export const SOURCES_MAX = 8;
/** The days a training load reads, ending today: two chronic windows. An owner's choice. */
export const LOAD_WINDOW_DAYS = 56;
/** M1's acute and chronic windows (acuteChronicRatio's own defaults). */
export const ACUTE_DAYS = 7;
export const CHRONIC_DAYS = 28;
/** The complete weeks a trend reads unless asked otherwise, and the fewest and most it may. */
export const TREND_WEEKS = 8;
export const MIN_TREND_WEEKS = CHANGE_MIN_POINTS;
export const MAX_TREND_WEEKS = 26;

/** Shown with every ratio (PRD §10): what it can and cannot say. */
export const ACWR_CAVEAT =
	'A rough guide to how fast your load is rising, not an injury predictor. About 0.8–1.3 is ' +
	'typical and above 1.5 is a sharp rise: both are rules of thumb.';

/** A number code computed, as a tool returns it and an answer's metric block cites it. */
export interface Figure {
	value: number;
	unit: string | null;
	method: string;
	sources: SourceRef[];
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
}

export interface TrainingLoad {
	status: 'ok';
	/** The days the moving averages read: from the first completed workout in the window. */
	from: IsoDate;
	to: IsoDate;
	days: number;
	acute: Figure;
	chronic: Figure;
	ratio: Figure;
	last7Days: Figure;
	unrated: Figure;
	caveat: string;
}

export type TrendMetric = 'sessions' | 'minutes' | 'session_load' | 'running_distance';

export type Trend = Omit<Figure, 'value'> & {
	metric: TrendMetric;
	/** One per complete week, oldest first; a week with nothing logged is 0. */
	points: SeriesPoint[];
	change: SeriesChange;
	changeMethod: string;
};

export interface PerformanceTrends {
	status: 'ok';
	/** The complete weeks read: from the first with anything logged, to last Sunday. */
	weeks: { from: IsoDate; to: IsoDate; count: number };
	/** Only what was trained: a trend no record contributes to is left out. */
	trends: Trend[];
}

const METHOD = {
	planned: 'sessions the current program version plans this week, skipped ones left out',
	completed: 'planned sessions with a completed workout logged against them',
	skipped: 'planned sessions marked skipped',
	workouts: 'completed workouts, planned or not',
	minutes: 'sum of the durations of completed workouts',
	sessionLoad: 'sRPE load: minutes × session RPE of each completed workout (Foster), summed',
	unrated: 'completed workouts with no session RPE or duration, so no load',
	runningDistance: 'sum of the distances of logged runs, in your distance unit',
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
		running_distance: 'distance of logged runs per week, in your distance unit'
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

const dateRef = (date: IsoDate, label: string): SourceRef => ({
	type: 'date',
	id: date,
	label,
	date
});
const workoutRef = (w: LoggedSession): SourceRef => ({
	type: 'workout',
	id: w.id,
	label: w.title,
	date: w.date
});
const sessionRef = (s: PlannedSessionInRange): SourceRef => ({
	type: 'session',
	id: s.lineageId,
	label: s.title,
	date: s.scheduledOn
});

/** The period's date, then the newest SOURCES_MAX of `records` (given oldest first). */
const sourcesOf = (period: SourceRef, records: readonly SourceRef[]) => [
	period,
	...records.slice(-SOURCES_MAX).reverse()
];

function figure(
	value: number,
	unit: string | null,
	step: number,
	method: string,
	period: SourceRef,
	records: readonly SourceRef[]
): Figure {
	return { value: round(value, step), unit, method, sources: sourcesOf(period, records) };
}

/**
 * The week from `week` (a Monday; today's week unless given) to its Sunday, as the plan and the
 * log have it. Insufficient data when nothing was planned or logged. Refuses a week that has not
 * begun.
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
	const to = addDays(from, 6);
	const { planned, logged } = await getSessionsInRange(ownerId, { from, to }, deps);
	if (planned.length === 0 && logged.length === 0) return noTraining();
	const mileage = await getWeeklyMileage(ownerId, { from, to }, {}, deps);
	const [volume] = await getWeeklyMuscleVolume(ownerId, { from, to }, deps);

	const period = dateRef(from, `Week of ${from}`);
	const sessions = (rows: PlannedSessionInRange[], method: string) =>
		figure(rows.length, 'sessions', 1, method, period, rows.map(sessionRef));
	const happening = planned.filter((s) => s.status !== 'skipped');
	const done = completed(logged);
	const workouts = done.map(workoutRef);
	const runs = logged.filter((w) => w.kind === 'run');
	const unrated = done.filter((w) => w.load === null);
	const inProgress = from === mondayOf(day);
	return {
		status: 'ok',
		week: { from, to, inProgress, through: inProgress ? day : to },
		planned: sessions(happening, METHOD.planned),
		completed: sessions(
			happening.filter((s) => s.status === 'completed'),
			METHOD.completed
		),
		skipped: sessions(
			planned.filter((s) => s.status === 'skipped'),
			METHOD.skipped
		),
		workouts: figure(done.length, 'sessions', 1, METHOD.workouts, period, workouts),
		minutes: figure(minutesOf(done), 'min', 0.1, METHOD.minutes, period, workouts),
		sessionLoad: figure(
			loadOf(done),
			'AU',
			0.1,
			METHOD.sessionLoad,
			period,
			rated(done).map(workoutRef)
		),
		unrated: figure(unrated.length, 'sessions', 1, METHOD.unrated, period, unrated.map(workoutRef)),
		runningDistance: figure(
			mileage.weeks[0]?.distance ?? 0,
			mileage.unit,
			0.01,
			METHOD.runningDistance,
			period,
			runs.map(workoutRef)
		),
		hardSets: {
			values: volume?.groups ?? {},
			unit: 'hard sets',
			method: METHOD.hardSets,
			sources: sourcesOf(period, logged.filter((w) => w.kind === 'strength').map(workoutRef))
		}
	};
}

/**
 * The acute and chronic loads and their ratio as of today: M1's acuteChronicRatio over the daily
 * sRPE loads of completed workouts, from the first one in the last LOAD_WINDOW_DAYS days (days
 * before it would read as rest the owner never took). A workout with no load counts 0 that day.
 * Insufficient data under CHRONIC_DAYS days of history, and with no load at all.
 */
export async function getTrainingLoad(
	ownerId: string,
	{ today }: { today: IsoDate },
	deps: TrainingDeps = {}
): Promise<TrainingLoad | InsufficientData> {
	const to = checkToday(today);
	const window = { from: addDays(to, 1 - LOAD_WINDOW_DAYS), to };
	const done = completed((await getSessionsInRange(ownerId, window, deps)).logged);
	if (done.length === 0) return noTraining();
	const from = done[0]!.date;
	const days = daysBetween(from, to) + 1;
	if (days < CHRONIC_DAYS) return insufficient('too_little_history', days, CHRONIC_DAYS, 'days');
	const daily = new Map<IsoDate, number>();
	for (const w of done) daily.set(w.date, (daily.get(w.date) ?? 0) + (w.load ?? 0));
	const loads = Array.from({ length: days }, (_, n) => daily.get(addDays(from, n)) ?? 0);
	const { acute, chronic, ratio } = acuteChronicRatio(loads, ACUTE_DAYS, CHRONIC_DAYS)!;
	if (ratio === null) return insufficient('no_rated_sessions', 0, 1, 'sessions');

	const period = dateRef(to, `As of ${to}`);
	const withLoad = rated(done);
	const lastWeek = withLoad.filter((w) => daysBetween(w.date, to) < ACUTE_DAYS);
	const all = withLoad.map(workoutRef);
	const recent = lastWeek.map(workoutRef);
	const unrated = done.filter((w) => w.load === null);
	return {
		status: 'ok',
		from,
		to,
		days,
		acute: figure(acute, 'AU/day', 0.1, METHOD.acute, period, recent),
		chronic: figure(chronic, 'AU/day', 0.1, METHOD.chronic, period, all),
		ratio: figure(ratio, null, 0.01, METHOD.ratio, period, all),
		last7Days: figure(loadOf(lastWeek), 'AU', 0.1, METHOD.last7Days, period, recent),
		unrated: figure(unrated.length, 'sessions', 1, METHOD.unrated, period, unrated.map(workoutRef)),
		caveat: ACWR_CAVEAT
	};
}

/**
 * Weekly sessions, minutes, sRPE load and running distance over the last `weeks` complete weeks
 * (TREND_WEEKS by default), from the first week with anything logged, each with seriesChange.
 * Insufficient data when nothing was logged in them.
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
	const to = addDays(mondayOf(day), -1);
	const { logged } = await getSessionsInRange(
		ownerId,
		{ from: addDays(to, 1 - 7 * weeks), to },
		deps
	);
	if (logged.length === 0) return noTraining();
	const from = mondayOf(logged[0]!.date);
	const count = (daysBetween(from, to) + 1) / 7;
	const runs = logged.filter((w) => w.kind === 'run');
	// No run, no running trend: the mileage read is left out.
	const mileage = runs.length > 0 ? await getWeeklyMileage(ownerId, { from, to }, {}, deps) : null;

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
		const sources = sourcesOf(period, records.map(workoutRef));
		return [
			{
				metric,
				unit,
				method: METHOD.trend[metric],
				sources,
				points,
				change: seriesChange(points),
				changeMethod: SERIES_CHANGE_METHOD
			}
		];
	};
	const done = completed(logged);
	const weekOf = (rows: readonly LoggedSession[], at: IsoDate) =>
		rows.filter((w) => mondayOf(w.date) === at);
	return {
		status: 'ok',
		weeks: { from, to, count },
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
		]
	};
}
