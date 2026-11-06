import { describe, expect, it } from 'vitest';
import { volumeLoad } from '../load';
import { personalRecords, setE1rm } from '../training/metrics';
import type { LoadType, Measure } from '../training/vocabulary';
import { convertWeight } from '../units';
import {
	checkSet,
	e1rmApplies,
	e1rmOf,
	LOAD_RULES,
	prCandidates,
	prKinds,
	setFields,
	totals,
	volumeOf
} from './logging';
import type { RuledSet } from './logging';
import type { ExerciseSummary } from './types';

const exercise = (name: string, measure: Measure, loadType: LoadType): ExerciseSummary => ({
	name,
	measure,
	loadType,
	unilateral: false
});

const BACK_SQUAT = exercise('Back squat', 'reps', 'external');
const PULL_UP = exercise('Pull-up', 'reps', 'bodyweight');
const ASSISTED_PULL_UP = exercise('Assisted pull-up', 'reps', 'assisted');
const BANDED_WALK = exercise('Banded lateral walk', 'reps', 'none');
const PLANK = exercise('Plank', 'time', 'bodyweight');
const SLED_PUSH = exercise('Sled push', 'distance', 'external');

/** A performed working set; each test fills in what it records. */
const set = (values: Partial<RuledSet> = {}): RuledSet => ({
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	isSkipped: false,
	...values
});

type Field = 'reps' | 'seconds' | 'metres' | 'missedReps' | 'weight' | 'assistance';

/** A value each field accepts when its exercise records it. */
const FILLED: Record<Field, number> = {
	reps: 5,
	seconds: 45,
	metres: 30,
	missedReps: 2,
	weight: 20,
	assistance: 20
};

interface Pair {
	measure: Measure;
	loadType: LoadType;
	load: 'weight' | 'added' | 'assistance' | null;
	amount: 'reps' | 'seconds' | 'metres';
	labels: { load: string | null; amount: string; blank: string | null };
	/** Left blank, refused at its path. */
	needs: Field[];
	/** Filled in, refused at its path. */
	refuses: Field[];
}

const AMOUNT_LABEL = { reps: 'Reps', seconds: 'Time', metres: 'Distance' } as const;
const NOT_REPS: Field[] = ['reps', 'missedReps'];

/** Every measure × load type pair, written out rather than derived from the rules under test. */
const PAIRS: Pair[] = (
	[
		['reps', 'reps', ['seconds', 'metres']],
		['time', 'seconds', [...NOT_REPS, 'metres']],
		['distance', 'metres', [...NOT_REPS, 'seconds']]
	] as const
).flatMap(([measure, amount, foreign]): Pair[] => {
	const labels = (load: string | null, blank: string | null) => ({
		load,
		amount: AMOUNT_LABEL[amount],
		blank
	});
	return [
		{
			measure,
			loadType: 'external',
			load: 'weight',
			amount,
			labels: labels('Weight', null),
			needs: [amount, 'weight'],
			refuses: [...foreign, 'assistance']
		},
		{
			measure,
			loadType: 'bodyweight',
			load: 'added',
			amount,
			labels: labels('Added weight', 'Bodyweight'),
			needs: [amount],
			refuses: [...foreign, 'assistance']
		},
		{
			measure,
			loadType: 'assisted',
			load: 'assistance',
			amount,
			labels: labels('Assistance', 'Assisted'),
			needs: [amount],
			refuses: [...foreign, 'weight']
		},
		{
			measure,
			loadType: 'none',
			load: null,
			amount,
			labels: labels(null, null),
			needs: [amount],
			refuses: [...foreign, 'weight', 'assistance']
		}
	];
});

