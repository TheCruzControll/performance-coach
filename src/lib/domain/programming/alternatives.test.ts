/**
 * alternatives.ts: the substitution group first, then the same kind of movement, the closest
 * first; only eligible exercises, never the original; and blocked explains an empty list.
 */
import { describe, expect, it } from 'vitest';
import { catalogueByKey } from '../exercises/index';
import { LIFTS } from '../profile/catalog';
import { alternativesFor } from './alternatives';
import { whyNothingFits } from './eligibility';
import type { InputCustomExercise, ProgrammingInput } from './input';
import { GYM_PRESETS } from './rules/defaults';

function input(over: Partial<ProgrammingInput> = {}): ProgrammingInput {
	return {
		goals: [],
		paused: [],
		maintenance: false,
		disciplines: ['strength'],
		experience: { strength: 'new' },
		daysPerWeek: 3,
		availableDays: ['mon', 'wed', 'fri'],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: [],
		equipment: [...GYM_PRESETS.commercial],
		injuries: [],
		likes: [],
		dislikes: [],
		customExercises: [],
		baselines: Object.fromEntries(
			LIFTS.filter((l) => l !== 'custom').map((l) => [l, null])
		) as ProgrammingInput['baselines'],
		running: null,
		muayThai: null,
		nutritionPhase: null,
		bodyWeightKg: null,
		assumptions: [],
		refs: { goals: [], paused: [], commitments: [] },
		...over
	};
}

const exercise = (key: string) => catalogueByKey.get(key)!;
const keys = (of: { key: string }[]) => of.map((e) => e.key);

