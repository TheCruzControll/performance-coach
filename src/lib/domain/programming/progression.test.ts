/**
 * progression.ts and the progression stage: weeks 2 to the deload by the block's rules, stored as
 * data. Known 1RMs step +2.5 % a week under M1's table, blank ones load from the latest estimate
 * through loadForTarget, the third accumulation week adds a back-off set that still fits the
 * session after timefit, the deload keeps 60 % of the sets at RPE 6 or under, and the stored
 * rules round-trip as JSON and drive the same weeks. Also the brief's beginner and powerlifter
 * scenarios.
 */
import { describe, expect, it } from 'vitest';
import { loadForTarget } from '../e1rm';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { percentOfOneRepMax } from '../rpe';
import { BASELINE_INSTRUCTION, prescribedLoad } from '../training/describe';
import type {
	PlannedExercisePlan,
	ProgramPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { DEFAULT_LOAD_INCREMENT, roundToIncrement } from '../units';
import { DecisionLog } from './decisions';
import { generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import type { ProgrammingInput } from './input';
import { keepShare, knownShare, progressWeeks } from './progression';
import { FIRST_BLOCK, weekTargets } from './rules/blocks';
import { LOAD_RULES } from './rules/loads';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { Draft } from './stage';
import { estimateMinutes } from './timefit';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile, options = OPTIONS) =>
	generateProgram(inputOf(profile), options);

const strengthIn = (week: WeekPlan) =>
	week.sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength');
const keyOf = (e: PlannedExercisePlan) => ('key' in e.exercise ? e.exercise.key : '');
const line = (e: PlannedExercisePlan, role: string) => e.sets.find((l) => l.role === role)!;
const isMain = (e: PlannedExercisePlan) =>
	e.baselineLift !== null && e.sets.some((l) => l.role === 'top');
/** The first main lift `key` in each week of the first block. */
const liftByWeek = (plan: ProgramPlan, key: string) =>
	plan.blocks[0]!.weeks.map((w) =>
		strengthIn(w)
			.flatMap((s) => s.exercises)
			.find((e) => keyOf(e) === key && isMain(e))
	);
const setCount = (s: StrengthSessionPlan) =>
	s.exercises.flatMap((e) => e.sets).reduce((n, l) => n + l.sets, 0);

/** The draft just before `stage` runs, and the context to run it on. */
function draftBefore(stage: string, input: ProgrammingInput) {
	const context = { input, options: OPTIONS, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const s of STAGES.slice(
		0,
		STAGES.findIndex((x) => x.name === stage)
	)) {
		draft = s.run(draft, context);
	}
	return { draft, context };
}

/** The default first block's targets, the baseline week first. */
const BLOCK = (() => {
	let step = 0;
	return FIRST_BLOCK.map((kind) => {
		const targets = weekTargets(kind, step);
		if (kind === 'accumulation') step += 1;
		return targets;
	});
})();

describe('knownShare', () => {
	it('steps a known 1RM +2.5 % a building week and −10 % into the deload, an estimate a step under', () => {
		const shares = (basis: 'measured' | 'estimated') =>
			BLOCK.map((_, w) => knownShare(5, basis, BLOCK.slice(0, w + 1)));
		expect(shares('measured')).toEqual([0.725, 0.75, 0.775, 0.8, 0.7]);
		expect(shares('estimated')).toEqual([0.7, 0.725, 0.75, 0.775, 0.675]);
	});

	it('never goes above M1’s table for the reps at the week’s RPE cap, however long the build', () => {
		const build = [
			weekTargets('baseline', 0),
			...Array.from({ length: 8 }, (_, i) => weekTargets('build', i))
		];
		for (let reps = 1; reps <= 12; reps++) {
			for (let w = 1; w < build.length; w++) {
				const table = percentOfOneRepMax(reps, build[w]!.rpeCap)!;
				expect(knownShare(reps, 'measured', build.slice(0, w + 1))).toBeLessThanOrEqual(table);
				expect(knownShare(reps, 'estimated', build.slice(0, w + 1))).toBeLessThanOrEqual(
					table - LOAD_RULES.estimateDiscount
				);
			}
		}
		// Sets of 8: +2.5 % would pass RPE 7.5's 69.4 % in week 2, so the table holds it there.
		expect(knownShare(8, 'measured', BLOCK.slice(0, 2))).toBe(0.675);
		expect(knownShare(15, 'measured', BLOCK.slice(0, 2))).toBeNull();
	});
});

describe('keepShare', () => {
	const set = (role: SetPrescription['role'], sets: number) => ({ role, sets }) as SetPrescription;
	const exercise = (...sets: SetPrescription[]) => ({ sets }) as PlannedExercisePlan;
	const counts = (es: PlannedExercisePlan[]) => es.map((e) => e.sets.map((l) => l.sets));

	it('keeps 60 % of the sets, cutting the line with the most, the last of equals, never a top set', () => {
		const before = [
			exercise(set('top', 1), set('back_off', 3)),
			exercise(set('working', 3)),
			exercise(set('working', 3))
		];
		expect(counts(keepShare(before, 0.6))).toEqual([[1, 2], [2], [1]]);
		expect(counts(before)).toEqual([[1, 3], [3], [3]]);
	});

	it('leaves every line at least one set', () => {
		const before = [exercise(set('top', 1), set('back_off', 2)), exercise(set('working', 1))];
		expect(counts(keepShare(before, 0.1))).toEqual([[1, 1], [1]]);
	});
});

describe('the weeks after the baseline', () => {
	it('loads a blank 1RM from the latest estimate through loadForTarget, rising with the RPE', () => {
		const squat = liftByWeek(generate(SCENARIOS.beginner()), 'back_squat');
		const e1rm = 127.3;
		squat.slice(1).forEach((e, i) => {
			const week = i + 2;
			const top = line(e!, 'top');
			const rpe = BLOCK[week - 1]!.rpeCap;
			expect(top).toMatchObject({ loadKind: 'from_e1rm', targetRpe: rpe, repsMax: 5 });
			expect(top.loadValue).toBe(percentOfOneRepMax(5, rpe));
			const resolved = roundToIncrement(loadForTarget(e1rm, 5, rpe)!, DEFAULT_LOAD_INCREMENT.kg);
			expect(prescribedLoad(top, { unit: 'kg', oneRepMaxKg: e1rm })).toBe(resolved);
			expect(line(e!, 'back_off')).toMatchObject({
				loadKind: 'from_e1rm',
				loadValue: roundToIncrement(top.loadValue! * 0.9, 0.025, 'down')
			});
			expect(e!.instructions).toBeNull();
		});
		const tops = squat.slice(1, 4).map((e) => line(e!, 'top').loadValue!);
		expect(tops).toEqual([...tops].sort((a, b) => a - b));
		expect(new Set(tops).size).toBe(3);
		expect(line(squat[4]!, 'top').loadValue!).toBeLessThan(tops[2]!);
	});

	it('steps a known 1RM from the same snapshot, a building week at a time, and drops it in the deload', () => {
		const squat = liftByWeek(generate(SCENARIOS.powerlifter()), 'back_squat');
		expect(squat.map((e) => line(e!, 'top').loadValue)).toEqual([0.725, 0.75, 0.775, 0.8, 0.7]);
		expect(squat.map((e) => line(e!, 'back_off').loadValue)).toEqual([
			0.65, 0.675, 0.675, 0.7, 0.625
		]);
		for (const e of squat) {
			expect(line(e!, 'top')).toMatchObject({
				loadKind: 'percent_1rm',
				loadBasis: 'measured',
				reference1rm: 180
			});
		}
	});

	it.each(['beginner', 'powerlifter', 'hybrid', 'journey'] as const)(
		'%s: nothing in week 1 above RPE 7.5, the top sets rise through the build, and the last week is lower',
		(key) => {
			const weeks = generate(SCENARIOS[key]()).blocks[0]!.weeks;
			const sets = (w: WeekPlan) =>
				strengthIn(w).flatMap((s) => s.exercises.flatMap((e) => e.sets));
			expect(Math.max(...sets(weeks[0]!).map((l) => l.targetRpe ?? 0))).toBeLessThanOrEqual(7.5);
			const topRpe = weeks.map((w) =>
				Math.max(
					...sets(w)
						.filter((l) => l.role === 'top')
						.map((l) => l.targetRpe!)
				)
			);
			const building = weeks.flatMap((w, i) =>
				w.kind === 'accumulation' || w.kind === 'build' ? [topRpe[i]!] : []
			);
			expect(building.length).toBeGreaterThan(0);
			for (let i = 1; i < building.length; i++)
				expect(building[i]).toBeGreaterThanOrEqual(building[i - 1]!);
			const last = weeks.at(-1)!;
			expect(['deload', 'taper', 'event']).toContain(last.kind);
			expect(Math.max(...sets(last).map((l) => l.targetRpe ?? 0))).toBeLessThanOrEqual(
				last.targets.rpeCap
			);
			expect(topRpe.at(-1)!).toBeLessThan(Math.max(...building));
		}
	);

	it('gives each main lift a back-off set more in the third accumulation week, which still fits 60 minutes after timefit', () => {
		const input = inputOf(SCENARIOS.beginner());
		expect(input.sessionMinutes).toBe(60);
		const plan = generateProgram(input, OPTIONS);
		const weeks = plan.blocks[0]!.weeks;
		expect(weeks.map((w) => w.targets.volumeFactor)).toEqual([1, 1, 1, 1.1, 0.6]);
		const [, , third, fourth] = weeks.map(strengthIn);
		fourth!.forEach((s, i) => {
			expect(s.estMinutes).toBe(estimateMinutes(s, input));
			expect(s.estMinutes).toBeLessThanOrEqual(60);
			s.exercises.forEach((e, j) => {
				const before = third![i]!.exercises[j]!;
				expect(keyOf(e)).toBe(keyOf(before));
				const extra = e.sets.some((l) => l.role === 'top') ? LOAD_RULES.extraMainSets : 0;
				expect(e.sets.map((l) => l.sets)).toEqual(
					before.sets.map((l) => l.sets + (l.role === 'back_off' ? extra : 0))
				);
			});
		});
		expect(plan.decisions.filter((d) => d.kind === 'time_trimmed')).toEqual([]);
	});

	it('still fits a 45-minute session after timefit, trimming with a decision rather than a top set', () => {
		const input = inputOf(SCENARIOS.dumbbellsOnly());
		const plan = generateProgram(input, OPTIONS);
		for (const s of plan.blocks[0]!.weeks.flatMap(strengthIn)) {
			expect(s.estMinutes).toBeLessThanOrEqual(45);
			for (const e of s.exercises.filter((x) => x.sets.some((l) => l.role === 'top'))) {
				expect(line(e, 'top').sets).toBe(1);
			}
		}
	});

	it('keeps 60 % of each session’s sets in the deload, at RPE 6 or under, never cutting a top set', () => {
		const weeks = generate(SCENARIOS.powerlifter()).blocks[0]!.weeks;
		const [base, deload] = [strengthIn(weeks[2]!), strengthIn(weeks[4]!)];
		deload.forEach((s, i) => {
			const lines = s.exercises.flatMap((e) => e.sets);
			expect(setCount(s)).toBe(Math.max(lines.length, Math.round(setCount(base[i]!) * 0.6)));
			expect(lines.every((l) => l.sets >= 1 && (l.targetRpe ?? 0) <= 6)).toBe(true);
			expect(lines.filter((l) => l.role === 'top').every((l) => l.sets === 1)).toBe(true);
			expect(s.exercises.map(keyOf)).toEqual(base[i]!.exercises.map(keyOf));
		});
	});

	it('gives a blank lift first planned after week 1 its baseline set in its first week', () => {
		const friday = scenarioDay(1, 4);
		const plan = generate(SCENARIOS.beginner(), { ...OPTIONS, firstPlannedDay: friday });
		const firstLoaded = (key: string) =>
			liftByWeek(plan, key).map((e) =>
				e ? (e.instructions === BASELINE_INSTRUCTION ? 'baseline' : line(e, 'top').loadKind) : null
			);
		expect(firstLoaded('back_squat')).toEqual([
			'baseline',
			'from_e1rm',
			'from_e1rm',
			'from_e1rm',
			'from_e1rm'
		]);
		expect(firstLoaded('bench_press')).toEqual([
			null,
			'baseline',
			'from_e1rm',
			'from_e1rm',
			'from_e1rm'
		]);
		const bench = liftByWeek(plan, 'bench_press')[1]!;
		expect(line(bench, 'top')).toMatchObject({
			loadKind: 'rpe_based',
			targetRpe: 7.5,
			loadValue: null
		});
		expect(line(bench, 'back_off').loadKind).toBe('from_e1rm');
	});
});

describe('the progression stage', () => {
	it('stores the rules on the first block as JSON data that rebuilds the same weeks', () => {
		const input = inputOf(SCENARIOS.powerlifter());
		const plan = generateProgram(input, OPTIONS);
		const stored = JSON.parse(JSON.stringify(plan.blocks[0]!.progression)) as typeof LOAD_RULES;
		expect(stored).toEqual(LOAD_RULES);
		expect(plan.blocks.slice(1).map((b) => [b.outline, b.progression])).toEqual(
			plan.blocks.slice(1).map(() => [true, {}])
		);

		const { draft, context } = draftBefore('progression', input);
		const progressed = STAGES.find((s) => s.name === 'progression')!.run(draft, context);
		expect(progressWeeks(draft.blocks[0]!.weeks, input, stored)).toEqual(
			progressed.blocks[0]!.weeks
		);

		// The stored numbers drive the weeks: change one and the block follows it.
		const adapted = progressWeeks(draft.blocks[0]!.weeks, input, {
			...stored,
			extraMainSets: 2,
			measuredShare: 0.9
		});
		const squat = (weeks: WeekPlan[], w: number) =>
			strengthIn(weeks[w]!)
				.flatMap((s) => s.exercises)
				.find((e) => keyOf(e) === 'back_squat')!;
		expect(line(squat(adapted, 3), 'back_off').sets).toBe(
			line(squat(adapted, 2), 'back_off').sets + 2
		);
		expect(line(squat(adapted, 1), 'top').loadValue).toBe(0.725);
		expect(line(squat(progressed.blocks[0]!.weeks, 1), 'top').loadValue).toBe(0.75);
	});

	it('explains each week after the baseline in a progression decision', () => {
		const decisions = (plan: ProgramPlan) => plan.decisions.filter((d) => d.kind === 'progression');
		const blank = decisions(generate(SCENARIOS.beginner()));
		expect(blank.map((d) => [d.ruleKey, d.refs, d.summary])).toEqual([
			['progression.accumulation', ['blocks.0.weeks.1'], 'Week 2: top sets at RPE 7.5'],
			['progression.accumulation', ['blocks.0.weeks.2'], 'Week 3: top sets at RPE 8'],
			[
				'progression.accumulation',
				['blocks.0.weeks.3'],
				'Week 4: top sets at RPE 8.5, a back-off set more on each main lift'
			],
			['progression.deload', ['blocks.0.weeks.4'], 'Week 5: top sets at RPE 6, 40 % fewer sets']
		]);
		expect(blank[0]!.why).toContain('Loads from your estimated 1RM follow the RPE');
		const known = decisions(generate(SCENARIOS.powerlifter()));
		expect(known.map((d) => d.summary)).toEqual([
			'Week 2: top sets at RPE 7.5, loads from a known 1RM +2.5 %',
			'Week 3: top sets at RPE 8, loads from a known 1RM +2.5 %',
			'Week 4: top sets at RPE 8.5, loads from a known 1RM +2.5 %, a back-off set more on each main lift',
			'Week 5: top sets at RPE 6, loads from a known 1RM −10 %, 40 % fewer sets'
		]);
		expect(known[3]).toMatchObject({ evidence: { rpeCap: 6, loadStep: -0.1, volumeFactor: 0.6 } });
		expect(known[0]!.why).not.toContain('estimated');
	});
});

describe('the brief’s scenarios', () => {
	it('beginner (3 days, 60 min, blank 1RMs): RPE-based main lifts, and the same plan on a second run', () => {
		const plan = generate(SCENARIOS.beginner());
		const week1 = strengthIn(plan.blocks[0]!.weeks[0]!)
			.flatMap((s) => s.exercises)
			.filter(isMain);
		expect(week1.length).toBeGreaterThan(0);
		for (const e of week1) {
			expect([line(e, 'top').loadKind, line(e, 'back_off').loadKind]).toEqual([
				'rpe_based',
				'from_e1rm'
			]);
			expect(e.instructions).toBe(BASELINE_INSTRUCTION);
		}
		const later = plan.blocks[0]!.weeks.slice(1).flatMap((w) =>
			strengthIn(w)
				.flatMap((s) => s.exercises)
				.filter(isMain)
		);
		expect(later.every((e) => e.sets.every((l) => l.loadKind === 'from_e1rm'))).toBe(true);
		expect(generate(SCENARIOS.beginner())).toEqual(plan);
	});

	it('powerlifter (measured SBD, a meet in 16 weeks): percentage main lifts, none above 75 % in week 1, and decisions that cite the maxes', () => {
		const plan = generate(SCENARIOS.powerlifter());
		const week1 = strengthIn(plan.blocks[0]!.weeks[0]!)
			.flatMap((s) => s.exercises)
			.filter(isMain);
		expect(new Set(week1.map(keyOf))).toEqual(new Set(['back_squat', 'bench_press', 'deadlift']));
		for (const l of week1.flatMap((e) => e.sets)) {
			expect(l).toMatchObject({ loadKind: 'percent_1rm', loadBasis: 'measured' });
			expect(l.loadValue).toBeLessThanOrEqual(0.75);
		}
		const cited = plan.decisions.filter((d) => d.kind === 'load_basis');
		expect(cited.map((d) => d.evidence.oneRepMaxKg)).toEqual([180, 120, 220]);
		for (const [d, kg] of cited.map((d, i) => [d, [180, 120, 220][i]] as const)) {
			expect(d.why).toContain(`measured 1RM of ${kg} kg`);
		}
	});
});
