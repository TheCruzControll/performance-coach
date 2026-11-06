import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, localDay } from './dates';

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
