/**
 * avoidance.ts: injuries rule out their body area's rows up to their severity, movements to
 * avoid are read as a phrase, a name or the phrases inside them, every exclusion has its reason,
 * and unreadable text comes back unmatched. The tables are checked as data.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { normaliseExerciseName } from '../exercises/match';
import { BODY_AREAS, SEVERITIES } from '../profile/catalog';
import { AVOID_PHRASES, avoidanceOf, INJURY_EXCLUSIONS, matchesExercise } from './avoidance';
import type { Avoidance, LibraryExercise } from './avoidance';
import type { InputInjury } from './input';

const injury = (over: Partial<InputInjury>): InputInjury => ({
	bodyArea: 'other',
	side: null,
	severity: 'mild',
	avoid: [],
	...over
});

const of = (injuries: InputInjury[], library: readonly LibraryExercise[] = CATALOGUE) =>
	avoidanceOf(injuries, library);

/** The reasons `avoidance` gives for `key`: the first matching rule of each exclusion. */
function reasons(
	avoidance: Avoidance,
	key: string,
	library: readonly LibraryExercise[] = CATALOGUE
) {
	const exercise = library.find((e) => e.key === key)!;
	return avoidance.exclusions.flatMap(
		({ rules }) => rules.find(({ match }) => matchesExercise(exercise, match))?.reason ?? []
	);
}
const out = (avoidance: Avoidance) =>
	CATALOGUE.filter((e) => reasons(avoidance, e.key).length).map((e) => e.key);

describe('the tables', () => {
	it('give every row a selector that leaves out some exercises but never all of them', () => {
		const rows = [...Object.values(INJURY_EXCLUSIONS).flat(), ...AVOID_PHRASES];
		for (const row of rows) {
			const matched = CATALOGUE.filter((e) => matchesExercise(e, row)).length;
			expect(matched, JSON.stringify(row)).toBeGreaterThan(0);
			expect(matched, JSON.stringify(row)).toBeLessThan(CATALOGUE.length / 2);
		}
		expect(Object.keys(INJURY_EXCLUSIONS)).toEqual([...BODY_AREAS]);
		for (const area of BODY_AREAS) {
			const order = INJURY_EXCLUSIONS[area].map((row) => SEVERITIES.indexOf(row.from));
			expect(order, area).toEqual([...order].sort());
		}
	});

	it('word every phrase once, so no text reads two ways', () => {
		const says = AVOID_PHRASES.flatMap((phrase) => phrase.says.map(normaliseExerciseName));
		expect(says.filter((text, i) => says.indexOf(text) !== i)).toEqual([]);
	});

	it('match nothing with an `except` alone', () => {
		expect(CATALOGUE.some((e) => matchesExercise(e, { except: ['knee_friendly'] }))).toBe(false);
	});
});

describe('injuries', () => {
	it('rule out their area’s rows up to their severity', () => {
		const shoulder = (severity: InputInjury['severity']) =>
			of([injury({ bodyArea: 'shoulder', severity })]);
		const mild = out(shoulder('mild'));
		const moderate = out(shoulder('moderate'));
		const severe = out(shoulder('severe'));
		expect(mild).toEqual(expect.arrayContaining(['snatch', 'split_jerk']));
		expect(mild).not.toContain('overhead_press');
		expect(moderate).toEqual(expect.arrayContaining([...mild, 'overhead_press', 'power_clean']));
		expect(moderate).not.toContain('bench_press');
		expect(severe).toEqual(expect.arrayContaining([...moderate, 'bench_press', 'pull_up']));
		// What the catalogue marks shoulder friendly stays, as do rows.
		for (const key of ['landmine_press', 'floor_press', 'face_pull', 'barbell_row']) {
			expect(severe).not.toContain(key);
		}
	});

	it('give one reason per injury: the first row that matches, naming the injury', () => {
		const shoulder = of([injury({ bodyArea: 'shoulder', side: 'left', severity: 'moderate' })]);
		expect(reasons(shoulder, 'snatch')).toEqual([
			'Your moderate left shoulder injury rules out catching a bar overhead'
		]);
		expect(reasons(shoulder, 'overhead_press')).toEqual([
			'Your moderate left shoulder injury rules out overhead work'
		]);
		const knees = of([injury({ bodyArea: 'knee', side: 'both', severity: 'severe' })]);
		expect(reasons(knees, 'back_squat')).toEqual([
			'Your severe knee injury rules out deep knee bends'
		]);
		expect(reasons(knees, 'box_squat')).toEqual([]);
		expect(of([injury({ bodyArea: 'other', severity: 'severe' })])).toEqual({
			exclusions: [],
			unmatched: []
		});
	});
});

