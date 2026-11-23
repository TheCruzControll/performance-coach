/**
 * generator-phasing: each week's strength prescriptions follow its block type. The phasing stage
 * gives the main lifts each strength phase's reps and top RPE (loaded through M1's table at that
 * RPE, measured, estimated and blank 1RMs each as M3 loads them), halves the accessories of
 * realization and taper weeks, and holds a strength goal at maintenance to its dose's top-set RPE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { percentOfOneRepMax } from '../rpe';
import { BASELINE_INSTRUCTION } from '../training/describe';
import { plannedHardSets } from '../training/metrics';
import type {
	BlockPlan,
	DecisionPlan,
	PlannedExercisePlan,
	ProgramPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { MUSCLE_GROUP_LABEL } from '../training/vocabulary';
import type { MuscleGroup } from '../training/vocabulary';
import { addDays } from '../calendar';
import { DecisionLog } from './decisions';
import { firstDraft, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { ESTIMATE_INSTRUCTION } from './loads';
import { M7_SCENARIOS, m7Day } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { doseBand } from './priority/doses';
import { mainRpe } from './progression';
import { LOAD_RULES } from './rules/loads';
import { DOSES } from './rules/maintenance';
import { PLAN_BUDGET } from './rules/road';
import { HARD_SET_RANGES } from './rules/volume';
import { SCENARIOS, SCENARIO_START } from './scenarios';
import { chooseSplit } from './splits';
import type { Draft, GenerateOptions, StageContext } from './stage';
import * as stages from './stages/prepare';
import type { PlannedBlock } from './stages/prepare';
import { phaseWeek, phasing, strengthMode } from './stages/phasing';
import { estimateMinutes } from './timefit';

const MAJOR: MuscleGroup[] = ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'hips'];
const MUSCLES = new Map(CATALOGUE.map((e) => [e.key, e]));
const optionsOn = (startsOn: string): GenerateOptions => ({ startsOn, firstPlannedDay: startsOn });
const OPTIONS = optionsOn(SCENARIO_START);
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/**
 * The stages up to and including `last` run on `profile`, prepare first, as generateProgram runs
 * them; `block` plans the priorities at that block's phase, as M6's next block does.
 */
function draftThrough(
	profile: TrainingProfile,
	last: string,
	options = OPTIONS,
	block?: PlannedBlock
) {
	const log = new DecisionLog();
	const prepared = stages.prepare(inputOf(profile), options, log, block);
	const context: StageContext = { input: prepared.input, options, log };
	let draft: Draft = firstDraft(prepared);
	for (const stage of STAGES.slice(0, STAGES.findIndex((s) => s.name === last) + 1)) {
		draft = stage.run(draft, context);
	}
	return { draft, context };
}

const strengthIn = (week: WeekPlan) =>
	week.sessions.filter(
		(s): s is StrengthSessionPlan => s.kind === 'strength' && s.source === 'generator'
	);
const keyOf = (e: PlannedExercisePlan) => ('key' in e.exercise ? e.exercise.key : '');
/** A main lift: the main slot's exercise, the one with a top set. */
const isMain = (e: PlannedExercisePlan) => e.sets.some((l) => l.role === 'top');
const mainsIn = (week: WeekPlan) => strengthIn(week).flatMap((s) => s.exercises.filter(isMain));
const topOf = (e: PlannedExercisePlan) => e.sets.find((l) => l.role === 'top')!;
const hardSets = (week: WeekPlan, group: MuscleGroup) =>
	plannedHardSets(week, MUSCLES).groups[group] ?? 0;
/** The first block's weeks at full volume: the ones the volume stage balances. */
const building = (block: BlockPlan) => block.weeks.filter((w) => w.targets.volumeFactor >= 1);
const volumeOf = (decisions: readonly DecisionPlan[], group: MuscleGroup) =>
	decisions.find(
		(d) =>
			d.kind === 'volume_adjusted' &&
			d.ruleKey !== 'volume.push_pull' &&
			d.evidence.group === MUSCLE_GROUP_LABEL[group]
	);

/** meetPrep's first block from each of these Mondays is planned in this strength phase. */
const MEET_STARTS = [
	[SCENARIO_START, 'accumulation'],
	[m7Day(7, 0), 'intensification'],
	[m7Day(8, 0), 'realization'],
	[m7Day(9, 0), 'taper']
] as const;

