/**
 * The next block from the season (m7-plan next-cycle-periodised): M3's first block for an M7
 * scenario is the reviewed block, directivesFrom asks the season planner for the next one at
 * today's goals, and generateNextBlock plans it through M6's nextShape from the directives'
 * weekPlan. Its block type, modes, deloads and running follow M7's rules, recorded as decisions;
 * M3's own generator is untouched.
 */
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import type { WeekPlan } from '../../training/types';
import { DecisionLog } from '../decisions';
import { generateProgram } from '../generate';
import { buildProgrammingInput } from '../input';
import { M7_SCENARIOS } from '../periodisation/scenarios';
import { canonicalJson, fnv1a64 } from '../random';
import type { CycleGoal } from '../review/cycle';
import { cycleReviewSnapshotSchema } from '../review/cycle-snapshot';
import type { CycleReviewSnapshot } from '../review/cycle-snapshot';
import { directivesFrom } from '../review/directives';
import type { PlannedWeek } from '../review/directives';
import { SCENARIO_START } from '../scenarios';
import { plannedWeeks } from '../stages/next-shape';
import { prepare } from '../stages/prepare';
import { nextBlockDates } from './dates';
import { generateNextBlock } from './generate';
import { nextBlockInput } from './input';

const LINEAGE = '5b3c3d0e-8f5a-4a43-9a9c-2f0f6a1c0b01';
const weeksOf = (b: { startsOn: string; endsOn: string }) =>
	(daysBetween(b.startsOn, b.endsOn) + 1) / 7;
const idOf = (p: TrainingProfile, title: string) => p.goals.find((g) => g.title === title)!.id;

/** S9's marathon first, then a Muay Thai goal (journeyHybrid's), so get stronger ranks third. */
function marathonFirst() {
	const p = M7_SCENARIOS.runnerLifter();
	const j = M7_SCENARIOS.journeyHybrid();
	const [marathon, stronger] = p.goals;
	p.goals = [
		marathon!,
		{ ...j.goals.find((g) => g.title === 'Muay Thai')!, priority: 2 },
		{ ...stronger!, priority: 3 }
	];
	p.experience.push(j.experience.find((e) => e.discipline === 'muay_thai')!);
	return p;
}

/** S6's build muscle, with get stronger second (its experience from S9). */
function muscleThenStrength() {
	const p = M7_SCENARIOS.hypertrophyBlock();
	const r = M7_SCENARIOS.runnerLifter();
	p.goals.push({ ...r.goals.find((g) => g.title === 'Get stronger')!, priority: 2 });
	p.experience.push(r.experience.find((e) => e.discipline === 'strength')!);
	return p;
}

interface Case {
	profile: () => TrainingProfile;
	deloadNeed?: CycleReviewSnapshot['deloadNeed']['verdict'];
	/** A change to today's profile only, after the first program and before the review. */
	later?: (p: TrainingProfile) => void;
	start?: 'this_week' | 'next_monday';
}