describe('setFields and checkSet, for every measure and load type', () => {
	it('covers all twelve pairs', () => {
		expect(PAIRS).toHaveLength(12);
		expect(new Set(PAIRS.map((p) => `${p.measure}/${p.loadType}`)).size).toBe(12);
	});

	for (const pair of PAIRS) {
		const name = `${pair.measure}/${pair.loadType}`;
		const ex = exercise('Test lift', pair.measure, pair.loadType);
		/** What a complete set of it records: its amount, and its load field when it has one. */
		const valid = set({
			[pair.amount]: FILLED[pair.amount],
			...(pair.load === null ? {} : { [pair.load === 'assistance' ? 'assistance' : 'weight']: 20 })
		});

		it(`${name}: asks for ${pair.load ?? 'no load'} and ${pair.amount}`, () => {
			expect(setFields(pair.measure, pair.loadType)).toEqual({
				load: pair.load,
				amount: pair.amount,
				labels: pair.labels
			});
		});

		it(`${name}: accepts a complete set, and an optional load left blank`, () => {
			expect(checkSet(valid, ex)).toEqual({});
			if (!pair.needs.includes('weight'))
				expect(checkSet({ ...valid, weight: null, assistance: null }, ex)).toEqual({});
		});

		for (const field of pair.needs) {
			it(`${name}: refuses a set with no ${field}`, () => {
				expect(Object.keys(checkSet({ ...valid, [field]: null }, ex))).toEqual([
					`payload.${field}`
				]);
			});
		}

		for (const field of pair.refuses) {
			it(`${name}: refuses a set with ${field}`, () => {
				expect(Object.keys(checkSet({ ...valid, [field]: FILLED[field] }, ex))).toEqual([
					`payload.${field}`
				]);
			});
		}
	}

	it('names the exercise and what it takes', () => {
		expect(checkSet(set({ reps: 5 }), BACK_SQUAT)).toEqual({
			'payload.weight': 'Back squat needs a weight'
		});
		expect(checkSet(set({ reps: 5, weight: 100, assistance: 20 }), BACK_SQUAT)).toEqual({
			'payload.assistance': 'Only assisted exercises take assistance'
		});
		expect(checkSet(set({ reps: 6, weight: 20 }), ASSISTED_PULL_UP)).toEqual({
			'payload.weight': 'Assisted pull-up takes assistance, not a weight'
		});
		expect(checkSet(set({ reps: 12, weight: 10 }), BANDED_WALK)).toEqual({
			'payload.weight': 'Banded lateral walk takes no weight'
		});
		expect(checkSet(set({ reps: 45 }), PLANK)).toEqual({
			'payload.seconds': 'Plank needs a time',
			'payload.reps': 'Plank records a time, not reps'
		});
		expect(checkSet(set({ metres: 30, missedReps: 1, weight: 60 }), SLED_PUSH)).toEqual({
			'payload.missedReps': 'Sled push records a distance, not reps'
		});
		expect(checkSet(set({ weight: 100 }), BACK_SQUAT)).toEqual({
			'payload.reps': 'Back squat needs reps'
		});
	});
});

