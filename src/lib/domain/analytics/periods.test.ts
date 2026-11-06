import { afterEach, describe, expect, it } from 'vitest';
import { addDays, daysBetween, isoWeekKey, weekdayOf } from '../calendar';
import { localDay } from '../dates';
import {
	DEFAULT_PERIOD,
	MONTHLY_AFTER_WEEKS,
	PERIOD_LABEL,
	PERIODS,
	parsePeriod,
	periodWindow,
	sameDaysLastWeek,
	trendWindow,
	weekStarts
} from './periods';
import type { Period, WeekRange } from './periods';

const WEDNESDAY = '2026-11-04';
const MONDAY = '2026-11-02';
const SUNDAY = '2026-11-08';
const LAST_SUNDAY = '2026-11-01';

/** Checks a range is whole Monday-to-Sunday weeks, `count` of them. */
function expectWholeWeeks(range: WeekRange | null, count: number) {
	expect(range).not.toBeNull();
	expect(weekdayOf(range!.from)).toBe('mon');
	expect(weekdayOf(range!.to)).toBe('sun');
	expect(range!.count).toBe(count);
	expect(daysBetween(range!.from, range!.to)).toBe(7 * count - 1);
}

describe('periods', () => {
	it('lists the five periods shortest first and opens on 12 weeks', () => {
		expect(PERIODS).toEqual(['4w', '12w', '26w', '52w', 'all']);
		expect(DEFAULT_PERIOD).toBe('12w');
		expect(PERIODS.map((period) => PERIOD_LABEL[period])).toEqual([
			'Last 4 weeks',
			'Last 12 weeks',
			'Last 26 weeks',
			'Last 52 weeks',
			'All time'
		]);
	});

	it.each(PERIODS)('parses %s as itself', (period) => {
		expect(parsePeriod(period)).toBe(period);
	});

	it.each([null, undefined, '', '13w', '4W', 'ALL', ' 12w', '12', 'week', 'constructor'])(
		'gives 12w for the unknown value %j',
		(value) => {
			expect(parsePeriod(value)).toBe('12w');
		}
	);
});

