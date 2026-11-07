/**
 * Running (PRD §10, §11): weekly mileage, pace by run type, long-run progression, best efforts and
 * reported races, frequency and, when it was tracked, heart rate. The dashboards, the reviews and
 * the progression rules read these, so each running number has one definition.
 *
 * - Distances are exact metres (run_records stores them so: 5 mi is 8046.72 m), summed through
 *   M3's weeklyDistance; a run's time is seconds.
 * - Every pace is M4's: segmentPace (s/km, lower is better) of amounts that runTotals adds up, so
 *   a pace here is the pace the run screen and History show. No pace arithmetic is written here.
 * - A run's totals are its record's distance, time and heart rate; one its record lacks is taken
 *   from runTotals of its segments as run.
 * - Each run type is judged by the part of the run that shows it (PACE_PART): a tempo run by its
 *   tempo segments, else the whole run; intervals by their interval segments only. Every other
 *   type, an unknown one included, by the whole run. Only tempo and interval segments ever change
 *   a pace. A segment counts toward a part's pace only with both a distance and a time.
 * - Weeks run Monday to Sunday on the owner's calendar (M3's weekStartOf), so a Sunday-evening run
 *   stays in its week. The week in progress is kept apart, flagged, and never in a period figure.
 * - Heart rate is optional: a type's figure is shown only once HR_MIN_RUNS of its runs in the
 *   period carry one.
 *
 * Conventions for src/lib/domain/analytics (M6): pure, imported by path (no index file), no zod,
 * no runtime import of domain/programming or domain/exercises. Server-only at runtime: this is not
 * in scripts/analytics-client-imports.test.ts's CLIENT_SAFE.
 */
import type { IsoDate } from '../calendar.ts';
import { RACE_DISTANCE_INFO } from '../profile/catalog.ts';
import type { RaceDistance } from '../profile/catalog.ts';
import type { RaceResult } from '../profile/types.ts';
import { weekStartOf, weeklyDistance } from '../training/metrics.ts';
import { SESSION_TYPES } from '../training/vocabulary.ts';
import type { RunSegmentKind, SessionType } from '../training/vocabulary.ts';
import { cleanFloat } from '../units.ts';
import type { DistanceUnit } from '../units.ts';
import { runTotals, segmentPace } from '../workout/run.ts';
import type { RunTotals, SegmentAmounts } from '../workout/run.ts';
import { weekStarts } from './periods.ts';
import type { PeriodWindow } from './periods.ts';
import { averageOf, compare, fillWeeks } from './series.ts';
import type { Availability, MetricKind, SeriesPoint } from './types.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/**
 * The part of a run that shows its type's pace. A tempo run with no timed tempo segment falls back
 * to the whole run; intervals never do, since warm-up and recoveries would hide the work.
 */
export const PACE_PART: Readonly<
	Partial<Record<SessionType, { kind: RunSegmentKind; fallback: boolean }>>
> = {
	tempo_run: { kind: 'tempo', fallback: true },
	interval_run: { kind: 'interval', fallback: false }
};

/** A week without a long_run session takes its longest run as the long run when at least this × the week's mean run. */
export const LONG_RUN_OF_MEAN = 1.5;

/** A long run more than this many percent longer than the one before is flagged as a jump. */
export const LONG_RUN_JUMP_PCT = 10;

/** A logged run within this share of a standard distance is an effort at it (±2 %). */
export const EFFORT_TOLERANCE = 0.02;

/**
 * The standard distances efforts and reported races are grouped by. An 'other' race has none.
 * Open question for the owner: logged runs could get an explicit 'race' type instead.
 */
export const EFFORT_DISTANCES = [
	'5k',
	'10k',
	'half_marathon',
	'marathon'
] as const satisfies readonly RaceDistance[];
export type EffortDistance = (typeof EFFORT_DISTANCES)[number];

/** Runs of a type that must carry a heart rate before its heart-rate figure is shown. */
export const HR_MIN_RUNS = 4;

// ---- Inputs ----------------------------------------------------------------------------------

/** A segment as run (M4's run_record_segments). */
export type RunFactSegment = SegmentAmounts & { kind: RunSegmentKind };

