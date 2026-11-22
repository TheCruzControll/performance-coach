/**
 * Moving a program's start (owner decision 2026-11-12): the days week 1 may begin on instead, and
 * when a start may no longer move. Pure: the caller passes the owner's local today.
 *
 * - A start moves only before any training on it: while its first planned day is today or later
 *   and no workout is logged against the program (moveRefusal). Once training has begun, its weeks
 *   are the record of what was done, so the start stays where it is.
 * - The new start is any day from today to `START_DAYS_AHEAD` days ahead. Week 1 is that day's
 *   Monday-to-Sunday week, planned from the day on, so later weeks and blocks stay on Mondays.
 * - The program is then planned again from the new dates (generateProgram), never shifted: its
 *   blocks and weeks stay on Mondays and a dated goal keeps its date, so a taper is placed before
 *   its event from the new start and can never slide past it. An event before the new first
 *   planned day is no longer planned for: eventsAhead names the ones in the window, for the screen
 *   to say so.
 */
import { addDays, mondayOf, parseIsoDate, weekdayOf, type IsoDate } from '../calendar.ts';
import { WEEKDAY_INFO } from '../profile/catalog.ts';
import { PARTIAL_FIRST_WEEK } from '../training/schemas.ts';

/**
 * Decision (owner, 2026-11-22: 'i want to be able to start any day'): week 1 may start on any
 * day from today to this many days ahead. Eight weeks covers a holiday or a busy month; a longer
 * wait is a new program rather than a moved one.
 */
export const START_DAYS_AHEAD = 56;

/** The last day a program may start on, from `today`. */
export const latestStart = (today: IsoDate): IsoDate => addDays(today, START_DAYS_AHEAD);

/** Week 1's dates: its Monday, and its first day with sessions (the Monday, or the start day). */
export interface StartDates {
	startsOn: IsoDate;
	firstPlannedDay: IsoDate;
}

/** Why a start can no longer move: its first planned day has passed, or training was logged. */
export type StartMoveRefusal = 'started' | 'logged';

/** Week 1's dates for a start on `day`: the Monday of its week, and the day itself. */
export const startFrom = (day: IsoDate): StartDates => ({
	startsOn: mondayOf(day),
	firstPlannedDay: day
});

/**
 * Week 1's dates when `value` is a real `YYYY-MM-DD` day from `today` to latestStart(today)
 * (and a Monday, while PARTIAL_FIRST_WEEK is off); null for anything else.
 */
export function startDay(
	value: unknown,
	today: IsoDate,
	{ partialFirstWeek = PARTIAL_FIRST_WEEK } = {}
): StartDates | null {
	if (typeof value !== 'string' || parseIsoDate(value) === null) return null;
	if (value < today || value > latestStart(today)) return null;
	if (!partialFirstWeek && mondayOf(value) !== value) return null;
	return startFrom(value);
}

export const sameStart = (a: StartDates, b: StartDates) =>
	a.startsOn === b.startsOn && a.firstPlannedDay === b.firstPlannedDay;

/** Why the start of a program can't move on `today`; null while it can. */
export function moveRefusal({
	today,
	firstPlannedDay,
	logged
}: {
	today: IsoDate;
	/** The program's first day with sessions, in its current version. */
	firstPlannedDay: IsoDate;
	/** Whether any workout is logged against the program. */
	logged: boolean;
}): StartMoveRefusal | null {
	if (logged) return 'logged';
	if (firstPlannedDay < today) return 'started';
	return null;
}

/**
 * The dated events from today to latestStart(today), earliest first: a start after one of them
 * no longer plans for it, which the Start date screen says.
 */
export function eventsAhead<E extends { date: IsoDate }>(
	today: IsoDate,
	events: readonly E[]
): E[] {
	const latest = latestStart(today);
	return events
		.filter((e) => e.date >= today && e.date <= latest)
		.sort((a, b) => a.date.localeCompare(b.date));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Mon 16 Nov': a start in a decision's words. */
export const startWords = (date: IsoDate) =>
	`${WEEKDAY_INFO[weekdayOf(date)].short} ${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