describe('alternativesFor', () => {
	it('swaps a back squat, with dumbbells only, for dumbbell squats and then split squats', () => {
		const { alternatives, blocked } = alternativesFor(
			'back_squat',
			input({ equipment: ['dumbbells'] })
		);
		const found = keys(alternatives);
		expect(found.slice(0, 3)).toEqual(['dumbbell_front_squat', 'goblet_squat', 'bodyweight_squat']);
		expect(alternatives.slice(0, 3).every((a) => a.via === 'group')).toBe(true);
		expect(found).toEqual(
			expect.arrayContaining(['split_squat', 'reverse_lunge', 'forward_lunge'])
		);
		expect(found).not.toContain('back_squat');
		for (const key of found) {
			expect(
				exercise(key).equipment.every((item) => item === 'dumbbells'),
				key
			).toBe(true);
		}
		// Unilateral matches are ranked by the flag: every bilateral squat comes first.
		const flags = found.map((key) => exercise(key).unilateral);
		expect(flags.indexOf(true)).toBeGreaterThan(flags.lastIndexOf(false));
		// Within the owner's skill first: the pistol squat is advanced.
		const lunges = found.filter(
			(key) => exercise(key).loadType === 'bodyweight' && exercise(key).unilateral
		);
		expect(lunges.at(-1)).toBe('pistol_squat');
		expect(blocked.find((b) => b.key === 'bulgarian_split_squat')?.reasons).toEqual([
			{ kind: 'equipment', text: 'Needs a bench', missing: ['bench'] }
		]);
	});

	it('ranks the same unilateral flag before load and skill within a tier', () => {
		const rows = keys(alternativesFor('single_arm_dumbbell_row', input()).alternatives);
		// The renegade row is the other one-arm row: first, though it is the harder one.
		expect(rows[0]).toBe('renegade_row');
		expect(exercise('renegade_row').skillLevel).toBe('intermediate');
		const bilateral = keys(alternativesFor('barbell_row', input()).alternatives);
		expect(bilateral.indexOf('inverted_row')).toBeLessThan(
			bilateral.indexOf('single_arm_dumbbell_row')
		);
	});

	it('gives a power clean no alternatives with bodyweight only, and blocked says why', () => {
		const bodyweight = input({ equipment: [] });
		const { alternatives, blocked } = alternativesFor('power_clean', bodyweight);
		expect(alternatives).toEqual([]);
		expect(keys(blocked)).toEqual(
			expect.arrayContaining(['squat_clean', 'hang_power_clean', 'dumbbell_hang_clean'])
		);
		expect(
			keys(blocked)
				.slice(0, 3)
				.every((key) => exercise(key).substitutionGroup === 'olympic_clean')
		).toBe(true);
		for (const { key, reasons } of blocked) {
			expect(
				reasons.map((r) => r.kind),
				key
			).toEqual(['equipment']);
		}
		expect(blocked.find((b) => b.key === 'squat_clean')?.reasons[0]?.text).toBe('Needs a barbell');
		expect(whyNothingFits(blocked, bodyweight)).toMatch(/^Needs a barbell, .* or dumbbells$/);
	});

	it('puts the group first, then the same kind of movement, and never the exercise itself', () => {
		const { alternatives } = alternativesFor('bench_press', input());
		expect(keys(alternatives)).not.toContain('bench_press');
		const via = alternatives.map((a) => a.via);
		expect(via.indexOf('pattern')).toBeGreaterThan(via.lastIndexOf('group'));
		expect(alternatives.filter((a) => a.via === 'pattern')).toEqual([
			{ key: 'assisted_dip', via: 'pattern' },
			{ key: 'dip', via: 'pattern' }
		]);
	});

	it('offers the same kind of movement only with a primary muscle in common', () => {
		const curls = alternativesFor('dumbbell_curl', input());
		expect(keys(curls.alternatives)).toEqual(
			expect.arrayContaining(['barbell_curl', 'hammer_curl'])
		);
		for (const key of [...keys(curls.alternatives), ...keys(curls.blocked)]) {
			expect(exercise(key).primaryMuscles, key).toContain('biceps');
		}
		expect(exercise('leg_extension')).toMatchObject({ pattern: 'isolation', measure: 'reps' });
	});

	it('keeps the measure, so the prescription still reads', () => {
		const gym = input({ equipment: [...GYM_PRESETS.commercial, 'bands'] });
		const pallof = alternativesFor('pallof_press', gym);
		expect(keys(pallof.alternatives)).toEqual(['band_pallof_press', 'bird_dog']);
		// Same pattern and muscles, but held for time: never offered for sets of reps.
		for (const key of ['side_plank', 'pallof_hold']) {
			expect(exercise(key)).toMatchObject({ pattern: 'anti_rotation', measure: 'time' });
			expect([...keys(pallof.alternatives), ...keys(pallof.blocked)]).not.toContain(key);
		}
	});

	it('ranks liked ones first in their tier, blocks disliked ones and breaks ties by key', () => {
		const plain = keys(alternativesFor('bench_press', input()).alternatives);
		const group = plain.filter((key) => exercise(key).substitutionGroup === 'horizontal_press');
		expect(group.length).toBeGreaterThan(5);
		const liked = alternativesFor(
			'bench_press',
			input({ likes: ['push_up'], dislikes: ['dumbbell_bench_press'] })
		);
		expect(keys(liked.alternatives)[0]).toBe('push_up');
		expect(keys(liked.alternatives)).not.toContain('dumbbell_bench_press');
		expect(liked.blocked).toEqual([
			{
				key: 'dumbbell_bench_press',
				reasons: [{ kind: 'dislike', text: 'You said you don’t like it' }]
			}
		]);
		// Equals keep key order: both are loaded, bilateral, beginner and share the chest.
		expect(plain.indexOf('dumbbell_bench_press')).toBeLessThan(
			plain.indexOf('machine_chest_press')
		);
		expect(alternativesFor('bench_press', input())).toEqual(
			alternativesFor('bench_press', input())
		);
	});

	it('offers the owner’s own exercises in the group, and refuses an unknown key', () => {
		const sandbag: InputCustomExercise = {
			...exercise('goblet_squat'),
			key: 'custom:00000000-0000-4000-8000-000000000001',
			name: 'Sandbag squat',
			aliases: [],
			equipment: []
		};
		const { alternatives } = alternativesFor(
			'back_squat',
			input({ equipment: [], customExercises: [sandbag] })
		);
		expect(alternatives).toContainEqual({ key: sandbag.key, via: 'group' });
		expect(() => alternativesFor('no_such_lift', input())).toThrow(
			"Unknown exercise 'no_such_lift'"
		);
	});
});
