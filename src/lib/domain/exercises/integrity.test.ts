/**
 * The exercise library's data. parseTable checks each row's fields as a part loads (an unknown
 * key, a bad rep range or a time measure without seconds throws on import), so these cases check
 * what no single row can: uniqueness across parts, the substitution groups, the links to M2 and
 * what each part must cover.
 *
 * Layout: 'the whole catalogue' holds the invariants every part keeps. Each part then has its own
 * block, part 1 (catalogue/lower.ts) below; part 2 adds its block and the whole-catalogue counts.
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT, EXERCISE_SUGGESTIONS, LIFTS, LIFT_LABEL } from '../profile/catalog';
import type { Equipment } from '../profile/catalog';
import * as lower from './catalogue/lower';
import * as upper from './catalogue/upper';
import { CATALOGUE, SUBSTITUTION_GROUPS, catalogueByKey, type CatalogueExercise } from './index';
import { matchExercise, normaliseExerciseName } from './match';

const PARTS = { lower, upper };

const keys = (exercises: readonly CatalogueExercise[]) => exercises.map(({ key }) => key);
const membersOf = (group: string) => CATALOGUE.filter((e) => e.substitutionGroup === group);
/** The entry needs exactly this equipment: dumbbells only, say, or nothing for bodyweight. */
const needsOnly = (exercise: CatalogueExercise, ...equipment: Equipment[]) =>
	exercise.equipment.length === equipment.length &&
	equipment.every((item) => exercise.equipment.includes(item));

describe('the whole catalogue', () => {
	it('loads every part: any row that does not parse throws on import', () => {
		expect(CATALOGUE).toEqual([...lower.exercises, ...upper.exercises]);
	});

	it('has unique keys across parts', () => {
		expect(catalogueByKey.size).toBe(CATALOGUE.length);
	});

	it('has distinct names and aliases, ignoring case, punctuation and plurals', () => {
		const owner = new Map<string, string>();
		const clashes: string[] = [];
		for (const { key, name, aliases } of CATALOGUE) {
			for (const term of [name, ...aliases]) {
				const normal = normaliseExerciseName(term);
				const first = owner.get(normal);
				if (first) clashes.push(`'${term}' (${key}) repeats ${first}`);
				else owner.set(normal, `'${term}' (${key})`);
			}
		}
		expect(clashes).toEqual([]);
	});

	it('matches every name and alias to its own entry', () => {
		const misses = CATALOGUE.flatMap(({ key, name, aliases }) =>
			[name, ...aliases]
				.filter((term) => matchExercise(term, CATALOGUE) !== key)
				.map((term) => `${term} → ${key}`)
		);
		expect(misses).toEqual([]);
	});

	it('names only M2 EQUIPMENT keys as equipment', () => {
		const unknown = CATALOGUE.flatMap((e) => e.equipment).filter(
			(item) => !EQUIPMENT.includes(item)
		);
		expect(unknown).toEqual([]);
	});

	it('gives every time-measured entry its default seconds, and no other entry any', () => {
		const wrong = CATALOGUE.filter((e) => (e.measure === 'time') !== (e.defaultSeconds !== null));
		expect(keys(wrong)).toEqual([]);
	});

	it('defines each group in exactly one part, and each part uses only its own groups', () => {
		expect(Object.keys(lower.groups).filter((group) => group in upper.groups)).toEqual([]);
		for (const [part, { groups, exercises }] of Object.entries(PARTS)) {
			const foreign = exercises.filter(
				(e) => e.substitutionGroup && !(e.substitutionGroup in groups)
			);
			expect(keys(foreign), part).toEqual([]);
		}
	});

	it('gives every group an intent sentence and ≥ 2 members sharing its pattern', () => {
		for (const [group, intent] of Object.entries(SUBSTITUTION_GROUPS)) {
			expect(intent, group).toMatch(/^[A-Z].{10,}\.$/);
			const members = membersOf(group);
			expect(members.length, group).toBeGreaterThanOrEqual(2);
			expect(new Set(members.map((e) => e.pattern)).size, group).toBe(1);
		}
	});

	it('links each M2 lift from at most one entry, keyed and named as M2 names the lift', () => {
		for (const lift of LIFTS) {
			const linked = CATALOGUE.filter((e) => e.baselineLift === lift);
			expect(linked.length, lift).toBeLessThanOrEqual(1);
			if (linked[0]) {
				expect(linked[0].key).toBe(lift);
				expect(matchExercise(LIFT_LABEL[lift], CATALOGUE)).toBe(lift);
			}
		}
	});
});

