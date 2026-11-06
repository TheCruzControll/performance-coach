import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { classifyTrend, TREND_METHOD } from './trend';
import type { TrendOptions, TrendResult } from './trend';
import type { SeriesPoint } from './types';

const MONDAY = '2026-08-10';
const at = (day: number) => addDays(MONDAY, day);
const point = (day: number, value: number | null, inProgress = false): SeriesPoint => ({
	at: at(day),
	value,
	inProgress
});
/** Complete weekly points from `values`, Mondays from 10 August 2026. */
const weekly = (values: readonly (number | null)[]) =>
	values.map((value, week) => point(7 * week, value));

/** A seeded linear congruential generator (Numerical Recipes), so every series is reproducible. */
function lcg(seed: number) {
	let state = Math.imul(seed, 0x9e3779b9) >>> 0;
	const uniform = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
	// Box–Muller: a standard normal draw from two uniforms.
	const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
	return { uniform, normal };
}

const SEEDS = Array.from({ length: 200 }, (_, n) => n + 1);
const WEEKS = 12;

/** 12 weeks around 100 with uniform ±3 % noise. */
const flat = (seed: number) => {
	const random = lcg(seed);
	return weekly(Array.from({ length: WEEKS }, () => 100 + 3 * (2 * random.uniform() - 1)));
};
/** 12 weeks from `start`, moving `perWeek` a week, with normal noise of SD `sd`. */
const linear = (seed: number, start: number, perWeek: number, sd: number) => {
	const random = lcg(seed);
	return weekly(
		Array.from({ length: WEEKS }, (_, w) => start + perWeek * w + sd * random.normal())
	);
};

const E1RM: TrendOptions = { direction: 'up', mpc: { rel: 0.025 } };
const PACE: TrendOptions = { direction: 'down', mpc: { rel: 0.02 } };

/** The share of seeds whose result passes `test`. */
const share = (results: readonly TrendResult[], test: (result: TrendResult) => boolean) =>
	results.filter(test).length / results.length;

describe('error rates on 200 seeded series', () => {
	it('calls a flat series with ±3 % noise normal variation, even with no minimal change', () => {
		const results = SEEDS.map((seed) => classifyTrend(flat(seed), { direction: 'up' }));
		const rate = share(results, (result) => result.verdict === 'normal_variation');
		expect(rate, 'flat series called normal variation').toBeGreaterThanOrEqual(0.95);
	});

	it('finds +1 % a week with 1 % noise a real trend, up and good', () => {
		const results = SEEDS.map((seed) => classifyTrend(linear(seed, 100, 1, 1), E1RM));
		const rate = share(
			results,
			(r) => r.verdict === 'real_trend' && r.direction === 'up' && r.good === true
		);
		expect(rate, 'rising series found real, up and good').toBeGreaterThanOrEqual(0.95);
	});

	it('finds the mirrored decline a real trend, down and bad', () => {
		const results = SEEDS.map((seed) => classifyTrend(linear(seed, 100, -1, 1), E1RM));
		const rate = share(
			results,
			(r) => r.verdict === 'real_trend' && r.direction === 'down' && r.good === false
		);
		expect(rate, 'falling series found real, down and bad').toBeGreaterThanOrEqual(0.95);
	});

	it('calls a falling pace good when lower is better, and gives no good for a neutral metric', () => {
		const results = SEEDS.map((seed) => classifyTrend(linear(seed, 330, -3.3, 3.3), PACE));
		const rate = share(
			results,
			(r) => r.verdict === 'real_trend' && r.direction === 'down' && r.good === true
		);
		expect(rate, 'falling pace found real, down and good').toBeGreaterThanOrEqual(0.95);

		const weight = classifyTrend(weekly([80, 80.6, 81, 81.7, 82.1, 82.8]), { direction: 'none' });
		expect(weight).toMatchObject({ verdict: 'real_trend', direction: 'up', good: null });
	});

	it('flags one +20 % outlier on a flat series, with the same verdict as without that week', () => {
		// Either end of the window, where one point weighs most on the Mann–Kendall S, and the middle.
		for (const week of [0, WEEKS / 2, WEEKS - 1]) {
			let flagged = 0;
			let same = 0;
			let normal = 0;
			for (const seed of SEEDS) {
				const series = flat(seed);
				const spike = series[week]!;
				const result = classifyTrend(
					series.with(week, { ...spike, value: spike.value! * 1.2 }),
					E1RM
				);
				const without = classifyTrend(series.toSpliced(week, 1), E1RM);
				if (result.outliers.some((outlier) => outlier.at === spike.at)) flagged++;
				if (result.verdict === without.verdict) same++;
				if (result.verdict === 'normal_variation') normal++;
			}
			expect(flagged, `week ${week}: spikes flagged`).toBe(SEEDS.length);
			expect(normal / SEEDS.length, `week ${week}: called normal`).toBeGreaterThanOrEqual(0.95);
			expect(same / SEEDS.length, `week ${week}: verdict unchanged`).toBeGreaterThanOrEqual(0.95);
		}
	});

	it('keeps a real rise real through one session 20 % low, and flags it', () => {
		for (const week of [0, WEEKS / 2, WEEKS - 1]) {
			const results = SEEDS.map((seed) => {
				const series = linear(seed, 100, 1, 1);
				const dip = series[week]!;
				const result = classifyTrend(series.with(week, { ...dip, value: dip.value! * 0.8 }), E1RM);
				return { result, flagged: result.outliers.some((outlier) => outlier.at === dip.at) };
			});
			expect(
				results.every(({ flagged }) => flagged),
				`week ${week}: dips flagged`
			).toBe(true);
			const rate = share(
				results.map(({ result }) => result),
				(r) => r.verdict === 'real_trend' && r.direction === 'up'
			);
			expect(rate, `week ${week}: still real with one bad session`).toBeGreaterThanOrEqual(0.95);
		}
	});
});

