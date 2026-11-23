/**
 * generator-running, paces (m7r/07): runs are paced from current fitness. Paces come from the best
 * recent race's VDOT by Daniels' formula (an undated race at low confidence when no race has a
 * date), else the told easy pace's, each segment at its kind's training pace. In a marathon week
 * planned with its targets the long run closes at marathon pace, a steady segment at M pace whose
 * share rises over the build.
 *
 * generator-running, race plans (m7r/08): a marathon or half week planned with its targets takes
 * its long run at the planned length, at most 1.5 km over the longest planned before it, none in
 * the race week, and its phase's race work up to its hooks' quality sessions; a cutback week holds
 * at most 80 % of the biggest week; a running goal that does not lead holds its dose.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type { BlockPlan, ProgramPlan, RunSessionPlan, WeekPlan } from '../training/types';
import type { Phase } from '../training/vocabulary';
import { buildAddedSession } from './added';
import { DecisionLog } from './decisions';
import { firstDraft, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { paceFor, trainingPaces, vdotFromEasyPace, vdotFromPerformance } from './paces';
import { deloadSessions } from './periodisation/deload';
import { enduranceWeeks } from './periodisation/endurance';
import { M7_SCENARIOS, m7Day } from './periodisation/scenarios';
import { taperSessions, taperWeeks } from './periodisation/taper';
import { ENDURANCE, HALF_HOOKS } from './rules/endurance';
import { TARGETS } from './rules/deload';
import { MAINTENANCE_BLOCK } from './rules/maintenance';
import { MARATHON_HOOKS } from './rules/running';
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
/** A run's metres, a timed quality session's at runnerLifter's told easy pace (5:30 /km). */
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

/** runnerLifter with its marathon a half marathon instead, and `longestKm` as its longest run. */
function halfRunner(longestKm = 26) {
	const profile = M7_SCENARIOS.runnerLifter();
	Object.assign(profile.goals[0]!, { title: 'Half marathon', eventType: 'Half marathon' });
	profile.running!.longestRun = longestKm;
	return profile;
}

/** The running stage over `block` for `profile`, after the stages before it, as generate runs them. */
function runningOver(profile: TrainingProfile, options: GenerateOptions, block: BlockPlan) {
	const log = new DecisionLog();
	const prepared = prepare(inputOf(profile), options, log);
	const context: StageContext = { input: prepared.input, options, log };
	let draft: Draft = firstDraft(prepared);
	for (const stage of STAGES.slice(0, STAGES.findIndex((s) => s.name === 'commitments') + 1)) {
		draft = stage.run(draft, context);
	}
	const own = new DecisionLog();
	const after = running({ ...draft, blocks: [block] }, { ...context, log: own });
	return { block: after.blocks[0]!, decisions: own.list() };
}

/**
 * `race`'s `phase` weeks as periodisation/endurance.ts plans them from week 1 (55 km a week, its
 * longest run `longestKm`), run through the running stage as the first block.
 */
