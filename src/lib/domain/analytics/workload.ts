/**
 * Workload (PRD §10, §11): session-RPE load across disciplines, the acute:chronic ratio with its
 * caveat, monotony and strain, Muay Thai load and the recovery notes. Progress, the reviews and
 * the progression rules read these, so load has one definition.
 *
 * - A session's load is M3's sessionLoadOf: minutes × session RPE (M1's sessionLoad, in AU). The
 *   RPE is the workout's own, else its run record's, else its other-session record's; the
 *   duration falls back the same way (an other session's minutes always exist).
 * - A session with no RPE or no duration is 'load unknown': counted and named, never taken as 0.
 *   Totals add the known loads only, and a day or week of only unknown loads has no total (null);
 *   one with no sessions has 0.
 * - Days are the owner's calendar days (localDay in the profile's time zone), so a clock change
 *   never moves a session or drops a day. Weeks are periods.ts's: the complete weeks, with the
 *   week in progress apart, flagged, and never in a total, a monotony or a strain.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (today is an argument), imported by path
 * (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: this is not in scripts/analytics-client-imports.test.ts's CLIENT_SAFE.
 */
import { addDays } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { untrusted } from '../coach/memory.ts';
import type { UntrustedText } from '../coach/memory.ts';
import { localDay } from '../dates.ts';
import { acuteChronicRatio } from '../load.ts';
import type { DisciplineTone } from '../profile/catalog.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type { CustomMetric } from '../training/types.ts';
import { sessionTone } from '../training/vocabulary.ts';
import type { OtherSessionKind, SessionType } from '../training/vocabulary.ts';
import { cleanFloat } from '../units.ts';
import type { OtherFields, RunFields } from '../workout/mutations.ts';
import type { Weekly, Weeks } from './adherence.ts';
import { weekStarts } from './periods.ts';
import { mean, sd, total } from './series.ts';
import type { SeriesPoint } from './types.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/** The order load stacks in, bottom first: the charts' fixed discipline stack (M6 palette). */
export const LOAD_STACK = [
	'strength',
	'hypertrophy',
	'conditioning',
	'combat',
	'running'
] as const satisfies readonly DisciplineTone[];
export type LoadGroup = (typeof LOAD_STACK)[number];

/** M1's acuteChronicRatio windows, in days. */
export const ACUTE_DAYS = 7;
export const CHRONIC_DAYS = 28;

/**
 * Shown with every ratio, because its link to injury is debated: what it can and cannot say. The
 * bands are rules of thumb, and say so.
 */
export const ACWR_CAVEAT = {
	text:
		'A rough guide to how fast your load is rising, not an injury predictor. About 0.8–1.3 is ' +
		'typical and above 1.5 is a sharp rise: both are rules of thumb.',
	typical: { from: 0.8, to: 1.3, ruleOfThumb: true },
	sharp: { above: 1.5, ruleOfThumb: true }
} as const;

/**
 * Where Progress shows the ratio: with its caveat as planned ('shown'), behind 'More', or not at
 * all. The plan's default, still an open question for the owner.
 */
export type AcwrPlacement = 'shown' | 'more' | 'dropped';
export const ACWR_PLACEMENT: AcwrPlacement = 'shown';

/** A Muay Thai session at this RPE or above is hard. */
export const HARD_RPE = 7;

/**
 * The other-session metric keys that count rounds (M3's Muay Thai templates store `rounds`). Any
 * other key is ignored and named, so a key M4's logging adds shows up rather than vanishing.
 */
export const ROUND_KEYS = ['rounds', 'sparring_rounds'] as const;

/** How many recent recovery notes a summary carries, and how much of each. */
export const LATEST_NOTES = 3;
export const NOTE_MAX_CHARS = 500;

// ---- Session loads ---------------------------------------------------------------------------

/**
 * A completed, undeleted workout with its run or other-session record, as the facts loader reads
 * it (M4's CanonicalWorkoutRow fits, with startedAt as a Date).
 */
