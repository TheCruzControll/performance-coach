/**
 * The next block (M6): M3's first block for a scenario is the reviewed block, the cycle review's
 * directives and the results overlay (next-block/input.ts) feed generateNextBlock, and the block it
 * plans is checked against M3's own load rules, the dates and the decisions that explain it.
 */
import { describe, expect, it } from 'vitest';
import type { Exposure } from '../../analytics/prescribed';
import { addDays, weekdayOf } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { BASELINE_INSTRUCTION } from '../../training/describe';
import type {
	BaselineLift,
	BlockPlan,
	PlannedExercisePlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../../training/types';
import { MOVEMENT_PATTERN_LABEL } from '../../training/vocabulary';
import { cleanFloat } from '../../units';
import { alternativesFor } from '../alternatives';
import { isEligible } from '../eligibility';
import { generateProgram } from '../generate';
import { buildProgrammingInput, toExerciseKey } from '../input';
import { checkWeek } from '../interference';
import { baselineShare } from '../loads';
import { decideFromResults } from '../results';
import { SCENARIO_START, SCENARIOS, scenarioDay } from '../scenarios';
import type { ScenarioKey } from '../scenarios';
import type { CycleDirectives } from '../review/directives';
import { fnv1a64, GENERATOR_ID as M3_GENERATOR_ID } from '../random';
import { exerciseOf } from '../selection';
import { estimateMinutes } from '../timefit';
import { nextBlockDates } from './dates';
import type { NextBlockStart } from './dates';
import { generateNextBlock, GENERATOR_ID, nextStages, SIGNIFICANT } from './generate';
import type { NextBlockOptions } from './generate';
import { nextBlockInput } from './input';
import type { ResultsSnapshot } from './input';

const LINEAGE = '5b3c3d0e-8f5a-4a43-9a9c-2f0f6a1c0b01';
/** The Monday after M3's 5-week first block. */
const ON_TIME = scenarioDay(6, 0);

const strengthIn = (sessions: readonly SessionPlan[]) =>
	sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength');
const keyOf = (e: PlannedExercisePlan) => toExerciseKey(e.exercise);
const keysIn = (block: BlockPlan) =>
	new Set(
		block.weeks.flatMap((w) => strengthIn(w.sessions).flatMap((s) => s.exercises.map(keyOf)))
	);
/** The top set of `key` in `week`'s first session holding it as a main lift. */
const topIn = (week: WeekPlan, key: string) =>
	strengthIn(week.sessions)
		.flatMap((s) => s.exercises.filter((e) => keyOf(e) === key))
		.flatMap((e) => e.sets.filter((l) => l.role === 'top'))[0];
const runMetres = (week: WeekPlan) =>
	week.sessions.reduce(
		(n, s) => (s.kind === 'run' ? s.segments.reduce((m, g) => m + (g.distanceMetres ?? 0), n) : n),
		0
	);

const exposure = (day: string, deviation: number, more: Partial<Exposure> = {}): Exposure => ({
	day,
	lineage: LINEAGE,
	exerciseId: 'x',
	substituted: false,
	sets: { prescribed: 4, completed: 4, extra: 0 },
	missedReps: 0,
	rpeDeviations: [deviation],
	rpeTargets: [8],
	meanRpeDeviation: deviation,
	topSet: null,
	kg: 100,
	hit: true,
	...more
});
/** Three sessions a full RPE easier than prescribed: consistently below target. */
const EASY = [
	exposure(scenarioDay(3, 0), -1),
	exposure(scenarioDay(4, 0), -1),
	exposure(scenarioDay(5, 0), -1)
];

interface Case {
	key: ScenarioKey;
	change?: (p: TrainingProfile) => void;
	/** A change to today's profile only, after the reviewed block. */
	later?: (p: TrainingProfile) => void;
	snapshot?: Partial<ResultsSnapshot>;
	directives?: Partial<CycleDirectives>;
	results?: NextBlockOptions['previous']['results'];
	today?: string;
	start?: NextBlockStart;
}

/** M3's first block for the scenario, reviewed and followed by the next block. */
function scenario(c: Case) {
	const profile = SCENARIOS[c.key]();
	c.change?.(profile);
	const base = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const first = generateProgram(base, {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	const previous = first.blocks[0]!;
	const outline = first.blocks[1] ?? null;
	const events = profile.goals.flatMap((g) => (g.eventDate ? [g.eventDate] : []));
	c.later?.(profile);
	const current = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const directives: CycleDirectives = {
		fromBlockLineage: LINEAGE,
		phase: outline?.phase ?? previous.phase,
		weeks: 4,
		fromOutline: outline !== null,
		keep: [],
		rotate: [],
		volume: [],
		rpe: [7, 8.5],
		deload: 'none',
		running: null,
		avoidDays: [],
		progression: 'progress',
		...c.directives
	};
	const dates = nextBlockDates({
		blocks: first.blocks,
		reviewedBlock: 0,
		today: c.today ?? ON_TIME,
		start: c.start ?? 'this_week',
		events,
		weeks: directives.weeks
	});
	const snapshot: ResultsSnapshot = {
		timeZone: 'UTC',
		e1rms: [],
		maxes: [],
		running: null,
		...c.snapshot
	};
	const next = nextBlockInput(current, snapshot, directives);
	const options: NextBlockOptions = {
		dates,
		outline,
		previous: { block: previous, results: c.results ?? [], unit: 'kg' },
		directives
	};
	return { next, options, previous, dates, result: generateNextBlock(next, options) };
}

const e1rm = (lift: BaselineLift, value: number, on = scenarioDay(5, 2)) => ({
	lift,
	point: { value, on }
});

describe('the stage list', () => {
	it('is M3’s with blocks replaced by nextShape, carryover once the strength days are filled and results after progression', () => {
		const { next, options } = scenario({ key: 'beginner' });
		expect(nextStages(next, options).map((s) => s.name)).toEqual([
			'demand',
			'nextShape',
			'commitments',
			'strength',
			'running',
			'other',
			'placement',
			'phasing',
			'volume',
			'carryover',
			'loads',
			'progression',
			'results',
			'timefit',
			'schedule'
		]);
	});

	it('inherits M7’s stages by name: phasing before volume, and schedule last', () => {
		const { next, options } = scenario({ key: 'hybrid' });
		const names = nextStages(next, options).map((s) => s.name);
		expect(names.indexOf('phasing')).toBeGreaterThan(names.indexOf('placement'));
		expect(names.indexOf('phasing')).toBeLessThan(names.indexOf('volume'));
		expect(names.at(-1)).toBe('schedule');
	});

	it('stores an id that carries M3’s GENERATOR_ID, so an M3 or M7 bump changes the fingerprint', () => {
		expect(GENERATOR_ID).toBe(`next-block/2+${M3_GENERATOR_ID}`);
		expect(GENERATOR_ID).toBe('next-block/2+perfo-programming/6');
	});
});

describe('the season through prepare (generator-season)', () => {
	it('records a maintenance_dose for each stream the season caps in the block', () => {
		const { result } = scenario({ key: 'hybrid' });
		const doses = result.decisions.filter((d) => d.kind === 'maintenance_dose');
		expect(doses.length).toBeGreaterThan(0);
		for (const d of doses) expect(d.evidence).toMatchObject({ mode: 'maintenance' });
	});

	it('resolves the priorities over the block it plans, not a fresh season’s first block', () => {
		for (const key of ['beginner', 'powerlifter', 'hybrid'] as const) {
			const { result } = scenario({ key });
			const resolved = result.decisions.filter((d) => d.kind === 'priority_resolved');
			expect(resolved.length, key).toBeGreaterThan(0);
			expect(resolved.at(-1)!.evidence.until, key).toBe(result.block.endsOn);
		}
	});
});

describe('scenarios', () => {
	it('a beginner who progressed: loads from the e1RM, basis estimated, conservative', () => {
		const { result } = scenario({
			key: 'beginner',
			snapshot: { e1rms: [e1rm('back_squat', 100), e1rm('bench_press', 70), e1rm('deadlift', 120)] }
		});
		const week = result.block.weeks[0]!;
		for (const [lift, kg] of [
			['back_squat', 100],
			['bench_press', 70],
			['deadlift', 120]
		] as const) {
			const top = topIn(week, lift)!;
			expect(top).toMatchObject({
				loadKind: 'percent_1rm',
				loadBasis: 'estimated',
				reference1rm: kg
			});
			const reps = top.repsMax ?? top.repsMin!;
			// An estimate starts a step under what a measured 1RM would.
			expect(top.loadValue!).toBeLessThan(baselineShare(reps, week.targets.rpeCap, 'measured')!);
		}
		expect(result.decisions.filter((d) => d.kind === 'load_basis').map((d) => d.ruleKey)).toEqual(
			expect.arrayContaining(['loads.estimated'])
		);
	});

	it('a 140 kg squat e1RM: week 1’s loads are M3’s estimated-basis loads from 140, rounded', () => {
		const { result } = scenario({
			key: 'beginner',
			snapshot: { e1rms: [e1rm('back_squat', 140)] }
		});
		const week = result.block.weeks[0]!;
		const top = topIn(week, 'back_squat')!;
		const share = baselineShare(top.repsMax ?? top.repsMin!, week.targets.rpeCap, 'estimated')!;
		expect(top.loadValue).toBe(share);
		expect(top.reference1rm).toBe(140);
		expect(top.loadValue! * 140).toBeCloseTo(share * 140, 6);
	});

	it('a newer measured bench 1RM: percent_1rm on it, basis measured', () => {
		const { result } = scenario({
			key: 'powerlifter',
			snapshot: {
				e1rms: [e1rm('bench_press', 118, scenarioDay(4, 1))],
				maxes: [{ lift: 'bench_press', kind: 'measured', kg: 120, on: scenarioDay(5, 3) }]
			}
		});
		const top = topIn(result.block.weeks[0]!, 'bench_press')!;
		expect(top).toMatchObject({
			loadKind: 'percent_1rm',
			loadBasis: 'measured',
			reference1rm: 120
		});
	});

	it('no estimate: the main lifts stay RPE-based with the recording instruction', () => {
		const { result } = scenario({ key: 'beginner' });
		const lift = strengthIn(result.block.weeks[0]!.sessions)[0]!.exercises.find((e) =>
			e.sets.some((l) => l.role === 'top')
		)!;
		expect(lift.instructions).toBe(BASELINE_INSTRUCTION);
		expect(lift.sets.find((l) => l.role === 'top')!.loadKind).toBe('rpe_based');
	});

	it('results move a lift’s start: three easy sessions put the squat up in every week, explained and significant', () => {
		const c: Case = { key: 'beginner', snapshot: { e1rms: [e1rm('back_squat', 50)] } };
		const flat = scenario(c).result.block.weeks;
		const { result } = scenario({
			...c,
			results: [{ exercise: 'back_squat', exposures: EASY, trend: null }]
		});
		const top = topIn(flat[0]!, 'back_squat')!;
		const outcome = decideFromResults(
			EASY,
			{ name: 'Back squat', line: top, loadType: 'external', pattern: 'squat' },
			null,
			{ unit: 'kg', e1rmKg: 50, rpeCap: flat[0]!.targets.rpeCap }
		);
		expect(outcome.action).toBe('add_load');
		expect(outcome.pct!).toBeGreaterThanOrEqual(SIGNIFICANT.loadPct);
		result.block.weeks.forEach((week, w) => {
			const [before, after] = [topIn(flat[w]!, 'back_squat')!, topIn(week, 'back_squat')!];
			expect(after.loadValue!).toBeGreaterThan(before.loadValue!);
		});
		expect(topIn(result.block.weeks[0]!, 'back_squat')!.loadValue).toBe(outcome.to);
		const d = result.decisions.find(
			(x) => x.kind === 'results_progression' && x.evidence.exercise === 'Back squat'
		)!;
		expect(d.ruleKey).toBe(outcome.ruleKey);
		expect(d.summary).toBe(`Back squat: +${cleanFloat(outcome.pct!, 1)} % on its starting load`);
		expect(d.why).toBe(outcome.why);
		const change = result.significantChanges.find((x) => x.kind === 'load')!;
		expect(change).toMatchObject({ subject: 'Back squat', to: outcome.pct });
		expect(result.decisions[change.decision]).toEqual(d);
	});

	it.each([
		['bench_press', 'Bench press', 87],
		['back_squat', 'Back squat', 140]
	] as const)(
		'an off-step %s e1RM: the decision states the load change week 1 really gets',
		(lift, name, kg) => {
			const c: Case = { key: 'beginner', snapshot: { e1rms: [e1rm(lift, kg)] } };
			const flat = scenario(c).result.block.weeks[0]!;
			const { result } = scenario({
				...c,
				results: [{ exercise: lift, exposures: EASY, trend: null }]
			});
			const [before, after] = [
				topIn(flat, lift)!.loadValue!,
				topIn(result.block.weeks[0]!, lift)!.loadValue!
			];
			const pct = cleanFloat((after / before - 1) * 100, 2);
			const d = result.decisions.find(
				(x) => x.kind === 'results_progression' && x.evidence.exercise === name
			)!;
			expect(d.evidence.pct).toBe(pct);
			expect(d.summary).toBe(
				pct === 0 ? `${name}: holds` : `${name}: +${cleanFloat(pct, 1)} % on its starting load`
			);
		}
	);

	it('a plateaued intermediate: the stalled accessory rotates to its top alternative, and volume rises', () => {
		const flat = scenario({ key: 'injuredShoulder' });
		const accessory = [...keysIn(flat.previous)].find((key) =>
			flat.previous.weeks[0]!.sessions.some(
				(s) =>
					s.kind === 'strength' &&
					s.exercises.some((e) => keyOf(e) === key && !e.sets.some((l) => l.role === 'top'))
			)
		)!;
		const { result, next } = scenario({
			key: 'injuredShoulder',
			directives: {
				rotate: [{ exercise: accessory, reason: 'Stalled over 4 sessions: a fresh stimulus' }],
				volume: [{ group: 'quads', change: 0.1, reason: 'Under its range this block' }]
			}
		});
		const best = alternativesFor(accessory, next.input).alternatives[0]!.key;
		expect(keysIn(result.block).has(accessory)).toBe(false);
		expect(keysIn(result.block).has(best)).toBe(true);
		const rotated = result.decisions.find((d) => d.kind === 'exercise_rotated')!;
		expect(rotated.evidence).toMatchObject({
			previous: exerciseOf(next.input, accessory)!.name,
			exercise: exerciseOf(next.input, best)!.name
		});
		expect(result.significantChanges.some((c) => c.kind === 'swap')).toBe(true);
		// The owner's part scales each building week's volume by 1.1: the block fills the season's
		// two-week accumulation outline, M3's 1, 1 (generator-season; M3's road had no outline here).
		expect(next.subset.targets.volumeFactor).toBe(1.1);
		expect(result.block.weeks.map((w) => w.targets.volumeFactor)).toEqual([1.1, 1.1]);
	});

	it('a fatigued hybrid athlete: week 1 is a deload, scheduled and explained', () => {
		const { result } = scenario({
			key: 'hybrid',
			directives: { deload: 'first', progression: 'hold', rpe: [6, 8] }
		});
		const [first, ...rest] = result.block.weeks;
		expect(first!.kind).toBe('deload');
		expect(first!.targets).toMatchObject({ rpeCap: 6, volumeFactor: 0.6 });
		expect(rest.every((w) => w.kind !== 'deload')).toBe(true);
		const d = result.decisions.find((x) => x.kind === 'deload_scheduled')!;
		expect(d.summary).toBe('Deload in week 1');
		expect(d.refs).toEqual(['blocks.0.weeks.0']);
		expect(result.significantChanges.find((c) => c.kind === 'deload')).toMatchObject({ to: 1 });
	});

	it('a marathon outline: the build starts from the actual mileage, at most 10 % over it', () => {
		const weeks = [30, 32, 34].map((km, i) => ({
			weekStart: scenarioDay(3 + i, 0),
			metres: km * 1000
		}));
		const told = scenario({ key: 'hybrid' }).result.block;
		const { result, options } = scenario({
			key: 'hybrid',
			snapshot: { running: { weeks, longRuns: [], paces: [], efforts: [] } }
		});
		expect(options.outline?.phase).toBe('marathon_build');
		expect(result.block.phase).toBe('marathon_build');
		const metres = result.block.weeks.map(runMetres);
		// Week 1 runs from the last three weeks' mean (32 km), not the profile's 30 km.
		expect(metres[0]).toBeGreaterThan(runMetres(told.weeks[0]!));
		expect(metres[0]).toBeLessThanOrEqual(32_000 * 1.1);
		expect(result.block.weeks.every((w) => w.targets.runVolumeFactor <= 1.3)).toBe(true);
	});

	it('low adherence: nothing increases, though the sessions were easy', () => {
		const { result } = scenario({
			key: 'beginner',
			snapshot: { e1rms: [e1rm('back_squat', 140)] },
			directives: { progression: 'hold' },
			results: [{ exercise: 'back_squat', exposures: EASY, trend: null }]
		});
		const weeks = result.block.weeks;
		expect(weeks.every((w) => w.targets.loadStep === 0 && w.targets.volumeFactor <= 1)).toBe(true);
		expect(new Set(weeks.map((w) => w.targets.rpeCap)).size).toBe(1);
		const shares = weeks.map((w) => topIn(w, 'back_squat')!.loadValue);
		const start = baselineShare(5, weeks[0]!.targets.rpeCap, 'estimated');
		expect(shares.every((s) => s === shares[0])).toBe(true);
		expect(shares[0]).toBeLessThanOrEqual(start ?? shares[0]!);
		const d = result.decisions.find((x) => x.kind === 'results_progression')!;
		expect(d.summary).toBe('Back squat: holds');
		expect(d.why).toContain('This block adds no load');
		expect(result.significantChanges.some((c) => c.kind === 'load')).toBe(false);
	});

	it('a 3-week-late review: a bridge, then the block on the shifted dates, the bridge a significant change', () => {
		const today = addDays(ON_TIME, 21);
		const { result, dates } = scenario({ key: 'beginner', today });
		expect(result.bridge).toMatchObject({
			phase: 'transition',
			startsOn: ON_TIME,
			endsOn: addDays(today, -1),
			outline: false
		});
		expect(result.bridge!.weeks.map((w) => [w.kind, w.sessions.length])).toEqual([
			['unplanned', 0],
			['unplanned', 0],
			['unplanned', 0]
		]);
		expect(result.block.startsOn).toBe(today);
		expect(result.block.startsOn).toBe(dates.block.startsOn);
		const bridge = result.significantChanges.find((c) => c.kind === 'bridge')!;
		expect(bridge.to).toBe(3);
		const planned = result.decisions[bridge.decision]!;
		expect(planned.kind).toBe('next_block_planned');
		expect(planned.why).toContain('The 3 weeks since your last block are left unplanned');
	});

	it('a Wednesday ‘this week’ start: no session on that Monday or Tuesday', () => {
		const wednesday = addDays(ON_TIME, 9);
		const { result } = scenario({ key: 'hybrid', today: wednesday });
		const week = result.block.weeks[0]!;
		expect(week.startsOn).toBe(addDays(ON_TIME, 7));
		expect(week.sessions.length).toBeGreaterThan(0);
		expect(week.sessions.every((s) => s.date >= wednesday)).toBe(true);
		expect(week.sessions.some((s) => ['mon', 'tue'].includes(weekdayOf(s.date)))).toBe(false);
	});
});

describe('structure', () => {
	const kept = () => {
		const flat = scenario({ key: 'powerlifter' });
		const keep = [...keysIn(flat.previous)].map((exercise) => ({
			exercise,
			reason: 'Progressed over 4 sessions'
		}));
		return { flat, ...scenario({ key: 'powerlifter', directives: { keep } }) };
	};

	it('takes the dates as given, keeps the kept exercises in their slots, and rotates only to eligible ones', () => {
		const { result, dates, previous, next } = kept();
		expect([result.block.startsOn, result.block.endsOn]).toEqual([
			dates.block.startsOn,
			dates.block.endsOn
		]);
		expect(result.block.weeks).toHaveLength(dates.block.weeks);
		for (const key of keysIn(previous)) expect(keysIn(result.block).has(key)).toBe(true);
		const keptDecisions = result.decisions.filter((d) => d.kind === 'exercise_kept');
		expect(keptDecisions.length).toBeGreaterThan(0);
		for (const d of keptDecisions) {
			// Each sits in its slot: the ref names the kept exercise, of the slot's pattern.
			const [, w, s, e] = /weeks\.(\d+)\.sessions\.(\d+)\.exercises\.(\d+)/
				.exec(d.refs[0]!)!
				.map(Number);
			const session = result.block.weeks[w!]!.sessions[s!] as StrengthSessionPlan;
			const exercise = exerciseOf(next.input, keyOf(session.exercises[e!]!))!;
			expect(exercise.name).toBe(d.evidence.exercise);
			expect(d.evidence.slot).toBe(MOVEMENT_PATTERN_LABEL[exercise.pattern].toLowerCase());
		}
		for (const key of keysIn(result.block))
			expect(isEligible(exerciseOf(next.input, key)!, next.input).ok).toBe(true);
	});

	it.each([
		['beginner', 'split_squat'],
		['powerlifter', 'barbell_row'],
		['powerlifter', 'bird_dog']
	] as [ScenarioKey, string][])(
		'%s keeping all but %s and rotating it: every kept exercise stays, the rotation is explained',
		(key, rotated) => {
			const flat = scenario({ key });
			const keep = [...keysIn(flat.previous)]
				.filter((exercise) => exercise !== rotated)
				.map((exercise) => ({ exercise, reason: 'Progressed over 4 sessions' }));
			const rotate = [{ exercise: rotated, reason: 'Stalled' }];
			const { result, next } = scenario({ key, directives: { keep, rotate } });
			const now = keysIn(result.block);
			for (const { exercise } of keep)
				if (isEligible(exerciseOf(next.input, exercise)!, next.input).ok)
					expect(now.has(exercise), exercise).toBe(true);
			expect(now.has(rotated)).toBe(false);
			const d = result.decisions.find((x) => x.kind === 'exercise_rotated')!;
			expect(d.evidence.previous).toBe(exerciseOf(next.input, rotated)!.name);
			// The ref is the slot it fills, never a main lift elsewhere.
			const [, w, s, e] = /weeks\.(\d+)\.sessions\.(\d+)\.exercises\.(\d+)/
				.exec(d.refs[0]!)!
				.map(Number);
			const at = (result.block.weeks[w!]!.sessions[s!] as StrengthSessionPlan).exercises[e!]!;
			expect(exerciseOf(next.input, keyOf(at))!.name).toBe(d.evidence.exercise);
			expect(at.sets.some((l) => l.role === 'top')).toBe(false);
			const swap = result.significantChanges.find((x) => x.kind === 'swap')!;
			expect(result.decisions[swap.decision]).toEqual(d);
		}
	);

	it('a liked, stalled accessory is kept, not rotated', () => {
		const rotated = 'split_squat';
		const name = CATALOGUE.find((e) => e.key === rotated)!.name;
		const { result, next } = scenario({
			key: 'beginner',
			later: (p) =>
				p.exercises.push({ id: 'liked', exercise: name, sentiment: 'like', reason: null }),
			directives: { rotate: [{ exercise: rotated, reason: 'Stalled' }] }
		});
		expect(next.input.likes).toContain(rotated);
		expect(keysIn(result.block).has(rotated)).toBe(true);
		expect(result.decisions.some((d) => d.kind === 'exercise_rotated')).toBe(false);
		expect(result.significantChanges.some((c) => c.kind === 'swap')).toBe(false);
	});

	it.each(['beginner', 'powerlifter', 'hybrid', 'injuredShoulder', 'journey'] as ScenarioKey[])(
		'%s: sessions fit the session length, commitments are placed and interference is respected',
		(key) => {
			const { result, next } = scenario({ key });
			for (const week of result.block.weeks) {
				for (const s of strengthIn(week.sessions)) {
					expect(s.estMinutes).toBe(estimateMinutes(s, next.input));
					expect(s.estMinutes).toBeLessThanOrEqual(next.input.sessionMinutes);
				}
				const commitments = next.input.commitments.flatMap((c) =>
					c.days.map((d) => [c, d] as const)
				);
				const placed = week.sessions.filter((s) => s.source === 'commitment');
				expect(placed).toHaveLength(commitments.length);
			}
			const paths = new Map<SessionPlan, string>();
			result.block.weeks.forEach((w, wi) =>
				w.sessions.forEach((s, si) => paths.set(s, `blocks.0.weeks.${wi}.sessions.${si}`))
			);
			const cited = new Set(
				result.decisions.filter((d) => d.kind === 'priority_tradeoff').flatMap((d) => d.refs)
			);
			const avoid = checkWeek(result.block.weeks.flatMap((w) => w.sessions)).filter(
				(v) => v.severity === 'avoid' && !v.sessions.some((s) => cited.has(paths.get(s)!))
			);
			expect(avoid.map((v) => v.message)).toEqual([]);
		}
	);

	it('is deterministic byte for byte, whatever the order of the results', () => {
		const results = [
			{ exercise: 'back_squat', exposures: EASY, trend: null },
			{ exercise: 'bench_press', exposures: EASY, trend: null }
		];
		const c: Case = { key: 'hybrid', results, directives: { deload: 'last' } };
		const a = scenario(c).result;
		const b = scenario({ ...c, results: [...results].reverse() }).result;
		expect(JSON.stringify(b)).toBe(JSON.stringify(a));
		expect(scenario(c).result.fingerprint).toBe(a.fingerprint);
		expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(scenario({ ...c, directives: { deload: 'first' } }).result.fingerprint).not.toBe(
			a.fingerprint
		);
	});

	it('gives every significant change a decision that explains it', () => {
		const kinds = {
			swap: 'exercise_rotated',
			load: 'results_progression',
			hard_sets: 'results_progression',
			run_volume: 'run_volume',
			phase: 'next_block_planned',
			deload: 'deload_scheduled',
			bridge: 'next_block_planned'
		};
		const seen = new Set<string>();
		for (const c of [
			{ key: 'hybrid', directives: { deload: 'first' }, today: addDays(ON_TIME, 14) },
			{
				key: 'beginner',
				snapshot: { e1rms: [e1rm('back_squat', 50)] },
				results: [{ exercise: 'back_squat', exposures: EASY, trend: null }]
			},
			{
				key: 'powerlifter',
				directives: { rotate: [{ exercise: 'sissy_squat', reason: 'Stalled' }] }
			},
			{ key: 'beginner', later: (p) => void (p.schedule.daysPerWeek = 5) },
			{
				key: 'hybrid',
				snapshot: {
					running: {
						weeks: [45, 46, 47].map((km, i) => ({
							weekStart: scenarioDay(3 + i, 0),
							metres: km * 1000
						})),
						longRuns: [],
						paces: [],
						efforts: []
					}
				}
			}
		] as Case[]) {
			const { result } = scenario(c);
			for (const change of result.significantChanges) {
				seen.add(change.kind);
				expect(result.decisions[change.decision]?.kind).toBe(kinds[change.kind]);
			}
		}
		expect([...seen].sort()).toEqual(Object.keys(kinds).sort());
		expect(SIGNIFICANT).toEqual({ loadPct: 5, hardSets: 2, runVolume: 0.1 });
	});
});

/**
 * The next block, its bridge, decisions and significant changes as JSON, hashed after
 * generator-season made prepare plan the season (its priorities, order, modes and doses). Only the
 * fingerprint may change with a stage list or GENERATOR_ID change; these bytes change only with a
 * plan change, and the PR that changes them lists each.
 */
const GOLDEN_CASES: [string, Case, string][] = [
	['a beginner on time', { key: 'beginner' }, '8594230b9f4e2914'],
	[
		'a powerlifter from next Monday',
		{ key: 'powerlifter', start: 'next_monday' },
		'402b6dddf4e0f811'
	],
	[
		'a hybrid with results and a last-week deload',
		{
			key: 'hybrid',
			results: [
				{ exercise: 'back_squat', exposures: EASY, trend: null },
				{ exercise: 'bench_press', exposures: EASY, trend: null }
			],
			directives: { deload: 'last' }
		},
		// generator-phasing: hybrid's secondary strength is held to the lower half of its band;
		// generator-running: its paces come from its VDOT.
		'80e105b9e0edcf71'
	],
	[
		'the journey two weeks late',
		{ key: 'journey', today: addDays(ON_TIME, 14) },
		// generator-running: its paces come from its VDOT; generator-combat: its fight camp's sessions.
		'ee0c6d1ed53ace3b'
	]
];

describe('byte-identical blocks', () => {
	it.each(GOLDEN_CASES)('%s: the block is byte for byte the one from before', (_, c, hash) => {
		const { fingerprint: _fingerprint, ...block } = scenario(c).result;
		expect(fnv1a64(JSON.stringify(block))).toBe(hash);
	});
});
