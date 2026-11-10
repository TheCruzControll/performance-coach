/**
 * Adherence (PRD §10, §11): planned against completed, skipped and missed, per week, discipline
 * and weekday, with the weekly sessions and training time beside it. The dashboards, the reviews
 * and the progression rules read these, so adherence has one definition.
 *
 * - A planned session is completed by its lineage, as M3's program reads derive it: a completed,
 *   undeleted workout logged against the lineage in any version (`completed`, M3's
 *   completedLineages), or a status M3 already derived. Completed wins over a stored skip.
 * - Otherwise it is skipped (the owner's choice, made before its day too), missed once its day
 *   has passed, or pending today and after. Pending is never due: the rate leaves it out.
 * - The rate is completed ÷ (completed + skipped + missed), as a percentage; null with nothing
 *   planned ('No plan for this period') or nothing due yet. Totals add counts, never rates.
 * - A session counts on the day it is planned now, so a moved one counts on its new day, in its
 *   new week. A lineage is one session: given in two versions' rows, the later row counts, so
 *   pass versions oldest first.
 * - Extra sessions are workouts with no planned lineage (off plan). A planned session logged late,
 *   in a later week, completes its session and is never extra.
 * - The week in progress is kept apart from the complete weeks and flagged; its counts run through
 *   today, and its later days are pending.
 * - Training time adds the durations recorded. A session without one is named and counted, never
 *   taken as 0: a week of only such sessions has no time (null), a week with none has 0.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (today is an argument), imported by path
 * (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: this is not in scripts/analytics-client-imports.test.ts's CLIENT_SAFE.
 */