describe('availability', () => {
	it('needs 6 points over 21 days, and says what is missing', () => {
		const sparse = classifyTrend([point(0, 100), point(5, 101), point(10, 103)], E1RM);
		expect(sparse).toMatchObject({
			verdict: 'insufficient_data',
			needs: { points: 3, days: 11 },
			n: 3,
			spanDays: 10,
			method: TREND_METHOD
		});
		expect(classifyTrend([], E1RM)).toMatchObject({
			verdict: 'insufficient_data',
			needs: { points: 6, days: 21 },
			n: 0,
			spanDays: 0,
			slopePerWeek: null,
			p: null,
			noise: null,
			outliers: []
		});
	});

	const days = [0, 4, 8, 13, 17, 21];
	/** Exactly linear in days, so the change along the line is `change` and the noise is 0. */
	const rising = (change: number, on = days) =>
		on.map((day) => point(day, 100 + (change * day) / on.at(-1)!));

	it('is enough at exactly 6 points over 21 days, and one point or one day short is not', () => {
		expect(classifyTrend(rising(5), E1RM)).toMatchObject({
			verdict: 'real_trend',
			n: 6,
			spanDays: 21
		});
		expect(classifyTrend(rising(5, [0, 4, 8, 13, 21]), E1RM)).toMatchObject({
			verdict: 'insufficient_data',
			needs: { points: 1, days: 0 }
		});
		expect(classifyTrend(rising(5, [0, 4, 8, 12, 16, 20]), E1RM)).toMatchObject({
			verdict: 'insufficient_data',
			needs: { points: 0, days: 1 }
		});
	});

	it('takes changes from the minimal practical change up as real, and not just under it', () => {
		const options: TrendOptions = { direction: 'up', mpc: { abs: 2.5 } };
		expect(classifyTrend(rising(2.49), options).verdict).toBe('normal_variation');
		expect(classifyTrend(rising(2.5), options)).toMatchObject({
			verdict: 'real_trend',
			change: 2.5
		});
		expect(classifyTrend(rising(2.51), options).verdict).toBe('real_trend');
		// A relative minimal change is a share of the line's starting level (100 here).
		const relative: TrendOptions = { direction: 'up', mpc: { rel: 0.025 } };
		expect(classifyTrend(rising(2.49), relative)).toMatchObject({
			verdict: 'normal_variation',
			minChange: 2.5,
			changePct: 2.49
		});
		expect(classifyTrend(rising(2.51), relative).verdict).toBe('real_trend');
	});

	it('never lets a low point in progress, or a gap, change the verdict or count toward it', () => {
		for (const seed of SEEDS.slice(0, 20)) {
			for (const series of [flat(seed), linear(seed, 100, 1, 1)]) {
				const withWeekSoFar = [...series, point(7 * WEEKS, 31, true), point(7 * WEEKS + 7, null)];
				expect(classifyTrend(withWeekSoFar, E1RM)).toEqual(classifyTrend(series, E1RM));
			}
		}
		const five = weekly([100, 102, 104, 106, 108]);
		expect(classifyTrend([...five, point(35, 40, true)], E1RM)).toMatchObject({
			verdict: 'insufficient_data',
			n: 5,
			spanDays: 28,
			needs: { points: 1, days: 0 }
		});
	});
});

