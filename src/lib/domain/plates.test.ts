import { describe, expect, it } from 'vitest';
import { calculatePlates, STANDARD_PLATES } from './plates';

describe('calculatePlates', () => {
	it('loads a standard kg bar heaviest-first', () => {
		const r = calculatePlates(100, 20, STANDARD_PLATES.kg);
		expect(r.perSide).toEqual([25, 15]);
		expect(r).toMatchObject({ achieved: 100, remainder: 0, exact: true });
	});

	it('prefers the biggest plates among equally short solutions', () => {
		// 30 kg per side: 25+5 (not 20+10 or 15+15)
		expect(calculatePlates(80, 20, STANDARD_PLATES.kg).perSide).toEqual([25, 5]);
	});

	it('handles fractional plates and lb', () => {
		expect(calculatePlates(142.5, 20, STANDARD_PLATES.kg).perSide).toEqual([25, 25, 10, 1.25]);
		expect(calculatePlates(315, 45, STANDARD_PLATES.lb).perSide).toEqual([45, 45, 45]);
		expect(calculatePlates(230, 45, STANDARD_PLATES.lb).perSide).toEqual([45, 45, 2.5]);
		expect(calculatePlates(185, 45, STANDARD_PLATES.lb).perSide).toEqual([45, 25]);
	});

	it('finds exact solutions a greedy fill would miss with limited inventory', () => {
		// per side 30: greedy takes the only 25 then cannot make 5 → DP uses 20 + 10
		const r = calculatePlates(80, 20, [
			{ weight: 25, pairs: 1 },
			{ weight: 20, pairs: 1 },
			{ weight: 10, pairs: 1 }
		]);
		expect(r.perSide).toEqual([20, 10]);
		expect(r.exact).toBe(true);
	});

	it('returns the heaviest load below the target when exact is impossible', () => {
		const r = calculatePlates(101.3, 20, STANDARD_PLATES.kg);
		expect(r.achieved).toBe(101);
		expect(r.remainder).toBe(0.3);
		expect(r.exact).toBe(false);
	});

	it('respects pair limits', () => {
		// 100 per side with only two pairs of 25s: 25+25+20+20 = 90 falls short; 5×20 is exact.
		const r = calculatePlates(220, 20, [{ weight: 25, pairs: 2 }, { weight: 20 }]);
		expect(r.perSide).toEqual([20, 20, 20, 20, 20]);
		expect(r.achieved).toBe(220);
		const capped = calculatePlates(220, 20, [
			{ weight: 25, pairs: 2 },
			{ weight: 20, pairs: 2 }
		]);
		expect(capped).toMatchObject({ perSide: [25, 25, 20, 20], achieved: 200, remainder: 20 });
	});

	it('returns just the bar when the target does not exceed it', () => {
		expect(calculatePlates(20, 20, STANDARD_PLATES.kg)).toEqual({
			perSide: [],
			achieved: 20,
			remainder: 0,
			exact: true
		});
		expect(calculatePlates(15, 20, STANDARD_PLATES.kg).exact).toBe(false);
	});
});