describe('strength phases (S12 meetPrep)', () => {
	it.each(MEET_STARTS)('from %s, every main lift takes its %s week’s reps and top RPE', (on) => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.meetPrep()), optionsOn(on));
		const block = plan.blocks[0]!;
		expect(plan.decisions.filter((d) => d.kind === 'load_eased')).toEqual([]);
		for (const week of block.weeks) {
			const { mainLifts } = week.targets;
			expect(mainLifts, week.startsOn).toBeDefined();
			const { repsMin, repsMax, topRpe } = mainLifts!;
			expect(mainsIn(week).length, week.startsOn).toBeGreaterThan(0);
			for (const lift of mainsIn(week)) {
				for (const line of lift.sets) {
					expect([line.repsMin, line.repsMax], `${keyOf(lift)} ${week.startsOn}`).toEqual([
						repsMin,
						repsMax
					]);
				}
				expect(topOf(lift).targetRpe).toBe(topRpe);
				const backOff = lift.sets.find((l) => l.role === 'back_off')!;
				expect(backOff.targetRpe).toBe(Math.max(5, topRpe - 1));
			}
		}
	});

	it('plans each phase its own scheme: 6–8, then 3–5, then 1–3, then singles and doubles', () => {
		const firstWeek = (on: string) =>
			generateProgram(inputOf(M7_SCENARIOS.meetPrep()), optionsOn(on)).blocks[0]!;
		expect(
			MEET_STARTS.map(([on]) => {
				const block = firstWeek(on);
				const { repsMin, repsMax } = block.weeks[0]!.targets.mainLifts!;
				return [block.phase, repsMin, repsMax];
			})
		).toEqual([
			['accumulation', 6, 8],
			['intensification', 3, 5],
			['realization', 1, 3],
			['taper', 1, 2]
		]);
	});

	it('names the phase in load_basis and progression, with the main lifts’ reps', () => {
		for (const [on, phase] of MEET_STARTS) {
			const plan = generateProgram(inputOf(M7_SCENARIOS.meetPrep()), optionsOn(on));
			const bases = plan.decisions.filter((d) => d.kind === 'load_basis');
			expect(bases.length).toBe(3);
			for (const d of bases) expect(d.evidence.phase, on).toBe(phase);
			for (const d of plan.decisions.filter((x) => x.kind === 'progression')) {
				expect(d.evidence.phase, on).toBe(phase);
				expect(d.summary, on).toMatch(
					/^Week \d+: main lifts in sets of \d+(–\d+)?, top sets at RPE/
				);
			}
		}
	});

	it('keeps measured and estimated 1RMs distinct and leaves a blank one RPE-based', () => {
		const profile = M7_SCENARIOS.meetPrep();
		profile.baselines = profile.baselines
			.filter((b) => b.lift !== 'deadlift')
			.map((b) =>
				b.lift === 'bench_press' ? { ...b, kind: 'estimated' as const, source: 'estimate' } : b
			);
		const input = inputOf(profile);
		const plan = generateProgram(input, OPTIONS);
		const [first, second] = plan.blocks[0]!.weeks;
		const lift = (week: WeekPlan, key: string) => mainsIn(week).find((e) => keyOf(e) === key)!;
		// Week 1 works up to the phase's 8 reps at RPE 7, M1's table share, a measured max under it.
		const table = percentOfOneRepMax(8, 7)!;
		const share = Math.floor((table * LOAD_RULES.measuredShare) / 0.025 + 1e-9) * 0.025;
		const squat = topOf(lift(first!, 'back_squat'));
		expect(squat).toMatchObject({
			loadKind: 'percent_1rm',
			loadBasis: 'measured',
			reference1rm: 180
		});
		expect(squat.loadValue).toBeCloseTo(share, 6);
		const bench = lift(first!, 'bench_press');
		expect(topOf(bench)).toMatchObject({
			loadKind: 'percent_1rm',
			loadBasis: 'estimated',
			reference1rm: 120
		});
		expect(topOf(bench).loadValue).toBeCloseTo(share - LOAD_RULES.estimateDiscount, 6);
		expect(bench.instructions).toBe(ESTIMATE_INSTRUCTION);
		const deadlift = lift(first!, 'deadlift');
		expect(topOf(deadlift)).toMatchObject({ loadKind: 'rpe_based', loadValue: null, repsMax: 8 });
		expect(deadlift.instructions).toBe(BASELINE_INSTRUCTION);
		// The week after loads it from the estimate that set gives, at M1's table for its reps.
		const later = topOf(lift(second!, 'deadlift'));
		const { repsMax, topRpe } = second!.targets.mainLifts!;
		expect(later).toMatchObject({ loadKind: 'from_e1rm', loadBasis: null });
		expect(later.loadValue).toBeCloseTo(percentOfOneRepMax(repsMax, topRpe)!, 6);
		const basis = (lift: string) =>
			plan.decisions.find((d) => d.kind === 'load_basis' && d.evidence.lift === lift)!;
		expect(basis('back_squat').ruleKey).toBe('loads.measured');
		expect(basis('bench_press').ruleKey).toBe('loads.estimated');
		expect(basis('deadlift').ruleKey).toBe('loads.baseline_set');
		expect(basis('deadlift').evidence).toMatchObject({ reps: 8, rpe: 7 });
	});

	it('halves the work beside the main lifts in realization and taper weeks, and nowhere else', () => {
		for (const [on, phase] of MEET_STARTS) {
			const before = draftThrough(M7_SCENARIOS.meetPrep(), 'placement', optionsOn(on)).draft;
			const after = draftThrough(M7_SCENARIOS.meetPrep(), 'phasing', optionsOn(on)).draft;
			const halved = phase === 'realization' || phase === 'taper';
			before.blocks[0]!.weeks.forEach((week, w) => {
				strengthIn(week).forEach((session, s) => {
					const rest = (x: StrengthSessionPlan) => x.exercises.filter((e) => !isMain(e));
					const phased = strengthIn(after.blocks[0]!.weeks[w]!)[s]!;
					const kept = rest(phased).map(keyOf);
					const all = rest(session).map(keyOf);
					expect(kept, `${on} ${session.title}`).toEqual(
						halved ? all.slice(0, Math.ceil(all.length / 2)) : all
					);
					expect(phased.exercises.filter(isMain).length).toBe(
						session.exercises.filter(isMain).length
					);
				});
			});
		}
	});

	it('floors a back-off at RPE 5 when the top set is lower, as M3 does', () => {
		const { draft, context } = draftThrough(M7_SCENARIOS.meetPrep(), 'placement');
		const week = draft.blocks[0]!.weeks[0]!;
		const session = strengthIn(week).find((s) => s.exercises.some(isMain))!;
		const handMade: WeekPlan = {
			...week,
			targets: {
				...week.targets,
				mainLifts: { repsMin: 6, repsMax: 8, topRpe: 5.5, setsFactor: 1 }
			},
			sessions: [{ ...session, exercises: [session.exercises.find(isMain)!] }]
		};
		const phased = phaseWeek(handMade, draft.blocks[0]!, context.input, false);
		const lift = strengthIn(phased)[0]!.exercises[0]!;
		expect(topOf(lift).targetRpe).toBe(5.5);
		expect(lift.sets.find((l) => l.role === 'back_off')!.targetRpe).toBe(5);
	});

	it('gives the meet week a single at RPE 7, with the accessories halved', () => {
		const on = m7Day(9, 0);
		const plan = generateProgram(inputOf(M7_SCENARIOS.meetPrep()), optionsOn(on));
		const block = plan.blocks[0]!;
		expect(block.phase).toBe('taper');
		const w = block.weeks.findIndex((week) => week.kind === 'event');
		expect(w).toBeGreaterThanOrEqual(0);
		expect(block.weeks[w]!.targets.mainLifts).toMatchObject({ repsMin: 1, repsMax: 1, topRpe: 7 });
		const before = draftThrough(M7_SCENARIOS.meetPrep(), 'placement', optionsOn(on)).draft
			.blocks[0]!.weeks[w]!;
		const rest = (s: StrengthSessionPlan) => s.exercises.filter((e) => !isMain(e)).map(keyOf);
		strengthIn(block.weeks[w]!).forEach((session, s) => {
			const all = rest(strengthIn(before)[s]!);
			expect(rest(session)).toEqual(all.slice(0, Math.ceil(all.length / 2)));
		});
	});
});

