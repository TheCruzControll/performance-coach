import { afterEach, describe, expect, it } from 'vitest';
import { addDays, daysBetween, isoWeekKey, mondayOf, parseIsoDate, weekdayOf } from './calendar';
import { WEEKDAYS } from './profile/catalog';

describe('parseIsoDate', () => {
	it('gives UTC midnight of a real calendar date', () => {
		expect(parseIsoDate('2026-11-05')?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
		expect(parseIsoDate('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
		// Divisible by 400: a leap year although it is a century.
		expect(parseIsoDate('2000-02-29')?.toISOString()).toBe('2000-02-29T00:00:00.000Z');
		expect(parseIsoDate('0099-01-01')?.toISOString()).toBe('0099-01-01T00:00:00.000Z');
	});

	it('refuses dates that do not exist and anything not written YYYY-MM-DD', () => {
		for (const text of [
			'2027-02-29',
			'2100-02-29',
			'2026-02-30',
			'2026-04-31',
			'2026-13-01',
			'2026-00-10',
			'2026-11-00',
			'2026-1-05',
			'26-11-05',
			'2026/11/05',
			'2026-11-05T00:00:00Z',
			' 2026-11-05',
			''
		]) {
			expect(parseIsoDate(text), text).toBeNull();
		}
	});
});

describe('addDays', () => {
	it('crosses month ends', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
		expect(addDays('2026-05-01', -1)).toBe('2026-04-30');
	});

	it('crosses year ends both ways', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
		expect(addDays('2026-11-05', 365)).toBe('2027-11-05');
	});

	it('knows leap years, century rules included', () => {
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
		expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
		expect(addDays('2100-02-28', 1)).toBe('2100-03-01');
		expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
	});

	it('refuses a date that is not real and a part of a day', () => {
		expect(() => addDays('2027-02-29', 1)).toThrow(/Not a calendar date.*2027-02-29/);
		expect(() => addDays('2026-11-05', 0.5)).toThrow(/whole number/);
	});
});

describe('daysBetween', () => {
	it('counts across year ends, signed', () => {
		expect(daysBetween('2026-12-25', '2027-01-08')).toBe(14);
		expect(daysBetween('2027-01-08', '2026-12-25')).toBe(-14);
		expect(daysBetween('2026-11-05', '2026-11-05')).toBe(0);
	});

	it('counts leap days', () => {
		expect(daysBetween('2027-01-01', '2028-01-01')).toBe(365);
		expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366);
		expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
	});

	it('undoes addDays', () => {
		for (const days of [-400, -1, 0, 1, 6, 7, 59, 366, 1000]) {
			expect(daysBetween('2026-11-05', addDays('2026-11-05', days)), String(days)).toBe(days);
		}
	});
});

describe('Monday-first weeks', () => {
	it('names each day with an M2 weekday, Monday first', () => {
		const week = [0, 1, 2, 3, 4, 5, 6].map((n) => weekdayOf(addDays('2026-11-02', n)));
		expect(week).toEqual([...WEEKDAYS]);
		expect(weekdayOf('2028-02-29')).toBe('tue');
	});

	it('takes every day of a week back to its Monday, Sunday included', () => {
		expect(mondayOf('2026-11-02')).toBe('2026-11-02');
		expect(mondayOf('2026-11-05')).toBe('2026-11-02');
		expect(mondayOf('2026-11-08')).toBe('2026-11-02');
		expect(mondayOf('2026-11-09')).toBe('2026-11-09');
		expect(mondayOf('2026-03-01')).toBe('2026-02-23');
		expect(mondayOf('2027-01-01')).toBe('2026-12-28');
	});
});

describe('isoWeekKey', () => {
	it('numbers weeks by their Thursday, so a week belongs to one year', () => {
		expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
		expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
		expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
		expect(isoWeekKey('2026-11-05')).toBe('2026-W45');
	});

	it('has a week 53 in long years', () => {
		expect(isoWeekKey('2026-12-31')).toBe('2026-W53');
		expect(isoWeekKey('2027-01-03')).toBe('2026-W53');
		expect(isoWeekKey('2027-01-04')).toBe('2027-W01');
		expect(isoWeekKey('2020-12-31')).toBe('2020-W53');
		expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
		expect(isoWeekKey('2027-12-31')).toBe('2027-W52');
	});

	it('gives one key per Monday-to-Sunday week, in calendar order', () => {
		const days = [0, 1, 2, 3, 4, 5, 6].map((n) => isoWeekKey(addDays('2026-12-28', n)));
		expect(new Set(days)).toEqual(new Set(['2026-W53']));
		const keys = [-14, -7, 0, 7, 14].map((n) => isoWeekKey(addDays('2026-12-28', n)));
		expect(keys).toEqual([...keys].sort());
	});
});

describe('time zones', () => {
	const zone = process.env.TZ;
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it('never move a day, across daylight saving too', () => {
		for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata']) {
			process.env.TZ = tz;
			// Los Angeles springs forward on 8 March 2026, Auckland falls back on 5 April.
			expect(addDays('2026-03-07', 1), tz).toBe('2026-03-08');
			expect(addDays('2026-03-08', 1), tz).toBe('2026-03-09');
			expect(addDays('2026-04-05', 1), tz).toBe('2026-04-06');
			expect(daysBetween('2026-03-01', '2026-04-30'), tz).toBe(60);
			expect(weekdayOf('2026-11-08'), tz).toBe('sun');
			expect(mondayOf('2026-11-08'), tz).toBe('2026-11-02');
		}
	});
});