describe('the change that counts', () => {
	it('calls a significant change under the minimal practical change normal variation', () => {
		const creeping = weekly(Array.from({ length: WEEKS }, (_, w) => 100 + 0.1 * w));
		const result = classifyTrend(creeping, E1RM);
		expect(result).toMatchObject({ verdict: 'normal_variation', change: 1.1, noise: 0 });
		expect(result.p).toBeLessThan(0.001);
		expect(classifyTrend(creeping, { direction: 'up' }).verdict).toBe('real_trend');
	});

	it('calls a significant change within twice the noise normal variation', () => {
		// +0.5 a week under a ±6 zigzag: S = 36 (p ≈ 0.02), but the change (5.5) is inside 2 × noise.
		const zigzag = weekly(
			Array.from({ length: WEEKS }, (_, w) => 100 + 0.5 * w + (w % 2 ? 6 : -6))
		);
		const result = classifyTrend(zigzag, { direction: 'up', mpc: { abs: 1 } });
		expect(result.p).toBeLessThan(0.05);
		expect(result).toMatchObject({
			verdict: 'normal_variation',
			slopePerWeek: 0.5,
			change: 5.5,
			noise: 8.8956,
			minChange: 17.7912,
			outliers: []
		});
	});
});

/** A permutation of 0…n−1 with exactly `inversions` inversions (its Lehmer code, greedily). */
function withInversions(n: number, inversions: number): number[] {
	const left = Array.from({ length: n }, (_, k) => k);
	let remaining = inversions;
	return Array.from({ length: n }, (_, i) => {
		const skip = Math.min(remaining, n - 1 - i);
		remaining -= skip;
		return left.splice(skip, 1)[0]!;
	});
}
/** n weekly points with Mann–Kendall S = s and no ties. */
const withS = (n: number, s: number) =>
	weekly(withInversions(n, (n * (n - 1)) / 2 / 2 - s / 2).map((rank) => 100 + rank));

describe('the Mann–Kendall p', () => {
	// P(S ≥ s) under no trend, to three significant figures, for s = n(n − 1)/2 mod 2, then every
	// second value up to n(n − 1)/2: Kendall, Rank Correlation Methods (1975), Appendix Table 1,
	// reproduced in Gilbert (1987), Table A18.
	const TABLE: Record<number, readonly number[]> = {
		4: [0.625, 0.375, 0.167, 0.0417],
		5: [0.592, 0.408, 0.242, 0.117, 0.0417, 0.00833],
		6: [0.5, 0.36, 0.235, 0.136, 0.0681, 0.0278, 0.00833, 0.00139],
		7: [0.5, 0.386, 0.281, 0.191, 0.119, 0.0681, 0.0345, 0.0151, 0.00536, 0.00139, 0.000198],
		8: [
			0.548, 0.452, 0.36, 0.274, 0.199, 0.138, 0.0894, 0.0543, 0.0305, 0.0156, 0.00707, 0.00275,
			0.000868, 0.000198, 0.0000248
		],
		9: [
			0.54, 0.46, 0.381, 0.306, 0.238, 0.179, 0.13, 0.0901, 0.0597, 0.0376, 0.0223, 0.0124, 0.00633,
			0.00294, 0.00121, 0.000427, 0.000121, 0.0000248, 0.00000276
		],
		10: [
			0.5, 0.431, 0.364, 0.3, 0.242, 0.19, 0.146, 0.108, 0.0779, 0.0542, 0.0363, 0.0233, 0.0143,
			0.00833, 0.00457, 0.00234, 0.00111, 0.000473, 0.000179, 0.0000576, 0.0000149, 0.00000276,
			0.000000276
		]
	};

	it('is exact, matching the published table for n = 4 to 10, rising and falling', () => {
		for (const [key, column] of Object.entries(TABLE)) {
			const n = Number(key);
			for (const [k, upper] of column.entries()) {
				const s = (((n * (n - 1)) / 2) % 2) + 2 * k;
				const twoSided = s === 0 ? 1 : 2 * upper;
				// Half a unit in the table's third significant figure, doubled for two sides.
				const tolerance = 10 ** (Math.floor(Math.log10(upper)) - 2);
				for (const sign of [1, -1]) {
					const { p } = classifyTrend(withS(n, sign * s), E1RM);
					expect(Math.abs(p! - twoSided), `n = ${n}, S = ${sign * s}`).toBeLessThanOrEqual(
						tolerance
					);
				}
			}
		}
	});

	it('cannot reach p < 0.05 with 4 points, which is why a verdict needs 6', () => {
		const four = [point(0, 100), point(7, 105), point(14, 110), point(21, 115)];
		const result = classifyTrend(four, { direction: 'up', minPoints: 4 });
		expect(result.p).toBeCloseTo(1 / 12, 10);
		expect(result.verdict).toBe('normal_variation');
	});

	it('uses the normal approximation with continuity correction beyond 20 points', () => {
		// S = 50, Var(S) = 21 × 20 × 47 / 18, z = 49 / √Var(S); the exact p would be 0.14032.
		expect(classifyTrend(withS(21, 50), E1RM).p).toBeCloseTo(0.1389669, 6);
	});

	it('corrects for heavy ties', () => {
		// Hard sets a week, in three steps of four tied weeks: S = 48 and, corrected for the three
		// ties of 4, Var(S) = (12·11·29 − 3·4·3·13) / 18 = 560 / 3, so z = 47 / √(560 / 3) and
		// p = 0.0005816 (0.0012690 without the tie correction).
		const steps = weekly([10, 10, 10, 10, 12, 12, 12, 12, 14, 14, 14, 14]);
		const result = classifyTrend(steps, { direction: 'up', mpc: { abs: 2 } });
		expect(result.p).toBeCloseTo(0.0005816115, 9);
		expect(result).toMatchObject({ verdict: 'real_trend', direction: 'up', good: true });

		// Alternating ties: S = 6, Var(S) = 156, p = 0.689; the slope is 0.
		const alternating = weekly(Array.from({ length: WEEKS }, (_, w) => (w % 2 ? 12 : 10)));
		const flatTies = classifyTrend(alternating, { direction: 'up' });
		expect(flatTies.p).toBeCloseTo(0.6889206, 6);
		expect(flatTies).toMatchObject({ verdict: 'normal_variation', slopePerWeek: 0, change: 0 });
	});
});

