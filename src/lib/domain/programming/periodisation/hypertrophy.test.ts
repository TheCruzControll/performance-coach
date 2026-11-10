import { describe, expect, it } from 'vitest';
import { EXPERIENCE_LEVELS, NUTRITION_PHASES } from '../../profile/catalog';
import type { ExperienceLevel, NutritionPhase } from '../../profile/catalog';
import { periodisedWeekTargetsSchema } from '../../training/schemas';
import type { ExerciseTag, Muscle } from '../../training/vocabulary';
import { HARD_SET_RANGES } from '../rules/volume';
import { hypertrophyKindOf, hypertrophyReps, hypertrophyWeeks } from './hypertrophy';
import type { HypertrophyWeek } from './hypertrophy';
import { BLOCK_WEEK_KINDS } from './kinds';

const BAND = { sets: HARD_SET_RANGES.hypertrophy.sets };
const [LOW, HIGH] = BAND.sets;
const PHASES: (NutritionPhase | null)[] = [null, ...NUTRITION_PHASES];
const BLOCKS = EXPERIENCE_LEVELS.flatMap((level) =>
	PHASES.flatMap((phase) =>
		[4, 5, 6].map((weeks) => ({
			level,
			phase,
			weeks,
			plan: hypertrophyWeeks(BAND, weeks, level, phase)
		}))
	)
);
const ranges = (plan: HypertrophyWeek[]) =>
	plan.map(({ targets: { setsPerGroup: s } }) => [s.min, s.max]);
const building = (plan: HypertrophyWeek[]) => plan.slice(0, -1);
const deloadOf = (plan: HypertrophyWeek[]) => plan.at(-1)!;
const block = (weeks: number, level: ExperienceLevel, phase: NutritionPhase | null = null) =>
	hypertrophyWeeks(BAND, weeks, level, phase);