describe('weeks phasing leaves alone', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns the draft itself when the plan has no season', () => {
		vi.spyOn(stages, 'prepare').mockImplementation((input) => ({ input, periodisation: null }));
		const { draft, context } = draftThrough(SCENARIOS.hybrid(), 'placement');
		expect(phasing(draft, context)).toBe(draft);
	});

	it('rewrites no week of a dosed plan whose weeks already sit at the dose’s cap', () => {
		const { draft, context } = draftThrough(SCENARIOS.journey(), 'placement');
		expect(draft.periodisation).toBeTruthy();
		expect(strengthMode(context.input)).toBe('maintenance');
		for (const block of draft.blocks) {
			for (const week of block.weeks) {
				expect(week.targets.rpeCap).toBeLessThanOrEqual(DOSES.strength.topSetRpeCap);
			}
		}
		const after = phasing(draft, context);
		draft.blocks.forEach((block, b) =>
			block.weeks.forEach((week, w) => expect(after.blocks[b]!.weeks[w]).toEqual(week))
		);
	});
});

describe('hypertrophy main lifts (S6 hypertrophyBlock)', () => {
	const plan = generateProgram(inputOf(M7_SCENARIOS.hypertrophyBlock()), OPTIONS);
	const block = plan.blocks[0]!;

	it('prescribes and loads the main lifts at the week’s top RPE, under the isolations’ cap', () => {
		expect(mainRpe({ ...block.weeks[1]!.targets })).toBe(block.weeks[1]!.targets.mainLifts!.topRpe);
		expect(mainRpe({ rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 })).toBe(7);
		// A schedule-eased cap below the top RPE wins.
		expect(mainRpe({ ...block.weeks[1]!.targets, rpeCap: 6.5 })).toBe(6.5);
		// Its compounds work in the block's 6–10 at the top RPE, half a point under the isolations' cap.
		for (const week of building(block)) {
			const { repsMin, repsMax, topRpe } = week.targets.mainLifts!;
			expect(topRpe).toBeLessThanOrEqual(week.targets.rpeCap);
			expect(mainsIn(week).length).toBeGreaterThan(0);
			for (const lift of mainsIn(week)) {
				expect(topOf(lift)).toMatchObject({ repsMin, repsMax, targetRpe: topRpe });
			}
		}
	});
});