/** A completed, undeleted run: its workout, its record's totals and its segments in order. */
export interface RunFact {
	workout: string;
	startedAt: Date;
	sessionType: SessionType;
	metres: number | null;
	seconds: number | null;
	avgHr: number | null;
	rpe: number | null;
	segments: readonly RunFactSegment[];
}

/** The weeks a figure reads: periods.ts's complete weeks and the week in progress. */
export type Weeks = Pick<PeriodWindow, 'weeks' | 'inProgress'>;

/** A run's whole-run totals: its record's, each missing one from runTotals of its segments. */
export function wholeRun(run: RunFact): RunTotals {
	const fromSegments = runTotals(run.segments);
	return {
		distanceMetres: run.metres ?? fromSegments.distanceMetres,
		durationSeconds: run.seconds ?? fromSegments.durationSeconds,
		avgHr: run.avgHr ?? fromSegments.avgHr
	};
}

/** Each run's week, when it is a complete week of `window` or the week in progress. */
function weekOf(window: Weeks, timeZone: string) {
	const complete = new Set(weekStarts(window.weeks));
	return (run: RunFact) => {
		const week = weekStartOf(run.startedAt, timeZone);
		const inProgress = week === window.inProgress.weekStart;
		return complete.has(week) || inProgress ? { week, inProgress } : null;
	};
}

/** The runs of each week of `window`, complete weeks oldest first, then the week in progress. */
function runsByWeek<R extends RunFact>(runs: readonly R[], window: Weeks, timeZone: string) {
	const of = weekOf(window, timeZone);
	const groups = new Map<IsoDate, R[]>();
	for (const run of runs) {
		const placed = of(run);
		if (placed) groups.set(placed.week, [...(groups.get(placed.week) ?? []), run]);
	}
	const week = (weekStart: IsoDate, inProgress: boolean) => ({
		weekStart,
		inProgress,
		runs: groups.get(weekStart) ?? []
	});
	return [
		...weekStarts(window.weeks).map((monday) => week(monday, false)),
		week(window.inProgress.weekStart, true)
	];
}

// ---- Weekly mileage and frequency ------------------------------------------------------------

export interface WeekRunning {
	weekStart: IsoDate;
	inProgress: boolean;
	/** Exact, through M3's weeklyDistance; 0 for a week with no distance recorded. */
	metres: number;
	/** The same in the owner's unit (km or mi), through M1's fromMetres. */
	distance: number;
	runs: number;
	/** The run times recorded, added; a run without one adds nothing. */
	seconds: number;
	/** The week's longest run; null without a run that recorded a distance. */
	longestMetres: number | null;
}

export interface WeeklyRunning {
	/** Each complete week, zero-filled, oldest first. */
	weeks: WeekRunning[];
	inProgress: WeekRunning;
	/** Metres per week, the week in progress last and flagged: what a mileage trend reads. */
	points: SeriesPoint[];
}

/** Weekly mileage, runs, time and longest run for the weeks of `window`. */
export function weeklyRunning(
	runs: readonly RunFact[],
	window: Weeks,
	unit: Exclude<DistanceUnit, 'm'>,
	timeZone: string
): WeeklyRunning {
	const all = runsByWeek(runs, window, timeZone).map(({ weekStart, inProgress, runs: theirs }) => {
		const totals = theirs.map(wholeRun);
		const measured = theirs.flatMap((run, i) => {
			const distance = totals[i]!.distanceMetres;
			return distance === null ? [] : [{ distance, unit: 'm' as const, startedAt: run.startedAt }];
		});
		const [week] = weeklyDistance(measured, unit, timeZone);
		const lengths = measured.map((m) => m.distance);
		return {
			weekStart,
			inProgress,
			metres: week?.metres ?? 0,
			distance: week?.distance ?? 0,
			runs: theirs.length,
			seconds: runTotals(totals.map((t) => ({ ...t, avgHr: null }))).durationSeconds ?? 0,
			longestMetres: lengths.length === 0 ? null : Math.max(...lengths)
		};
	});
	const weeks = all.slice(0, -1);
	const inProgress = all.at(-1)!;
	const buckets = new Map(all.map((w) => [w.weekStart, w.metres]));
	return { weeks, inProgress, points: fillWeeks(buckets, window.weeks, 'zero', window.inProgress) };
}