describe('hypertrophy blocks', () => {
	it('starts at the band’s low end and adds sets each week: [10, 12], then [12, 14]', () => {
		expect(ranges(block(4, 'intermediate'))).toEqual([
			[10, 12],
			[12, 14],
			[14, 16],
			[16, 18],
			[6, 7]
		]);
		expect(block(4, 'intermediate').map((w) => w.targets.setsPerGroup.step)).toEqual([
			0, 2, 2, 2, 0
		]);
		expect(ranges(block(5, 'novice'))).toEqual([
			[10, 12],
			[11, 13],
			[12, 14],
			[13, 15],
			[14, 16],
			[6, 7]
		]);
	});

	it('keeps every week’s setsPerGroup within the band', () => {
		for (const { level, phase, weeks, plan } of BLOCKS) {
			for (const { targets } of plan) {
				const { min, max } = targets.setsPerGroup;
				expect(min, `${level} ${phase} ${weeks}`).toBeLessThanOrEqual(max);
				expect(max, `${level} ${phase} ${weeks}`).toBeLessThanOrEqual(HIGH);
			}
			for (const { targets } of building(plan)) {
				expect(targets.setsPerGroup.min, `${level} ${phase} ${weeks}`).toBeGreaterThanOrEqual(
					phase === 'cut' ? 0.8 * LOW : LOW
				);
			}
		}
	});

	it('never lowers volume until the deload, each step at most 2 sets and 20 %', () => {
		for (const { level, phase, weeks, plan } of BLOCKS) {
			const weeksBuilt = building(plan);
			for (let i = 1; i < weeksBuilt.length; i++) {
				const before = weeksBuilt[i - 1]!.targets;
				const now = weeksBuilt[i]!.targets;
				const rise = now.setsPerGroup.min - before.setsPerGroup.min;
				const label = `${level} ${phase} ${weeks} week ${i}`;
				expect(rise, label).toBeGreaterThanOrEqual(0);
				expect(now.setsPerGroup.max, label).toBeGreaterThanOrEqual(before.setsPerGroup.max);
				expect(rise, label).toBeLessThanOrEqual(2);
				expect(rise, label).toBeLessThanOrEqual(0.2 * before.setsPerGroup.min);
				expect(now.setsPerGroup.step, label).toBe(rise);
				expect(now.volumeFactor, label).toBeGreaterThanOrEqual(before.volumeFactor);
			}
			const last = weeksBuilt.at(-1)!.targets.setsPerGroup;
			expect(last.min, `${level} ${phase} ${weeks}`).toBeGreaterThan(
				weeksBuilt[0]!.targets.setsPerGroup.min
			);
		}
	});

	it('ends in a deload with at least 40 % fewer sets than any building week', () => {
		for (const { level, phase, weeks, plan } of BLOCKS) {
			const deload = deloadOf(plan).targets;
			const first = plan[0]!.targets.setsPerGroup;
			expect(deload.setsPerGroup.min, `${level} ${phase} ${weeks}`).toBeLessThanOrEqual(
				0.6 * first.min
			);
			expect(deload.setsPerGroup.max, `${level} ${phase} ${weeks}`).toBeLessThanOrEqual(
				0.6 * first.max
			);
			expect(deload.setsPerGroup.step).toBe(0);
			expect(deload).toMatchObject({ rpeCap: 6, volumeFactor: 0.6, loadStep: -0.1 });
			expect(deload.mainLifts).toEqual({ repsMin: 6, repsMax: 10, topRpe: 6, setsFactor: 0.6 });
		}
	});

	it('keeps 80 % of the band on a cut and never goes above it; a bulk climbs to the top', () => {
		for (const level of EXPERIENCE_LEVELS) {
			for (const weeks of [4, 5, 6]) {
				const cut = block(weeks, level, 'cut');
				expect(cut[0]!.targets.setsPerGroup.min).toBe(0.8 * LOW);
				for (const { targets } of cut) {
					expect(targets.setsPerGroup.max).toBeLessThanOrEqual(0.8 * HIGH);
				}
				const bulk = building(block(weeks, level, 'bulk'));
				const maintenance = building(block(weeks, level, 'maintenance'));
				expect(bulk.at(-1)!.targets.setsPerGroup.max).toBeGreaterThanOrEqual(
					maintenance.at(-1)!.targets.setsPerGroup.max
				);
			}
		}
		expect(ranges(block(6, 'novice', 'cut'))).toEqual([
			[8, 10],
			[9, 11],
			[10, 12],
			[11, 13],
			[12, 14],
			[13, 15],
			[4, 6]
		]);
		expect(ranges(building(block(6, 'novice', 'bulk'))).at(-1)).toEqual([18, 20]);
		expect(ranges(building(block(6, 'novice'))).at(-1)).toEqual([15, 17]);
		expect(ranges(building(block(6, 'advanced'))).at(-1)).toEqual([18, 20]);
	});

	it('ramps the top set from RPE 7 to 9, an isolation’s last set to 9.5', () => {
		const rpes = (plan: HypertrophyWeek[]) => building(plan).map((w) => w.targets.mainLifts.topRpe);
		expect(rpes(block(4, 'intermediate'))).toEqual([7, 8, 8.5, 9]);
		expect(rpes(block(5, 'intermediate'))).toEqual([7, 8, 8.5, 8.5, 9]);
		expect(rpes(block(6, 'intermediate'))).toEqual([7, 8, 8, 8.5, 8.5, 9]);
		for (const { plan } of BLOCKS) {
			for (const { targets } of building(plan)) {
				expect(targets.rpeCap).toBe(targets.mainLifts.topRpe + 0.5);
				expect(targets.mainLifts).toMatchObject({ repsMin: 6, repsMax: 10 });
				expect(targets.volumeFactor).toBe(targets.mainLifts.setsFactor);
			}
			expect(building(plan).at(-1)!.targets.rpeCap).toBe(9.5);
		}
	});

	it('gives rep ranges by exercise kind', () => {
		const exercise = (tags: ExerciseTag[], primaryMuscles: Muscle[]) => ({ tags, primaryMuscles });
		const squat = exercise(['compound'], ['quads', 'glutes']);
		const flye = exercise([], ['chest']);
		const lateralRaise = exercise([], ['side_delts']);
		const curl = exercise([], ['biceps']);
		const calfRaise = exercise([], ['calves']);
		const jump = exercise(['explosive'], ['calves']);
		expect([squat, flye, lateralRaise, curl, calfRaise, jump].map(hypertrophyKindOf)).toEqual([
			'compound',
			'isolation',
			'isolation',
			'small',
			'small',
			'compound'
		]);
		expect(hypertrophyReps(squat)).toEqual({ min: 6, max: 10 });
		expect(hypertrophyReps(flye)).toEqual({ min: 10, max: 15 });
		expect(hypertrophyReps(curl)).toEqual({ min: 12, max: 20 });
		expect(hypertrophyKindOf(exercise([], ['biceps', 'lats']))).toBe('isolation');
	});

	it('plans 4-, 5- and 6-week blocks, each with its deload, and refuses any other length', () => {
		for (const weeks of [4, 5, 6]) expect(block(weeks, 'advanced')).toHaveLength(weeks + 1);
		for (const weeks of [0, 3, 7, 4.5]) {
			expect(() => block(weeks, 'advanced')).toThrow(RangeError);
		}
	});

	it('takes its kinds from BLOCK_WEEK_KINDS, and every week validates', () => {
		for (const { plan } of BLOCKS) {
			expect(plan.map((w) => w.kind)).toEqual([
				...building(plan).map(() => BLOCK_WEEK_KINDS.hypertrophy.building),
				BLOCK_WEEK_KINDS.hypertrophy.deload
			]);
			for (const { phase, targets } of plan) {
				expect(phase).toBe('hypertrophy');
				const parsed = periodisedWeekTargetsSchema.safeParse(targets);
				expect(parsed.success, JSON.stringify(targets)).toBe(true);
				expect(parsed.data).toEqual(targets);
			}
		}
		expect(block(4, 'novice')).toEqual(block(4, 'novice'));
	});
});
