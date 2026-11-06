/**
 * loads.ts and the loads stage: the M3 brief's week-1 baseline rules. A blank 1RM works up to a
 * set of 5 @ RPE 7 with the recording instruction and back-offs from the estimate it gives; a
 * measured 1RM is loaded under M1's table; an estimated one is never treated as measured; nothing
 * else changes; and every main lift's load_basis decision cites its 1RM.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { percentOfOneRepMax } from '../rpe';
import { BASELINE_INSTRUCTION, describePrescription } from '../training/describe';
import type { PlannedExercisePlan, ProgramPlan, StrengthSessionPlan } from '../training/types';
import { roundToIncrement } from '../units';
import { DecisionLog } from './decisions';
import { generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import type { ProgrammingInput } from './input';
import { baselineShare, ESTIMATE_INSTRUCTION } from './loads';
import { LOAD_RULES } from './rules/loads';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { ScenarioKey } from './scenarios';
import type { Draft } from './stage';
import { loads } from './stages/loads';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile) => generateProgram(inputOf(profile), OPTIONS);

const strengthIn = (sessions: readonly { kind: string }[]) =>
	sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength');
const weekOne = (plan: ProgramPlan) =>
	strengthIn(plan.blocks[0]!.weeks[0]!.sessions).flatMap((s) => s.exercises);
const keyOf = (e: PlannedExercisePlan) => ('key' in e.exercise ? e.exercise.key : '');
/** Main lifts: a top set and a baseline lift. */
const mains = (exercises: readonly PlannedExercisePlan[]) =>
	exercises.filter((e) => e.baselineLift !== null && e.sets.some((l) => l.role === 'top'));
const line = (e: PlannedExercisePlan, role: string) => e.sets.find((l) => l.role === role)!;
const KG = { unit: 'kg' as const };

/** The draft as the stage before loads leaves it, and the context to run loads on it. */
function beforeLoads(input: ProgrammingInput) {
	const context = { input, options: OPTIONS, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES.slice(
		0,
		STAGES.findIndex((s) => s.name === 'loads')
	)) {
		draft = stage.run(draft, context);
	}
	return { draft, context };
}

describe('baselineShare', () => {
	it('loads a measured set of 5 at 72.5 %, under M1’s 78.6 % for 5 @ RPE 7', () => {
		expect(percentOfOneRepMax(5, 7)).toBe(0.786);
		expect(baselineShare(5, 7, 'measured')).toBe(0.725);
		expect(baselineShare(5, 7, 'estimated')).toBe(0.7);
	});

	it('keeps an estimate a step under a measured 1RM, and both under M1’s table, for every set it can load', () => {
		for (let reps = 1; reps <= 12; reps++) {
			for (const rpe of [6, 6.5, 7, 7.5, 8, 8.5]) {
				const measured = baselineShare(reps, rpe, 'measured')!;
				const estimated = baselineShare(reps, rpe, 'estimated')!;
				expect(measured).toBeLessThan(percentOfOneRepMax(reps, rpe)!);
				expect(cleanStep(measured - estimated)).toBeGreaterThanOrEqual(LOAD_RULES.estimateDiscount);
				expect(roundToIncrement(measured, LOAD_RULES.loadRounding)).toBe(measured);
			}
		}
	});

	it('gives nothing off M1’s table, so such a lift stays RPE-based', () => {
		expect(baselineShare(15, 7, 'measured')).toBeNull();
		expect(baselineShare(5, 5.5, 'measured')).toBeNull();
	});
});

/** A difference of shares without float noise. */
const cleanStep = (n: number) => Math.round(n * 1e6) / 1e6;

describe('week 1 with blank 1RMs', () => {
	it('works every main lift up to a set of 5 @ RPE 7 by feel, with the instruction and no load', () => {
		const lifts = mains(weekOne(generate(SCENARIOS.beginner())));
		expect(lifts.map(keyOf).sort()).toEqual([
			'back_squat',
			'back_squat',
			'bench_press',
			'deadlift',
			'overhead_press'
		]);
		for (const e of lifts) {
			const top = line(e, 'top');
			expect(top).toMatchObject({
				sets: 1,
				repsMin: 5,
				repsMax: 5,
				targetRpe: 7,
				loadKind: 'rpe_based',
				loadValue: null,
				loadBasis: null,
				reference1rm: null
			});
			expect(e.instructions).toBe(BASELINE_INSTRUCTION);
			const words = describePrescription(top, KG);
			expect(words).toMatchObject({
				headline: 'Work up to a set of 5 @ RPE 7',
				load: null,
				instruction: BASELINE_INSTRUCTION
			});
		}
	});

	it('loads its 2–3 back-offs from the estimate the top set gives, at 90 % of that set', () => {
		const plans = [generate(SCENARIOS.beginner()), generate(SCENARIOS.journey())];
		for (const e of plans.flatMap((plan) => mains(weekOne(plan)))) {
			const backOff = line(e, 'back_off');
			const share = roundToIncrement(0.9 * percentOfOneRepMax(5, 7)!, 0.025, 'down');
			expect(share).toBe(0.7);
			expect(backOff).toMatchObject({ loadKind: 'from_e1rm', loadValue: share, targetRpe: 6 });
			expect(backOff.sets).toBeGreaterThanOrEqual(2);
			expect(backOff.sets).toBeLessThanOrEqual(3);
			// No number until the top set is logged; then 90 % of it, on the owner's plates.
			expect(describePrescription(backOff, KG)).toMatchObject({
				load: null,
				basis: '70 % of your week-1 estimate'
			});
			const topSet = 100;
			const e1rm = topSet / percentOfOneRepMax(5, 7)!;
			expect(describePrescription(backOff, { ...KG, oneRepMaxKg: e1rm }).load).toBe('90 kg');
		}
	});
});

