/**
 * splits.ts: the split follows the discipline and the number of strength days it is given, days
 * are lettered when the week repeats them, every week trains squat, hinge, push and pull and
 * pulls at least as often as it pushes, and a goal of another kind ranked first means maintenance.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { Discipline } from '../profile/catalog';
import type { TrainingProfile } from '../profile/types';
import { buildProgrammingInput } from './input';
import { LAYOUTS, SLOT_KINDS, STYLES } from './rules/strength';
import type { LayoutKey } from './rules/strength';
import { SCENARIOS } from './scenarios';
import { chooseSplit, splitFacts, strengthDiscipline } from './splits';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** The minimal profile with its one goal training `disciplines`. */
function training(...disciplines: Discipline[]) {
	const p = SCENARIOS.minimal();
	p.goals[0]!.disciplines = disciplines;
	return inputOf(p);
}

const PUSH = ['horizontal_push', 'vertical_push'];
const PULL = ['horizontal_pull', 'vertical_pull'];
const patternsOf = (split: ReturnType<typeof chooseSplit>) =>
	split.days.flatMap((day) => day.slots.map(([, kind]) => SLOT_KINDS[kind].patterns[0]!));

describe('chooseSplit', () => {
	it.each([
		[1, 'full_body', ['Full body']],
		[2, 'full_body', ['Full body A', 'Full body B']],
		[3, 'full_body', ['Full body A', 'Full body B', 'Full body C']],
		[4, 'upper_lower', ['Upper A', 'Lower A', 'Upper B', 'Lower B']],
		[5, 'ppl_upper_lower', ['Push', 'Pull', 'Legs', 'Upper', 'Lower']],
		[6, 'ppl', ['Push A', 'Pull A', 'Legs A', 'Push B', 'Pull B', 'Legs B']]
	] as const)('gives general strength on %i days a %s split', (count, layout, titles) => {
		const split = chooseSplit(training('strength'), count);
		expect(split).toMatchObject({ layout, discipline: 'strength', maintenance: false });
		expect(split.days.map((d) => d.title)).toEqual(titles);
		expect(split.prescription).toBe(STYLES.strength);
		expect(split).toMatchObject({ type: 'strength', lifts: true });
	});

	it('gives each discipline with a split of its own that split, whatever the count', () => {
		const layouts: [Discipline, LayoutKey][] = [
			['powerlifting', 'sbd'],
			['weightlifting', 'weightlifting'],
			['athletic', 'athletic']
		];
		for (const [discipline, layout] of layouts) {
			for (const count of [1, 2, 3, 4]) {
				expect(chooseSplit(training(discipline), count).layout).toBe(layout);
			}
		}
		expect(chooseSplit(training('powerlifting'), 4).days.map((d) => d.title)).toEqual([
			'Squat',
			'Bench A',
			'Deadlift',
			'Bench B'
		]);
		const athletic = chooseSplit(training('athletic'), 3);
		expect(athletic.days.map((d) => d.title)).toEqual(['Athletic A', 'Athletic B', 'Athletic C']);
		for (const day of athletic.days) expect(day.slots[0]).toEqual(['power', 'power']);
	});

	it('gives a powerlifter squat, bench and deadlift as main lifts on any number of days', () => {
		for (const count of [1, 2, 3, 4, 5]) {
			const mains = chooseSplit(training('powerlifting'), count).days.flatMap((day) =>
				day.slots.filter(([role]) => role === 'main').map(([, , lift]) => lift)
			);
			expect(new Set(mains)).toEqual(new Set(['back_squat', 'bench_press', 'deadlift']));
		}
	});

	it('trains hypertrophy for size, its main slots open to the best fit', () => {
		const split = chooseSplit(training('hypertrophy'), 4);
		expect(split).toMatchObject({ layout: 'upper_lower', type: 'hypertrophy', lifts: false });
		expect(split.prescription).toBe(STYLES.hypertrophy);
	});

	it('plans maintenance when a goal of another kind ranks first, or every goal is paused', () => {
		const hybrid = inputOf(SCENARIOS.hybrid());
		expect(strengthDiscipline(hybrid)).toBe('strength');
		const split = chooseSplit(hybrid, 2);
		expect(split).toMatchObject({
			layout: 'maintenance',
			discipline: 'strength',
			maintenance: true
		});
		expect(split.prescription).toBe(STYLES.maintenance);
		expect(split.days.map((d) => d.title)).toEqual(['Strength A', 'Strength B']);

		const paused = SCENARIOS.powerlifter();
		paused.goals[0]!.status = 'paused';
		const input = inputOf(paused);
		expect(input.maintenance).toBe(true);
		expect(chooseSplit(input, 2)).toMatchObject({ layout: 'maintenance', maintenance: true });
		expect(splitFacts(chooseSplit(input, 2), input, 0).reason).toBe(
			'keeps the strength you have with fewer hard sets, leaving your energy for your paused goals'
		);
	});

	it('refuses a split with no strength goal or no day', () => {
		expect(() => chooseSplit(training('running'), 2)).toThrow(RangeError);
		expect(() => chooseSplit(training('strength'), 0)).toThrow(RangeError);
		expect(strengthDiscipline(training('running', 'muay_thai'))).toBeNull();
	});
});

