/**
 * The one definition of a period (PRD §10): which days a Progress figure covers, what it is
 * compared with, how its series is bucketed and which weeks its trend verdict reads.
 *
 * - A period is whole Monday-to-Sunday weeks that have ended: the complete weeks ending the
 *   Sunday before today's week, on the owner's calendar (calendar.ts, so no time zone or clock
 *   change can move a day). Totals, averages, trends and comparisons use these weeks only, so 11
 *   weeks and 3 days are never set against 12 full weeks, and a Wednesday never looks like a
 *   decline.
 * - Today's week is the week in progress, Monday to today, always kept apart: it is shown as
 *   'This week so far' and compared with the same days of last week (sameDaysLastWeek). This is
 *   the M6 plan's default, still an open question for the owner.
 * - The previous period is as many complete weeks again, ending the day before. 'all' has none.
 * - 'all' starts on the Monday of the owner's first activity, and its series is bucketed by month
 *   once it holds more than MONTHLY_AFTER_WEEKS weeks.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (today is an argument), imported by path
 * (no index file), no zod, no runtime import of domain/programming or domain/exercises, and
 * client-safe only when listed in scripts/analytics-client-imports.test.ts. This module is
 * client-safe. The periods' names, labels and ?period parsing live in period-names.ts (re-exported
 * here), which is what a screen's switcher loads: it keeps these windows and the calendar out of
 * every Progress route's initial JavaScript.
 */
import { addDays, daysBetween, mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import type { Period } from './period-names.ts';
import type { Bucket } from './types.ts';

export { DEFAULT_PERIOD, PERIOD_LABEL, PERIODS, parsePeriod, type Period } from './period-names.ts';

const PERIOD_WEEKS: Readonly<Record<Exclude<Period, 'all'>, number>> = {
	'4w': 4,
	'12w': 12,
	'26w': 26,
	'52w': 52
};

/**
 * 'all' switches from weekly to monthly buckets beyond this many complete weeks (two years), so
 * a long history stays a readable chart and a small page. An owner's choice: change it here.
 */
export const MONTHLY_AFTER_WEEKS = 104;

/**
 * The fewest complete weeks a trend verdict reads. A shorter period (4w) shows its own numbers
 * and comparisons but takes its verdict from the last TREND_MIN_WEEKS complete weeks, and says
 * so (trendWindow). Open question for the owner: or show 'Choose 12 weeks or longer for trends'.
 */
export const TREND_MIN_WEEKS = 12;

/** Whole Monday-to-Sunday weeks: the first Monday, the last Sunday and how many weeks. */
export interface WeekRange {
	from: IsoDate;
	to: IsoDate;
	count: number;
}

/** Today's week: its Monday, today, and how many days of it have begun (1 on a Monday, 7 on a Sunday). */
export interface InProgressWeek {
	weekStart: IsoDate;
	through: IsoDate;
	days: number;
}

/** Calendar days from `from` to `through`, both included. */
export interface DayRange {
	from: IsoDate;
	through: IsoDate;
	days: number;
}

export interface PeriodWindow {
	period: Period;
	/** The period's complete weeks; null when there are none ('all' before a first full week). */
	weeks: WeekRange | null;
	/** Today's week, never part of `weeks`. */
	inProgress: InProgressWeek;
	/** As many complete weeks, ending the day before `weeks`; null for 'all' and without `weeks`. */
	previous: WeekRange | null;
	bucket: Bucket;
}

/** `count` whole weeks ending on `sunday`. */
const weeksEnding = (sunday: IsoDate, count: number): WeekRange => ({
	from: addDays(sunday, 1 - 7 * count),
	to: sunday,
	count
});

/** Complete weeks from the Monday of the first activity to the week before `weekStart`. */
function weeksSince(firstActivityOn: IsoDate | null, weekStart: IsoDate): number {
	if (firstActivityOn === null) return 0;
	return Math.max(0, daysBetween(mondayOf(firstActivityOn), weekStart) / 7);
}

/**
 * The window a period covers on `today` (the owner's calendar day). `firstActivityOn` is the day
 * of the owner's first logged training, or null before any: only 'all' reads it. Throws
 * RangeError for a malformed date.
 */
export function periodWindow(
	today: IsoDate,
	period: Period,
	firstActivityOn: IsoDate | null
): PeriodWindow {
	const weekStart = mondayOf(today);
	const inProgress = { weekStart, through: today, days: daysBetween(weekStart, today) + 1 };
	const count = period === 'all' ? weeksSince(firstActivityOn, weekStart) : PERIOD_WEEKS[period];
	const weeks = count > 0 ? weeksEnding(addDays(weekStart, -1), count) : null;
	const previous =
		period === 'all' || weeks === null ? null : weeksEnding(addDays(weeks.from, -1), count);
	const bucket: Bucket = count > MONTHLY_AFTER_WEEKS ? 'month' : 'week';
	return { period, weeks, inProgress, previous, bucket };
}

/** Each Monday of `range`, oldest first; none for null. */
export function weekStarts(range: WeekRange | null): IsoDate[] {
	if (range === null) return [];
	return Array.from({ length: range.count }, (_, week) => addDays(range.from, 7 * week));
}

export interface TrendWindow {
	/** The complete weeks a trend verdict reads; null when there are none. */
	weeks: WeekRange | null;
	/** False when the verdict reads other weeks than the period's figures, which a tile must say. */
	sameAsPeriod: boolean;
	label: string;
}

/**
 * The complete weeks a period's trend verdicts read: the period's own when it is TREND_MIN_WEEKS
 * or longer ('all' included), otherwise the last TREND_MIN_WEEKS complete weeks.
 */
export function trendWindow(window: PeriodWindow): TrendWindow {
	const { period } = window;
	if (period === 'all') {
		return { weeks: window.weeks, sameAsPeriod: true, label: 'Trend over all your training' };
	}
	const count = Math.max(PERIOD_WEEKS[period], TREND_MIN_WEEKS);
	return {
		weeks: weeksEnding(addDays(window.inProgress.weekStart, -1), count),
		sameAsPeriod: count === PERIOD_WEEKS[period],
		label: `Trend over the last ${count} weeks`
	};
}

/**
 * Last week's days that match the week in progress: Monday to the same weekday a week ago, so
 * 'this week so far' is compared like for like ('5,900 kg by Wednesday last week').
 */
export function sameDaysLastWeek(inProgress: InProgressWeek): DayRange {
	return {
		from: addDays(inProgress.weekStart, -7),
		through: addDays(inProgress.through, -7),
		days: inProgress.days
	};
}