describe('robustness', () => {
	const numbers = (result: TrendResult) => [
		result.slopePerWeek,
		result.change,
		result.changePct,
		result.noise,
		result.minChange,
		result.p
	];

	it('gives a constant series noise 0, normal variation and no NaN', () => {
		for (const value of [80, 0, -3.7, 1e9 + 0.3]) {
			const result = classifyTrend(weekly(Array.from({ length: WEEKS }, () => value)), E1RM);
			expect(result, String(value)).toMatchObject({
				verdict: 'normal_variation',
				noise: 0,
				slopePerWeek: 0,
				change: 0,
				p: 1,
				outliers: []
			});
			expect(
				numbers(result).every((n) => n === null || Number.isFinite(n)),
				String(value)
			).toBe(true);
		}
	});

	it('never changes the result with the order of the points', () => {
		for (const seed of SEEDS.slice(0, 50)) {
			const series = linear(seed, 100, seed % 3 === 0 ? 0 : 0.6, 1.5);
			series[seed % WEEKS] = { ...series[seed % WEEKS]!, value: 130 };
			const shuffled = [...series];
			const random = lcg(seed + 1000);
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(random.uniform() * (i + 1));
				[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
			}
			expect(classifyTrend(shuffled, E1RM), `seed ${seed}`).toEqual(classifyTrend(series, E1RM));
		}
	});

	it('never pairs two values on one day, for the slope or for S', () => {
		// +2 a week, with 104 and 108 also on the Monday of week 3 (whose line value is 106). Pairs
		// on other days give S = 40; with the tie of 3 days and the two ties of 2 values, Kendall's
		// Var(S) = (10·9·25 − 3·2·11 − 2·2·1·9) / 18 + (6 × 4) / (2·10·9), so p = 0.00035953.
		const series = [
			...weekly([100, 102, 104, 106, 108, 110, 112, 114]),
			point(21, 104),
			point(21, 108)
		];
		const result = classifyTrend(series, E1RM);
		expect(classifyTrend([...series].reverse(), E1RM)).toEqual(result);
		expect(result.p).toBeCloseTo(0.0003595317, 9);
		expect(result).toMatchObject({
			verdict: 'real_trend',
			n: 10,
			spanDays: 49,
			slopePerWeek: 2,
			change: 14,
			noise: 0,
			outliers: [
				{ at: at(21), value: 104 },
				{ at: at(21), value: 108 }
			]
		});
	});

	it('refuses values that are not finite and options that are out of range', () => {
		expect(() => classifyTrend(weekly([1, 2, Number.NaN]), E1RM)).toThrow(RangeError);
		expect(() => classifyTrend([], { direction: 'up', alpha: 0 })).toThrow(RangeError);
		expect(() => classifyTrend([], { direction: 'up', minPoints: 2 })).toThrow(RangeError);
		expect(() => classifyTrend([], { direction: 'up', minSpanDays: 0 })).toThrow(RangeError);
		expect(() => classifyTrend([], { direction: 'up', mpc: { rel: -0.1 } })).toThrow(RangeError);
	});
});