export interface LoggedSession {
	id: string;
	title: string;
	sessionType: SessionType;
	startedAt: Date;
	durationSeconds: number | null;
	sessionRpe: number | null;
	run: Pick<RunFields, 'durationSeconds' | 'rpe'> | null;
	other: Pick<OtherFields, 'kind' | 'durationMinutes' | 'rpe' | 'metrics'> | null;
}

/** What an unknown load lacks. */
export type Missing = 'rpe' | 'duration' | 'both';

export interface SessionLoad {
	id: string;
	title: string;
	/** The owner's calendar day it started on. */
	date: IsoDate;
	group: LoadGroup;
	minutes: number | null;
	rpe: number | null;
	/** Which record the RPE came from. */
	rpeFrom: 'session' | 'run' | 'other' | null;
	/** AU; null: load unknown, with `missing` saying why. */
	load: number | null;
	missing: Missing | null;
}

/** A session whose load is unknown, named so a screen can say which and why. */
export type UnknownLoad = Pick<SessionLoad, 'id' | 'title' | 'date' | 'group'> & {
	missing: Missing;
};

function rpeOf(s: LoggedSession): Pick<SessionLoad, 'rpe' | 'rpeFrom'> {
	if (s.sessionRpe !== null) return { rpe: s.sessionRpe, rpeFrom: 'session' };
	if (s.run && s.run.rpe !== null) return { rpe: s.run.rpe, rpeFrom: 'run' };
	if (s.other && s.other.rpe !== null) return { rpe: s.other.rpe, rpeFrom: 'other' };
	return { rpe: null, rpeFrom: null };
}

function secondsOf(s: LoggedSession): number | null {
	return (
		s.durationSeconds ?? s.run?.durationSeconds ?? (s.other ? s.other.durationMinutes * 60 : null)
	);
}

/** Each session's load on the owner's day, in the order given. */
export function sessionLoads(sessions: readonly LoggedSession[], timeZone: string): SessionLoad[] {
	return sessions.map((s) => {
		const { rpe, rpeFrom } = rpeOf(s);
		const seconds = secondsOf(s);
		const load = sessionLoadOf({ durationSeconds: seconds, sessionRpe: rpe });
		return {
			id: s.id,
			title: s.title,
			date: localDay(s.startedAt, timeZone),
			group: sessionTone(s.sessionType),
			minutes: seconds === null ? null : seconds / 60,
			rpe,
			rpeFrom,
			load,
			missing: load === null ? missingOf(rpe, seconds) : null
		};
	});
}

function missingOf(rpe: number | null, seconds: number | null): Missing {
	if (rpe === null) return seconds === null ? 'both' : 'rpe';
	return 'duration';
}

/** The known loads added: null when there are loads and none is known, 0 for none. */
function knownLoad(loads: readonly SessionLoad[]): number | null {
	const known = loads.flatMap((l) => (l.load === null ? [] : [l.load]));
	if (known.length === 0) return loads.length === 0 ? 0 : null;
	return total(known);
}

const unknownOf = (loads: readonly SessionLoad[]): UnknownLoad[] =>
	loads.flatMap(({ id, title, date, group, missing }) =>
		missing === null ? [] : [{ id, title, date, group, missing }]
	);

const between = <T extends { date: IsoDate }>(items: readonly T[], from: IsoDate, to: IsoDate) =>
	items.filter((item) => item.date >= from && item.date <= to);

// ---- Days ------------------------------------------------------------------------------------

export interface DailyLoad {
	date: IsoDate;
	/** The known loads added; 0 for a rest day, null for a day of only unknown loads. */
	load: number | null;
	sessions: number;
	unknown: number;
}