describe('periodWindow', () => {
	it('on a Wednesday, 12w is the 12 complete weeks ending last Sunday, with Monday to Wednesday apart', () => {
		const window = periodWindow(WEDNESDAY, '12w', '2024-01-10');
		expect(window.weeks).toEqual({ from: '2026-08-10', to: LAST_SUNDAY, count: 12 });
		expectWholeWeeks(window.weeks, 12);
		expect(window.inProgress).toEqual({ weekStart: MONDAY, through: WEDNESDAY, days: 3 });
		// The week in progress is never part of the period's weeks.
		expect(window.inProgress.weekStart > window.weeks!.to).toBe(true);
		expect(weekStarts(window.weeks)).not.toContain(MONDAY);
		expect(window.bucket).toBe('week');
		expect(window.period).toBe('12w');
	});

	it('on a Monday, the week in progress has 1 day and the weeks still end the day before', () => {
		const window = periodWindow(MONDAY, '4w', null);
		expect(window.inProgress).toEqual({ weekStart: MONDAY, through: MONDAY, days: 1 });
		expect(window.weeks).toEqual({ from: '2026-10-05', to: LAST_SUNDAY, count: 4 });
	});

	it('on a Sunday, the whole week is still in progress, with 7 days', () => {
		const window = periodWindow(SUNDAY, '4w', null);
		expect(window.inProgress).toEqual({ weekStart: MONDAY, through: SUNDAY, days: 7 });
		expect(window.weeks?.to).toBe(LAST_SUNDAY);
	});

	it.each([
		['4w', 4],
		['12w', 12],
		['26w', 26],
		['52w', 52]
	] as const)(
		'gives %s %i weeks and a previous window as long, ending the day before',
		(period, n) => {
			const { weeks, previous } = periodWindow(WEDNESDAY, period, null);
			expectWholeWeeks(weeks, n);
			expectWholeWeeks(previous, n);
			expect(previous!.to).toBe(addDays(weeks!.from, -1));
			expect(weeks!.to).toBe(LAST_SUNDAY);
		}
	);

	it('gives the 12 weeks before as the previous window of 12w', () => {
		expect(periodWindow(WEDNESDAY, '12w', null).previous).toEqual({
			from: '2026-05-18',
			to: '2026-08-09',
			count: 12
		});
	});

	describe("'all'", () => {
		it("starts on the Monday of the first activity's week and has no previous window", () => {
			// 12 March 2025 is a Wednesday; its Monday is 10 March.
			const window = periodWindow(WEDNESDAY, 'all', '2025-03-12');
			expect(window.weeks).toEqual({ from: '2025-03-10', to: LAST_SUNDAY, count: 86 });
			expectWholeWeeks(window.weeks, 86);
			expect(window.previous).toBeNull();
			expect(window.bucket).toBe('week');
		});

		it('starts on that Monday when the first activity was on a Monday or a Sunday', () => {
			expect(periodWindow(WEDNESDAY, 'all', '2026-10-19').weeks?.from).toBe('2026-10-19');
			expect(periodWindow(WEDNESDAY, 'all', '2026-10-25').weeks?.from).toBe('2026-10-19');
		});

		it(`buckets by week up to ${MONTHLY_AFTER_WEEKS} weeks and by month beyond`, () => {
			const at = (weeks: number) => periodWindow(WEDNESDAY, 'all', addDays(MONDAY, -7 * weeks));
			expect(at(104).weeks?.count).toBe(104);
			expect(at(104).bucket).toBe('week');
			expect(at(105).weeks?.count).toBe(105);
			expect(at(105).bucket).toBe('month');
			// Only 'all' can reach monthly buckets: 52w stays weekly whatever the history.
			expect(periodWindow(WEDNESDAY, '52w', '2015-01-01').bucket).toBe('week');
		});

		it('has no complete weeks for a new owner in their first week, only the week in progress', () => {
			for (const first of [MONDAY, WEDNESDAY]) {
				const window = periodWindow(WEDNESDAY, 'all', first);
				expect(window.weeks).toBeNull();
				expect(window.previous).toBeNull();
				expect(window.inProgress.days).toBe(3);
				expect(weekStarts(window.weeks)).toEqual([]);
			}
		});

		it('has no complete weeks before any activity, or for a first activity dated later', () => {
			expect(periodWindow(WEDNESDAY, 'all', null).weeks).toBeNull();
			expect(periodWindow(WEDNESDAY, 'all', '2026-12-01').weeks).toBeNull();
		});

		it('has one complete week once the first full week has ended', () => {
			expect(periodWindow(WEDNESDAY, 'all', '2026-10-29').weeks).toEqual({
				from: '2026-10-26',
				to: LAST_SUNDAY,
				count: 1
			});
		});
	});

	it('keeps the fixed periods whole even for an owner who started recently', () => {
		const window = periodWindow(WEDNESDAY, '12w', '2026-10-29');
		expectWholeWeeks(window.weeks, 12);
		expectWholeWeeks(window.previous, 12);
	});

	it('throws RangeError for a malformed date', () => {
		expect(() => periodWindow('2026-11-31', '12w', null)).toThrow(RangeError);
		expect(() => periodWindow(WEDNESDAY, 'all', '4 Nov 2026')).toThrow(RangeError);
	});

	describe('calendar edges', () => {
		it('crosses ISO week 53 and the year end', () => {
			// 3 January 2027 ends 2026-W53; 6 January 2027 is a Wednesday.
			const window = periodWindow('2027-01-06', '4w', null);
			expect(window.weeks).toEqual({ from: '2026-12-07', to: '2027-01-03', count: 4 });
			expect(weekStarts(window.weeks).map(isoWeekKey)).toEqual([
				'2026-W50',
				'2026-W51',
				'2026-W52',
				'2026-W53'
			]);
			expect(window.inProgress).toEqual({
				weekStart: '2027-01-04',
				through: '2027-01-06',
				days: 3
			});
			expect(window.previous).toEqual({ from: '2026-11-09', to: '2026-12-06', count: 4 });
		});

		it('keeps a week that straddles New Year in progress as one week', () => {
			// Wednesday 31 December 2025 and Thursday 1 January 2026 share the week of 29 December.
			expect(periodWindow('2025-12-31', '4w', null).inProgress).toEqual({
				weekStart: '2025-12-29',
				through: '2025-12-31',
				days: 3
			});
			const newYear = periodWindow('2026-01-01', '4w', null);
			expect(newYear.inProgress).toEqual({
				weekStart: '2025-12-29',
				through: '2026-01-01',
				days: 4
			});
			expect(newYear.weeks?.to).toBe('2025-12-28');
		});

		it('counts a leap day as a day like any other', () => {
			// 29 February 2028 is a Tuesday; 2024's was a Thursday.
			const leap = periodWindow('2028-02-29', '4w', null);
			expect(leap.inProgress).toEqual({ weekStart: '2028-02-28', through: '2028-02-29', days: 2 });
			expect(leap.weeks).toEqual({ from: '2028-01-31', to: '2028-02-27', count: 4 });
			const after = periodWindow('2024-03-06', '4w', null);
			expect(after.weeks).toEqual({ from: '2024-02-05', to: '2024-03-03', count: 4 });
			expect(weekStarts(after.weeks)).toContain('2024-02-26');
			expect(daysBetween(after.weeks!.from, after.weeks!.to)).toBe(27);
		});

		it.each([
			// London springs forward on Sunday 29 March 2026, Los Angeles on 8 March and back on 1 November.
			['Europe/London', '2026-03-29T22:30:00Z', '2026-03-29', 7],
			['Europe/London', '2026-03-29T23:30:00Z', '2026-03-30', 1],
			['Europe/London', '2026-10-25T23:30:00Z', '2026-10-25', 7],
			['America/Los_Angeles', '2026-03-09T06:30:00Z', '2026-03-08', 7],
			['America/Los_Angeles', '2026-03-09T07:30:00Z', '2026-03-09', 1],
			['America/Los_Angeles', '2026-11-02T07:30:00Z', '2026-11-01', 7],
			['America/Los_Angeles', '2026-11-02T08:30:00Z', '2026-11-02', 1]
		])(
			'places %s at %s on %s, day %i of its week, across daylight saving',
			(zone, instant, day, days) => {
				const today = localDay(new Date(instant), zone);
				expect(today).toBe(day);
				const window = periodWindow(today, '4w', null);
				expect(window.inProgress.days).toBe(days);
				expectWholeWeeks(window.weeks, 4);
				expectWholeWeeks(window.previous, 4);
			}
		);
	});
});

