/**
 * generator-running, paces (m7r/07): runs are paced from current fitness. Paces come from the best
 * recent race's VDOT by Daniels' formula (an undated race at low confidence when no race has a
 * date), else the told easy pace's, each segment at its kind's training pace. In a marathon week
 * planned with its targets the long run closes at marathon pace, a steady segment at M pace whose
 * share rises over the build. m7r/08 extends this file with its long-run, cutback, race-work and
 * dose cases.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type { BlockPlan, ProgramPlan, RunSessionPlan, WeekPlan } from '../training/types';
import { buildAddedSession } from './added';
import { DecisionLog } from './decisions';
import { firstDraft, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { paceFor, trainingPaces, vdotFromEasyPace, vdotFromPerformance } from './paces';
import { enduranceWeeks } from './periodisation/endurance';
import { M7_SCENARIOS } from './periodisation/scenarios';
import { ENDURANCE } from './rules/endurance';
import { ROUGH_GUIDE } from './running';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { Draft, GenerateOptions, StageContext } from './stage';
import { prepare } from './stages/prepare';
import { running } from './stages/running';

type Races = NonNullable<TrainingProfile['running']>['races'];

const optionsOn = (on: string): GenerateOptions => ({ startsOn: on, firstPlannedDay: on });
const OPTIONS = optionsOn(SCENARIO_START);
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const runsIn = (week: WeekPlan) =>
	week.sessions.filter((s): s is RunSessionPlan => s.kind === 'run' && s.source === 'generator');
const metresOf = (run: RunSessionPlan) =>
	run.segments.reduce((sum, s) => sum + (s.distanceMetres ?? 0) * (s.repeats ?? 1), 0);
const longRunOf = (week: WeekPlan) => runsIn(week).find((r) => r.type === 'long_run');
const qualityIn = (week: WeekPlan) =>
	runsIn(week).filter((r) => r.type === 'tempo_run' || r.type === 'interval_run');
const paceOf = (segment: RunSessionPlan['segments'][number]) => [
	segment.paceMinSecondsPerKm,
	segment.paceMaxSecondsPerKm
];
const decisionOf = (plan: Pick<ProgramPlan, 'decisions'>, kind: string) =>
	plan.decisions.find((d) => d.kind === kind)!;
/** The share of a long run at marathon pace: its steady segment's metres over the run's. */
const steadyShareOf = (run: RunSessionPlan) =>
	run.segments.find((s) => s.kind === 'steady')!.distanceMetres! / metresOf(run);

/** runnerLifter (a marathon in week 16, a 10K in 43:00 six weeks before week 1). */
const TEN_K_VDOT = vdotFromPerformance(10_000, 43 * 60);
const TEN_K_PACES = trainingPaces(TEN_K_VDOT);

/** runnerLifter with its races mapped, and no told easy pace when `told` is false. */
function lifterWith(races: (races: Races) => Races, told = true) {
	const profile = M7_SCENARIOS.runnerLifter();
	profile.running!.races = races(profile.running!.races);
	if (!told) profile.running!.easyPaceSeconds = null;
	return profile;
}

/**
 * runnerLifter's marathon `phase` weeks as periodisation/endurance.ts plans them from week 1 (55 km
 * a week, its longest run 26 km), run through the running stage as the first block.
 */
