import { describe, expect, it, vi } from 'vitest';
import { canonicalTimeZone, DAY_MEMO_MAX, localDay } from './dates';

describe('localDay', () => {
	it('is the day the owner lived, not the UTC one', () => {
		// 18:30 on 5 November in Los Angeles (PST, UTC−8).
		expect(localDay(new Date('2026-11-06T02:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-05');
		expect(localDay(new Date('2026-11-06T02:30:00Z'), 'UTC')).toBe('2026-11-06');
		// Zones ahead of UTC, including half-hour offsets, reach tomorrow first.
		expect(localDay(new Date('2026-11-05T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-11-06');
		expect(localDay(new Date('2026-11-05T18:45:00Z'), 'Asia/Kolkata')).toBe('2026-11-06');
		expect(localDay(new Date('2026-11-05T18:15:00Z'), 'Asia/Kolkata')).toBe('2026-11-05');
	});

	it('follows daylight saving time', () => {
		// 00:30 on 1 July in Los Angeles (PDT, UTC−7); a fixed UTC−8 would say 30 June.
		expect(localDay(new Date('2026-07-01T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-07-01');
		expect(localDay(new Date('2026-12-01T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-30');
	});

	it('makes one formatter per time zone and formats each instant once, however often asked', () => {
		// A zone no other test asks for, so nothing is made or memoised for it yet.
		const zone = 'Pacific/Chatham';
		const made = vi.spyOn(Intl, 'DateTimeFormat');
		const formatted = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
		const instants = Array.from(
			{ length: 200 },
			(_, i) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000)
		);
		const days = instants.map((at) => localDay(at, zone));
		for (let pass = 0; pass < 4; pass++)
			expect(instants.map((at) => localDay(new Date(at.getTime()), zone))).toEqual(days);
		expect(made).toHaveBeenCalledTimes(1);
		expect(formatted).toHaveBeenCalledTimes(instants.length);
		made.mockRestore();
		formatted.mockRestore();
		// Chatham is UTC+13:45 in January: 10:15 UTC is already tomorrow there.
		expect(localDay(new Date('2026-01-01T10:15:00Z'), zone)).toBe('2026-01-02');
		expect(localDay(new Date('2026-01-01T10:14:00Z'), zone)).toBe('2026-01-01');
	});

	it('keeps each zone’s memo bounded', () => {
		expect(DAY_MEMO_MAX).toBe(50_000);
	});
});

describe('canonicalTimeZone', () => {
	it('accepts IANA zones and UTC, spelled as Intl resolves them', () => {
		expect(canonicalTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
		expect(canonicalTimeZone('america/los_angeles')).toBe('America/Los_Angeles');
		expect(canonicalTimeZone('Europe/London')).toBe('Europe/London');
		expect(canonicalTimeZone('UTC')).toBe('UTC');
		// Engines differ on the canonical name of renamed zones; either way it is supported.
		expect(canonicalTimeZone('Asia/Kolkata')).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
	});

	it('refuses anything else, fixed offsets included', () => {
		for (const value of ['', 'Mars/Olympus', 'Local', 'Los Angeles', '+05:30', '-08:00']) {
			expect(canonicalTimeZone(value), value).toBeNull();
		}
	});
});
