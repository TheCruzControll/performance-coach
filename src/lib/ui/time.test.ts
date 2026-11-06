import { describe, expect, it } from 'vitest';
import { relativeTime, shortDate, timeAgo } from './time';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Local-time constructors: the calendar day is the same in every time zone the tests run in.
const NOW = new Date(2026, 10, 6, 12, 0, 0);
const before = (ms: number) => new Date(NOW.getTime() - ms);

/** timeAgo as it shipped before relativeTime existed: the oracle for "output unchanged". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function oldShortDate(d: Date, now: Date) {
	const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
	return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}
function oldTimeAgo(value: Date | string, now: Date): string {
	const d = value instanceof Date ? value : new Date(value);
	const seconds = Math.max(0, (now.getTime() - d.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} days ago`;
	return oldShortDate(d, now);
}

describe('relativeTime', () => {
	it.each([
		[0, 'just now'],
		[59 * SECOND, 'just now'],
		[MINUTE - 1, 'just now'],
		[MINUTE, '1 min ago'],
		[59 * MINUTE, '59 min ago'],
		[HOUR - 1, '59 min ago'],
		[HOUR, '1 h ago'],
		[23 * HOUR, '23 h ago'],
		[DAY - 1, '23 h ago'],
		[DAY, 'yesterday'],
		[47 * HOUR, 'yesterday'],
		[2 * DAY - 1, 'yesterday'],
		[2 * DAY, '2 days ago'],
		[6 * DAY + 23 * HOUR, '6 days ago'],
		[7 * DAY - 1, '6 days ago']
	])('%i ms before now reads %s', (ago, label) => {
		expect(relativeTime(before(ago), NOW)).toBe(label);
	});

	it('has no label from 7 days, so the caller shows a date', () => {
		expect(relativeTime(before(7 * DAY), NOW)).toBeNull();
		expect(relativeTime(before(400 * DAY), NOW)).toBeNull();
	});

	it('reads a time in the future (a device clock ahead of the server) as just now', () => {
		expect(relativeTime(before(-5 * MINUTE), NOW)).toBe('just now');
		expect(relativeTime(before(-10 * DAY), NOW)).toBe('just now');
	});

	it('accepts the ISO string a serialised date arrives as', () => {
		expect(relativeTime(before(3 * HOUR).toISOString(), NOW)).toBe('3 h ago');
	});

	it('depends only on the interval, never on the calendar or the time zone', () => {
		// 2 minutes across midnight, and across a new year, are still 2 minutes.
		const midnight = new Date(2026, 10, 7, 0, 1, 0);
		expect(relativeTime(new Date(2026, 10, 6, 23, 59, 0), midnight)).toBe('2 min ago');
		const newYear = new Date(2027, 0, 1, 0, 1, 0);
		expect(relativeTime(new Date(2026, 11, 31, 23, 59, 0), newYear)).toBe('2 min ago');
		// The same two instants in UTC give the same label as in local time.
		const at = Date.UTC(2026, 10, 6, 23, 30);
		expect(relativeTime(new Date(at - 25 * HOUR), new Date(at))).toBe('yesterday');
	});
});

describe('timeAgo', () => {
	const instants = [
		0,
		30 * SECOND,
		MINUTE - 1,
		MINUTE,
		12 * MINUTE,
		HOUR - 1,
		HOUR,
		3 * HOUR,
		DAY - 1,
		DAY,
		36 * HOUR,
		2 * DAY - 1,
		2 * DAY,
		4 * DAY,
		7 * DAY - 1,
		7 * DAY,
		8 * DAY,
		30 * DAY,
		200 * DAY,
		400 * DAY,
		-MINUTE,
		-3 * DAY
	];

	it.each(instants)('%i ms before now reads exactly as before', (ago) => {
		const value = before(ago);
		expect(timeAgo(value, NOW)).toBe(oldTimeAgo(value, NOW));
		expect(timeAgo(value.toISOString(), NOW)).toBe(oldTimeAgo(value.toISOString(), NOW));
	});

	it('falls back to the short date from 7 days', () => {
		expect(timeAgo(new Date(2026, 9, 30, 12), NOW)).toBe('30 Oct');
		expect(timeAgo(new Date(2025, 10, 5, 12), NOW)).toBe('5 Nov 2025');
	});
});

describe('shortDate', () => {
	it('leaves out the year in the current year', () => {
		expect(shortDate(new Date(2026, 0, 1, 9), NOW)).toBe('1 Jan');
		expect(shortDate(new Date(2026, 10, 5, 9), NOW)).toBe('5 Nov');
		expect(shortDate(new Date(2026, 11, 31, 9).toISOString(), NOW)).toBe('31 Dec');
	});

	it('adds the year in any other year', () => {
		expect(shortDate(new Date(2025, 10, 5, 9), NOW)).toBe('5 Nov 2025');
		expect(shortDate(new Date(2027, 2, 14, 9), NOW)).toBe('14 Mar 2027');
	});
});
