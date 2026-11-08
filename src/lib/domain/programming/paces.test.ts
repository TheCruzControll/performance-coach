import { describe, expect, it } from 'vitest';
import { RUN_SEGMENT_KINDS } from '../training/vocabulary';
import {
	bestRecentPerformance,
	currentPaces,
	heartRateZones,
	paceFor,
	raceEquivalent,
	raceWeight,
	trainingPaces,
	vdotFromEasyPace,
	vdotFromPerformance,
	zoneOf
} from './paces';
import type { Race } from './paces';
import * as P from './rules/paces';
import { PACE_INTENSITIES, SEGMENT_PACES } from './rules/paces';
import { RULE_BY_ID } from './rules/registry/index';
import { EFFORTS, RIEGEL_EXPONENT } from './rules/running';

const MILE = 1609.344;
const ON = '2026-06-01';
const race = (metres: number, seconds: number, racedOn: string | null): Race => ({
	distanceMetres: metres,
	timeSeconds: seconds,
	racedOn
});

describe('vdotFromPerformance', () => {
	it('gives 49.8 for a 20:00 5K and about 51 for a 1:30 half, as Daniels’ tables do', () => {
		expect(vdotFromPerformance(5000, 20 * 60)).toBeCloseTo(49.8, 0);
		expect(Math.abs(vdotFromPerformance(5000, 20 * 60) - 49.8)).toBeLessThanOrEqual(0.3);
		expect(Math.abs(vdotFromPerformance(21_097.5, 90 * 60) - 51)).toBeLessThanOrEqual(0.5);
		// Daniels' table: VDOT 50 runs the 10K in 41:21 and the marathon in 3:10:49.
		expect(Math.abs(vdotFromPerformance(10_000, 41 * 60 + 21) - 50)).toBeLessThanOrEqual(0.2);
		expect(Math.abs(vdotFromPerformance(42_195, 3 * 3600 + 10 * 60 + 49) - 50)).toBeLessThanOrEqual(
			0.2
		);
	});

	it('carries a distance the equations do not read by Riegel to the nearer end', () => {
		const ultra = vdotFromPerformance(50_000, 5 * 3600);
		const carried = 5 * 3600 * (42_195 / 50_000) ** RIEGEL_EXPONENT;
		expect(ultra).toBeCloseTo(vdotFromPerformance(42_195, carried), 9);
		const mile = vdotFromPerformance(1000, 200);
		expect(mile).toBeCloseTo(vdotFromPerformance(1500, 200 * 1.5 ** RIEGEL_EXPONENT), 9);
	});

	it('refuses a distance or time that is not positive', () => {
		expect(() => vdotFromPerformance(0, 1200)).toThrow(RangeError);
		expect(() => vdotFromPerformance(5000, Number.NaN)).toThrow(RangeError);
	});
});

describe('trainingPaces', () => {
	// Daniels' Running Formula, Table 2 (VDOT training intensities): E per km, M per mile,
	// T and I per km, R per 400 m, all here in seconds per km.
	const PUBLISHED = {
		40: { E: 367, M: 526 / (MILE / 1000), T: 306, I: 282, R: 106 * 2.5 },
		50: { E: 307, M: 437 / (MILE / 1000), T: 255, I: 235, R: 87 * 2.5 },
		60: { E: 265, M: 374 / (MILE / 1000), T: 220, I: 203, R: 75 * 2.5 }
	} as const;

	it.each([40, 50, 60] as const)('at VDOT %i is within 2 %% of Daniels’ table', (vdot) => {
		const paces = trainingPaces(vdot);
		for (const intensity of PACE_INTENSITIES) {
			const [fast, slow] = paces[intensity];
			const published = PUBLISHED[vdot][intensity];
			expect(published, `${intensity} at ${vdot}`).toBeGreaterThanOrEqual(fast * 0.98);
			expect(published, `${intensity} at ${vdot}`).toBeLessThanOrEqual(slow * 1.02);
		}
		// Daniels' M is the marathon the VDOT predicts.
		const marathonPace = raceEquivalent(vdot, 42_195) / 42.195;
		expect(Math.abs(marathonPace / PUBLISHED[vdot].M - 1)).toBeLessThanOrEqual(0.02);
	});

	it('gives ranges, fastest first, that get faster with VDOT and from E to R', () => {
		let previous = trainingPaces(30);
		for (let vdot = 31; vdot <= 85; vdot++) {
			const paces = trainingPaces(vdot);
			for (const intensity of PACE_INTENSITIES) {
				const [fast, slow] = paces[intensity];
				expect(fast).toBeLessThan(slow);
				expect(fast).toBeLessThanOrEqual(previous[intensity][0]);
				expect(slow).toBeLessThan(previous[intensity][1]);
			}
			const middles = PACE_INTENSITIES.map((i) => paces[i][0] + paces[i][1]);
			expect(middles).toEqual([...middles].sort((a, b) => b - a));
			previous = paces;
		}
	});

	it('keeps every pace inside the segment contract', () => {
		for (const vdot of [1, 120]) {
			for (const [fast, slow] of Object.values(trainingPaces(vdot))) {
				expect(fast).toBeGreaterThanOrEqual(120);
				expect(slow).toBeLessThanOrEqual(1500);
			}
		}
	});
});

