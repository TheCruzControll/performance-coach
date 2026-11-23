/**
 * The band each week was planned to (planned-targets.ts, m7r/06): M7 scenario plans read through
 * blockBands and weekBand as the targets service reads a stored version; M3's blocks (a generator
 * before M7, or no season) are left to M6's rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type { BlockPlan, DecisionPlan } from '../training/types';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { M7_SCENARIOS } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { blockBands, PRE_M7_GENERATORS, weekBand } from './planned-targets';
import type { BlockBands } from './planned-targets';
import { GENERATOR_ID } from './random';
import { SCENARIOS, SCENARIO_START } from './scenarios';
import type { ScenarioKey } from './scenarios';
import * as stages from './stages/prepare';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** `profile` planned from SCENARIO_START, and its first block read as `generator` stored it. */
function read(profile: TrainingProfile, generator = GENERATOR_ID) {
	const input = inputOf(profile);
	const plan = generateProgram(input, OPTIONS);
	const block = plan.blocks[0]!;
	const bands = blockBands({ input, generator, startsOn: SCENARIO_START }, block);
	return { plan, block, bands };
}
const weeksOf = (block: BlockPlan, bands: BlockBands) =>
	block.weeks.map((w) => weekBand(w.targets, bands));

/** S9's runner-lifter with its ranks swapped: strength first, the week-16 marathon second. */
const strengthFirst = () => {
	const profile = M7_SCENARIOS.runnerLifter();
	return { ...profile, goals: profile.goals.map((g) => ({ ...g, priority: 3 - g.priority! })) };
};
/** The [lo, hi] of 'N–M hard sets' in a maintenance_dose decision's dose words. */
const doseSets = (d: DecisionPlan) => {
	const [, lo, hi] = /(\d+)–(\d+) hard sets/.exec(String(d.evidence.dose))!;
	return [Number(lo), Number(hi)];
};

afterEach(() => vi.restoreAllMocks());

