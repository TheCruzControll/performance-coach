import { describe, expect, it } from 'vitest';
import { acuteChronicRatio, sessionLoad, volumeLoad } from './load';

describe('load metrics', () => {
	it('computes volume load', () => {
		expect(
			volumeLoad([
				{ weight: 100, reps: 5 },
				{ weight: 100, reps: 5 },
				{ weight: 90, reps: 8 }
			])
		).toBe(1720);
		expect(volumeLoad([])).toBe(0);
	});

	it('computes session-RPE load and validates input', () => {
		expect(sessionLoad(60, 7)).toBe(420);
		expect(() => sessionLoad(60, 11)).toThrow(RangeError);
		expect(() => sessionLoad(-1, 5)).toThrow(RangeError);
	});

	it('returns null ACWR until there is enough history', () => {
		expect(acuteChronicRatio(new Array(27).fill(300))).toBeNull();
	});

	it('is ~1.0 for steady load and rises after a spike', () => {
		const steady = new Array(42).fill(300);
		expect(acuteChronicRatio(steady)!.ratio).toBeCloseTo(1, 6);
		const spike = [...new Array(35).fill(300), ...new Array(7).fill(600)];
		expect(acuteChronicRatio(spike)!.ratio).toBeGreaterThan(1.3);
	});
});
