import { describe, expect, it } from 'vitest';
import { backupPathname, parseBackupPathname } from './pathnames';
import { RETENTION, selectForDeletion } from './retention';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-07T12:00:00Z');

const name = (iso: string) => backupPathname(new Date(iso));
const dayOf = (n: string) => parseBackupPathname(n)?.day;

/** One backup a day at the cron's 10:41 UTC, `days` of them, the last on `last`'s day. */
function daily(days: number, last = NOW): string[] {
	const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate(), 10, 41);
	return Array.from({ length: days }, (_, i) => backupPathname(new Date(end - i * DAY_MS)));
}

/** A seeded Fisher–Yates shuffle, so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let s = seed;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

describe('RETENTION', () => {
	it('is 30 daily and 12 monthly, keeping the earliest of a month', () => {
		expect(RETENTION).toEqual({ daily: 30, monthly: 12, monthlyKeeps: 'earliest' });
	});
});

describe('selectForDeletion', () => {
	it('keeps 30 days plus 12 month-firsts out of 400 daily backups, an overlap counted once', () => {
		const names = daily(400);
		const { keep, delete: remove, unparseable } = selectForDeletion(names, NOW);

		const days = daily(30);
		// Dec 2025 … Nov 2026; Nov 1 is also one of the 30 days.
		const firsts = Array.from({ length: 12 }, (_, i) =>
			backupPathname(new Date(Date.UTC(2025, 11 + i, 1, 10, 41)))
		);
		expect(firsts.filter((n) => days.includes(n))).toEqual([name('2026-11-01T10:41:00Z')]);
		expect(keep).toEqual([...new Set([...firsts, ...days])].sort());
		expect(keep).toHaveLength(41);
		expect(remove).toHaveLength(400 - 41);
		expect(unparseable).toEqual([]);
		expect([...keep, ...remove].sort()).toEqual([...names].sort());
	});

	it('gives the same answer for shuffled input', () => {
		const names = [...daily(400), 'backups/notes.txt', name('2026-11-07T23:00:00Z')];
		const expected = selectForDeletion(names, NOW);
		for (const seed of [1, 2, 3, 42, 9_001]) {
			expect(selectForDeletion(shuffled(names, seed), NOW)).toEqual(expected);
		}
	});

	it('keeps the newest backup of a day with several', () => {
		const morning = name('2026-11-05T06:00:00Z');
		const noon = name('2026-11-05T12:00:00Z');
		const night = name('2026-11-05T23:59:59Z');
		const { keep, delete: remove } = selectForDeletion([noon, night, morning], NOW, {
			daily: 30,
			monthly: 0
		});
		expect(keep).toEqual([night]);
		expect(remove).toEqual([morning, noon]);
	});

	it('keeps the earliest backup of a month, which may be another than that day’s newest', () => {
		const first = name('2026-08-01T10:41:00Z');
		const firstLater = name('2026-08-01T20:00:00Z');
		const mid = name('2026-08-15T10:41:00Z');
		const { keep } = selectForDeletion([mid, firstLater, first], NOW);
		expect(keep).toEqual([first]);
	});

	it("keeps the month's newest when the owner picks 'newest'", () => {
		const first = name('2026-08-01T10:41:00Z');
		const last = name('2026-08-31T10:41:00Z');
		const { keep } = selectForDeletion([first, last], NOW, {
			...RETENTION,
			monthlyKeeps: 'newest'
		});
		expect(keep).toEqual([last]);
	});

	it('keeps whatever is left across a 40-day gap', () => {
		// Nothing from Sep 20 to Oct 29; the 30-day window holds only the backups after the gap.
		const before = daily(60, new Date('2026-09-19T00:00:00Z'));
		const after = daily(9);
		const { keep } = selectForDeletion([...before, ...after], NOW);
		const kept = keep.map(dayOf);
		expect(kept).toEqual([
			// Before the gap (Jul 22 … Sep 19), only each month's earliest.
			'2026-07-22',
			'2026-08-01',
			'2026-09-01',
			// Nothing in Oct before Oct 30, which is October's earliest and inside the 30 days.
			'2026-10-30',
			'2026-10-31',
			'2026-11-01',
			'2026-11-02',
			'2026-11-03',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07'
		]);
	});

	it('keeps a leap day as its own day and Feb 29 as nothing special for the month', () => {
		const now = new Date('2028-03-15T12:00:00Z');
		const names = daily(30, now);
		const leap = name('2028-02-29T10:41:00Z');
		expect(names).toContain(leap);
		const febFirst = name('2028-02-01T10:41:00Z');
		const { keep } = selectForDeletion([...names, febFirst], now);
		// Feb 15 … Mar 15 is 30 days with Feb 29 among them; Feb 1 is February's earliest.
		expect(keep).toContain(leap);
		expect(keep).toContain(febFirst);
		expect(keep).toHaveLength(31);
		expect(keep.map(dayOf)[0]).toBe('2028-02-01');
		expect(keep.map(dayOf)[1]).toBe('2028-02-15');
	});

	it('counts days in UTC: 23:59:59Z on the day before the window is out, 00:00:00Z is in', () => {
		const now = new Date('2026-11-07T00:00:00Z');
		// The window is Oct 9 … Nov 7; monthly 0 leaves only the daily rule.
		const outside = name('2026-10-08T23:59:59Z');
		const inside = name('2026-10-09T00:00:00Z');
		const { keep, delete: remove } = selectForDeletion([outside, inside], now, {
			daily: 30,
			monthly: 0
		});
		expect(keep).toEqual([inside]);
		expect(remove).toEqual([outside]);
	});

	it('counts months in UTC: the last second of the month before the window is out', () => {
		const now = new Date('2026-11-07T00:00:00Z');
		// The window is Dec 2025 … Nov 2026; daily 0 leaves only the monthly rule.
		const outside = name('2025-11-30T23:59:59Z');
		const inside = name('2025-12-01T00:00:00Z');
		const { keep, delete: remove } = selectForDeletion([outside, inside], now, {
			daily: 0,
			monthly: 12
		});
		expect(keep).toEqual([inside]);
		expect(remove).toEqual([outside]);
	});

	it('is idempotent on its survivors', () => {
		// 400 days at 10:41, a second backup at 22:00 on each of the last 20 days, and one ahead.
		const evenings = daily(20).map((n) => n.replace('T1041', 'T2200'));
		const first = selectForDeletion([...daily(400), ...evenings], NOW);
		expect(first.delete.length).toBeGreaterThan(0);
		const second = selectForDeletion(first.keep, NOW);
		expect(second.keep).toEqual(first.keep);
		expect(second.delete).toEqual([]);
	});

	it('keeps mustKeep and future-dated backups, whatever the windows say', () => {
		const ancient = name('2020-01-15T10:41:00Z');
		const sameDayOlder = name('2026-11-07T01:00:00Z');
		const newest = name('2026-11-07T10:41:00Z');
		const ahead = name('2026-11-07T12:00:01Z');
		const nextYear = name('2027-11-07T10:41:00Z');
		const { keep, delete: remove } = selectForDeletion(
			[ancient, sameDayOlder, newest, ahead, nextYear],
			NOW,
			{ daily: 0, monthly: 0 },
			[ancient, 'backups/2026/11/07/not-in-the-listing.pcbk']
		);
		expect(keep).toEqual([ancient, ahead, nextYear]);
		expect(remove).toEqual([sameDayOlder, newest]);
	});

	it('keeps mustKeep even when it is an older backup of a day', () => {
		const older = name('2026-11-06T01:00:00Z');
		const newer = name('2026-11-06T10:41:00Z');
		const policy = { daily: 30, monthly: 0 };
		expect(selectForDeletion([older, newer], NOW, policy).delete).toEqual([older]);
		const { keep, delete: remove } = selectForDeletion([older, newer], NOW, policy, [older]);
		expect(keep).toEqual([older, newer]);
		expect(remove).toEqual([]);
	});

	it('reports unparseable names and never deletes them', () => {
		const odd = [
			'backups/2026/11/07/coach-20261107T104100z.pcbk',
			'backups/README',
			'../backups/2020/01/01/coach-20200101T000000Z.pcbk',
			'backups/2020/01/01/coach-20200101T000000Z.pcbk.tmp'
		];
		const old = name('2020-01-01T00:00:00Z');
		const { keep, delete: remove, unparseable } = selectForDeletion([...odd, old], NOW);
		expect(unparseable).toEqual([...odd].sort());
		expect(remove).toEqual([old]);
		expect(keep).toEqual([]);
		for (const n of odd) expect(remove).not.toContain(n);
	});

	it('answers each name once when the listing repeats one', () => {
		const n = name('2026-11-06T10:41:00Z');
		expect(selectForDeletion([n, n, 'x', 'x'], NOW)).toEqual({
			keep: [n],
			delete: [],
			unparseable: ['x']
		});
	});

	it('answers an empty listing with nothing', () => {
		expect(selectForDeletion([], NOW)).toEqual({ keep: [], delete: [], unparseable: [] });
	});

	it('refuses an invalid now or a policy that is not a whole number', () => {
		expect(() => selectForDeletion([], new Date(Number.NaN))).toThrow(RangeError);
		expect(() => selectForDeletion([], NOW, { daily: -1, monthly: 12 })).toThrow(RangeError);
		expect(() => selectForDeletion([], NOW, { daily: 30, monthly: 1.5 })).toThrow(RangeError);
	});
});
