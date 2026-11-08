import { describe, expect, it } from 'vitest';
import { ADHOC_DEFAULTS, adhocKindOf, adhocKit } from './adhoc.ts';

const UNITS = { weight: 'lb', distance: 'mi' } as const;
const PLANLESS = {
	plannedLineage: null,
	plannedSessionId: null,
	programId: null,
	versionNumber: null
};

describe('adhocKit', () => {
	it('a run: an easy run with no planned segments, in the owner’s units, linked to no plan', () => {
		expect(adhocKit('run', UNITS, '2026-11-06')).toEqual({
			v: 1,
			kind: 'run',
			title: 'Run',
			sessionType: 'easy_run',
			discipline: 'running',
			date: '2026-11-06',
			...PLANLESS,
			units: UNITS,
			run: { segments: [] }
		});
	});

	it('Muay Thai and other: a 60-minute Muay Thai class with no target and no metrics yet', () => {
		expect(adhocKit('other', UNITS, '2026-11-06')).toEqual({
			v: 1,
			kind: 'other',
			title: 'Muay Thai',
			sessionType: 'muay_thai',
			discipline: 'muay_thai',
			date: '2026-11-06',
			...PLANLESS,
			units: UNITS,
			other: { kind: 'class', durationMinutes: 60, targetRpe: null, metrics: [] }
		});
	});

	it('follows ADHOC_DEFAULTS, the owner’s one place to change them', () => {
		expect(adhocKit('other', UNITS, '2026-11-06').other.durationMinutes).toBe(
			ADHOC_DEFAULTS.other.session.durationMinutes
		);
		expect(adhocKit('run', UNITS, '2026-11-06').title).toBe(ADHOC_DEFAULTS.run.title);
	});

	it('copies the units, so a kit never shares them with its caller', () => {
		const units = { weight: 'kg' as const, distance: 'km' as const };
		const kit = adhocKit('run', units, '2026-11-06');
		units.weight = 'lb' as 'kg';
		expect(kit.units.weight).toBe('kg');
	});
});

describe('adhocKindOf', () => {
	it('reads run and other, and nothing else (strength arrives with add-exercise)', () => {
		expect(adhocKindOf('run')).toBe('run');
		expect(adhocKindOf('other')).toBe('other');
		for (const value of ['strength', '', 'RUN', null]) expect(adhocKindOf(value)).toBeNull();
	});
});