/** One entry per calendar day from `from` to `through`, both included, oldest first. */
export function dailyLoads(
	loads: readonly SessionLoad[],
	from: IsoDate,
	through: IsoDate
): DailyLoad[] {
	if (through < from) throw new RangeError(`${through} is before ${from}`);
	const byDate = Map.groupBy(between(loads, from, through), (l) => l.date);
	const days: DailyLoad[] = [];
	for (let date = from; date <= through; date = addDays(date, 1)) {
		const theirs = byDate.get(date) ?? [];
		const unknown = theirs.filter((l) => l.load === null).length;
		days.push({ date, load: knownLoad(theirs), sessions: theirs.length, unknown });
	}
	return days;
}

/**
 * Foster's monotony of a complete week: the mean of its 7 daily loads over their sample SD
 * (series.ts's sd). A day of only unknown loads reads as no known load. Null when the SD is 0
 * (every day the same, an empty week too). Throws RangeError for anything but 7 days.
 */
export function monotony(week: readonly DailyLoad[]): number | null {
	const raw = rawMonotony(week);
	return raw === null ? null : cleanFloat(raw);
}

/** Unrounded, so strain multiplies the exact monotony. */
function rawMonotony(week: readonly DailyLoad[]): number | null {
	if (week.length !== 7) throw new RangeError(`A week has 7 days, not ${week.length}`);
	const values = week.map((day) => day.load ?? 0);
	const spread = sd(values);
	return spread ? mean(values)! / spread : null;
}

// ---- Weeks -----------------------------------------------------------------------------------

export interface LoadFigure {
	load: number | null;
	/** The known load of each group, all of them in LOAD_STACK order; they add to `load`. */
	byGroup: { group: LoadGroup; load: number }[];
	sessions: number;
	unknown: UnknownLoad[];
}

export interface WeekLoad extends LoadFigure {
	weekStart: IsoDate;
	/** The last day counted: the Sunday, or today for the week in progress. */
	through: IsoDate;
	inProgress: boolean;
	/** Complete weeks only; null in progress and with no spread (monotony). */
	monotony: number | null;
	/** The week's load × its monotony: complete weeks only. */
	strain: number | null;
}

export interface PeriodLoad {
	weeks: WeekLoad[];
	inProgress: WeekLoad;
	/** The complete weeks together. */
	total: LoadFigure;
}

function figureOf(loads: readonly SessionLoad[]): LoadFigure {
	return {
		load: knownLoad(loads),
		byGroup: LOAD_STACK.map((group) => ({
			group,
			load: knownLoad(loads.filter((l) => l.group === group && l.load !== null)) ?? 0
		})),
		sessions: loads.length,
		unknown: unknownOf(loads)
	};
}

function weekOf(
	loads: readonly SessionLoad[],
	weekStart: IsoDate,
	through: IsoDate | null
): WeekLoad {
	const last = through ?? addDays(weekStart, 6);
	const figure = figureOf(between(loads, weekStart, last));
	const m = through === null ? rawMonotony(dailyLoads(loads, weekStart, last)) : null;
	return {
		weekStart,
		through: last,
		inProgress: through !== null,
		...figure,
		monotony: m === null ? null : cleanFloat(m),
		strain: m === null || figure.load === null ? null : cleanFloat(figure.load * m)
	};
}

/** Load by week and group: each complete week, the week in progress apart, and the total. */
export function weeklyLoad(loads: readonly SessionLoad[], window: Weeks): PeriodLoad {
	const { weeks, inProgress } = window;
	return {
		weeks: weekStarts(weeks).map((monday) => weekOf(loads, monday, null)),
		inProgress: weekOf(loads, inProgress.weekStart, inProgress.through),
		total: figureOf(weeks ? between(loads, weeks.from, weeks.to) : [])
	};
}

// ---- Acute:chronic ratio ---------------------------------------------------------------------

export type AcwrZone = 'low' | 'typical' | 'raised' | 'sharp';

export interface AcuteChronic {
	from: IsoDate;
	through: IsoDate;
	days: number;
	/** M1's exponentially weighted averages, AU per day, as it gives them. */
	acute: number;
	chronic: number;
	/** Null with no known load (chronic 0). */
	ratio: number | null;
	/** The ratio against ACWR_CAVEAT's rules of thumb. */
	zone: AcwrZone | null;
	/** Sessions whose load was unknown, left out of the days read. */
	unknown: number;
	caveat: typeof ACWR_CAVEAT;
}