function enduranceBlock(
	race: 'marathon' | 'half',
	phase: Phase,
	longestKm = 26,
	startsOn = SCENARIO_START
) {
	const profile = race === 'marathon' ? M7_SCENARIOS.runnerLifter() : halfRunner(longestKm);
	profile.running!.longestRun = longestKm;
	const weeks = enduranceWeeks(race, {
		startsOn,
		raceOn: profile.goals[0]!.eventDate!,
		startVolume: 55_000,
		longestRun: longestKm * 1000,
		level: null,
		paces: TEN_K_PACES
	}).filter((w) => w.phase === phase);
	const first = weeks[0]!.startsOn;
	const block: BlockPlan = {
		phase,
		name: phase,
		startsOn: first,
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
	return runningOver(profile, optionsOn(first), block);
}

const marathonBlock = (phase: Phase, longestKm = 26) =>
	enduranceBlock('marathon', phase, longestKm);
/** A half's weeks start in scenario week 9, so the runway to race day is one a half's plan fits. */
const halfBlock = (phase: Phase, longestKm = 26) =>
	enduranceBlock('half', phase, longestKm, m7Day(9, 0));

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

	it('does not throw on a 5K in 4:00:00: the told easy pace sets the paces', () => {
		const profile = lifterWith((races) => [
			{
				...races[0]!,
				distance: '5k' as const,
				distanceMetres: 5000,
				timeSeconds: 4 * 60 * 60,
				racedOn: '2026-11-01'
			}
		]);
		const plan = generateProgram(inputOf(profile), OPTIONS);
		expect(decisionOf(plan, 'run_pace_source').ruleKey).toBe('running.paces_from_told');
		const easy = plan.blocks[0]!.weeks.flatMap(runsIn).find((r) => r.type === 'easy_run')!;
		expect(paceOf(easy.segments[0]!)).toEqual([
			...paceFor('easy', trainingPaces(vdotFromEasyPace(330)))
		]);
	});

	it('paces from an older good race when the only race in the 26 weeks is too slow to pace', () => {
		const profile = lifterWith((races) => [
			{
				...races[0]!,
				distance: '5k' as const,
				distanceMetres: 5000,
				timeSeconds: 4 * 60 * 60,
				racedOn: '2026-11-01'
			},
			{ ...races[0]!, racedOn: '2026-03-01' }
		]);
		const plan = generateProgram(inputOf(profile), OPTIONS);
		expect(decisionOf(plan, 'run_pace_source')).toMatchObject({
			ruleKey: 'paces.vdot',
			why: expect.stringContaining(`by Daniels’ formula${ROUGH_GUIDE.old}.`)
		});
		const easy = plan.blocks[0]!.weeks.flatMap(runsIn).find((r) => r.type === 'easy_run')!;
		expect(paceOf(easy.segments[0]!)).toEqual([...paceFor('easy', TEN_K_PACES)]);
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
			ruleKey: 'endurance.race_work',
			summary: 'Quality running: marathon pace in the long run and a threshold run'
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

	it('drops the marathon-pace words when a deload eases the steady segment or a taper cuts it', () => {
		const peak = marathonBlock('marathon_peak').block.weeks[0]!;
		const long = longRunOf(peak)!;
		const eased = deloadSessions(peak, TARGETS, () => true).find(
			(s): s is RunSessionPlan => s.kind === 'run' && s.date === long.date
		)!;
		expect(eased.segments.map((s) => s.kind)).toEqual(['long', 'easy']);
		expect(eased.instructions).toBeNull();

		const taper = marathonBlock('marathon_taper').block;
		const raceOn = M7_SCENARIOS.runnerLifter().goals[0]!.eventDate!;
		const first = longRunOf(taper.weeks[0]!)!;
		const cut = taperSessions(
			taper.weeks,
			taperWeeks('marathon', 'primary', raceOn)
		)[0]!.sessions.find((s): s is RunSessionPlan => s.kind === 'run' && s.date === first.date)!;
		const steadyOf = (run: RunSessionPlan) =>
			run.segments.find((s) => s.kind === 'steady')!.distanceMetres!;
		expect(steadyOf(cut)).toBeLessThan(steadyOf(first));
		expect(cut.instructions).toBeNull();
	});

	it('gives a first program no marathon-pace work', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.runnerLifter()), OPTIONS);
		const segments = plan.blocks.flatMap((b) => b.weeks.flatMap(runsIn)).flatMap((r) => r.segments);
		expect(segments.map((s) => s.kind)).not.toContain('steady');
		expect(decisionOf(plan, 'quality_session')).toMatchObject({ ruleKey: 'running.tempo_run' });
	});
});

