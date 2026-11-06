import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCES_KEY, preferences } from '#lib/client/preferences.svelte.ts';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';
import { basicsDraft, deviceFollows } from './basics';

const saved: AthleteProfile = {
	name: 'Niko Cruz',
	weightUnit: 'lb',
	distanceUnit: 'mi',
	timeZone: 'America/Los_Angeles',
	birthYear: 1994,
	nutritionPhase: 'cut',
	targetWeight: 160,
	targetDate: '2027-03-13',
	baselinesUnknown: false,
	onboarding: { current: 'goals', completed: ['welcome'], skipped: [], completedAt: null },
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('basicsDraft', () => {
	it('edits the name and the units the coach uses, and nothing else of the profile', () => {
		expect(basicsDraft(saved)).toEqual({ name: 'Niko Cruz', weightUnit: 'lb', distanceUnit: 'mi' });
	});

	it('saves straight back without a time zone, so the saved zone stays', () => {
		const result = validate(SCHEMAS.basics, basicsDraft(saved));
		expect(result).toEqual({ ok: true, data: basicsDraft(saved) });
		expect(result.ok && 'timeZone' in result.data).toBe(false);
	});
});

describe('deviceFollows', () => {
	it('switches this device’s display units to the ones just saved, and keeps its theme', () => {
		const stored = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value)
		});
		expect([preferences.units, preferences.distance]).toEqual(['kg', 'km']);

		deviceFollows({ name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' });
		expect([preferences.units, preferences.distance]).toEqual(['lb', 'mi']);
		expect(JSON.parse(stored.get(PREFERENCES_KEY)!)).toEqual({
			theme: 'dark',
			units: 'lb',
			distance: 'mi'
		});

		deviceFollows({ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km' });
		expect(JSON.parse(stored.get(PREFERENCES_KEY)!)).toMatchObject({ units: 'kg', distance: 'km' });
	});
});
