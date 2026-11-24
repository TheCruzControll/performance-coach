import { describe, expect, it } from 'vitest';
import { ADHOC_DEFAULTS, adhocKindOf, adhocKit, adhocSessionOf } from './adhoc.ts';

const UNITS = { weight: 'lb', distance: 'mi' } as const;
const PLANLESS = {
	plannedLineage: null,
	plannedSessionId: null,
	programId: null,
	versionNumber: null
};

describe('adhocKit', () => {
	it('strength: a strength session with no exercises yet, in the owner’s units, linked to no plan', () => {
		expect(adhocKit('strength', UNITS, '2026-11-06')).toEqual({
			v: 1,
			kind: 'strength',
			title: 'Strength',
			sessionType: 'strength',
			discipline: 'strength',
			date: '2026-11-06',
			...PLANLESS,
			units: UNITS,
			exercises: []
		});
	});

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

	it('Muay Thai or something else: a 60-minute Muay Thai class with no target and no metrics yet', () => {
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

	it('an other session started as a type: titled by it, that type, 60 minutes, Muay Thai', () => {
		expect(adhocKit('other', UNITS, '2026-11-06', 'pad_work')).toEqual({
			...adhocKit('other', UNITS, '2026-11-06'),
			title: 'Pad work',
			other: { kind: 'pad_work', durationMinutes: 60, targetRpe: null, metrics: [] }
		});
		expect(adhocKit('other', UNITS, '2026-11-06', 'pad_work')).toMatchObject({
			sessionType: 'muay_thai',
			discipline: 'muay_thai'
		});
		expect(adhocKit('other', UNITS, '2026-11-06', 'custom').title).toBe('Your own session');
		expect(adhocKit('other', UNITS, '2026-11-06', 'strength_conditioning')).toMatchObject({
			title: 'Strength and conditioning',
			other: { kind: 'strength_conditioning' }
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
	it('reads strength, run and other, and nothing else', () => {
		expect(adhocKindOf('strength')).toBe('strength');
		expect(adhocKindOf('run')).toBe('run');
		expect(adhocKindOf('other')).toBe('other');
		for (const value of ['planned', '', 'RUN', null]) expect(adhocKindOf(value)).toBeNull();
	});
});

describe('adhocSessionOf', () => {
	it('reads a session type, and nothing else', () => {
		expect(adhocSessionOf('pad_work')).toBe('pad_work');
		expect(adhocSessionOf('custom')).toBe('custom');
		for (const value of ['naps', '', 'toString', 'PAD_WORK', null]) {
			expect(adhocSessionOf(value)).toBeNull();
		}
	});
});