describe('movements to avoid', () => {
	const avoiding = (...avoid: string[]) => of([injury({ avoid })]);

	it('read “overhead pressing” as pressing overhead, not every overhead exercise', () => {
		const left = out(avoiding('overhead pressing'));
		expect(left).toEqual(
			expect.arrayContaining(['overhead_press', 'push_press', 'push_jerk', 'handstand_push_up'])
		);
		for (const key of ['dumbbell_pullover', 'waiters_walk', 'landmine_press', 'bench_press']) {
			expect(left).not.toContain(key);
		}
		expect(reasons(avoiding('Overhead pressing'), 'overhead_press')).toEqual([
			'You asked to avoid “Overhead pressing”'
		]);
		expect(out(avoiding('overhead'))).toContain('dumbbell_pullover');
	});

	it('read a whole phrase as a kind of movement, before reading it as a name', () => {
		const squats = out(avoiding('Squats'));
		expect(squats).toEqual(CATALOGUE.filter((e) => e.pattern === 'squat').map((e) => e.key));
		expect(out(avoiding('Front squats'))).toEqual(['front_squat']);
		expect(out(avoiding('Box jumps'))).toEqual(['box_jump']);
		const deep = out(avoiding('deep squats'));
		expect(deep).toEqual(expect.arrayContaining(['back_squat', 'pistol_squat']));
		expect(deep).not.toContain('leg_press');
	});

	it('read the phrases inside other text', () => {
		const heavy = out(avoiding('No heavy deadlifts, please'));
		expect(heavy).toEqual(
			expect.arrayContaining(['deadlift', 'romanian_deadlift', 'good_morning'])
		);
		for (const key of ['kettlebell_swing', 'hip_thrust', 'dumbbell_romanian_deadlift']) {
			expect(heavy).not.toContain(key);
		}
		const both = out(avoiding('jumping & twisting'));
		expect(both).toEqual(expect.arrayContaining(['box_jump', 'russian_twist', 'cable_woodchop']));
	});

	it('read the names inside other text, and return the words they cannot read', () => {
		const named = avoiding('Burpees and box jumps', 'No heavy deadlifts, please');
		expect(out(named)).toEqual(expect.arrayContaining(['burpee', 'box_jump', 'deadlift']));
		expect(out(named)).not.toContain('tuck_jump');
		expect(named.unmatched).toEqual([]);
		const partly = avoiding('Burpees, tyre flips and sandbag tosses');
		expect(out(partly)).toEqual(['burpee']);
		expect(partly.unmatched).toEqual(['tyre flips', 'sandbag tosses']);
	});

	it('read the owner’s own exercises by name', () => {
		const sandbag: LibraryExercise = {
			...CATALOGUE.find((e) => e.key === 'power_clean')!,
			key: 'custom:1',
			name: 'Sandbag clean',
			aliases: []
		};
		const library = [...CATALOGUE, sandbag];
		const avoidance = of([injury({ avoid: ['Sandbag clean'] })], library);
		expect(reasons(avoidance, 'custom:1', library)).toEqual(['You asked to avoid “Sandbag clean”']);
		expect(reasons(avoidance, 'power_clean', library)).toEqual([]);
	});

	it('return what they cannot read, once each, leaving nothing out for it', () => {
		const avoidance = of([
			injury({ avoid: ['Running', 'anything that hurts'] }),
			injury({ bodyArea: 'knee', avoid: ['Running', 'jumping'] })
		]);
		expect(avoidance.unmatched).toEqual(['Running', 'anything that hurts']);
		expect(avoidance.exclusions.map((e) => e.kind)).toEqual(['injury', 'avoid']);
		expect(avoidance.exclusions[1]?.rules.map((r) => r.reason)).toEqual([
			'You asked to avoid “jumping”'
		]);
	});
});