export interface RunFrequency {
	/** Runs over the complete weeks. */
	runs: number;
	/** The average complete week's runs; null without a complete week. */
	perWeek: number | null;
	/** Runs over the complete weeks by session type, in the vocabulary's order. */
	byType: Partial<Record<SessionType, number>>;
	/** Runs so far in the week in progress. */
	inProgress: number;
}

/** How often the owner ran, from weeklyRunning's weeks and the runs it read. */
export function runFrequency(
	runs: readonly RunFact[],
	window: Weeks,
	timeZone: string
): RunFrequency {
	const weeks = runsByWeek(runs, window, timeZone);
	const complete = weeks.filter((w) => !w.inProgress).flatMap((w) => w.runs);
	const points = weeks.map((w) => ({
		at: w.weekStart,
		value: w.runs.length,
		inProgress: w.inProgress
	}));
	const byType = Object.fromEntries(
		SESSION_TYPES.flatMap((type) => {
			const count = complete.filter((run) => run.sessionType === type).length;
			return count ? [[type, count]] : [];
		})
	);
	return {
		runs: complete.length,
		perWeek: window.weeks ? averageOf(points) : null,
		byType,
		inProgress: weeks.at(-1)!.runs.length
	};
}

// ---- Pace by type ----------------------------------------------------------------------------

/** Which part of a run its pace was taken from. */
export type PaceBasis = 'whole' | 'tempo' | 'interval';

/** One run's pace input: the amounts segmentPace read, and its result in s/km. */
export interface RunPace {
	workout: string;
	startedAt: Date;
	sessionType: SessionType;
	basis: PaceBasis;
	distanceMetres: number;
	durationSeconds: number;
	paceSecondsPerKm: number;
}

/** The pace of `amounts` through M4's segmentPace, in s/km; null without both a distance and a time. */
const paceOf = (amounts: Pick<SegmentAmounts, 'distanceMetres' | 'durationSeconds'>) =>
	segmentPace(amounts, 'km');

/** A run's pace input by its type's part (PACE_PART); null when the run has none to give. */
export function runPace(run: RunFact): RunPace | null {
	const part = PACE_PART[run.sessionType];
	let basis: PaceBasis = 'whole';
	let amounts: Pick<SegmentAmounts, 'distanceMetres' | 'durationSeconds'> = wholeRun(run);
	if (part) {
		const timed = run.segments.filter(
			(s) => s.kind === part.kind && s.distanceMetres !== null && s.durationSeconds !== null
		);
		if (timed.length > 0) {
			basis = part.kind === 'tempo' ? 'tempo' : 'interval';
			amounts = runTotals(timed);
		} else if (!part.fallback) return null;
	}
	const pace = paceOf(amounts);
	if (pace === null) return null;
	return {
		workout: run.workout,
		startedAt: run.startedAt,
		sessionType: run.sessionType,
		basis,
		distanceMetres: amounts.distanceMetres!,
		durationSeconds: amounts.durationSeconds!,
		paceSecondsPerKm: pace
	};
}

/** The distance-weighted pace of several inputs: segmentPace of their amounts added by runTotals. */
const pooledPace = (inputs: readonly RunPace[]) =>
	inputs.length === 0 ? null : paceOf(runTotals(inputs.map((i) => ({ ...i, avgHr: null }))));

export interface TypePace {
	sessionType: SessionType;
	/** Each run's input, oldest first, the week in progress included. */
	runs: RunPace[];
	/** Pace per week in s/km, a gap for a week without one, the week in progress last and flagged. */
	points: SeriesPoint[];
	/** The pace over the complete weeks; null without a run in them. */
	period: number | null;
}