import { addDays, mondayOf, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { DISCIPLINES, WEEKDAYS } from '../profile/catalog.ts';
import type { Discipline, Weekday } from '../profile/catalog.ts';
import type { SessionView } from '../training/types.ts';
import { cleanFloat } from '../units.ts';
import type { CanonicalWorkoutRow } from '../workout/protocol.ts';
import { weekStarts } from './periods.ts';
import type { PeriodWindow, WeekRange } from './periods.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/** A weekday missed this many times or more in the weeks read is flagged (oftenMissed). */
export const OFTEN_MISSED = 3;

/** Why a rate is null, in words a screen shows. */
export const NO_RATE = {
	no_plan: 'No plan for this period',
	nothing_due: 'Nothing due yet'
} as const;
export type NoRate = keyof typeof NO_RATE;

// ---- Inputs ----------------------------------------------------------------------------------

/** A planned session as M3's program reads give it (SessionView fits): its day now and status. */
export type PlannedSession = Pick<
	SessionView,
	'lineage' | 'date' | 'status' | 'movedFrom' | 'discipline'
>;

/**
 * A completed, undeleted workout (M4's CanonicalWorkoutRow fits, with its day), on the owner's
 * calendar day it started (localDay). Off plan when it has no planned lineage.
 */
export type LoggedWorkout = Pick<
	CanonicalWorkoutRow,
	'id' | 'title' | 'discipline' | 'plannedLineage' | 'durationSeconds'
> & { date: IsoDate };

export interface AdherenceFacts {
	/** The planned sessions of the days read, of every program that plans them. */
	planned: readonly PlannedSession[];
	/** The lineages with a completed, undeleted workout, whenever it was logged. */
	completed: ReadonlySet<string>;
	/** The completed workouts of the days read, planned or not. */
	workouts: readonly LoggedWorkout[];
}

/** The weeks a figure reads: periods.ts's complete weeks and the week in progress. */
export type Weeks = Pick<PeriodWindow, 'weeks' | 'inProgress'>;

// ---- Outcomes and counts ---------------------------------------------------------------------

export type Outcome = 'completed' | 'skipped' | 'missed' | 'pending';

/** One planned session's outcome on `today`. */
export function outcomeOf(
	session: PlannedSession,
	completed: ReadonlySet<string>,
	today: IsoDate
): Outcome {
	if (session.status === 'completed' || completed.has(session.lineage)) return 'completed';
	if (session.status === 'skipped') return 'skipped';
	return session.date < today ? 'missed' : 'pending';
}

export interface AdherenceCounts {
	/** Every planned session: completed + skipped + missed + pending. */
	planned: number;
	completed: number;
	skipped: number;
	missed: number;
	pending: number;
	/** Of the planned sessions, those moved here from another day (each also in its outcome). */
	moved: number;
	/** completed ÷ (completed + skipped + missed) × 100; null, with why, when nothing is due. */
	pct: number | null;
	noRate: NoRate | null;
}

/**
 * One session per lineage, the last given winning, so an edit's later row replaces the earlier.
 * Worked out once per list: every week of a long period asks again of the same facts.
 */
const distinctOf = new WeakMap<readonly PlannedSession[], readonly PlannedSession[]>();
function distinct(sessions: readonly PlannedSession[]): readonly PlannedSession[] {
	let known = distinctOf.get(sessions);
	if (!known) {
		known = [...new Map(sessions.map((session) => [session.lineage, session])).values()];
		distinctOf.set(sessions, known);
	}
	return known;
}

/** Days from `from` to `to`, both included: a WeekRange fits. */
type Span = Pick<WeekRange, 'from' | 'to'>;

const within = (date: IsoDate, from: IsoDate, to: IsoDate) => date >= from && date <= to;

function countOf(
	sessions: readonly PlannedSession[],
	completed: ReadonlySet<string>,
	today: IsoDate
): AdherenceCounts {
	const counts = { completed: 0, skipped: 0, missed: 0, pending: 0 };
	for (const session of sessions) counts[outcomeOf(session, completed, today)] += 1;
	const due = counts.completed + counts.skipped + counts.missed;
	const noRate = sessions.length === 0 ? 'no_plan' : due === 0 ? 'nothing_due' : null;
	return {
		planned: sessions.length,
		...counts,
		moved: sessions.filter((session) => session.movedFrom !== null).length,
		pct: noRate ? null : cleanFloat((counts.completed / due) * 100),
		noRate
	};
}

/** The distinct sessions planned from `from` to `to`, both included; none for no range. */
function plannedIn(facts: AdherenceFacts, range: Span | null) {
	if (range === null) return [];
	return distinct(facts.planned).filter((s) => within(s.date, range.from, range.to));
}

/** The off-plan workouts from `from` to `to`. */
const extrasIn = (workouts: readonly LoggedWorkout[], range: Span) =>
	workouts.filter((w) => w.plannedLineage === null && within(w.date, range.from, range.to)).length;

// ---- Weeks -----------------------------------------------------------------------------------

export interface WeekAdherence extends AdherenceCounts {
	weekStart: IsoDate;
	/** The last day counted: the Sunday, or today for the week in progress. */
	through: IsoDate;
	inProgress: boolean;
	/** Off-plan workouts that week, outside the rate. */
	extra: number;
}

/** A Monday-to-Sunday week's adherence on `today`. Throws RangeError for a day not a Monday. */
export function weekAdherence(
	weekStart: IsoDate,
	facts: AdherenceFacts,
	today: IsoDate
): WeekAdherence {
	if (mondayOf(weekStart) !== weekStart) throw new RangeError(`Not a Monday: ${weekStart}`);
	const sunday = addDays(weekStart, 6);
	const inProgress = within(today, weekStart, sunday);
	const range = { from: weekStart, to: sunday };
	return {
		weekStart,
		through: inProgress ? today : sunday,
		inProgress,
		...countOf(plannedIn(facts, range), facts.completed, today),
		extra: extrasIn(facts.workouts, range)
	};
}

export interface PeriodAdherence {
	/** Each complete week, oldest first. */
	weeks: WeekAdherence[];
	inProgress: WeekAdherence;
	/** The complete weeks together, by their counts: the period's figure. */
	total: AdherenceCounts & { extra: number };
}

/** Adherence for a period's complete weeks, each and together, with the week in progress apart. */
export function periodAdherence(facts: AdherenceFacts, window: Weeks): PeriodAdherence {
	const today = window.inProgress.through;
	const weeks = weekStarts(window.weeks).map((monday) => weekAdherence(monday, facts, today));
	return {
		weeks,
		inProgress: weekAdherence(window.inProgress.weekStart, facts, today),
		total: {
			...countOf(plannedIn(facts, window.weeks), facts.completed, today),
			extra: weeks.reduce((sum, week) => sum + week.extra, 0)
		}
	};
}

// ---- Breakdowns ------------------------------------------------------------------------------

export interface DisciplineAdherence extends AdherenceCounts {
	discipline: Discipline;
}

/** Adherence by discipline over `weeks`, in the catalogue's order, for the disciplines planned. */
export function adherenceByDiscipline(
	facts: AdherenceFacts,
	weeks: WeekRange | null,
	today: IsoDate
): DisciplineAdherence[] {
	const sessions = plannedIn(facts, weeks);
	return DISCIPLINES.flatMap((discipline) => {
		const theirs = sessions.filter((s) => s.discipline === discipline);
		if (theirs.length === 0) return [];
		return [{ discipline, ...countOf(theirs, facts.completed, today) }];
	});
}

export interface WeekdayAdherence extends AdherenceCounts {
	weekday: Weekday;
	/** Missed OFTEN_MISSED times or more in the weeks read. */
	oftenMissed: boolean;
}

/** Adherence by weekday over `weeks`, all seven, Monday first, each on the day planned now. */
export function adherenceByWeekday(
	facts: AdherenceFacts,
	weeks: WeekRange | null,
	today: IsoDate
): WeekdayAdherence[] {
	const sessions = plannedIn(facts, weeks);
	return WEEKDAYS.map((weekday) => {
		const counts = countOf(
			sessions.filter((s) => weekdayOf(s.date) === weekday),
			facts.completed,
			today
		);
		return { weekday, ...counts, oftenMissed: counts.missed >= OFTEN_MISSED };
	});
}

// ---- Sessions and training time --------------------------------------------------------------

/** A per-week figure for a period: each complete week, the week in progress apart, and a total. */
export interface Weekly<T> {
	weeks: (T & { weekStart: IsoDate; inProgress: false })[];
	inProgress: T & { weekStart: IsoDate; inProgress: true };
	/** The complete weeks together. */
	total: T;
}

/** `figure` over each complete week, the week in progress and the complete weeks together. */
function weekly<T>(
	workouts: readonly LoggedWorkout[],
	window: Weeks,
	figure: (workouts: readonly LoggedWorkout[]) => T
): Weekly<T> {
	const of = (from: IsoDate, to: IsoDate) =>
		figure(workouts.filter((w) => within(w.date, from, to)));
	const { inProgress } = window;
	return {
		weeks: weekStarts(window.weeks).map((weekStart) => ({
			weekStart,
			inProgress: false as const,
			...of(weekStart, addDays(weekStart, 6))
		})),
		inProgress: {
			weekStart: inProgress.weekStart,
			inProgress: true as const,
			...of(inProgress.weekStart, inProgress.through)
		},
		total: window.weeks ? of(window.weeks.from, window.weeks.to) : figure([])
	};
}

/** Each discipline's value, in the catalogue's order, for the disciplines present. */
function byDiscipline<V>(
	workouts: readonly LoggedWorkout[],
	value: (theirs: LoggedWorkout[]) => V
): Partial<Record<Discipline, V>> {
	return Object.fromEntries(
		DISCIPLINES.flatMap((d) => {
			const theirs = workouts.filter((w) => w.discipline === d);
			return theirs.length ? [[d, value(theirs)]] : [];
		})
	);
}

export interface SessionCount {
	sessions: number;
	byDiscipline: Partial<Record<Discipline, number>>;
}

/** Completed workouts, planned and off plan, by week and discipline. */
export function weeklySessions(
	workouts: readonly LoggedWorkout[],
	window: Weeks
): Weekly<SessionCount> {
	return weekly(workouts, window, (theirs) => ({
		sessions: theirs.length,
		byDiscipline: byDiscipline(theirs, (d) => d.length)
	}));
}

/** A session with no duration recorded, named so a screen can say which. */
export type Untimed = Pick<LoggedWorkout, 'id' | 'title' | 'date' | 'discipline'>;

export interface TrainingTime {
	/** The recorded durations added; null when there are sessions and none has one, 0 for none. */
	seconds: number | null;
	byDiscipline: Partial<Record<Discipline, number | null>>;
	/** The sessions with no duration, by day: counted and named, never taken as 0. */
	untimed: Untimed[];
}

/** The durations of `workouts` added; null when there are some and none has a duration. */
function secondsOf(workouts: readonly LoggedWorkout[]): number | null {
	const known = workouts.flatMap((w) => (w.durationSeconds === null ? [] : [w.durationSeconds]));
	if (known.length === 0) return workouts.length === 0 ? 0 : null;
	return known.reduce((sum, seconds) => sum + seconds, 0);
}

/** Training time by week and discipline, with the sessions that have no duration named. */
export function trainingTime(
	workouts: readonly LoggedWorkout[],
	window: Weeks
): Weekly<TrainingTime> {
	return weekly(workouts, window, (theirs) => ({
		seconds: secondsOf(theirs),
		byDiscipline: byDiscipline(theirs, secondsOf),
		untimed: theirs
			.filter((w) => w.durationSeconds === null)
			.map(({ id, title, date, discipline }) => ({ id, title, date, discipline }))
			.sort((a, b) => a.date.localeCompare(b.date))
	}));
}
