/**
 * The swap rules (domain/workout/substitution.ts) against the generator they copy. Swap in a run
 * is the zone 2 bike session the generator plans (ZONE2_BIKE, cross-training.ts); Swap in a class
 * steps a Muay Thai format down the generator's RPE ladder (MUAY_THAI). Domain code may not import
 * programming at runtime, so the rules write those values out; this test keeps them equal.
 */
import { describe, expect, it } from 'vitest';
import { LIGHTER_KINDS, SWAP_BIKE } from '../workout/substitution';
import { MUAY_THAI, ZONE2_BIKE } from './rules/running';

type Format = 'technical' | 'pad_work' | 'sparring';
const rpe = (format: string) => MUAY_THAI[format as Format].rpe;

describe('Swap in a run is the zone 2 bike the generator plans', () => {
	it('is titled, typed and kinded as a planned zone 2 bike session', () => {
		expect(SWAP_BIKE.title).toBe(ZONE2_BIKE.title);
		expect(SWAP_BIKE.sessionType).toBe('conditioning');
		expect(SWAP_BIKE.kind).toBe('conditioning');
	});
});

describe('Swap in a class steps down the Muay Thai ladder', () => {
	it('offers only formats with a lower RPE than the one swapped from, a commitment class aside', () => {
		for (const [from, tos] of Object.entries(LIGHTER_KINDS)) {
			if (from === 'class') continue;
			for (const to of tos ?? []) {
				expect(rpe(to), `${from} to ${to}`).toBeLessThan(rpe(from));
			}
		}
	});
});