/** Pace by session type for the weeks of `window`, in the vocabulary's order; runs without one are left out. */
export function paceByType(runs: readonly RunFact[], window: Weeks, timeZone: string): TypePace[] {
	const weeks = runsByWeek(runs, window, timeZone).map((w) => ({
		...w,
		paces: w.runs.flatMap((run) => runPace(run) ?? [])
	}));
	return SESSION_TYPES.flatMap((sessionType) => {
		const theirs = weeks.map((w) => ({
			...w,
			paces: w.paces.filter((p) => p.sessionType === sessionType)
		}));
		const inputs = theirs.flatMap((w) => w.paces);
		if (inputs.length === 0) return [];
		const buckets = new Map<IsoDate, number>();
		for (const w of theirs) {
			const pace = pooledPace(w.paces);
			if (pace !== null) buckets.set(w.weekStart, pace);
		}
		return [
			{
				sessionType,
				runs: [...inputs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
				points: fillWeeks(buckets, window.weeks, 'gap', window.inProgress),
				period: pooledPace(theirs.filter((w) => !w.inProgress).flatMap((w) => w.paces))
			}
		];
	});
}

// ---- Long runs -------------------------------------------------------------------------------

export interface WeekLongRun {
	weekStart: IsoDate;
	inProgress: boolean;
	/** The week's long run; null when it had none. */
	run: { workout: string; startedAt: Date; metres: number; seconds: number | null } | null;
	/** How it was found: a long_run session, or the longest run at LONG_RUN_OF_MEAN × the mean. */
	found: 'long_run_session' | 'longest_run' | null;
	/** The latest earlier long run's metres in these weeks; null for none. */
	previousMetres: number | null;
	/** Percent longer (or shorter) than that one; null without both. */
	changePct: number | null;
	/** More than LONG_RUN_JUMP_PCT longer than the one before. */
	jump: boolean;
}

/** The week's long run: its longest long_run session, otherwise its longest run when long enough. */
function longRunOf(runs: readonly RunFact[]) {
	const measured = runs.flatMap((run) => {
		const { distanceMetres, durationSeconds } = wholeRun(run);
		return distanceMetres === null
			? []
			: [{ run, metres: distanceMetres, seconds: durationSeconds }];
	});
	const longest = (list: typeof measured) =>
		list.reduce<(typeof measured)[number] | null>(
			(a, b) => (a && a.metres >= b.metres ? a : b),
			null
		);
	const session = longest(measured.filter((m) => m.run.sessionType === 'long_run'));
	if (session) return { pick: session, found: 'long_run_session' as const };
	const top = longest(measured);
	if (top === null) return { pick: null, found: null };
	const mean = measured.reduce((sum, m) => sum + m.metres, 0) / measured.length;
	if (top.metres < cleanFloat(LONG_RUN_OF_MEAN * mean)) return { pick: null, found: null };
	return { pick: top, found: 'longest_run' as const };
}

/** Each week's long run in `window`, with its change from the long run before and a jump flagged. */
export function longRuns(runs: readonly RunFact[], window: Weeks, timeZone: string): WeekLongRun[] {
	let previous: number | null = null;
	return runsByWeek(runs, window, timeZone).map(({ weekStart, inProgress, runs: theirs }) => {
		const { pick, found } = longRunOf(theirs);
		const { pct } = compare(pick?.metres ?? null, previous, 'up');
		const week: WeekLongRun = {
			weekStart,
			inProgress,
			run: pick && {
				workout: pick.run.workout,
				startedAt: pick.run.startedAt,
				metres: pick.metres,
				seconds: pick.seconds
			},
			found,
			previousMetres: previous,
			changePct: pct,
			jump: pct !== null && pct > LONG_RUN_JUMP_PCT
		};
		if (pick) previous = pick.metres;
		return week;
	});
}

// ---- Best efforts and reported races ---------------------------------------------------------

export interface Effort {
	/** A logged run's workout, or a reported race's id. */
	id: string;
	/** best_effort: the fastest logged run at the distance; effort: another; reported: M2's race_results. */
	label: 'best_effort' | 'effort' | 'reported';
	kind: Extract<MetricKind, 'measured' | 'reported'>;
	/** When it was run: the run's start, or the race's day (null when the owner gave none). */
	on: Date | IsoDate | null;
	distanceMetres: number;
	durationSeconds: number;
	paceSecondsPerKm: number;
	/** A reported race's event name. */
	eventName: string | null;
}

export interface DistanceEfforts {
	distance: EffortDistance;
	label: string;
	metres: number;
	/** The fastest logged effort by pace; null for none. */
	best: Effort | null;
	/** Logged efforts, oldest first. */
	efforts: Effort[];
	/** Reported races at the distance, as M2 stores them. */
	reported: Effort[];
}

/** The standard distance a run's metres are within EFFORT_TOLERANCE of, edges included. */
function effortDistance(metres: number): EffortDistance | null {
	return (
		EFFORT_DISTANCES.find((d) => {
			const target = RACE_DISTANCE_INFO[d].metres!;
			return Math.abs(cleanFloat(metres - target)) <= cleanFloat(target * EFFORT_TOLERANCE);
		}) ?? null
	);
}

/** Efforts at 5 km, 10 km, half and marathon from logged runs, with the owner's reported races. */
export function bestEfforts(
	runs: readonly RunFact[],
	races: readonly RaceResult[]
): DistanceEfforts[] {
	const logged = runs.flatMap((run) => {
		const { distanceMetres, durationSeconds } = wholeRun(run);
		const pace = paceOf({ distanceMetres, durationSeconds });
		const distance = distanceMetres === null ? null : effortDistance(distanceMetres);
		if (pace === null || distance === null) return [];
		const effort: Effort = {
			id: run.workout,
			label: 'effort',
			kind: 'measured',
			on: run.startedAt,
			distanceMetres: distanceMetres!,
			durationSeconds: durationSeconds!,
			paceSecondsPerKm: pace,
			eventName: null
		};
		return [{ distance, effort }];
	});
	return EFFORT_DISTANCES.map((distance) => {
		const efforts = logged
			.filter((l) => l.distance === distance)
			.map((l) => l.effort)
			.sort((a, b) => (a.on as Date).getTime() - (b.on as Date).getTime());
		const fastest = efforts.reduce<Effort | null>(
			(a, b) => (a && a.paceSecondsPerKm <= b.paceSecondsPerKm ? a : b),
			null
		);
		const labelled = efforts.map((e) =>
			e === fastest ? { ...e, label: 'best_effort' as const } : e
		);
		const reported = races.flatMap((race): Effort[] => {
			const pace = paceOf({
				distanceMetres: race.distanceMetres,
				durationSeconds: race.timeSeconds
			});
			if (race.distance !== distance || pace === null) return [];
			return [
				{
					id: race.id,
					label: 'reported',
					kind: 'reported',
					on: race.racedOn,
					distanceMetres: race.distanceMetres,
					durationSeconds: race.timeSeconds,
					paceSecondsPerKm: pace,
					eventName: race.eventName
				}
			];
		});
		return {
			distance,
			label: RACE_DISTANCE_INFO[distance].label,
			metres: RACE_DISTANCE_INFO[distance].metres!,
			best: labelled.find((e) => e.label === 'best_effort') ?? null,
			efforts: labelled,
			reported
		};
	});
}

// ---- Heart rate ------------------------------------------------------------------------------

export interface TypeHeartRate {
	sessionType: SessionType;
	/** Runs of the type in the complete weeks that carry a heart rate and a time. */
	tracked: number;
	/** Ready once HR_MIN_RUNS carry one. */
	availability: Availability;
	/** Their time-weighted mean, through M4's runTotals; null until ready. */
	avgHr: number | null;
}

/** Heart rate by session type over the complete weeks; only types with a tracked run are listed. */
export function heartRateByType(
	runs: readonly RunFact[],
	window: Weeks,
	timeZone: string
): TypeHeartRate[] {
	const complete = runsByWeek(runs, window, timeZone)
		.filter((w) => !w.inProgress)
		.flatMap((w) => w.runs);
	return SESSION_TYPES.flatMap((sessionType) => {
		const carried = complete
			.filter((run) => run.sessionType === sessionType)
			.map(wholeRun)
			.filter((t) => t.avgHr !== null && t.durationSeconds !== null);
		if (carried.length === 0) return [];
		const ready = carried.length >= HR_MIN_RUNS;
		const availability: Availability = ready
			? { ready: true }
			: { ready: false, have: carried.length, need: HR_MIN_RUNS, unit: 'runs' };
		const avgHr = ready
			? runTotals(carried.map((t) => ({ ...t, distanceMetres: null }))).avgHr
			: null;
		return [{ sessionType, tracked: carried.length, availability, avgHr }];
	});
}