/** Every long run within the race plan's caps: its target, the event's cap, 1.5 km over the last. */
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
		expect(decisionOf(half, 'run_volume')).toMatchObject({
			ruleKey: 'generator.block_runs',
			why: expect.stringContaining(
				'Each week follows your race plan: the long run grows at most 1.5 km a week, and every 4th week of base and build is a cutback to 80 % of the biggest.'
			)
		});
	});

	it('lets a marathon peak’s long run take more than 30 % of a week, within its target', () => {
		const { block } = marathonBlock('marathon_peak');
		const week = block.weeks.find((w) => {
			const long = longRunOf(w);
			return long !== undefined && metresOf(long) > 0.3 * weekMetres(w);
		});
		expect(week).toBeDefined();
		const target = week!.targets.running!.longRunMetres;
		expect(target).not.toBeNull();
		expect(metresOf(longRunOf(week!)!)).toBeLessThanOrEqual(target!);
	});

	it('leaves the long run out of the race week', () => {
		const { block } = marathonBlock('marathon_taper');
		const race = block.weeks.find((w) => w.kind === 'event')!;
		expect(race.targets.running).toBeDefined();
		expect(runsIn(race).length).toBeGreaterThan(0);
		expect(longRunOf(race)).toBeUndefined();
	});
});

describe('race-specific work', () => {
	it('gives every marathon build week a threshold run beside the marathon-pace long run', () => {
		const { block } = marathonBlock('marathon_build');
		for (const week of block.weeks) {
			const quality = qualityIn(week);
			expect(
				quality.map((r) => r.type),
				week.startsOn
			).toEqual(['tempo_run']);
			const tempo = quality[0]!.segments.find((s) => s.kind === 'tempo')!;
			expect(paceOf(tempo)).toEqual([...paceFor('tempo', TEN_K_PACES)]);
			expect(quality[0]!.instructions).toBe('20 min at threshold pace, between easy running.');
			// The marathon-pace long run is the hooks' second quality session.
			expect(quality.length + 1).toBe(MARATHON_HOOKS.marathon_build!.qualityPerWeek);
		}
	});

	it('holds a marathon taper week to its one quality session: the marathon-pace long run', () => {
		const { block } = marathonBlock('marathon_taper');
		expect(MARATHON_HOOKS.marathon_taper!.qualityPerWeek).toBe(1);
		const tapering = block.weeks.filter((w) => w.kind !== 'event');
		expect(tapering.length).toBeGreaterThan(0);
		for (const week of tapering) {
			expect(qualityIn(week), week.startsOn).toEqual([]);
			expect(longRunOf(week)!.segments.map((s) => s.kind)).toEqual(['long', 'steady']);
		}
		const race = block.weeks.find((w) => w.kind === 'event')!;
		expect(qualityIn(race)).toEqual([]);
	});

	it('gives a half’s build weeks, the cutback too, their 2 quality sessions from HALF_HOOKS', () => {
		const plan = generateProgram(inputOf(halfRunner()), optionsOn(m7Day(9, 0)));
		const block = plan.blocks[0]!;
		expect(block.phase).toBe('half_build');
		expect(block.weeks.map((w) => w.kind)).toContain('cutback');
		const want = HALF_HOOKS.half_build!.qualityPerWeek!;
		expect(want).toBe(2);
		for (const week of block.weeks) {
			const quality = qualityIn(week);
			expect(quality.map((r) => r.type).sort(), week.startsOn).toEqual([
				'interval_run',
				'tempo_run'
			]);
			const intervals = quality.find((r) => r.type === 'interval_run')!;
			// 10K pace: between threshold's fast end and VO2max's slow end.
			expect(paceOf(intervals.segments.find((s) => s.kind === 'interval')!)).toEqual([
				paceFor('interval', TEN_K_PACES)[1],
				paceFor('tempo', TEN_K_PACES)[0]
			]);
			expect(intervals.instructions).toBe('5 × 3 min at 10K pace, with 2-minute jogs.');
			expect(longRunOf(week)!.segments.map((s) => s.kind)).toEqual(['long']);
		}
		expect(decisionOf(plan, 'quality_session')).toMatchObject({
			ruleKey: 'endurance.race_work',
			summary: 'Quality running: a threshold run and 10K-pace intervals'
		});
	});

	it('names a half peak’s main workout first: 10K-pace intervals, then the threshold run', () => {
		const plan = generateProgram(inputOf(halfRunner()), optionsOn(m7Day(13, 0)));
		expect(plan.blocks[0]!.phase).toBe('half_peak');
		expect(decisionOf(plan, 'quality_session').summary).toBe(
			'Quality running: 10K-pace intervals and a threshold run'
		);
	});

	it('stores a half’s own hooks on its outline phases, and sizes a marathon peak with its own', () => {
		const plan = generateProgram(inputOf(halfRunner()), optionsOn(m7Day(9, 0)));
		for (const phase of ['half_peak', 'half_taper'] as const) {
			const outline = plan.blocks.find((b) => b.outline && b.phase === phase)!;
			expect(outline.progression, phase).toEqual(HALF_HOOKS[phase]);
		}
		expect(marathonBlock('marathon_peak').block.progression).toMatchObject(
			MARATHON_HOOKS.marathon_peak!
		);
	});
});