describe('every layout', () => {
	const cases = (Object.keys(LAYOUTS) as LayoutKey[]).flatMap((layout) =>
		[2, 3, 4, 5, 6].map((count) => [layout, count] as const)
	);
	const forLayout: Record<LayoutKey, () => ReturnType<typeof training>> = {
		full_body: () => training('strength'),
		upper_lower: () => training('strength'),
		ppl_upper_lower: () => training('strength'),
		ppl: () => training('strength'),
		sbd: () => training('powerlifting'),
		weightlifting: () => training('weightlifting'),
		athletic: () => training('athletic'),
		maintenance: () => inputOf(SCENARIOS.hybrid())
	};

	it.each(cases)(
		'%s on %i days trains squat, hinge, push and pull, pulling at least as often as pushing',
		(layout, count) => {
			const split = chooseSplit(forLayout[layout](), count);
			const patterns = patternsOf(split);
			for (const wanted of [['squat'], ['hinge'], PUSH, PULL]) {
				expect(patterns.some((p) => wanted.includes(p))).toBe(true);
			}
			const pushes = patterns.filter((p) => PUSH.includes(p)).length;
			expect(patterns.filter((p) => PULL.includes(p)).length).toBeGreaterThanOrEqual(pushes);
			for (const day of split.days) {
				expect(day.slots.some(([role]) => role === 'main')).toBe(true);
				expect(day.title.length).toBeLessThanOrEqual(60);
			}
		}
	);

	it('full body covers every main movement on a single day too', () => {
		const patterns = patternsOf(chooseSplit(training('strength'), 1));
		for (const wanted of [['squat'], ['hinge'], PUSH, PULL]) {
			expect(patterns.some((p) => wanted.includes(p))).toBe(true);
		}
	});
});

describe('splitFacts', () => {
	it('names the split with its article, its days, any strength classes and the top goal', () => {
		const strength = training('strength');
		expect(splitFacts(chooseSplit(strength, 4), strength, 0)).toEqual({
			split: 'upper/lower',
			article: 'an',
			days: 4,
			classes: '',
			reason: LAYOUTS.upper_lower.reason
		});
		expect(splitFacts(chooseSplit(strength, 2), strength, 2).classes).toBe(
			' besides your 2 strength classes'
		);
		expect(splitFacts(chooseSplit(strength, 2), strength, 1).classes).toBe(
			' besides your 1 strength class'
		);
		const hybrid = inputOf(SCENARIOS.hybrid());
		expect(splitFacts(chooseSplit(hybrid, 2), hybrid, 0)).toMatchObject({
			article: 'a',
			reason: 'keeps the strength you have with fewer hard sets, leaving your energy for Marathon'
		});
	});
});