describe('raceEquivalent', () => {
	it('round-trips with vdotFromPerformance', () => {
		for (const [metres, seconds] of [
			[1500, 290],
			[5000, 1200],
			[10_000, 2700],
			[21_097.5, 5400],
			[42_195, 14_400]
		] as const) {
			expect(raceEquivalent(vdotFromPerformance(metres, seconds), metres)).toBe(seconds);
		}
		for (const vdot of [35, 50, 70]) {
			expect(vdotFromPerformance(10_000, raceEquivalent(vdot, 10_000))).toBeCloseTo(vdot, 1);
		}
	});

	it('predicts Daniels’ published times', () => {
		// VDOT 50: 5K 19:57, half 1:31:35, marathon 3:10:49.
		expect(Math.abs(raceEquivalent(50, 5000) - (19 * 60 + 57))).toBeLessThanOrEqual(3);
		expect(Math.abs(raceEquivalent(50, 21_097.5) - (91 * 60 + 35))).toBeLessThanOrEqual(15);
		expect(Math.abs(raceEquivalent(50, 42_195) - (190 * 60 + 49))).toBeLessThanOrEqual(30);
	});

	it('carries beyond the marathon by Riegel', () => {
		const marathon = raceEquivalent(50, 42_195);
		expect(
			Math.abs(raceEquivalent(50, 50_000) - marathon * (50_000 / 42_195) ** 1.06)
		).toBeLessThan(1);
	});
});

describe('segment kinds', () => {
	it('maps every run segment kind to an intensity, steady to marathon pace', () => {
		const paces = trainingPaces(50);
		for (const kind of RUN_SEGMENT_KINDS) {
			expect(PACE_INTENSITIES, kind).toContain(SEGMENT_PACES[kind]);
			expect(paceFor(kind, paces)).toBe(paces[SEGMENT_PACES[kind]]);
		}
		expect(SEGMENT_PACES).toMatchObject({ steady: 'M', tempo: 'T', interval: 'I', easy: 'E' });
		expect(paceFor('steady', paces)).toBe(paces.M);
		expect(Object.values(SEGMENT_PACES)).not.toContain('R');
	});

	it('gives each kind the heart-rate zone M3’s segments already carry', () => {
		for (const [kind, effort] of Object.entries(EFFORTS)) {
			expect(zoneOf(kind as keyof typeof EFFORTS), kind).toBe(effort.hrZone);
		}
		expect(zoneOf('steady')).toBe(3);
	});
});