function zoneOf(ratio: number | null): AcwrZone | null {
	if (ratio === null) return null;
	if (ratio < ACWR_CAVEAT.typical.from) return 'low';
	if (ratio <= ACWR_CAVEAT.typical.to) return 'typical';
	return ratio > ACWR_CAVEAT.sharp.above ? 'sharp' : 'raised';
}

/**
 * M1's acuteChronicRatio over daily loads, oldest first and ending on the day it is read for.
 * Start them on the day of the first activity: days before it would read as rest never taken.
 * Null before CHRONIC_DAYS days.
 */
export function acwr(days: readonly DailyLoad[]): AcuteChronic | null {
	const m1 = acuteChronicRatio(
		days.map((day) => day.load ?? 0),
		ACUTE_DAYS,
		CHRONIC_DAYS
	);
	if (m1 === null) return null;
	return {
		from: days[0]!.date,
		through: days.at(-1)!.date,
		days: days.length,
		...m1,
		zone: zoneOf(m1.ratio),
		unknown: days.reduce((sum, day) => sum + day.unknown, 0),
		caveat: ACWR_CAVEAT
	};
}

// ---- Muay Thai -------------------------------------------------------------------------------

export interface MuayThaiFigure {
	sessions: number;
	/** The known minutes added; null when there are sessions and none has a duration. */
	minutes: number | null;
	load: number | null;
	unknown: UnknownLoad[];
	/** Sessions at HARD_RPE or above. */
	hard: number;
	/** Rounds from ROUND_KEYS, by session kind; total null when no session recorded any. */
	rounds: { total: number | null; byKind: Partial<Record<OtherSessionKind, number>> };
	/** Metric keys that are not ROUND_KEYS, distinct and sorted: ignored, and named. */
	ignoredKeys: string[];
	/** Round metrics whose value is not a whole number of 0 or more: ignored. */
	malformed: { id: string; key: string }[];
}

const isRoundKey = (key: string) => (ROUND_KEYS as readonly string[]).includes(key);
const isCount = (value: CustomMetric['value']): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

type Combat = SessionLoad & { kind: OtherSessionKind | null; metrics: readonly CustomMetric[] };

function muayThaiFigure(sessions: readonly Combat[]): MuayThaiFigure {
	const byKind: Partial<Record<OtherSessionKind, number>> = {};
	const ignored = new Set<string>();
	const malformed: { id: string; key: string }[] = [];
	let rounds: number | null = null;
	for (const s of sessions) {
		for (const { key, value } of s.metrics) {
			if (!isRoundKey(key)) ignored.add(key);
			else if (!isCount(value)) malformed.push({ id: s.id, key });
			else if (s.kind !== null) {
				rounds = (rounds ?? 0) + value;
				byKind[s.kind] = (byKind[s.kind] ?? 0) + value;
			}
		}
	}
	const minutes = sessions.flatMap((s) => (s.minutes === null ? [] : [s.minutes]));
	return {
		sessions: sessions.length,
		minutes: minutes.length ? total(minutes) : sessions.length ? null : 0,
		load: knownLoad(sessions),
		unknown: unknownOf(sessions),
		hard: sessions.filter((s) => s.rpe !== null && s.rpe >= HARD_RPE).length,
		rounds: { total: rounds, byKind },
		ignoredKeys: [...ignored].sort(),
		malformed
	};
}

/** Muay Thai (the combat group) by week: each complete week, the week in progress and the total. */
export function muayThaiLoad(
	sessions: readonly LoggedSession[],
	timeZone: string,
	window: Weeks
): Weekly<MuayThaiFigure> {
	const loads = sessionLoads(sessions, timeZone);
	const combat: Combat[] = loads.flatMap((load, n) =>
		load.group === 'combat'
			? [
					{
						...load,
						kind: sessions[n]!.other?.kind ?? null,
						metrics: sessions[n]!.other?.metrics ?? []
					}
				]
			: []
	);
	return weekly(combat, window, muayThaiFigure);
}

