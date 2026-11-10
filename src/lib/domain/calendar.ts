/**
 * Calendar-date maths on ISO `YYYY-MM-DD` strings, the form the schema, the services and the
 * screens use for days: a session's date, a week's Monday, a block's last day.
 *
 * A date here is a day on the calendar, not an instant, so every operation is UTC arithmetic:
 * neither the server's nor the device's time zone, nor a daylight-saving change, can move a day.
 * Which day it is now for the owner is a time-zone question, answered once (from the profile's
 * zone) before any of these run. Weeks start on Monday, as M2's WEEKDAYS do.
 */
import { WEEKDAYS, type Weekday } from './weekdays.ts';

/** A calendar date, written `YYYY-MM-DD`. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** UTC midnight of `text` when it is a real calendar date written `YYYY-MM-DD`, otherwise null. */
export function parseIsoDate(text: string): Date | null {
	const match = ISO_DATE.exec(text);
	if (!match) return null;
	const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	// 2027-02-29 rolls over to 1 March: the date was never real.
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The number `text` writes in ASCII digits from `at`, `length` long; -1 when one is not a digit. */
function digits(text: string, at: number, length: number): number {
	let n = 0;
	for (let i = at; i < at + length; i++) {
		const digit = text.charCodeAt(i) - 48;
		if (!(digit >= 0 && digit <= 9)) return -1;
		n = n * 10 + digit;
	}
	return n;
}
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * UTC midnight of `date` in milliseconds, by parseIsoDate's rule without building a Date: the
 * week scheduler (schedule/repair.ts) calls these thousands of times in one repair.
 */
function utc(date: IsoDate): number {
	const year = digits(date, 0, 4);
	const month = digits(date, 5, 2);
	const day = digits(date, 8, 2);
	const days = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1];
	const written = date.length === 10 && date[4] === '-' && date[7] === '-';
	if (!written || year < 0 || days === undefined || day < 1 || day > days) {
		throw new RangeError(`Not a calendar date (YYYY-MM-DD): '${date}'`);
	}
	// Date.UTC reads the years 0 to 99 as 1900 to 1999.
	return year < 100 ? parseIsoDate(date)!.getTime() : Date.UTC(year, month - 1, day);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
function format(ms: number): IsoDate {
	const date = new Date(ms);
	const year = date.getUTCFullYear();
	if (year < 0 || year > 9999) return date.toISOString().slice(0, 10);
	return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** Days since Monday (Monday 0, Sunday 6): 1 January 1970 was a Thursday. */
const sinceMonday = (ms: number) => (((Math.floor(ms / DAY_MS) + 3) % 7) + 7) % 7;

/** `date` moved by a whole number of days (negative goes back). */
export function addDays(date: IsoDate, days: number): IsoDate {
	if (!Number.isInteger(days)) throw new RangeError(`Not a whole number of days: ${days}`);
	return format(utc(date) + days * DAY_MS);
}

/** Whole days from `from` to `to`: positive when `to` is later, 0 on the same day. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
	return (utc(to) - utc(from)) / DAY_MS;
}

/** The M2 weekday `date` falls on. */
export function weekdayOf(date: IsoDate): Weekday {
	return WEEKDAYS[sinceMonday(utc(date))]!;
}

/**
 * Each day's Monday once worked out: the analytics ask for the week of every fact (tens of
 * thousands on two years), over a few hundred days. Emptied once it holds MONDAY_MEMO_MAX days.
 */
const MONDAY_MEMO_MAX = 10_000;
const mondays = new Map<IsoDate, IsoDate>();

/** The Monday of the Monday-to-Sunday week `date` falls in (`date` itself on a Monday). */
export function mondayOf(date: IsoDate): IsoDate {
	const known = mondays.get(date);
	if (known !== undefined) return known;
	const ms = utc(date);
	const monday = format(ms - sinceMonday(ms) * DAY_MS);
	if (mondays.size >= MONDAY_MEMO_MAX) mondays.clear();
	mondays.set(date, monday);
	return monday;
}

/**
 * The ISO 8601 week `date` falls in, as `YYYY-Www` (`2026-W53`). The year is the week's own: the
 * year its Thursday falls in, so 3 January 2027 is in 2026-W53 and 30 December 2024 in 2025-W01.
 * Keys sort in calendar order.
 */
export function isoWeekKey(date: IsoDate): string {
	const thursday = addDays(mondayOf(date), 3);
	const year = thursday.slice(0, 4);
	const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
	return `${year}-W${String(week).padStart(2, '0')}`;
}