describe('dose bands', () => {
	it('S11: strength at maintenance in a marathon peak stays within M3’s 4–10, on its maintenance split', () => {
		const profile = M7_SCENARIOS.runnerLifter();
		const peak = { phase: 'marathon_peak', endsOn: addDays(SCENARIO_START, 27) } as const;
		const { draft, context } = draftThrough(profile, 'timefit', OPTIONS, peak);
		const strength = Object.entries(context.input.modes ?? {}).find(
			([ref]) =>
				ref ===
				context.input.refs.goals[context.input.goals.findIndex((g) => g.title === 'Get stronger')]
		);
		expect(strength?.[1]).toBe('maintenance');
		const split = chooseSplit(context.input, 2);
		expect(split.layout).toBe('maintenance');
		const [lo, hi] = HARD_SET_RANGES.maintenance.sets;
		expect(doseBand(split, null, 'maintenance')).toEqual([lo, hi]);
		const decisions = context.log.list();
		expect(decisions.find((d) => d.kind === 'split_chosen')?.ruleKey).toBe('strength.maintenance');
		for (const week of building(draft.blocks[0]!)) {
			expect(week.targets.rpeCap).toBeLessThanOrEqual(DOSES.strength.topSetRpeCap);
			// The week's cap comes down to the dose's, and the marathon's runs already sit under it.
			expect(week.sessions.some((s) => s.kind === 'run')).toBe(true);
			for (const s of week.sessions.filter((x) => x.source !== 'commitment'))
				expect(s.targetRpe, `${s.title} ${s.date}`).toBeLessThanOrEqual(week.targets.rpeCap);
			for (const lift of mainsIn(week)) {
				expect(topOf(lift).targetRpe).toBeLessThanOrEqual(DOSES.strength.topSetRpeCap);
			}
			for (const session of strengthIn(week)) {
				for (const e of session.exercises.filter((x) => !isMain(x))) {
					for (const line of e.sets)
						expect(line.sets).toBeLessThanOrEqual(DOSES.strength.setsPerSlot);
				}
			}
			for (const group of MAJOR) {
				const over = Boolean(volumeOf(decisions, group)?.evidence.over);
				const sets = hardSets(week, group);
				expect(sets, `${group} ${week.startsOn}`).toBeGreaterThanOrEqual(lo);
				if (!over) expect(sets, `${group} ${week.startsOn}`).toBeLessThanOrEqual(hi);
			}
		}
	});
});

describe('every M7 scenario', () => {
	const KEYS = Object.keys(M7_SCENARIOS) as M7ScenarioKey[];

	it.each(KEYS)(
		'%s: every strength session still fits its minutes, and the plan is deterministic',
		(key) => {
			const input = inputOf(M7_SCENARIOS[key]());
			const plan: ProgramPlan = generateProgram(input, OPTIONS);
			for (const week of plan.blocks.flatMap((b) => b.weeks)) {
				for (const s of strengthIn(week)) {
					expect(s.estMinutes, `${s.title} ${s.date}`).toBe(estimateMinutes(s, input));
					expect(s.estMinutes, `${s.title} ${s.date}`).toBeLessThanOrEqual(input.sessionMinutes);
				}
			}
			expect(JSON.stringify(generateProgram(inputOf(M7_SCENARIOS[key]()), OPTIONS))).toBe(
				JSON.stringify(plan)
			);
		},
		// Each case generates the plan twice, near the 5 s default on a loaded runner.
		30_000
	);

	it('keeps longSeason within PLAN_BUDGET', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.longSeason()), OPTIONS);
		expect(plan.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(plan.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
	});
});
