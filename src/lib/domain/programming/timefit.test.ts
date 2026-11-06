/** timefit.ts: a session's minutes are its warm-up plus each set's work and rest. */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { PlannedExercisePlan, SetPrescription, StrengthSessionPlan } from '../training/types';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import { estimateMinutes } from './timefit';

const input = buildProgrammingInput(SCENARIOS.minimal(), { catalogue: CATALOGUE });

function set(over: Partial<SetPrescription>): SetPrescription {
	return {
		role: 'working',
		sets: 3,
		repsMin: null,
		repsMax: null,
		seconds: null,
		metres: null,
		targetRpe: 7,
		loadKind: 'rpe_based',
		loadValue: null,
		loadUnit: null,
		loadBasis: null,
		reference1rm: null,
		reference1rmUnit: null,
		restSeconds: 60,
		tempo: null,
		notes: null,
		...over
	};
}

const exercise = (key: string, sets: SetPrescription[]): PlannedExercisePlan => ({
	exercise: { key },
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets
});

const base = {
	date: SCENARIO_START,
	timeOfDay: null,
	orderInDay: 1,
	discipline: 'strength',
	customDiscipline: null,
	intensity: 'moderate',
	estLoad: 0,
	targetRpe: 7,
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

const strength = (exercises: PlannedExercisePlan[]): StrengthSessionPlan => ({
	...base,
	kind: 'strength',
	type: 'strength',
	title: 'Full body A',
	estMinutes: 0,
	exercises
});

/** A main lift: a top set of 5 and three back-offs, each with 150 s rest (170 s a set). */
const main = (key: string) =>
	exercise(key, [
		set({ role: 'top', sets: 1, repsMin: 5, repsMax: 5, restSeconds: 150 }),
		set({ role: 'back_off', sets: 3, repsMin: 5, repsMax: 5, restSeconds: 150 })
	]);

/** 59 minutes: two main lifts, two secondaries, then two accessories. */
const LONG = strength([
	main('back_squat'),
	main('bench_press'),
	exercise('seated_cable_row', [set({ repsMin: 8, repsMax: 8, restSeconds: 90 })]),
	exercise('split_squat', [set({ repsMin: 8, repsMax: 8, restSeconds: 90 })]),
	exercise('plank', [set({ seconds: 45 })]),
	exercise('face_pull', [set({ repsMin: 12, repsMax: 20 })])
]);

describe('estimateMinutes', () => {
	it('adds the warm-up and each set’s work and rest, a unilateral set done per side', () => {
		const session = strength([
			// (5 × 4 s + 180) + 2 × (5 × 4 s + 120) = 480 s
			exercise('back_squat', [
				set({ role: 'top', sets: 1, repsMin: 5, repsMax: 5, restSeconds: 180 }),
				set({ role: 'back_off', sets: 2, repsMin: 5, repsMax: 5, restSeconds: 120 })
			]),
			// 2 × (10 reps × 4 s × 2 sides + 60) = 280 s; the range's top end counts
			exercise('split_squat', [set({ sets: 2, repsMin: 6, repsMax: 10, restSeconds: 60 })]),
			// 2 × (30 + 30) = 120 s
			exercise('plank', [set({ sets: 2, seconds: 30, restSeconds: 30 })]),
			// 40 m at 1 s a metre, no rest
			exercise('farmers_carry', [set({ sets: 1, metres: 40, restSeconds: null })])
		]);
		// 600 s of warm-up + 920 s = 1520 s, rounded up to 26 min
		expect(estimateMinutes(session, input)).toBe(26);
		expect(estimateMinutes(strength([]), input)).toBe(10);
		expect(estimateMinutes(LONG, input)).toBe(59);
	});
});
