/**
 * generator-running: runs from current fitness. Paces come from the best recent race's VDOT (an
 * undated race at low confidence when no race has a date), else the told easy pace's; a marathon
 * or half week planned with its targets holds its long run within its caps, rising at most 1.5 km
 * a week, and its phase's race work (marathon pace closing the long run and a threshold run, or a
 * half's threshold run and 10K-pace intervals from HALF_HOOKS); a cutback week holds 20 % less; a
 * running goal that does not lead holds its dose.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type {
	BlockPlan,
	ProgramPlan,
	RunSessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { DecisionLog } from './decisions';
import { firstDraft, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { demandOf } from './interference';
import { paceFor, trainingPaces, vdotFromEasyPace, vdotFromPerformance } from './paces';
import { enduranceWeeks } from './periodisation/endurance';
import { M7_SCENARIOS, m7Day } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { ENDURANCE, HALF_HOOKS } from './rules/endurance';
import { MAINTENANCE_BLOCK } from './rules/maintenance';
import { PLAN_BUDGET } from './rules/road';
import { MARATHON_HOOKS } from './rules/running';
import { ROUGH_GUIDE } from './running';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { Draft, GenerateOptions, StageContext } from './stage';
import { prepare } from './stages/prepare';
import { running } from './stages/running';

const optionsOn = (on: string): GenerateOptions => ({ startsOn: on, firstPlannedDay: on });
const OPTIONS = optionsOn(SCENARIO_START);
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const runsIn = (week: WeekPlan) =>
	week.sessions.filter((s): s is RunSessionPlan => s.kind === 'run' && s.source === 'generator');
const metresOf = (run: RunSessionPlan) =>
	run.segments.reduce((sum, s) => sum + (s.distanceMetres ?? 0) * (s.repeats ?? 1), 0);
/** A run's metres, a timed quality session's by its minutes at the told easy pace of 5:30 /km. */
const metresOrMinutes = (run: RunSessionPlan) => metresOf(run) || (run.estMinutes * 60_000) / 330;
const weekMetres = (week: WeekPlan) => runsIn(week).reduce((sum, r) => sum + metresOrMinutes(r), 0);
const longRunOf = (week: WeekPlan) => runsIn(week).find((r) => r.type === 'long_run');
const qualityIn = (week: WeekPlan) =>
	runsIn(week).filter((r) => r.type === 'tempo_run' || r.type === 'interval_run');
const paceOf = (segment: RunSessionPlan['segments'][number]) => [
	segment.paceMinSecondsPerKm,
	segment.paceMaxSecondsPerKm
];
const decisionOf = (plan: Pick<ProgramPlan, 'decisions'>, kind: string) =>
	plan.decisions.find((d) => d.kind === kind)!;

/** runnerLifter (a marathon in week 16, a 10K in 43:00 six weeks before week 1). */
const TEN_K_PACES = trainingPaces(vdotFromPerformance(10_000, 43 * 60));

/** runnerLifter with its marathon a half marathon instead, and `longestKm` as its longest run. */
function halfRunner(longestKm = 26) {
	const profile = M7_SCENARIOS.runnerLifter();
	const race = profile.goals[0]!;
	Object.assign(race, { title: 'Half marathon', eventType: 'Half marathon' });
	profile.running!.longestRun = longestKm;
	return profile;
}

/**
 * runnerLifter's marathon `phase` weeks as periodisation/endurance.ts plans them from week 1 (55 km
 * a week, its longest run `longestKm`), run through the running stage as the first block.
 */
function marathonBlock(
	phase: 'marathon_build' | 'marathon_peak' | 'marathon_taper',
	longestKm = 26
) {
	const profile = M7_SCENARIOS.runnerLifter();
	profile.running!.longestRun = longestKm;
	const weeks = enduranceWeeks('marathon', {
		startsOn: SCENARIO_START,
		raceOn: profile.goals[0]!.eventDate!,
		startVolume: 55_000,
		longestRun: longestKm * 1000,
		level: null,
		paces: TEN_K_PACES
	}).filter((w) => w.phase === phase);
	const startsOn = weeks[0]!.startsOn;
	const options = optionsOn(startsOn);
	const log = new DecisionLog();
	const prepared = prepare(inputOf(profile), options, log);
	const context: StageContext = { input: prepared.input, options, log };
	let draft: Draft = firstDraft(prepared);
	for (const stage of STAGES.slice(0, STAGES.findIndex((s) => s.name === 'commitments') + 1)) {
		draft = stage.run(draft, context);
	}
	const block: BlockPlan = {
		phase,
		name: phase,
		startsOn,
		endsOn: addDays(weeks.at(-1)!.startsOn, 6),
		outline: false,
		goalRefs: [],
		progression: {},
		weeks: weeks.map((w) => ({
			kind: w.kind,
			startsOn: w.startsOn,
			endsOn: addDays(w.startsOn, 6),
			targets: w.targets,
			sessions: []
		}))
	};
	const own = new DecisionLog();
	const after = running({ ...draft, blocks: [block] }, { ...context, log: own });
	return { block: after.blocks[0]!, decisions: own.list() };
}