describe('weekStarts', () => {
	it('lists each Monday of a range, oldest first', () => {
		expect(weekStarts({ from: '2026-10-12', to: LAST_SUNDAY, count: 3 })).toEqual([
			'2026-10-12',
			'2026-10-19',
			'2026-10-26'
		]);
		expect(weekStarts(null)).toEqual([]);
	});
});

describe('trendWindow', () => {
	it('reads the last 12 complete weeks for 4w, and says so', () => {
		const window = periodWindow(WEDNESDAY, '4w', null);
		expect(trendWindow(window)).toEqual({
			weeks: { from: '2026-08-10', to: LAST_SUNDAY, count: 12 },
			sameAsPeriod: false,
			label: 'Trend over the last 12 weeks'
		});
	});

	it.each([
		['12w', 'Trend over the last 12 weeks'],
		['26w', 'Trend over the last 26 weeks'],
		['52w', 'Trend over the last 52 weeks']
	] as const)('keeps the period’s own weeks for %s', (period, label) => {
		const window = periodWindow(WEDNESDAY, period, null);
		expect(trendWindow(window)).toEqual({ weeks: window.weeks, sameAsPeriod: true, label });
	});

	it("keeps 'all' to its own weeks, however few", () => {
		const long = periodWindow(WEDNESDAY, 'all', '2024-01-03');
		expect(trendWindow(long)).toEqual({
			weeks: long.weeks,
			sameAsPeriod: true,
			label: 'Trend over all your training'
		});
		const short = periodWindow(WEDNESDAY, 'all', '2026-10-21');
		expect(trendWindow(short).weeks?.count).toBe(2);
		expect(trendWindow(periodWindow(WEDNESDAY, 'all', WEDNESDAY)).weeks).toBeNull();
	});

	it('never includes the week in progress', () => {
		for (const period of PERIODS) {
			const window = periodWindow(SUNDAY, period, '2025-01-01');
			expect(trendWindow(window).weeks?.to).toBe(LAST_SUNDAY);
		}
	});
});

describe('sameDaysLastWeek', () => {
	it('on a Wednesday is last Monday to last Wednesday', () => {
		const { inProgress } = periodWindow(WEDNESDAY, '12w', null);
		expect(sameDaysLastWeek(inProgress)).toEqual({
			from: '2026-10-26',
			through: '2026-10-28',
			days: 3
		});
		expect(weekdayOf(sameDaysLastWeek(inProgress).through)).toBe('wed');
	});

	it('on a Monday is last Monday alone, and on a Sunday the whole of last week', () => {
		expect(sameDaysLastWeek(periodWindow(MONDAY, '12w', null).inProgress)).toEqual({
			from: '2026-10-26',
			through: '2026-10-26',
			days: 1
		});
		expect(sameDaysLastWeek(periodWindow(SUNDAY, '12w', null).inProgress)).toEqual({
			from: '2026-10-26',
			through: LAST_SUNDAY,
			days: 7
		});
	});

	it('crosses the year end and a leap day', () => {
		expect(sameDaysLastWeek(periodWindow('2027-01-06', '4w', null).inProgress)).toEqual({
			from: '2026-12-28',
			through: '2026-12-30',
			days: 3
		});
		expect(sameDaysLastWeek(periodWindow('2028-03-07', '4w', null).inProgress)).toEqual({
			from: '2028-02-28',
			through: '2028-02-29',
			days: 2
		});
	});
});

describe('process time zones', () => {
	const zone = process.env.TZ;
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	const answers = () =>
		['2026-03-08', '2026-03-29', WEDNESDAY, '2026-11-01', '2027-01-06', '2028-02-29'].flatMap(
			(today) =>
				PERIODS.map((period: Period) => {
					const window = periodWindow(today, period, '2024-06-05');
					return [window, trendWindow(window), sameDaysLastWeek(window.inProgress)];
				})
		);

	it('gives the same answers under any process TZ, across daylight saving', () => {
		process.env.TZ = 'UTC';
		const expected = answers();
		for (const tz of ['America/Los_Angeles', 'Europe/London', 'Pacific/Auckland', 'Asia/Kolkata']) {
			process.env.TZ = tz;
			expect(answers(), tz).toEqual(expected);
		}
	});
});