describe('week 1 with known 1RMs', () => {
	it('loads a measured 180 kg squat at 72.5 % × 5 at most, basis measured, from a snapshot', () => {
		const squat = mains(weekOne(generate(SCENARIOS.powerlifter()))).find(
			(e) => keyOf(e) === 'back_squat'
		)!;
		const top = line(squat, 'top');
		expect(top).toMatchObject({
			repsMax: 5,
			targetRpe: 7,
			loadKind: 'percent_1rm',
			loadBasis: 'measured',
			reference1rm: 180,
			reference1rmUnit: 'kg'
		});
		expect(top.loadValue).toBeLessThanOrEqual(0.725);
		expect(top.loadValue).toBeLessThan(percentOfOneRepMax(5, 7)!);
		expect(line(squat, 'back_off')).toMatchObject({
			loadKind: 'percent_1rm',
			loadValue: 0.65,
			loadBasis: 'measured',
			reference1rm: 180
		});
		expect(squat.instructions).toBeNull();
		expect(describePrescription(top, KG)).toMatchObject({
			headline: '1 × 5 @ RPE 7',
			load: '130 kg',
			basis: '72.5 % of your measured 1RM',
			instruction: null
		});
	});

	it('loads an estimated 120 kg bench below the measured equivalent, basis estimated, held to its RPE', () => {
		const benchOf = (plan: ProgramPlan) =>
			mains(weekOne(plan)).find((e) => keyOf(e) === 'bench_press')!;
		const measured = line(benchOf(generate(SCENARIOS.powerlifter())), 'top');
		const p = SCENARIOS.powerlifter();
		const bench = p.baselines.find((b) => b.lift === 'bench_press')!;
		Object.assign(bench, { kind: 'estimated', source: 'estimate' });
		const estimatedBench = benchOf(generate(p));
		const estimated = line(estimatedBench, 'top');
		expect(measured).toMatchObject({ loadBasis: 'measured', reference1rm: 120 });
		expect(estimated).toMatchObject({
			loadKind: 'percent_1rm',
			loadBasis: 'estimated',
			reference1rm: 120,
			targetRpe: 7
		});
		expect(estimated.loadValue).toBeLessThan(measured.loadValue!);
		expect(estimatedBench.instructions).toBe(ESTIMATE_INSTRUCTION);
		expect(describePrescription(estimated, KG).basis).toBe('70 % of your estimated 1RM');
	});
});