describe('paces from current fitness', () => {
	it('falls back to the told easy pace’s VDOT on hybrid, which has no race', () => {
		const plan = generateProgram(inputOf(SCENARIOS.hybrid()), OPTIONS);
		const paces = trainingPaces(vdotFromEasyPace(330));
		const weeks = plan.blocks[0]!.weeks;
		const easy = weeks.flatMap(runsIn).filter((r) => r.type === 'easy_run');
		expect(easy.length).toBeGreaterThan(0);
		for (const run of easy) expect(paceOf(run.segments[0]!)).toEqual([...paceFor('easy', paces)]);
		const tempo = weeks.flatMap(runsIn).find((r) => r.type === 'tempo_run')!;
		expect(paceOf(tempo.segments.find((s) => s.kind === 'tempo')!)).toEqual([
			...paceFor('tempo', paces)
		]);
		const source = decisionOf(plan, 'run_pace_source');
		expect(source.ruleKey).toBe('running.paces_from_told');
		expect(source.why).toContain(
			`Paces come from your easy pace of 5:30 /km, a VDOT of ${Math.round(vdotFromEasyPace(330))} by Daniels’ formula`
		);
	});

	it('takes every pace from a race’s VDOT, ahead of a told easy pace', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.runnerLifter()), OPTIONS);
		const week = plan.blocks[0]!.weeks[1]!;
		const easy = runsIn(week).find((r) => r.type === 'easy_run')!;
		expect(paceOf(easy.segments[0]!)).toEqual([...paceFor('easy', TEN_K_PACES)]);
		const long = longRunOf(week)!;
		expect(paceOf(long.segments[0]!)).toEqual([...paceFor('long', TEN_K_PACES)]);
		const tempo = qualityIn(week)[0]!;
		expect(paceOf(tempo.segments.find((s) => s.kind === 'tempo')!)).toEqual([
			...paceFor('tempo', TEN_K_PACES)
		]);
		const vdot = Math.round(vdotFromPerformance(10_000, 43 * 60));
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			summary: `Run targets from your race time, a VDOT of ${vdot}`,
			why: expect.stringContaining(
				`Paces come from your 10K in 43:00 on 4 Oct, a VDOT of ${vdot}, by Daniels’ formula. Each is a range.`
			)
		});
	});

	it('gives an owner with only undated races race-based paces, worded as a rough guide', () => {
		const profile = M7_SCENARIOS.runnerLifter();
		profile.running!.races = profile.running!.races.map((r) => ({ ...r, racedOn: null }));
		profile.running!.easyPaceSeconds = null;
		const plan = generateProgram(inputOf(profile), OPTIONS);
		const easy = plan.blocks[0]!.weeks.flatMap(runsIn).find((r) => r.type === 'easy_run')!;
		expect(paceOf(easy.segments[0]!)).toEqual([...paceFor('easy', TEN_K_PACES)]);
		const vdot = Math.round(vdotFromPerformance(10_000, 43 * 60));
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			why: expect.stringContaining(
				`Paces come from your 10K in 43:00, a VDOT of ${vdot}, by Daniels’ formula${ROUGH_GUIDE.undated}.`
			)
		});
	});
});

/** Each long run is at most 1.5 km over the longest planned before it, and inside its caps. */
function expectLongRunsWithinCaps(weeks: readonly WeekPlan[], capMetres: number) {
	let longest: number | null = null;
	for (const week of weeks) {
		const long = longRunOf(week);
		if (!long) continue;
		const size = metresOf(long);
		if (longest !== null) {
			expect(size, week.startsOn).toBeLessThanOrEqual(longest + ENDURANCE.long_run.stepMetres);
		}
		const target = week.targets.running?.longRunMetres;
		if (target) expect(size, week.startsOn).toBeLessThanOrEqual(target);
		expect(size, week.startsOn).toBeLessThanOrEqual(capMetres);
		longest = Math.max(longest ?? 0, size);
	}
	expect(longest).not.toBeNull();
}