/** A healthy review of the first program's first block, then the next block on time. */
function reviewed(c: Case) {
	const profile = c.profile();
	const first = generateProgram(buildProgrammingInput(profile, { catalogue: CATALOGUE }), {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	const block = first.blocks[0]!;
	const next = first.blocks[1]!;
	const counts = { planned: 20, completed: 20, skipped: 0, missed: 0, pct: 100 };
	const snapshot = cycleReviewSnapshotSchema.parse({
		version: 1,
		block: {
			...{ lineage: LINEAGE, name: block.name, phase: block.phase },
			...{ from: block.startsOn, to: block.endsOn, weeks: block.weeks.length }
		},
		computedOn: addDays(block.endsOn, 1),
		timeZone: 'UTC',
		analyticsVersion: 1,
		inputsDigest: '0123456789abcdef',
		adherence: { ...counts, verdictsWithheld: false, weeks: [], oftenMissed: [] },
		goals: [],
		effectiveness: [],
		volume: [],
		fatigue: { level: 'none', reasons: [], deloadPlanned: false },
		deloadNeed: { verdict: c.deloadNeed ?? 'not_needed', reasons: [] },
		previous: null,
		next: { name: next.name, phase: next.phase, startsOn: next.startsOn },
		brief: {
			kind: 'cycle',
			from: block.startsOn,
			to: block.endsOn,
			summary: 'A block.',
			findings: []
		}
	}) as CycleReviewSnapshot;
	c.later?.(profile);
	const today = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const goals = profile.goals as unknown as CycleGoal[];
	const outline = { phase: next.phase, weeks: weeksOf(next) };
	const directives = directivesFrom({ snapshot, running: null }, outline, goals, today);
	const dates = nextBlockDates({
		blocks: first.blocks,
		reviewedBlock: 0,
		today: addDays(block.endsOn, 1),
		start: c.start ?? 'this_week',
		events: profile.goals.flatMap((g) => (g.eventDate ? [g.eventDate] : [])),
		weeks: directives.weeks
	});
	const empty = { timeZone: 'UTC', e1rms: [], maxes: [], running: null };
	const input = nextBlockInput(today, empty, directives);
	const previous = { block, results: [], unit: 'kg' as const };
	const result = generateNextBlock(input, { dates, outline: next, previous, directives });
	// Each goal's mode in the block, as generateNextBlock's prepare sets it.
	const dated = { startsOn: dates.block.startsOn, firstPlannedDay: dates.firstPlannedDay };
	const planned = { phase: directives.phase, endsOn: dates.block.endsOn };
	const { modes } = prepare(input.input, dated, new DecisionLog(), planned).input;
	return { profile, block, directives, result, input, modes: modes! };
}

type Reviewed = ReturnType<typeof reviewed>;

const runMetres = (week: WeekPlan) =>
	week.sessions.reduce(
		(n, s) => (s.kind === 'run' ? s.segments.reduce((m, g) => m + (g.distanceMetres ?? 0), n) : n),
		0
	);
const evidenceOf = (r: Reviewed, kind: string) =>
	r.result.decisions
		.filter((d) => d.kind === kind)
		.map((d): Record<string, unknown> => ({ ruleKey: d.ruleKey, ...d.evidence }));

describe('the next block from the season', () => {
	it('after marathon base comes marathon build, at most +10 % a week, with marathon-pace long runs and strength at maintenance', () => {
		const r = reviewed({ profile: marathonFirst });
		expect(r.block.phase).toBe('marathon_base');
		expect(r.result.block.phase).toBe('marathon_build');
		expect(r.result.block.weeks.map((w) => w.kind)).toEqual(
			r.directives.weekPlan!.slice(0, r.result.block.weeks.length).map((w) => w.kind)
		);
		expect(evidenceOf(r, 'block_type_chosen')).toEqual([
			expect.objectContaining({
				ruleKey: 'season.window',
				type: 'marathon',
				weeks: r.result.block.weeks.length
			})
		]);

		// Never more than 10 % over the biggest week so far, from the actual start.
		let most = r.input.input.running!.weeklyMetres!;
		for (const week of r.result.block.weeks) {
			expect(runMetres(week)).toBeLessThanOrEqual(Math.ceil(most * 1.1));
			most = Math.max(most, runMetres(week));
		}
		// Every build week's long run closes at marathon pace: a paced steady segment.
		const builds = r.result.block.weeks.filter((w) => w.kind === 'build');
		expect(builds.length).toBeGreaterThan(1);
		for (const week of builds) {
			expect(week.targets.running?.raceSpecific).toBe('marathon_pace');
			const long = week.sessions.find((s) => s.kind === 'run' && s.type === 'long_run');
			const steady =
				long?.kind === 'run' ? long.segments.find((g) => g.kind === 'steady') : undefined;
			expect(steady?.paceMinSecondsPerKm).toEqual(expect.any(Number));
		}

		const stronger = idOf(r.profile, 'Get stronger');
		expect(r.modes[idOf(r.profile, 'Marathon')]).toBe('primary');
		expect(r.modes[stronger]).toBe('maintenance');
		expect(evidenceOf(r, 'maintenance_dose')).toContainEqual(
			expect.objectContaining({ goalRef: stronger, stream: 'strength', mode: 'maintenance' })
		);
	});

	it('a marathon build outline longer than the season’s base keeps its phase, build following base', () => {
		const r = reviewed({ profile: M7_SCENARIOS.journeyHybrid });
		expect(r.block.phase).toBe('marathon_base');
		expect(r.result.block).toMatchObject({ phase: 'marathon_build', name: 'Marathon build' });
		const kinds = r.result.block.weeks.map((w) => w.kind);
		expect(kinds.lastIndexOf('base')).toBeLessThan(kinds.indexOf('build'));
		expect(kinds.filter((k) => k === 'build').length).toBeGreaterThan(1);
		const [chosen] = evidenceOf(r, 'block_type_chosen');
		expect(chosen).not.toHaveProperty('outlined');
		expect(evidenceOf(r, 'next_block_planned')[0]!.reason).toMatch(
			/^It is the marathon build phase/
		);
	});

	it('a block starting next Monday plans the season’s weeks from that Monday on', () => {
		const r = reviewed({ profile: marathonFirst, start: 'next_monday' });
		expect(r.result.bridge?.weeks).toHaveLength(1);
		const n = r.result.block.weeks.length;
		expect(r.result.block.weeks.map((w) => w.kind)).toEqual(
			r.directives.weekPlan!.slice(1, 1 + n).map((w) => w.kind)
		);
	});

	it('after the fight, the marathon leads and build muscle stays at maintenance', () => {
		const r = reviewed({ profile: M7_SCENARIOS.multiGoal });
		expect(r.block.phase).toBe('fight_camp');
		expect(r.result.block.phase).toBe('recovery');
		const marathon = idOf(r.profile, 'Marathon');
		expect(r.modes[marathon]).toBe('primary');
		expect(r.modes[idOf(r.profile, 'Build muscle')]).toBe('maintenance');
		expect(evidenceOf(r, 'priority_resolved')).toEqual([
			expect.objectContaining({ goalRef: marathon, mode: 'primary' })
		]);
		expect(evidenceOf(r, 'block_type_chosen')).toEqual([
			expect.objectContaining({ ruleKey: 'season.recovery', type: 'recovery' })
		]);
	});

	it('a needed deload comes first, before the season’s weeks', () => {
		const calm = reviewed({ profile: marathonFirst });
		const r = reviewed({ profile: marathonFirst, deloadNeed: 'needed' });
		expect(r.directives.deload).toBe('first');
		const kinds = r.result.block.weeks.map((w) => w.kind);
		expect(kinds[0]).toBe('deload');
		expect(kinds.slice(1)).toEqual(calm.result.block.weeks.slice(1).map((w) => w.kind));
		expect(r.result.block.weeks[0]!.targets.runVolumeFactor).toBeLessThan(
			calm.result.block.weeks[0]!.targets.runVolumeFactor
		);
		expect(evidenceOf(r, 'deload_scheduled')).toEqual([
			expect.objectContaining({ ruleKey: 'results.deload_first', week: 1 })
		]);
	});

	it('a goal reorder before the review re-chooses the block, with the reason', () => {
		const kept = reviewed({ profile: muscleThenStrength });
		expect(kept.directives.phase).toBe('hypertrophy');
		expect(evidenceOf(kept, 'block_type_chosen')).toEqual([
			expect.objectContaining({ type: 'muscle-building' })
		]);

		const swapped = reviewed({
			profile: muscleThenStrength,
			later: (p) => p.goals.forEach((g) => (g.priority = g.title === 'Get stronger' ? 1 : 2))
		});
		expect(swapped.directives.phase).toBe('accumulation');
		expect(swapped.result.block).toMatchObject({ phase: 'accumulation', name: 'Accumulation' });
		const [chosen] = evidenceOf(swapped, 'block_type_chosen');
		expect(chosen).toMatchObject({
			type: 'strength',
			outlined: 'hypertrophy',
			block: 'Accumulation'
		});
		expect(String(chosen!.reason)).toMatch(
			/^Your plan outlined hypertrophy here, but at today's goals it no longer fits\. Get stronger leads/
		);
		expect(evidenceOf(swapped, 'next_block_planned')[0]!.reason).toMatch(
			/^Your plan outlined hypertrophy here; at today's goals the season plans accumulation\./
		);
		expect(swapped.modes[idOf(swapped.profile, 'Get stronger')]).toBe('primary');
	});

	it('leaves M3’s generateProgram byte-identical', () => {
		// Hashes of M3's plan for three scenarios, taken on the base before this change.
		const hashes = (['journeyHybrid', 'multiGoal', 'hypertrophyBlock'] as const).map((key) => {
			const input = buildProgrammingInput(M7_SCENARIOS[key](), { catalogue: CATALOGUE });
			const options = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
			return fnv1a64(canonicalJson(generateProgram(input, options)));
		});
		expect(hashes).toEqual(['c6ea5a813dd72b40', 'dcc306d4d47d6430', '4bfb0a98aaf1bea6']);
	});
});

describe('plannedWeeks', () => {
	const week = (kind: PlannedWeek['kind'], volumeFactor: number): PlannedWeek => ({
		kind,
		targets: { rpeCap: 8.5, volumeFactor, loadStep: 0.025, runVolumeFactor: volumeFactor }
	});
	const plan = [week('accumulation', 1), week('accumulation', 1.1), week('deload', 0.6)];
	const review = { rpeCap: 8, volumeFactor: 1, loadStep: 0.02, runVolumeFactor: 1 };

	it('past the season’s block repeats its last loading week, held to the review’s targets', () => {
		const out = plannedWeeks(5, plan, { deload: 'none', targets: review, hold: false });
		expect(out.map((w) => [w.kind, w.targets.volumeFactor])).toEqual([
			['accumulation', 1],
			['accumulation', 1.1],
			['deload', 0.6],
			['accumulation', 1.1],
			['accumulation', 1.1]
		]);
		expect(out.every((w) => w.targets.rpeCap === 8)).toBe(true);
		const loading = out.filter((w) => w.kind === 'accumulation');
		expect(loading.map((w) => w.targets.loadStep)).toEqual([0.02, 0.02, 0.02, 0.02]);
	});

	it('a held block repeats the first loading week, so nothing rises', () => {
		const out = plannedWeeks(4, plan, { deload: 'none', targets: review, hold: true });
		expect(out.map((w) => [w.kind, w.targets.volumeFactor, w.targets.loadStep])).toEqual([
			['accumulation', 1, 0],
			['accumulation', 1, 0],
			['deload', 0.6, 0.025],
			['accumulation', 1, 0]
		]);
	});

	it('the directed deload replaces the last week, unless the season already deloads it', () => {
		const last = plannedWeeks(2, plan, { deload: 'last', targets: review, hold: false });
		expect(last.map((w) => w.kind)).toEqual(['accumulation', 'deload']);
		expect(last[1]!.targets.volumeFactor).toBeLessThan(1.1);
		const already = plannedWeeks(3, plan, { deload: 'last', targets: review, hold: false });
		expect(already[2]).toEqual({ kind: 'deload', targets: { ...plan[2]!.targets, rpeCap: 8 } });
	});
});
