/**
 * The week's days (PRD §2, §5; m3-plan 'One day rule'). demand.ts applies these numbers, and
 * strength (m3/17), running and commitments (m3/18) and placement (m3/23) all read its result,
 * so a week has one day rule:
 * - daysPerWeek counts every training day, commitment days included, capped by the days open to
 *   training: the available days and the commitment days (m3-plan open question 'Days per week').
 * - A commitment counts toward its discipline's quota (COMMITMENT_QUOTA).
 * - The free days go to the goals by priority: every goal up to its `min` first, then by turns up
 *   to its `max` (SESSIONS_WANTED). A day no goal asks for gets a mobility session.
 * - Two sessions share a day only under DOUBLES (doubleTime); otherwise the lowest-priority
 *   session is dropped.
 */
import type { Discipline, TimeOfDay } from '../../profile/catalog.ts';

/** What a commitment counts toward: strength days, runs, or other sessions. */
export type Quota = 'strength' | 'runs' | 'other';

/**
 * A running club is a run, counted in weekly run volume by its duration. A strength or
 * CrossFit-style class is a strength day with no hard sets credited, because the class sets its
 * content. Muay Thai, athletic and custom classes are other sessions (m3-plan open question
 * 'Commitments by discipline').
 */
export const COMMITMENT_QUOTA: Readonly<Record<Discipline, Quota>> = {
	running: 'runs',
	distance_running: 'runs',
	powerlifting: 'strength',
	weightlifting: 'strength',
	strength: 'strength',
	hypertrophy: 'strength',
	muay_thai: 'other',
	athletic: 'other',
	custom: 'other'
};

/** What the generator plans for a goal: strength days, runs, or a discipline's own sessions. */
export type Stream = 'strength' | 'runs' | 'muay_thai' | 'custom';

export interface SessionsWanted {
	stream: Stream;
	/** The fewest sessions a week that still move the goal forward. */
	min: number;
	/** The most worth planning; days beyond every goal's most get mobility. */
	max: number;
}

/** The sessions a week each discipline asks for when a goal trains it. */
export const SESSIONS_WANTED: Readonly<Record<Discipline, SessionsWanted>> = {
	// Each competition lift wants practice two or three times a week: SBD on 3–4 days.
	powerlifting: { stream: 'strength', min: 3, max: 4 },
	// The snatch and the clean and jerk are skills, and frequency builds them.
	weightlifting: { stream: 'strength', min: 3, max: 5 },
	// Full body twice a week keeps strength moving; four days is upper/lower.
	strength: { stream: 'strength', min: 2, max: 4 },
	// 10–20 hard sets per muscle need three sessions or more; push/pull/legs twice is six.
	hypertrophy: { stream: 'strength', min: 3, max: 6 },
	// Athletic performance is built in the gym: m3/17's athletic split, with a power slot.
	athletic: { stream: 'strength', min: 2, max: 4 },
	// Two runs a week keep running fitness; five is plenty without a race goal.
	running: { stream: 'runs', min: 2, max: 5 },
	// A half or full marathon needs at least three runs a week, a long run among them.
	distance_running: { stream: 'runs', min: 3, max: 6 },
	// Technique and timing need two sessions a week; classes give more.
	muay_thai: { stream: 'muay_thai', min: 2, max: 4 },
	// The owner's own discipline, with its content theirs: at least one session of it.
	custom: { stream: 'custom', min: 1, max: 3 }
};

/**
 * A second session in a day sits beside one commitment, at a time of its own: one of two distinct
 * preferred times the commitment leaves free, or, when the owner gave fewer (or 'it varies'), the
 * other end of the day from a commitment with a set time (doubleTime). Each session is at most
 * `maxSessionMinutes`, so the day leaves recovery between them.
 */
export const DOUBLES = {
	distinctTimes: 2,
	maxSessionMinutes: 90,
	rationale:
		'two sessions in a day need two times (two preferred times, or a commitment with a set time) and sessions of 90 min or less'
} as const;

/** Beside a commitment at this time with no second preferred time, a session goes at the other end of the day. */
export const OTHER_END_OF_DAY: Readonly<
	Record<Exclude<TimeOfDay, 'varies'>, Exclude<TimeOfDay, 'varies'>>
> = {
	early_morning: 'evening',
	morning: 'evening',
	midday: 'evening',
	afternoon: 'morning',
	evening: 'morning'
};

/**
 * The time a generated session takes beside a commitment at `taken`, or null when the day cannot
 * hold a second session (DOUBLES): with two distinct preferred times, the first one `taken` leaves
 * free. Beside a commitment with a set time: the one preferred time, if it is at the other end of
 * the day; with no preferred time ('it varies'), OTHER_END_OF_DAY. Otherwise null.
 */
export function doubleTime(
	taken: TimeOfDay | null,
	preferred: readonly TimeOfDay[]
): Exclude<TimeOfDay, 'varies'> | null {
	const distinct = preferred.filter((t): t is Exclude<TimeOfDay, 'varies'> => t !== 'varies');
	if (distinct.length >= DOUBLES.distinctTimes) return distinct.find((t) => t !== taken) ?? null;
	if (taken === null || taken === 'varies') return null;
	if (distinct.length === 0) return OTHER_END_OF_DAY[taken];
	const [only] = distinct as [Exclude<TimeOfDay, 'varies'>];
	return OTHER_END_OF_DAY[only] === OTHER_END_OF_DAY[taken] ? null : only;
}