// ---- Recovery --------------------------------------------------------------------------------

/** A recovery note (M3's recovery_notes row fits): any value may be blank, the note untrusted. */
export interface RecoveryEntry {
	id: string;
	notedOn: IsoDate;
	sleepHours: number | null;
	soreness: number | null;
	energy: number | null;
	stress: number | null;
	note: string | null;
}

export const RECOVERY_MEASURES = ['sleepHours', 'soreness', 'energy', 'stress'] as const;
export type RecoveryMeasure = (typeof RECOVERY_MEASURES)[number];

/** A measure's mean over the notes that give it, and how many do; null with none. */
export interface MeasureMean {
	mean: number | null;
	count: number;
}

export type RecoveryMeans = Record<RecoveryMeasure, MeasureMean> & { notes: number };

export interface RecoverySummary extends Weekly<RecoveryMeans> {
	/** Each measure's weekly mean, the complete weeks then the week in progress (flagged). */
	series: Record<RecoveryMeasure, SeriesPoint[]>;
	/** The latest notes with text, newest first: data, never instructions. */
	latest: { id: string; notedOn: IsoDate; text: UntrustedText }[];
}

function meansOf(entries: readonly (RecoveryEntry & { date: IsoDate })[]): RecoveryMeans {
	const of = (measure: RecoveryMeasure): MeasureMean => {
		const values = entries.flatMap((e) => (e[measure] === null ? [] : [e[measure]]));
		return { mean: mean(values), count: values.length };
	};
	return {
		notes: entries.length,
		sleepHours: of('sleepHours'),
		soreness: of('soreness'),
		energy: of('energy'),
		stress: of('stress')
	};
}

/**
 * Weekly means of sleep, soreness, energy and stress, blanks left out, with series for their
 * trends and the latest notes. Pass the notes in the order recorded: of one day, the later wins.
 */
export function recoverySummary(notes: readonly RecoveryEntry[], window: Weeks): RecoverySummary {
	const dated = notes.map((n) => ({ ...n, date: n.notedOn }));
	const summary = weekly(dated, window, meansOf);
	const points = [...summary.weeks, summary.inProgress];
	const series = Object.fromEntries(
		RECOVERY_MEASURES.map((m) => [
			m,
			points.map((w) => ({ at: w.weekStart, value: w[m].mean, inProgress: w.inProgress }))
		])
	) as Record<RecoveryMeasure, SeriesPoint[]>;
	const from = window.weeks?.from ?? window.inProgress.weekStart;
	const latest = between(dated, from, window.inProgress.through)
		.flatMap((n, order) => (n.note === null ? [] : [{ n, order }]))
		.sort((a, b) => b.n.notedOn.localeCompare(a.n.notedOn) || b.order - a.order)
		.slice(0, LATEST_NOTES)
		.map(({ n }) => ({ id: n.id, notedOn: n.notedOn, text: untrusted(n.note!, NOTE_MAX_CHARS) }));
	return { ...summary, series, latest };
}

// ---- Shared ----------------------------------------------------------------------------------

/** `figure` over each complete week, the week in progress and the complete weeks together. */
function weekly<T extends { date: IsoDate }, F>(
	items: readonly T[],
	window: Weeks,
	figure: (items: readonly T[]) => F
): Weekly<F> {
	const { weeks, inProgress } = window;
	return {
		weeks: weekStarts(weeks).map((weekStart) => ({
			weekStart,
			inProgress: false as const,
			...figure(between(items, weekStart, addDays(weekStart, 6)))
		})),
		inProgress: {
			weekStart: inProgress.weekStart,
			inProgress: true as const,
			...figure(between(items, inProgress.weekStart, inProgress.through))
		},
		total: figure(weeks ? between(items, weeks.from, weeks.to) : [])
	};
}