describe('a half taper', () => {
	it('gives every taper week one tempo run, and the race week no long run', () => {
		const { block } = halfBlock('half_taper');
		const race = block.weeks.find((w) => w.kind === 'event');
		expect(race).toBeDefined();
		expect(longRunOf(race!)).toBeUndefined();
		const taper = block.weeks.filter((w) => w.kind !== 'event');
		expect(taper.length).toBeGreaterThan(0);
		for (const week of taper) {
			expect(
				qualityIn(week).map((r) => r.type),
				week.startsOn
			).toEqual(['tempo_run']);
		}
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
		expect(plan.blocks[0]!.phase).toBe('fight_camp');
		expect(weeks.length).toBeGreaterThan(3);
		for (const week of weeks) {
			expect(weekMetres(week), week.startsOn).toBeLessThanOrEqual(dose);
			expect(qualityIn(week).length, week.startsOn).toBeLessThanOrEqual(1);
			expect(metresOf(longRunOf(week)!), week.startsOn).toBeLessThanOrEqual(longest);
		}
		const volume = decisionOf(plan, 'run_volume');
		expect(volume).toMatchObject({
			ruleKey: 'generator.run_dose',
			why: expect.stringContaining('running holds its dose: 65 % of your recent volume')
		});
		// The dose alone explains the volume: no second reason blames the long-run or session caps.
		expect(volume.why).not.toContain('The long run is held to');
	});

	it('keeps M3’s time-based week for a secondary running goal with no volume told (journey)', () => {
		const plan = generateProgram(inputOf(SCENARIOS.journey()), OPTIONS);
		expect(decisionOf(plan, 'priority_resolved').why).toContain('Marathon trains alongside');
		expect(decisionOf(plan, 'run_volume').ruleKey).toBe('running.time_week');
	});

	it('plans a week no bigger than its own runVolumeFactor, when that is below the dose', () => {
		const profile = M7_SCENARIOS.multiGoal();
		const planned = generateProgram(inputOf(profile), OPTIONS).blocks[0]!;
		// Three normal weeks; the middle one asks for 60 % of week 1, under the dose's 65 %.
		const weeks = planned.weeks.slice(0, 3).map((w, i) => ({
			kind: 'accumulation' as const,
			startsOn: w.startsOn,
			endsOn: w.endsOn,
			targets: { ...w.targets, runVolumeFactor: i === 1 ? 0.6 : 1 },
			sessions: []
		}));
		const { block } = runningOver(profile, OPTIONS, { ...planned, weeks });
		const recent = profile.running!.weeklyDistance! * 1000;
		expect(weekMetres(block.weeks[1]!)).toBeLessThanOrEqual(0.6 * recent);
	});

	it('ends a dosed week’s notes on a whole sentence, with a 40-character goal title and a mid-week start', () => {
		const profile = M7_SCENARIOS.multiGoal();
		const title = 'My marathon run alongside the fight camp';
		expect(title).toHaveLength(40);
		Object.assign(profile.goals[1]!, { title });
		// A Saturday start: week 1's runs have too few days left, a sentence that no longer fits.
		const plan = generateProgram(inputOf(profile), {
			startsOn: SCENARIO_START,
			firstPlannedDay: m7Day(1, 5)
		});
		const { why } = decisionOf(plan, 'run_volume');
		expect(why).toContain('doesn’t lead now');
		expect(why).not.toContain('…');
		expect(why.endsWith('.')).toBe(true);
	});
});