describe('which race sets the paces', () => {
	it('gives every race a weight: in full, low, undated or stale', () => {
		expect(raceWeight(race(5000, 1200, '2026-05-01'), ON)).toBe('full');
		expect(raceWeight(race(5000, 1200, '2025-12-01'), ON)).toBe('full'); // 182 days
		expect(raceWeight(race(5000, 1200, '2025-11-30'), ON)).toBe('low');
		expect(raceWeight(race(5000, 1200, '2025-06-02'), ON)).toBe('low'); // 364 days
		expect(raceWeight(race(5000, 1200, '2025-06-01'), ON)).toBe('stale');
		expect(raceWeight(race(5000, 1200, null), ON)).toBe('undated');
		expect(raceWeight(race(5000, 1200, '2026-06-05'), ON)).toBe('full');
	});

	it('takes a newer, slower race over an older, faster one', () => {
		const newer = race(5000, 22 * 60, '2026-04-01');
		const older = race(5000, 19 * 60, '2025-09-01');
		expect(bestRecentPerformance([older, newer], ON)).toMatchObject({
			race: newer,
			confidence: 'full',
			dated: true
		});
	});

	it('takes the best of the recent races, the newest on a tie', () => {
		const slow = race(10_000, 45 * 60, '2026-05-01');
		const fast = race(5000, 20 * 60, '2026-02-01');
		expect(bestRecentPerformance([slow, fast], ON)?.race).toBe(fast);
		const again = race(5000, 20 * 60, '2026-03-01');
		expect(bestRecentPerformance([fast, again], ON)?.race).toBe(again);
		expect(bestRecentPerformance([again, fast], ON)?.race).toBe(again);
	});

	it('counts an older race only when no newer exists, at low confidence', () => {
		const older = race(10_000, 42 * 60, '2025-09-01');
		const performance = bestRecentPerformance([older], ON);
		expect(performance).toMatchObject({ race: older, confidence: 'low', dated: true });
		expect(performance?.vdot).toBe(vdotFromPerformance(10_000, 42 * 60));
		expect(performance?.reason).toMatch(/over 26 weeks old/);
		expect(bestRecentPerformance([race(10_000, 42 * 60, '2025-01-01')], ON)).toBeNull();
	});

	it('gives an owner with only undated races race-based paces at low confidence', () => {
		const undated = race(21_097.5, 95 * 60, null);
		const performance = bestRecentPerformance([undated], ON);
		expect(performance).toMatchObject({ race: undated, confidence: 'low', dated: false });
		expect(performance?.reason).toMatch(/has no date/);
		expect(currentPaces({ races: [undated], easyPaceSecondsPerKm: 330 }, ON)).toMatchObject({
			source: 'race',
			confidence: 'low',
			paces: trainingPaces(vdotFromPerformance(21_097.5, 95 * 60))
		});
		// Any dated race, even one too old to count, shuts the undated one out.
		const stale = race(5000, 18 * 60, '2024-01-01');
		expect(bestRecentPerformance([stale, undated], ON)).toBeNull();
		const races = [stale, undated];
		expect(currentPaces({ races, easyPaceSecondsPerKm: 330 }, ON).source).toBe('easy_pace');
		expect(currentPaces({ races, easyPaceSecondsPerKm: null }, ON).source).toBe('effort');
	});

	it('takes a dated race over a faster undated one', () => {
		const dated = race(5000, 24 * 60, '2025-08-01');
		const undated = race(5000, 18 * 60, null);
		expect(bestRecentPerformance([undated, dated], ON)).toMatchObject({ race: dated, dated: true });
	});

	it('falls back to the told easy pace, then to effort alone', () => {
		const told = currentPaces({ races: [], easyPaceSecondsPerKm: 330 }, ON);
		expect(told).toMatchObject({ source: 'easy_pace', confidence: 'low' });
		expect(told.source === 'easy_pace' && told.vdot).toBe(vdotFromEasyPace(330));
		const [fast, slow] = told.paces!.E;
		expect(fast).toBeLessThan(330);
		expect(slow).toBeGreaterThan(330);
		const stale = [race(5000, 20 * 60, '2024-01-01')];
		expect(currentPaces({ races: stale, easyPaceSecondsPerKm: 330 }, ON).source).toBe('easy_pace');
		expect(currentPaces({ races: stale, easyPaceSecondsPerKm: null }, ON)).toEqual({
			source: 'effort',
			paces: null
		});
	});
});