describe('part 1: lower body, Olympic, plyometric, conditioning and lower mobility', () => {
	const part = lower.exercises;

	it('has at least 75 entries, each in one of its substitution groups', () => {
		expect(part.length).toBeGreaterThanOrEqual(75);
		expect(keys(part.filter((e) => !e.substitutionGroup))).toEqual([]);
	});

	it('covers each of its movement patterns with at least 3 entries', () => {
		const patterns = [
			'squat',
			'hinge',
			'lunge',
			'olympic',
			'plyometric',
			'isolation',
			'conditioning',
			'mobility'
		];
		for (const pattern of patterns) {
			expect(part.filter((e) => e.pattern === pattern).length, pattern).toBeGreaterThanOrEqual(3);
		}
	});

	it('has the groups the rest of M3 names', () => {
		for (const group of [
			'knee_dominant_bilateral',
			'hip_hinge_bilateral',
			'single_leg_knee',
			'olympic_pull',
			'vertical_jump',
			'cyclical_conditioning'
		]) {
			expect(lower.groups, group).toHaveProperty(group);
		}
	});

	it('keeps one measure within each group, so a swap keeps its prescription', () => {
		for (const group of Object.keys(lower.groups)) {
			expect(new Set(membersOf(group).map((e) => e.measure)).size, group).toBe(1);
		}
	});

	it('flags split squats, lunges, the single-leg groups and single-arm work unilateral', () => {
		const oneSided = part.filter(
			(e) =>
				e.substitutionGroup?.startsWith('single_leg_') ||
				[e.name, ...e.aliases].some((term) => /split squat|lunge|single-leg|single-arm/i.test(term))
		);
		expect(keys(oneSided)).toEqual(
			expect.arrayContaining([
				'bulgarian_split_squat',
				'split_squat',
				'reverse_lunge',
				'walking_lunge',
				'forward_lunge',
				'step_up',
				'pistol_squat',
				'lateral_lunge',
				'cossack_squat',
				'single_leg_romanian_deadlift',
				'kickstand_romanian_deadlift'
			])
		);
		expect(keys(oneSided.filter((e) => !e.unilateral))).toEqual([]);
	});

	it('tags every barbell squat, two-leg hinge and Olympic lift spinal_loading', () => {
		const loaded = part.filter(
			(e) =>
				e.equipment.includes('barbell') &&
				(e.pattern === 'olympic' ||
					e.substitutionGroup === 'knee_dominant_bilateral' ||
					e.substitutionGroup === 'hip_hinge_bilateral')
		);
		expect(keys(loaded)).toEqual(
			expect.arrayContaining(['back_squat', 'deadlift', 'snatch', 'power_clean', 'clean_pull'])
		);
		expect(keys(loaded.filter((e) => !e.tags.includes('spinal_loading')))).toEqual([]);
	});

	it.each([
		['squat', (e: CatalogueExercise) => e.pattern === 'squat' && !e.unilateral],
		['hinge', (e: CatalogueExercise) => e.pattern === 'hinge' && !e.unilateral],
		[
			'single-leg',
			(e: CatalogueExercise) => e.unilateral && ['squat', 'hinge', 'lunge'].includes(e.pattern)
		]
	])('gives %s work ≥ 2 dumbbell-only options and ≥ 1 bodyweight option', (_kind, isKind) => {
		const options = part.filter(isKind);
		expect(options.filter((e) => needsOnly(e, 'dumbbells')).length).toBeGreaterThanOrEqual(2);
		expect(options.filter((e) => needsOnly(e)).length).toBeGreaterThanOrEqual(1);
	});

	it.each([
		'back_squat',
		'front_squat',
		'deadlift',
		'snatch',
		'clean_and_jerk',
		'power_clean'
	] as const)('links %s to its M2 lift', (lift) => {
		expect(part.find((e) => e.baselineLift === lift)?.key).toBe(lift);
	});

	const SUGGESTIONS: Record<string, string> = {
		'Back squat': 'back_squat',
		'Front squat': 'front_squat',
		Deadlift: 'deadlift',
		'Romanian deadlift': 'romanian_deadlift',
		'Bulgarian split squat': 'bulgarian_split_squat',
		'Box jumps': 'box_jump',
		'Kettlebell swings': 'kettlebell_swing',
		Lunges: 'forward_lunge',
		'Leg press': 'leg_press',
		'Hip thrust': 'hip_thrust',
		Burpees: 'burpee'
	};

	it.each(Object.entries(SUGGESTIONS))("matches M2's suggestion '%s' to %s", (text, key) => {
		expect(EXERCISE_SUGGESTIONS).toContain(text);
		expect(matchExercise(text, CATALOGUE)).toBe(key);
		expect(part).toContainEqual(expect.objectContaining({ key }));
	});

	it('gives null, not a guess, once a custom exercise shares a catalogue name', () => {
		const library = [...CATALOGUE, { key: 'custom:1', name: 'Lunges', aliases: [] }];
		expect(matchExercise('Lunges', library)).toBeNull();
		expect(matchExercise('Walking lunges', library)).toBe('walking_lunge');
	});
});