describe('the loads stage', () => {
	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s: nothing in week 1 above RPE 7.5, and no load above what RPE 7 allows',
		(key) => {
			const exercises = weekOne(generate(SCENARIOS[key]()));
			for (const l of exercises.flatMap((e) => e.sets)) {
				expect(l.targetRpe ?? 0).toBeLessThanOrEqual(7.5);
				if (l.loadKind === 'percent_1rm') {
					expect(l.loadValue!).toBeLessThan(percentOfOneRepMax(l.repsMax!, 7)!);
				}
			}
		}
	);

	it('changes only the loads of week 1’s main lifts: other work keeps its RPE, rest and measure', () => {
		const p = SCENARIOS.minimal();
		p.goals[0]!.disciplines = ['athletic'];
		p.schedule.daysPerWeek = 2;
		const input = inputOf(p);
		const { draft, context } = beforeLoads(input);
		const after = loads(draft, context);
		const LOAD = ['loadKind', 'loadValue', 'loadBasis', 'reference1rm', 'reference1rmUnit'];
		const withoutLoads = (blocks: Draft['blocks']) =>
			blocks.map((b) => ({
				...b,
				weeks: b.weeks.map((w) => ({
					...w,
					sessions: strengthIn(w.sessions).map((s) => ({
						...s,
						exercises: s.exercises.map((e) => ({
							...e,
							instructions: null,
							sets: e.sets.map((l) =>
								Object.fromEntries(Object.entries(l).filter(([k]) => !LOAD.includes(k)))
							)
						}))
					}))
				}))
			}));
		expect(withoutLoads(after.blocks)).toEqual(withoutLoads(draft.blocks));
		expect(after.blocks.map((b) => b.weeks.slice(1))).toEqual(
			draft.blocks.map((b) => b.weeks.slice(1))
		);
		const week1 = strengthIn(after.blocks[0]!.weeks[0]!.sessions).flatMap((s) => s.exercises);
		const carry = week1.find((e) => keyOf(e) === 'kettlebell_rack_carry')!;
		expect(carry.sets).toEqual([
			expect.objectContaining({
				role: 'working',
				metres: 40,
				repsMin: null,
				targetRpe: 7,
				loadKind: 'rpe_based',
				restSeconds: 60
			})
		]);
		for (const e of week1.filter((e) => !mains([e]).length)) {
			expect(e.sets.every((l) => l.loadKind === 'rpe_based' && l.targetRpe === 7)).toBe(true);
		}
		expect(mains(week1).map(keyOf)).toEqual(['back_squat', 'deadlift']);
		for (const e of mains(week1)) expect(line(e, 'back_off').loadKind).toBe('from_e1rm');
	});

	it('cites each main lift’s 1RM in one load_basis decision', () => {
		const plan = generate(SCENARIOS.powerlifter());
		const basis = plan.decisions.filter((d) => d.kind === 'load_basis');
		expect(basis.map((d) => [d.ruleKey, d.evidence.lift, d.evidence.oneRepMaxKg])).toEqual([
			['loads.measured', 'back_squat', 180],
			['loads.measured', 'bench_press', 120],
			['loads.measured', 'deadlift', 220]
		]);
		expect(basis[0]).toMatchObject({
			summary: 'Back squat: your measured 1RM of 180 kg',
			refs: ['blocks.0'],
			evidence: { share: 0.725, reps: 5, rpe: 7 }
		});
		expect(basis[0]!.why).toBe(
			'Back squat is loaded from your measured 1RM of 180 kg. It starts at 72.5 % for sets of 5, under the 78.6 % that RPE 7 allows, so it begins comfortably even if your max has moved since you tested it.'
		);
	});

	it('says how a blank 1RM is found, and never calls an estimate measured', () => {
		const blank = generate(SCENARIOS.beginner()).decisions.filter((d) => d.kind === 'load_basis');
		expect(blank.map((d) => d.summary)).toEqual([
			'Back squat: a baseline set by RPE',
			'Bench press: a baseline set by RPE',
			'Deadlift: a baseline set by RPE',
			'Overhead press: a baseline set by RPE'
		]);
		expect(blank.every((d) => d.ruleKey === 'loads.baseline_set')).toBe(true);
		expect(blank[0]!.why).toContain('works up to a set of 5 at RPE 7 and records it');
		expect(blank.some((d) => 'oneRepMaxKg' in d.evidence)).toBe(false);

		const p = SCENARIOS.powerlifter();
		Object.assign(p.baselines[0]!, { kind: 'estimated', source: 'estimate' });
		const [squat] = generate(p).decisions.filter((d) => d.kind === 'load_basis');
		expect(squat).toMatchObject({
			ruleKey: 'loads.estimated',
			summary: 'Back squat: your estimated 1RM of 180 kg',
			evidence: { share: 0.7, oneRepMaxKg: 180 }
		});
		expect(squat!.why).not.toContain('measured 1RM');
	});

	it('describes each lift as its first session loads it, even when week 1 begins mid-week', () => {
		for (const day of [0, 3, 5]) {
			const firstPlannedDay = scenarioDay(1, day);
			const plan = generateProgram(inputOf(SCENARIOS.powerlifter()), {
				...OPTIONS,
				firstPlannedDay
			});
			const weeks = plan.blocks[0]!.weeks.map((w) =>
				mains(strengthIn(w.sessions).flatMap((s) => s.exercises))
			);
			const basis = plan.decisions.filter((d) => d.kind === 'load_basis');
			expect(basis).toHaveLength(3);
			for (const d of basis) {
				const top = line(
					weeks.flat().find((e) => e.baselineLift === d.evidence.lift)!,
					'top'
				);
				expect(d.evidence).toMatchObject({
					share: top.loadValue,
					rpe: top.targetRpe,
					reps: top.repsMax
				});
				expect(d.why).toContain(`It starts at ${top.loadValue! * 100} % for sets of 5`);
			}
			if (day === 5) expect(basis.some((d) => d.evidence.rpe === 7.5)).toBe(true);
		}
	});

	it('writes no load decision when no strength is planned', () => {
		const p = SCENARIOS.minimal();
		p.goals[0]!.disciplines = ['running'];
		const kinds = generate(p).decisions.map((d) => d.kind);
		expect(kinds).not.toContain('load_basis');
		expect(kinds).not.toContain('progression');
	});
});
