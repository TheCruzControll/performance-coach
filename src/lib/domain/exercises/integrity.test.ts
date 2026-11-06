/**
 * The exercise library's data. parseTable checks each row's fields as a part loads (an unknown
 * key, a bad rep range or a time measure without seconds throws on import), so these cases check
 * what no single row can: uniqueness across parts, the substitution groups, the links to M2 and
 * what each part must cover.
 *
 * Layout: 'the whole catalogue' holds the invariants every part keeps, and 'what the whole
 * catalogue covers' the brief's counts. Each part then has its own block: part 1
 * (catalogue/lower.ts), then part 2 (catalogue/upper.ts).
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT, EXERCISE_SUGGESTIONS, LIFTS, LIFT_LABEL } from '../profile/catalog';
import type { Equipment } from '../profile/catalog';
import { MOVEMENT_PATTERNS } from '../training/vocabulary';
import * as lower from './catalogue/lower';
import * as upper from './catalogue/upper';
import { CATALOGUE, SUBSTITUTION_GROUPS, catalogueByKey, type CatalogueExercise } from './index';
import { NOT_EXERCISES, matchExercise, normaliseExerciseName } from './match';

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

describe('what the whole catalogue covers', () => {
	it('has at least 150 entries, as the brief asks', () => {
		expect(CATALOGUE.length).toBeGreaterThanOrEqual(150);
	});

	it('gives every movement pattern at least 3 entries', () => {
		const thin = MOVEMENT_PATTERNS.filter(
			(pattern) => CATALOGUE.filter((e) => e.pattern === pattern).length < 3
		);
		expect(thin).toEqual([]);
	});

	/** The brief's categories, each found by its M2 equipment key or by its pattern. */
	const CATEGORIES: [string, number, (exercise: CatalogueExercise) => boolean][] = [
		['barbell', 15, (e) => e.equipment.includes('barbell')],
		['dumbbell', 15, (e) => e.equipment.includes('dumbbells')],
		['machine', 8, (e) => e.equipment.includes('machines')],
		['cable', 8, (e) => e.equipment.includes('cables')],
		// Trainable anywhere: no equipment, and the body is the load.
		['bodyweight', 15, (e) => needsOnly(e) && e.loadType === 'bodyweight'],
		['kettlebell', 6, (e) => e.equipment.includes('kettlebells')],
		['Olympic', 6, (e) => e.pattern === 'olympic'],
		['plyometric', 8, (e) => e.pattern === 'plyometric'],
		['conditioning', 8, (e) => e.pattern === 'conditioning'],
		['mobility', 10, (e) => e.pattern === 'mobility']
	];

	it.each(CATEGORIES)('has %s work: at least %i entries', (_category, minimum, isIn) => {
		expect(CATALOGUE.filter(isIn).length).toBeGreaterThanOrEqual(minimum);
	});

	it('measures conditioning and mobility in time or distance, never in reps', () => {
		const counted = CATALOGUE.filter(
			(e) => ['conditioning', 'mobility'].includes(e.pattern) && e.measure === 'reps'
		);
		expect(keys(counted)).toEqual([]);
	});

	it('rates every Olympic entry intermediate or above', () => {
		const easy = CATALOGUE.filter((e) => e.pattern === 'olympic' && e.skillLevel === 'beginner');
		expect(keys(easy)).toEqual([]);
	});

	it('links every M2 lift but custom to an entry', () => {
		const unlinked = LIFTS.filter(
			(lift) => lift !== 'custom' && !CATALOGUE.some((e) => e.baselineLift === lift)
		);
		expect(unlinked).toEqual([]);
	});

	it('matches every M2 suggestion to an entry, unless NOT_EXERCISES lists it', () => {
		const unmatched = EXERCISE_SUGGESTIONS.filter(
			(text) => matchExercise(text, CATALOGUE) === null && !NOT_EXERCISES.includes(text)
		);
		expect(unmatched).toEqual([]);
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

describe('part 2: pressing, pulling, arms, carries, core, neck and upper mobility', () => {
	const part = upper.exercises;

	it('has at least 75 entries, each in one of its substitution groups', () => {
		expect(part.length).toBeGreaterThanOrEqual(75);
		expect(keys(part.filter((e) => !e.substitutionGroup))).toEqual([]);
	});

	it('has the groups the rest of M3 names', () => {
		for (const group of [
			'horizontal_press',
			'vertical_press_overhead',
			'vertical_press_shoulder_friendly',
			'horizontal_row',
			'vertical_pull',
			'elbow_flexion',
			'elbow_extension',
			'loaded_carry',
			'anti_rotation'
		]) {
			expect(upper.groups, group).toHaveProperty(group);
		}
	});

	it('keeps one measure within each group, so a swap keeps its prescription', () => {
		for (const group of Object.keys(upper.groups)) {
			expect(new Set(membersOf(group).map((e) => e.measure)).size, group).toBe(1);
		}
	});

	it('flags single-arm rows and presses, offset carries and rotation work unilateral', () => {
		// Pressed one arm at a time, though their names do not say so.
		const oneArm = ['half_kneeling_landmine_press', 'bottoms_up_kettlebell_press'];
		const oneSided = part.filter(
			(e) =>
				oneArm.includes(e.key) ||
				e.substitutionGroup === 'offset_carry' ||
				// A twist, or a twisting pull resisted, works one side at a time.
				e.pattern === 'rotation' ||
				e.pattern === 'anti_rotation' ||
				[e.name, ...e.aliases].some((term) => /single-arm|one-arm|suitcase/i.test(term))
		);
		expect(keys(oneSided)).toEqual(
			expect.arrayContaining([
				'single_arm_dumbbell_overhead_press',
				'kettlebell_press',
				'landmine_press',
				...oneArm,
				'single_arm_dumbbell_row',
				'cable_lateral_raise',
				'suitcase_carry',
				'waiters_walk',
				'pallof_press',
				'side_plank',
				'cable_woodchop'
			])
		);
		expect(keys(oneSided.filter((e) => !e.unilateral))).toEqual([]);
	});

	it('tags the standing barbell presses and the barbell row spinal_loading', () => {
		const loaded = part.filter(
			(e) =>
				e.equipment.includes('barbell') &&
				e.loadType === 'external' &&
				(e.substitutionGroup === 'vertical_press_overhead' ||
					e.substitutionGroup === 'horizontal_row')
		);
		expect(keys(loaded)).toEqual(
			expect.arrayContaining(['overhead_press', 'push_press', 'barbell_row'])
		);
		expect(keys(loaded.filter((e) => !e.tags.includes('spinal_loading')))).toEqual([]);
	});

	it('tags every overhead press overhead, and keeps the shoulder-friendly press off it', () => {
		const overhead = membersOf('vertical_press_overhead');
		const friendly = membersOf('vertical_press_shoulder_friendly');
		expect(keys(overhead)).toEqual(
			expect.arrayContaining(['overhead_press', 'push_press', 'handstand_push_up'])
		);
		expect(keys(overhead.filter((e) => !e.tags.includes('overhead')))).toEqual([]);
		// An owner who cannot press overhead keeps a vertical press: the landmine press.
		expect(keys(friendly)).toContain('landmine_press');
		const notFriendly = friendly.filter(
			(e) => e.tags.includes('overhead') || !e.tags.includes('shoulder_friendly')
		);
		expect(keys(notFriendly)).toEqual([]);
	});

	it('never tags a horizontal push overhead, so horizontal pressing stays open', () => {
		const overhead = part.filter(
			(e) => e.pattern === 'horizontal_push' && e.tags.includes('overhead')
		);
		expect(keys(overhead)).toEqual([]);
	});

	/**
	 * What the brief's dumbbells-only gym can do. Upper-body dumbbell work mostly lies or sits on
	 * a bench, and that scenario (m3/17) counts one in, so a bench is allowed here.
	 */
	const dumbbellsOnly = (e: CatalogueExercise) =>
		needsOnly(e, 'dumbbells') || needsOnly(e, 'dumbbells', 'bench');

	it.each(['horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull'] as const)(
		'gives %s work ≥ 2 dumbbell-only options, a bench allowed',
		(pattern) => {
			const options = part.filter((e) => e.pattern === pattern && dumbbellsOnly(e));
			expect(options.length).toBeGreaterThanOrEqual(2);
		}
	);

	it.each(['bench_press', 'overhead_press', 'weighted_pull_up'] as const)(
		'links %s to its M2 lift',
		(lift) => {
			expect(part.find((e) => e.baselineLift === lift)?.key).toBe(lift);
		}
	);

	const SUGGESTIONS: Record<string, string> = {
		'Bench press': 'bench_press',
		'Overhead press': 'overhead_press',
		'Pull-ups': 'pull_up',
		Dips: 'dip'
	};

	it.each(Object.entries(SUGGESTIONS))("matches M2's suggestion '%s' to %s", (text, key) => {
		expect(EXERCISE_SUGGESTIONS).toContain(text);
		expect(matchExercise(text, CATALOGUE)).toBe(key);
		expect(part).toContainEqual(expect.objectContaining({ key }));
	});

	it("leaves M2's 'Running intervals' unmatched: running is planned as run segments", () => {
		expect(EXERCISE_SUGGESTIONS).toContain('Running intervals');
		expect(NOT_EXERCISES).toContain('Running intervals');
		expect(matchExercise('Running intervals', CATALOGUE)).toBeNull();
	});
});