describe('heartRateZones', () => {
	it('gives Karvonen zones from max and resting: zone 2 of 190 and 50 is 134–148 bpm', () => {
		expect(heartRateZones({ maxHr: 190, restingHr: 50 })).toEqual({
			method: 'reserve',
			zones: [
				[120, 134],
				[134, 148],
				[148, 162],
				[162, 176],
				[176, 190]
			]
		});
	});

	it('gives Friel’s bands from threshold heart rate, ahead of every other method', () => {
		const friel = {
			method: 'threshold',
			zones: [
				[111, 145],
				[145, 153],
				[153, 162],
				[162, 170],
				[170, 180]
			]
		};
		expect(heartRateZones({ thresholdHr: 170 })).toEqual(friel);
		expect(heartRateZones({ maxHr: 190, restingHr: 50, thresholdHr: 170 })).toEqual({
			...friel,
			zones: [...friel.zones.slice(0, 4), [170, 180]]
		});
		// Zone 5 never runs above a known max.
		expect(heartRateZones({ maxHr: 175, thresholdHr: 170 })?.zones[4]).toEqual([170, 175]);
	});

	it('falls back to a share of max alone', () => {
		expect(heartRateZones({ maxHr: 200, restingHr: null })).toEqual({
			method: 'max',
			zones: [
				[100, 120],
				[120, 140],
				[140, 160],
				[160, 180],
				[180, 200]
			]
		});
	});

	it('gives null with no data, resting alone, or heart rates that cannot all be right', () => {
		expect(heartRateZones({})).toBeNull();
		expect(heartRateZones({ maxHr: null, restingHr: null, thresholdHr: null })).toBeNull();
		expect(heartRateZones({ restingHr: 50 })).toBeNull();
		expect(heartRateZones({ maxHr: 150, restingHr: 160 })).toBeNull();
		expect(heartRateZones({ maxHr: 180, thresholdHr: 185 })).toBeNull();
		expect(heartRateZones({ restingHr: 60, thresholdHr: 60 })).toBeNull();
		expect(heartRateZones({ maxHr: 250 })).toBeNull();
		expect(heartRateZones({ maxHr: 190, restingHr: 20 })).toBeNull();
		expect(heartRateZones({ thresholdHr: Number.NaN })).toBeNull();
	});

	it('gives contiguous, ordered zones, the same every time', () => {
		for (const rates of [
			{ maxHr: 190, restingHr: 50 },
			{ thresholdHr: 165 },
			{ maxHr: 185 },
			{ maxHr: 201, restingHr: 47, thresholdHr: 177 }
		]) {
			const { zones } = heartRateZones(rates)!;
			expect(zones).toHaveLength(5);
			zones.forEach(([low, high], i) => {
				expect(low).toBeLessThan(high);
				if (i > 0) expect(low).toBe(zones[i - 1]![1]);
			});
			expect(heartRateZones(rates)).toEqual(heartRateZones(rates));
		}
	});
});

describe('the paces rules in the registry', () => {
	it('registers every rule constant of rules/paces.ts in the paces area, live', () => {
		const live = {
			'paces.vdot': P.DANIELS_GILBERT,
			'paces.vdot_distances': P.VDOT_DISTANCES,
			'paces.training_intensities': P.TRAINING_INTENSITIES,
			'paces.segment_paces': P.SEGMENT_PACES,
			'paces.segment_zones': P.SEGMENT_ZONES,
			'paces.easy_pace_share': P.EASY_PACE_SHARE,
			'paces.limits': P.PACE_LIMITS,
			'paces.recency': P.RECENCY,
			'paces.hr_methods': P.HR_METHODS,
			'paces.hr_zone_bands': P.HR_ZONE_BANDS,
			'paces.hr_limits': P.HR_LIMITS
		};
		for (const [id, values] of Object.entries(live)) {
			const rule = RULE_BY_ID.get(id);
			expect(rule, id).toMatchObject({ area: 'paces', kind: 'constant', status: 'active' });
			expect(rule?.kind === 'constant' && rule.values, id).toBe(values);
		}
	});
});