describe('what a set counts toward', () => {
	it('assisted pull-up, 6 reps with 20 kg assistance: no e1RM, no volume load, reps total 6', () => {
		const assisted = set({ reps: 6, assistance: 20, rpe: 8 });
		expect(checkSet(assisted, ASSISTED_PULL_UP)).toEqual({});
		expect(e1rmOf(assisted, ASSISTED_PULL_UP)).toBeNull();
		expect(e1rmApplies(assisted, ASSISTED_PULL_UP)).toBe(false);
		expect(volumeOf(assisted, ASSISTED_PULL_UP)).toBeNull();
		expect(totals([assisted], ASSISTED_PULL_UP)).toEqual({ reps: 6, seconds: 0, metres: 0 });
		expect(prKinds(ASSISTED_PULL_UP)).toEqual([]);
		expect(prCandidates(assisted, ASSISTED_PULL_UP)).toEqual([]);
	});

	it('pull-up with 10 kg added × 8: volume 80 kg, no e1RM, no PR', () => {
		const weighted = set({ reps: 8, weight: 10, rpe: 8 });
		// M3's setE1rm alone would estimate one from the added weight; the load type rules it out.
		expect(setE1rm(weighted)).not.toBeNull();
		expect(e1rmOf(weighted, PULL_UP)).toBeNull();
		expect(e1rmApplies(weighted, PULL_UP)).toBe(false);
		expect(volumeOf(weighted, PULL_UP)).toBe(80);
		expect(prCandidates(weighted, PULL_UP)).toEqual([]);
	});

	it("pull-up with nothing added: volume 0, and a 'most reps' PR candidate", () => {
		const unweighted = set({ reps: 8, rpe: 9 });
		expect(volumeOf(unweighted, PULL_UP)).toBe(0);
		expect(e1rmApplies(unweighted, PULL_UP)).toBe(false);
		expect(prKinds(PULL_UP)).toEqual(['most_reps']);
		expect(prCandidates(unweighted, PULL_UP)).toEqual(['most_reps']);
		expect(totals([unweighted], PULL_UP)).toEqual({ reps: 8, seconds: 0, metres: 0 });
	});

	it("back squat 100 kg × 5 @ RPE 8: M3's setE1rm, and volume 500 kg", () => {
		const top = set({ reps: 5, weight: 100, rpe: 8 });
		const estimate = e1rmOf(top, BACK_SQUAT);
		expect(estimate).not.toBeNull();
		expect(estimate).toEqual(setE1rm(top));
		expect(e1rmApplies(top, BACK_SQUAT)).toBe(true);
		expect(volumeOf(top, BACK_SQUAT)).toBe(500);
		expect(volumeOf(top, BACK_SQUAT)).toBe(volumeLoad([{ weight: 100, reps: 5 }]));
		expect(prKinds(BACK_SQUAT)).toEqual(['e1rm', 'rep_max']);
		expect(prCandidates(top, BACK_SQUAT)).toEqual(['e1rm', 'rep_max']);
	});

	it('back squat in lb: volume load in kg, through M1’s conversion', () => {
		const top = set({ reps: 5, weight: 225, unit: 'lb', rpe: 8 });
		expect(volumeOf(top, BACK_SQUAT)).toBe(convertWeight(225, 'lb', 'kg') * 5);
	});

	it("back squat sets outside M3's rules: RPE under 6 has no e1RM, 12 reps no rep max", () => {
		const easy = set({ reps: 5, weight: 100, rpe: 5 });
		expect(e1rmApplies(easy, BACK_SQUAT)).toBe(false);
		expect(volumeOf(easy, BACK_SQUAT)).toBe(500);
		expect(prCandidates(easy, BACK_SQUAT)).toEqual(['rep_max']);

		const long = set({ reps: 12, weight: 60, rpe: 8 });
		expect(personalRecords([{ ...long, performedAt: new Date() }])).toEqual([]);
		expect(prCandidates(long, BACK_SQUAT)).toEqual(['e1rm']);
	});

	it('plank 45 s: seconds total 45, no volume load', () => {
		const hold = set({ seconds: 45 });
		expect(checkSet(hold, PLANK)).toEqual({});
		expect(volumeOf(hold, PLANK)).toBeNull();
		expect(e1rmApplies(hold, PLANK)).toBe(false);
		expect(totals([hold], PLANK)).toEqual({ reps: 0, seconds: 45, metres: 0 });
		expect(prKinds(PLANK)).toEqual([]);
		expect(prCandidates(hold, PLANK)).toEqual([]);
	});

	it('sled push 30 m with 60 kg: metres 30, no volume load', () => {
		const push = set({ metres: 30, weight: 60 });
		expect(checkSet(push, SLED_PUSH)).toEqual({});
		expect(checkSet({ ...push, weight: null }, SLED_PUSH)).toEqual({
			'payload.weight': 'Sled push needs a weight'
		});
		expect(volumeOf(push, SLED_PUSH)).toBeNull();
		expect(e1rmApplies(push, SLED_PUSH)).toBe(false);
		expect(totals([push], SLED_PUSH)).toEqual({ reps: 0, seconds: 0, metres: 30 });
		expect(prKinds(SLED_PUSH)).toEqual([]);
		expect(prCandidates(push, SLED_PUSH)).toEqual([]);
	});

	it('unloaded reps sets report reps only', () => {
		const walk = set({ reps: 12 });
		expect(volumeOf(walk, BANDED_WALK)).toBeNull();
		expect(prKinds(BANDED_WALK)).toEqual([]);
		expect(totals([walk, walk], BANDED_WALK)).toEqual({ reps: 24, seconds: 0, metres: 0 });
	});

	describe('warm-up and skipped sets count toward nothing', () => {
		const cases = [
			[BACK_SQUAT, set({ reps: 5, weight: 100, rpe: 8 })],
			[PULL_UP, set({ reps: 8, rpe: 8 })],
			[PULL_UP, set({ reps: 8, weight: 10, rpe: 8 })],
			[PLANK, set({ seconds: 45 })],
			[SLED_PUSH, set({ metres: 30, weight: 60 })]
		] as const;

		for (const [ex, working] of cases) {
			for (const [kind, notWorking] of [
				['warm-up', { ...working, isWarmup: true }],
				['skipped', { ...working, isSkipped: true }]
			] as const) {
				it(`${ex.name}, a ${kind} set`, () => {
					expect(e1rmOf(notWorking, ex)).toBeNull();
					expect(volumeOf(notWorking, ex)).toBeNull();
					expect(prCandidates(notWorking, ex)).toEqual([]);
					expect(totals([notWorking], ex)).toEqual({ reps: 0, seconds: 0, metres: 0 });
				});
			}
		}

		it('totals add the working sets only', () => {
			const sets = [
				set({ reps: 5, isWarmup: true }),
				set({ reps: 8 }),
				set({ reps: 6, weight: 10 }),
				set({ reps: 8, isSkipped: true })
			];
			expect(totals(sets, PULL_UP)).toEqual({ reps: 14, seconds: 0, metres: 0 });
		});
	});

	it("totals read only the amount the exercise's measure records", () => {
		const holds = [set({ seconds: 45 }), set({ seconds: 30, reps: 3, metres: 10 })];
		expect(totals(holds, PLANK)).toEqual({ reps: 0, seconds: 75, metres: 0 });
		expect(totals([], PLANK)).toEqual({ reps: 0, seconds: 0, metres: 0 });
	});
});

describe('LOAD_RULES', () => {
	it('gives an e1RM PR only where an e1RM is estimated', () => {
		for (const rule of Object.values(LOAD_RULES)) expect(rule.prs.includes('e1rm')).toBe(rule.e1rm);
	});
});