describe('the long run in a race plan', () => {
	it('rises at most 1.5 km a week within its caps, in a marathon build and a half’s base', () => {
		const { block } = marathonBlock('marathon_build', 20);
		expect(block.weeks.length).toBeGreaterThan(3);
		expectLongRunsWithinCaps(block.weeks, ENDURANCE.long_run.cap.marathon.metres);
		const half = generateProgram(inputOf(halfRunner(20)), optionsOn(m7Day(2, 0)));
		expect(half.blocks[0]!.phase).toBe('half_base');
		expectLongRunsWithinCaps(half.blocks[0]!.weeks, ENDURANCE.long_run.cap.half.metres);
	});
});

describe('race-specific work', () => {
	it('gives every marathon build week a marathon-pace long run and a threshold run', () => {
		const { block } = marathonBlock('marathon_build');
		const shares: number[] = [];
		for (const week of block.weeks) {
			const long = longRunOf(week)!;
			const [easy, steady] = long.segments;
			expect(
				long.segments.map((s) => s.kind),
				week.startsOn
			).toEqual(['long', 'steady']);
			expect(paceOf(easy!)).toEqual([...paceFor('long', TEN_K_PACES)]);
			expect(paceOf(steady!)).toEqual([...paceFor('steady', TEN_K_PACES)]);
			expect(steady!.hrZone).toBe(3);
			expect(long.instructions).toContain(ENDURANCE.marathon_pace.label);
			shares.push(steady!.distanceMetres! / metresOf(long));

			const quality = qualityIn(week);
			expect(
				quality.map((r) => r.type),
				week.startsOn
			).toEqual(['tempo_run']);
			const tempo = quality[0]!.segments.find((s) => s.kind === 'tempo')!;
			expect(paceOf(tempo)).toEqual([...paceFor('tempo', TEN_K_PACES)]);
			expect(quality[0]!.instructions).toContain(ENDURANCE.quality.threshold.label);
			// The marathon-pace long run is the hooks' second quality session.
			expect(quality.length + 1).toBe(MARATHON_HOOKS.marathon_build!.qualityPerWeek);
		}
		const [low, high] = ENDURANCE.marathon_pace.share;
		expect(shares[0]).toBeGreaterThan(low - 0.01);
		expect(shares.at(-1)!).toBeGreaterThan(high - 0.02);
		for (const [i, share] of shares.entries()) {
			expect(share).toBeLessThanOrEqual(high);
			if (i) expect(share).toBeGreaterThanOrEqual(shares[i - 1]! - 0.01);
		}
		expect(decisionOf(marathonBlock('marathon_build'), 'quality_session')).toMatchObject({
			ruleKey: 'endurance.race_work',
			summary: 'Quality running: marathon pace in the long run and a threshold run'
		});
	});

	it('gives a half’s build weeks their 2 quality sessions from HALF_HOOKS', () => {
		const plan = generateProgram(inputOf(halfRunner()), optionsOn(m7Day(9, 0)));
		const block = plan.blocks[0]!;
		expect(block.phase).toBe('half_build');
		const want = HALF_HOOKS.half_build!.qualityPerWeek!;
		expect(want).toBe(2);
		for (const week of block.weeks) {
			const quality = qualityIn(week);
			expect(quality.map((r) => r.type).sort(), week.startsOn).toEqual([
				'interval_run',
				'tempo_run'
			]);
			expect(quality).toHaveLength(want);
			const repeat = quality
				.find((r) => r.type === 'interval_run')!
				.segments.find((s) => s.kind === 'interval')!;
			// 10K pace: between threshold's fast end and VO2max's slow end.
			expect(paceOf(repeat)).toEqual([
				paceFor('interval', TEN_K_PACES)[1],
				paceFor('tempo', TEN_K_PACES)[0]
			]);
			expect(longRunOf(week)!.segments.map((s) => s.kind)).toEqual(['long']);
		}
		expect(decisionOf(plan, 'quality_session')).toMatchObject({
			ruleKey: 'endurance.race_work',
			summary: 'Quality running: a threshold run and 10K-pace intervals'
		});
	});

	it('carries a half block’s own hooks into its progression at the running stage', () => {
		const options = optionsOn(m7Day(9, 0));
		const log = new DecisionLog();
		const prepared = prepare(inputOf(halfRunner()), options, log);
		let draft: Draft = firstDraft(prepared);
		for (const stage of STAGES.slice(0, STAGES.findIndex((s) => s.name === 'running') + 1)) {
			draft = stage.run(draft, { input: prepared.input, options, log });
		}
		expect(draft.blocks[0]!.progression).toMatchObject(HALF_HOOKS.half_build!);
	});

	it('records the marathon peak’s own hooks, which sized it, over M3’s defaults', () => {
		expect(marathonBlock('marathon_peak').block.progression).toMatchObject(
			MARATHON_HOOKS.marathon_peak!
		);
	});

	it('leaves the long run out of the race week', () => {
		const { block } = marathonBlock('marathon_taper');
		const race = block.weeks.find((w) => w.kind === 'event')!;
		expect(race.targets.running).toBeDefined();
		expect(runsIn(race).length).toBeGreaterThan(0);
		expect(longRunOf(race)).toBeUndefined();
	});
});