describe('the band an M7 week was planned to', () => {
	it("is a hypertrophy block's own rising range, unscaled, and its deload's first range scaled", () => {
		const { block, bands } = read(M7_SCENARIOS.hypertrophyBlock());
		const weeks = weeksOf(block, bands!);
		expect(weeks.map((w) => w.range)).toEqual([
			[10, 12],
			[12, 14],
			[14, 16],
			[16, 18],
			[6, 7.2]
		]);
		expect(weeks.map((w) => w.scale)).toEqual([1, 1, 1, 1, 0.6]);
		expect(weeks[1]).toMatchObject({
			source: 'plan',
			band: 'the 12–14 this block plans for the week'
		});
		expect(weeks[4]).toMatchObject({
			source: 'plan',
			band: 'the 10–12 this block plans for the week'
		});
	});

	it('is the maintenance dose in a maintenance block', () => {
		const { block, bands } = read(M7_SCENARIOS.offSeason());
		expect(block.weeks).toHaveLength(5);
		for (const week of weeksOf(block, bands!)) {
			expect(week).toMatchObject({ range: [4, 10], source: 'dose' });
		}
	});

	it("is the lower half of a secondary strength goal's band, scaled by each week's volume", () => {
		const { block, bands } = read(M7_SCENARIOS.runnerLifter());
		expect(block.weeks.every((w) => w.targets.setsPerGroup === undefined)).toBe(true);
		const weeks = weeksOf(block, bands!);
		expect(weeks.map((w) => w.scale)).toEqual([1, 1, 1, 1.1, 0.6]);
		expect(weeks.map((w) => w.range)).toEqual([
			[8, 11],
			[8, 11],
			[8, 11],
			[8.8, 12.1],
			[4.8, 6.6]
		]);
		expect(weeks[0]).toMatchObject({
			source: 'secondary',
			band: '8–11, the lower half of the 8–14 that suits getting stronger'
		});
	});

	it('follows the split the generator chose from the goals as prepare ranked them', () => {
		// Strength is ranked first, but the marathon is inside its lead window and leads, so the
		// generator held strength as secondary: 8–11, not the 8–14 the profile's order chooses.
		const { plan, block, bands } = read(strengthFirst());
		const led = plan.decisions.find((d) => d.kind === 'priority_resolved')!;
		expect(led.evidence).toMatchObject({ leader: 'Marathon', mode: 'primary' });
		expect(weekBand(block.weeks[0]!.targets, bands!)).toMatchObject({
			range: [8, 11],
			source: 'secondary'
		});
	});

	it("is a fight week's camp dose scaled to its volume, as the generator balanced it", () => {
		const { block, bands } = read(M7_SCENARIOS.multiGoal());
		const fight = block.weeks.at(-1)!;
		expect(fight.targets).toMatchObject({ volumeFactor: 0.4, setsPerGroup: { min: 4, max: 10 } });
		expect(weekBand(fight.targets, bands!)).toMatchObject({
			range: [1.6, 4],
			scale: 0.4,
			source: 'dose'
		});
	});

	it('is the dose cut as the held band is cut, for a fight camp on a cut', () => {
		const multi = M7_SCENARIOS.multiGoal();
		multi.profile.nutritionPhase = 'cut';
		const { block, bands } = read(multi);
		expect(bands!.held.keep).toBe(0.8);
		expect(block.weeks[0]!.targets.setsPerGroup).toMatchObject({ min: 4, max: 10 });
		expect(weekBand(block.weeks[0]!.targets, bands!)).toMatchObject({
			range: [3.2, 8],
			scale: 1,
			source: 'dose',
			band: bands!.held.band
		});
	});

	it('is the cut dose for a maintenance block chosen from the start on a cut, not the uncut 4–10', () => {
		// The season's first block is a strength block; a re-plan chose maintenance from the start,
		// so its weeks are judged by the phase it was chosen at, held on a cut.
		const profile = M7_SCENARIOS.runnerLifter();
		profile.profile.nutritionPhase = 'cut';
		const input = inputOf(profile);
		const plan = generateProgram(input, OPTIONS);
		const block = { ...plan.blocks[0]!, phase: 'maintenance' as const };
		const bands = blockBands({ input, generator: GENERATOR_ID, startsOn: SCENARIO_START }, block);
		expect(bands!.held.keep).toBe(0.8);
		for (const week of weeksOf(block, bands!)) expect(week.range).not.toEqual([4, 10]);
		expect(weekBand(block.weeks[0]!.targets, bands!)).toMatchObject({
			range: [3.2, 8],
			scale: 1,
			source: 'dose'
		});
	});

	it('is none for a fight camp with no strength goal, whatever dose its weeks store', () => {
		const multi = M7_SCENARIOS.multiGoal();
		const fightOnly = { ...multi, goals: multi.goals.filter((g) => g.priority === 1) };
		const { block, bands } = read(fightOnly);
		expect(block.weeks.every((w) => w.targets.setsPerGroup !== undefined)).toBe(true);
		expect(bands).toBeNull();
	});

	it.each(['hypertrophyBlock', 'multiGoal', 'offSeason', 'allPaused'] satisfies M7ScenarioKey[])(
		"%s: every week's band is the one the generator wrote in its decisions",
		(key) => {
			const { plan, block, bands } = read(M7_SCENARIOS[key]());
			const inFirst = plan.decisions.filter((d) => d.refs.includes('blocks.0'));
			const ramp = inFirst.find((d) => d.kind === 'volume_progressed');
			const dose = inFirst.find(
				(d) =>
					d.kind === 'maintenance_dose' &&
					(d.evidence.stream === 'strength' || d.evidence.stream === 'hypertrophy')
			);
			expect(ramp ?? dose, 'a band in the decisions').toBeDefined();
			const full = (w: (typeof block.weeks)[number]) => w.targets.volumeFactor >= 1;
			const first = block.weeks.find((w) => w.targets.setsPerGroup && full(w));
			const building: number[] = [];
			for (const week of block.weeks) {
				const own = week.targets.setsPerGroup;
				const read = weekBand(week.targets, bands!);
				const scale = own && full(week) ? 1 : week.targets.volumeFactor;
				expect(read.scale).toBe(scale);
				const base = own && full(week) ? own : (first?.targets.setsPerGroup ?? null);
				const [lo, hi] = base ? [base.min, base.max] : doseSets(dose!);
				expect(read.range[0]).toBeCloseTo(lo! * scale, 2);
				expect(read.range[1]).toBeCloseTo(hi! * scale, 2);
				if (ramp && !['deload', 'taper', 'event', 'recovery'].includes(week.kind))
					building.push(read.range[0]);
			}
			if (ramp) expect(building.join(', ')).toBe(ramp.evidence.ramp);
		}
	);
});

describe("M3's blocks keep M6's rule", () => {
	it.each(PRE_M7_GENERATORS)('a block %s built', (generator) => {
		expect(read(strengthFirst(), generator).bands).toBeUndefined();
		expect(read(M7_SCENARIOS.hypertrophyBlock(), generator).bands).toBeUndefined();
	});

	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s with no season, whatever generator built it',
		(key) => {
			vi.spyOn(stages, 'prepare').mockImplementation((input) => ({ input, periodisation: null }));
			expect(read(SCENARIOS[key]()).bands).toBeUndefined();
		}
	);
});
