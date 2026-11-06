/**
 * Calendar-date maths on ISO `YYYY-MM-DD` strings, the form the schema, the services and the
 * screens use for days: a session's date, a week's Monday, a block's last day.
 *
 * A date here is a day on the calendar, not an instant, so every operation is UTC arithmetic:
 * neither the server's nor the device's time zone, nor a daylight-saving change, can move a day.
 * Which day it is now for the owner is a time-zone question, answered once (from the profile's
 * zone) before any of these run. Weeks start on Monday, as M2's WEEKDAYS do.
 */
import { WEEKDAYS } from './profile/catalog.ts';
import type { Weekday } from './profile/catalog.ts';

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

function utc(date: IsoDate): Date {
	const parsed = parseIsoDate(date);
	if (!parsed) throw new RangeError(`Not a calendar date (YYYY-MM-DD): '${date}'`);
	return parsed;
}

const format = (date: Date): IsoDate => date.toISOString().slice(0, 10);

/** Days since Monday (Monday 0, Sunday 6). */
const sinceMonday = (date: Date) => (date.getUTCDay() + 6) % 7;

/** `date` moved by a whole number of days (negative goes back). */
export function addDays(date: IsoDate, days: number): IsoDate {
	if (!Number.isInteger(days)) throw new RangeError(`Not a whole number of days: ${days}`);
	return format(new Date(utc(date).getTime() + days * DAY_MS));
}

/** Whole days from `from` to `to`: positive when `to` is later, 0 on the same day. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
	return (utc(to).getTime() - utc(from).getTime()) / DAY_MS;
}

/** The M2 weekday `date` falls on. */
export function weekdayOf(date: IsoDate): Weekday {
	return WEEKDAYS[sinceMonday(utc(date))]!;
}

/** The Monday of the Monday-to-Sunday week `date` falls in (`date` itself on a Monday). */
export function mondayOf(date: IsoDate): IsoDate {
	return addDays(date, -sinceMonday(utc(date)));
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