describe('cutback weeks', () => {
	it('holds a cutback week to 80 % of the biggest week before it', () => {
		const plan = generateProgram(inputOf(halfRunner()), optionsOn(m7Day(9, 0)));
		const weeks = plan.blocks[0]!.weeks;
		const at = weeks.findIndex((w) => w.kind === 'cutback');
		expect(at).toBeGreaterThan(0);
		expect(weeks[at]!.targets.running?.cutback).toBe(true);
		const biggest = Math.max(...weeks.slice(0, at).map(weekMetres));
		expect(weekMetres(weeks[at]!)).toBeLessThanOrEqual(ENDURANCE.cutback.factor * biggest);
	});
});

describe('a running goal that does not lead', () => {
	it('holds its dose through multiGoal’s fight camp: 65 % of recent volume, one quality run, the long run held', () => {
		const profile = M7_SCENARIOS.multiGoal();
		const plan = generateProgram(inputOf(profile), OPTIONS);
		const recent = profile.running!.weeklyDistance! * 1000;
		const longest = profile.running!.longestRun! * 1000;
		const dose = MAINTENANCE_BLOCK.runVolumeFactor * recent;
		const weeks = plan.blocks[0]!.weeks;
		expect(weeks.length).toBeGreaterThan(3);
		for (const week of weeks) {
			expect(weekMetres(week), week.startsOn).toBeLessThanOrEqual(dose);
			expect(qualityIn(week).length, week.startsOn).toBeLessThanOrEqual(1);
			expect(metresOf(longRunOf(week)!), week.startsOn).toBeLessThanOrEqual(longest);
		}
		expect(decisionOf(plan, 'run_volume')).toMatchObject({
			ruleKey: 'generator.run_dose',
			why: expect.stringContaining('running holds its dose: 65 % of your recent volume')
		});
		// The dose alone explains the volume: no second reason blames the long-run or session caps.
		expect(decisionOf(plan, 'run_volume').why).not.toContain('The long run is held to');
	});
});

describe('marathonTaper (S5)', () => {
	it('keeps strength at maintenance through the taper, with no heavy lower body within 5 days of the race', () => {
		const profile = M7_SCENARIOS.marathonTaper();
		const raceOn = profile.goals[0]!.eventDate!;
		const plan = generateProgram(inputOf(profile), OPTIONS);
		expect(plan.blocks[0]!.phase).toBe('marathon_taper');
		const dose = plan.decisions.find(
			(d) => d.kind === 'maintenance_dose' && d.evidence.goal === 'Keep strength'
		);
		expect(dose).toBeDefined();
		const free = addDays(raceOn, -ENDURANCE.strength.noHeavyLowerDays);
		const lifts = plan.blocks[0]!.weeks.flatMap((w) =>
			w.sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength')
		);
		expect(lifts.length).toBeGreaterThan(0);
		for (const s of lifts) {
			for (const e of s.exercises) {
				for (const line of e.sets) {
					expect(line.targetRpe ?? 0, `${s.date}`).toBeLessThanOrEqual(ENDURANCE.strength.rpeCap);
				}
			}
			if (s.date >= free) expect(demandOf(s).heavyLower, s.date).toBe(false);
		}
		expect(lifts.some((s) => s.date >= free)).toBe(true);
	});
});

describe('every M7 scenario', () => {
	it('keeps longSeason within PLAN_BUDGET', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.longSeason()), OPTIONS);
		expect(plan.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(plan.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
	});

	it.each(Object.keys(M7_SCENARIOS) as M7ScenarioKey[])('%s is deterministic', (key) => {
		const plan = generateProgram(inputOf(M7_SCENARIOS[key]()), OPTIONS);
		expect(JSON.stringify(generateProgram(inputOf(M7_SCENARIOS[key]()), OPTIONS))).toBe(
			JSON.stringify(plan)
		);
	});
});