function marathonBlock(phase: 'marathon_build' | 'marathon_peak' | 'marathon_taper') {
	const profile = M7_SCENARIOS.runnerLifter();
	profile.running!.longestRun = 26;
	const weeks = enduranceWeeks('marathon', {
		startsOn: SCENARIO_START,
		raceOn: profile.goals[0]!.eventDate!,
		startVolume: 55_000,
		longestRun: 26_000,
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

	it('takes every pace, warm-up included, from a race’s VDOT ahead of a told easy pace', () => {
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
		expect(paceOf(tempo.segments[0]!)).toEqual([...paceFor('warm_up', TEN_K_PACES)]);
		const vdot = Math.round(TEN_K_VDOT);
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			summary: `Run targets from your race time, a VDOT of ${vdot}`,
			why: expect.stringContaining(
				`Paces come from your 10K in 43:00 on 4 Oct, a VDOT of ${vdot}, by Daniels’ formula. Each is a range.`
			)
		});
	});

	it('paces from the best recent race, not the latest', () => {
		const profile = lifterWith((races) => [
			...races,
			{
				...races[0]!,
				distance: '5k' as const,
				distanceMetres: 5000,
				timeSeconds: 25 * 60,
				racedOn: '2026-11-01'
			}
		]);
		const plan = generateProgram(inputOf(profile), OPTIONS);
		const easy = plan.blocks[0]!.weeks[1]!;
		const run = runsIn(easy).find((r) => r.type === 'easy_run')!;
		expect(paceOf(run.segments[0]!)).toEqual([...paceFor('easy', TEN_K_PACES)]);
		expect(decisionOf(plan, 'run_pace_source').why).toContain('your 10K in 43:00');
	});

	it('gives an owner with only undated races race paces, worded as a rough guide', () => {
		const profile = lifterWith((races) => races.map((r) => ({ ...r, racedOn: null })), false);
		const plan = generateProgram(inputOf(profile), OPTIONS);
		const easy = plan.blocks[0]!.weeks.flatMap(runsIn).find((r) => r.type === 'easy_run')!;
		expect(paceOf(easy.segments[0]!)).toEqual([...paceFor('easy', TEN_K_PACES)]);
		const vdot = Math.round(TEN_K_VDOT);
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			why: expect.stringContaining(
				`Paces come from your 10K in 43:00, a VDOT of ${vdot}, by Daniels’ formula${ROUGH_GUIDE.undated}.`
			)
		});
	});

	it('treats a race 26 to 52 weeks old as a rough guide, and an older one as none', () => {
		const old = lifterWith((races) => races.map((r) => ({ ...r, racedOn: '2026-03-01' })));
		const oldPlan = generateProgram(inputOf(old), OPTIONS);
		expect(decisionOf(oldPlan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			why: expect.stringContaining(`by Daniels’ formula${ROUGH_GUIDE.old}.`)
		});

		const stale = lifterWith((races) => races.map((r) => ({ ...r, racedOn: '2025-09-01' })), false);
		const plan = generateProgram(inputOf(stale), OPTIONS);
		const easy = plan.blocks[0]!.weeks.flatMap(runsIn).find((r) => r.type === 'easy_run')!;
		expect(easy.segments[0]).toMatchObject({
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: 2
		});
		expect(easy.segments[0]!.targetRpe).toEqual(expect.any(Number));
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'running.paces_from_effort',
			why: expect.stringContaining('None of your races is recent enough to set paces')
		});
	});

	it('paces an added run from the same VDOT, on the day it is added', () => {
		const week: WeekPlan = {
			kind: 'build',
			startsOn: SCENARIO_START,
			endsOn: addDays(SCENARIO_START, 6),
			targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
			sessions: []
		};
		const input = inputOf(M7_SCENARIOS.runnerLifter());
		const date = addDays(SCENARIO_START, 2);
		const easy = buildAddedSession({ kind: 'run', intent: 'easy', date }, week, input);
		expect(easy.kind === 'run' && paceOf(easy.segments[0]!)).toEqual([
			...paceFor('easy', TEN_K_PACES)
		]);
		const hard = buildAddedSession({ kind: 'run', intent: 'hard', date }, week, input);
		expect(
			hard.kind === 'run' && paceOf(hard.segments.find((s) => s.kind === 'interval')!)
		).toEqual([...paceFor('interval', TEN_K_PACES)]);
	});
});

describe('marathon pace on steady segments', () => {
	it('closes every build week’s long run at marathon pace, its share rising', () => {
		const { block, decisions } = marathonBlock('marathon_build');
		expect(block.weeks.length).toBeGreaterThan(3);
		const shares: number[] = [];
		for (const week of block.weeks) {
			const long = longRunOf(week)!;
			expect(
				long.segments.map((s) => s.kind),
				week.startsOn
			).toEqual(['long', 'steady']);
			const [easy, steady] = long.segments;
			expect(paceOf(easy!)).toEqual([...paceFor('long', TEN_K_PACES)]);
			expect(paceOf(steady!)).toEqual([...paceFor('steady', TEN_K_PACES)]);
			expect(steady).toMatchObject({ hrZone: 3, targetRpe: ENDURANCE.marathon_pace.rpe });
			expect(steady!.distanceMetres! % 100, week.startsOn).toBe(0);
			expect(long.instructions).toBe(
				`The last ${steady!.distanceMetres! / 1000} km at marathon pace.`
			);
			shares.push(steadyShareOf(long));
		}
		expect(shares[0]).toBeGreaterThan(0.19);
		expect(shares.at(-1)!).toBeGreaterThan(0.38);
		shares.forEach((share, i) => {
			expect(share).toBeLessThanOrEqual(0.4);
			if (i > 0) expect(share).toBeGreaterThanOrEqual(shares[i - 1]! - 0.01);
		});
		expect(decisions.find((d) => d.kind === 'quality_session')).toMatchObject({
			ruleKey: 'endurance.marathon_pace',
			summary: 'Quality running: marathon pace in the long run and one tempo run a week'
		});
	});

	it('holds the top share in peak, the first in the taper, and none in the race week', () => {
		for (const week of marathonBlock('marathon_peak').block.weeks) {
			expect(steadyShareOf(longRunOf(week)!), week.startsOn).toBeCloseTo(0.4, 1);
		}
		const taper = marathonBlock('marathon_taper').block;
		for (const week of taper.weeks.filter((w) => w.kind !== 'event')) {
			expect(steadyShareOf(longRunOf(week)!), week.startsOn).toBeCloseTo(0.2, 1);
		}
		const race = taper.weeks.find((w) => w.kind === 'event')!;
		for (const run of runsIn(race)) {
			expect(run.segments.map((s) => s.kind)).not.toContain('steady');
		}
	});

	it('gives a first program no marathon-pace work', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.runnerLifter()), OPTIONS);
		const segments = plan.blocks.flatMap((b) => b.weeks.flatMap(runsIn)).flatMap((r) => r.segments);
		expect(segments.map((s) => s.kind)).not.toContain('steady');
		expect(decisionOf(plan, 'quality_session')).toMatchObject({ ruleKey: 'running.tempo_run' });
	});
});
