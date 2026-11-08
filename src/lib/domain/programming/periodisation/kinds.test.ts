import { describe, expect, it } from 'vitest';
import { PHASES, WEEK_KINDS } from '../../training/vocabulary';
import {
	BLOCK_PHASES,
	BLOCK_WEEK_KINDS,
	LIGHT_RUNNING_WEEK_KINDS,
	LIGHT_WEEK_KINDS,
	WEEK_KIND_WHY
} from './kinds';

describe('periodisation kinds', () => {
	it('maps every block type to known phases and week kinds, the same types in both', () => {
		expect(Object.keys(BLOCK_WEEK_KINDS)).toEqual(Object.keys(BLOCK_PHASES));
		for (const [type, phases] of Object.entries(BLOCK_PHASES)) {
			expect(phases.length, type).toBeGreaterThan(0);
			for (const phase of phases) expect(PHASES, type).toContain(phase);
		}
		for (const [type, weeks] of Object.entries(BLOCK_WEEK_KINDS)) {
			for (const kind of Object.values(weeks)) expect(WEEK_KINDS, type).toContain(kind);
		}
	});

	it('gives a half its own phases and the same weeks as a marathon', () => {
		expect(BLOCK_PHASES.half).toEqual(['half_base', 'half_build', 'half_peak', 'half_taper']);
		expect(BLOCK_WEEK_KINDS.half).toEqual(BLOCK_WEEK_KINDS.marathon);
		expect(BLOCK_WEEK_KINDS.strength.realization).toBe('peak');
		expect(BLOCK_WEEK_KINDS.fight_camp).toEqual({
			camp: 'build',
			sparring_peak: 'peak',
			fight: 'event',
			deload: 'deload'
		});
	});

	it('marks deload, taper, event and recovery light, and a cutback light for running only', () => {
		expect([...LIGHT_WEEK_KINDS]).toEqual(['deload', 'taper', 'event', 'recovery']);
		for (const kind of LIGHT_RUNNING_WEEK_KINDS) expect(WEEK_KINDS).toContain(kind);
		expect(LIGHT_WEEK_KINDS).not.toContain('cutback');
		expect([...LIGHT_RUNNING_WEEK_KINDS]).toEqual([...LIGHT_WEEK_KINDS, 'cutback']);
	});

	it('gives each named week kind a reason: one complete sentence of at most 80 characters', () => {
		expect(Object.keys(WEEK_KIND_WHY).sort()).toEqual(
			['cutback', 'deload', 'event', 'maintenance', 'recovery', 'taper'].sort()
		);
		for (const [kind, why] of Object.entries(WEEK_KIND_WHY)) {
			expect(WEEK_KINDS, kind).toContain(kind);
			expect(why, kind).toMatch(/^[A-Z][^.!?]*\.$/);
			expect(why.length, kind).toBeLessThanOrEqual(80);
		}
	});
});
