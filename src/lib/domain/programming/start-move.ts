/**
 * Moving a program's start (owner decision 2026-11-12): the days week 1 may begin on instead,
 * and when a start may no longer move. Pure: the caller passes the owner's local today.
 *
 * - A start moves only before any training on it: while its first planned day is today or later
 *   and no workout is logged against the program (moveRefusal). Once training has begun, its weeks
 *   are the record of what was done, so the start stays where it is.
 * - The new start is a whole week from a Monday, as a build's 'Next Monday' is: one of the next
 *   MOVE_WEEKS_AHEAD Mondays, from the next one (today, on a Monday). 'This week', from today, is
 *   offered as the build offers it: while a part first week is allowed, on any day but Monday.
 *   Earlier and later both count, so moving back to an earlier choice undoes a move.
 * - The program is then planned again from the new dates (generateProgram), never shifted: its
 *   blocks and weeks stay on Mondays and a dated goal keeps its date, so a taper is placed before
 *   its event from the new start and can never slide past it. An event before the new first
 *   planned day is no longer planned for: eventsSkipped names them, for the screen to say so.
 */
import { addDays, mondayOf, weekdayOf, type IsoDate } from '../calendar.ts';
import { WEEKDAY_INFO } from '../profile/catalog.ts';
import { PARTIAL_FIRST_WEEK } from '../training/schemas.ts';

/**
 * Decision (owner decision 2026-11-12, 'move a program's start date'): how many Mondays the move
 * offers, the next one first. Eight weeks covers a holiday or a busy month; a longer wait is a new
 * program rather than a moved one.
 */
export const MOVE_WEEKS_AHEAD = 8;

/** Week 1's dates: its Monday, and its first day with sessions (the Monday, or today). */
export interface StartDates {
	startsOn: IsoDate;
	firstPlannedDay: IsoDate;
}

/** A choice as a form posts it: 'this_week', or the Monday week 1 starts on. */
export type StartValue = 'this_week' | IsoDate;

export interface StartChoice extends StartDates {
	value: StartValue;
}

/** Why a start can no longer move: its first planned day has passed, or training was logged. */
export type StartMoveRefusal = 'started' | 'logged';

/** The starts a move offers on `today`, earliest first. */
export function startChoices(
	today: IsoDate,
	{ partialFirstWeek = PARTIAL_FIRST_WEEK, weeks = MOVE_WEEKS_AHEAD } = {}
): StartChoice[] {
	const monday = mondayOf(today);
	const first = monday === today ? today : addDays(monday, 7);
	const thisWeek: StartChoice[] =
		partialFirstWeek && monday !== today
			? [{ value: 'this_week', startsOn: monday, firstPlannedDay: today }]
			: [];
	const mondays = Array.from({ length: weeks }, (_, i): StartChoice => {
		const startsOn = addDays(first, 7 * i);
		return { value: startsOn, startsOn, firstPlannedDay: startsOn };
	});
	return [...thisWeek, ...mondays];
}

/** The choice `value` names among today's, or null for one the move does not offer. */
export function choiceOf(
	value: unknown,
	today: IsoDate,
	options?: Parameters<typeof startChoices>[1]
): StartChoice | null {
	return startChoices(today, options).find((c) => c.value === value) ?? null;
}

/** The choice that keeps `current` as it is, if today's choices hold one. */
export function currentChoice(
	current: StartDates,
	today: IsoDate,
	options?: Parameters<typeof startChoices>[1]
): StartChoice | null {
	return startChoices(today, options).find((c) => sameStart(c, current)) ?? null;
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

/** The dated events, from today on, that fall before `start`'s first planned day. */
export function eventsSkipped<E extends { date: IsoDate }>(
	start: StartDates,
	today: IsoDate,
	events: readonly E[]
): E[] {
	return events.filter((e) => e.date >= today && e.date < start.firstPlannedDay);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Mon 16 Nov': a start in a decision's words. */
export const startWords = (date: IsoDate) =>
	`${WEEKDAY_INFO[weekdayOf(date)].short} ${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
