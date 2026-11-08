/**
 * pain.ts on the catalogue: gentler options keep the alternatives' intent, never include the
 * original or anything harder, avoid what the sore area's rules leave out, respect equipment and
 * dislikes, rank toward the gentlest, and an empty list is explained.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueByKey } from '../exercises/index';
import { BODY_AREAS, LIFTS } from '../profile/catalog';
import type { BodyArea } from '../profile/catalog';
import type { ExerciseTag } from '../training/vocabulary';
import { SKILL_LEVELS } from '../training/vocabulary';
import { alternativesFor } from './alternatives';
import type { ProgrammingInput } from './input';
import { gentlerFor } from './pain';
import { GYM_PRESETS } from './rules/defaults';
import { PAIN_RULES } from './rules/pain';

function input(over: Partial<ProgrammingInput> = {}): ProgrammingInput {
	return {
		goals: [],
		paused: [],
		maintenance: false,
		disciplines: ['strength'],
		experience: { strength: 'advanced' },
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
const skill = (key: string) => SKILL_LEVELS.indexOf(exercise(key).skillLevel);
const keys = (of: { key: string }[]) => of.map((e) => e.key);

/** The tags each area's pain must never be offered, as the plan states them. */
const STRESS_TAGS: Partial<Record<BodyArea, ExerciseTag[]>> = {
	shoulder: ['overhead'],
	knee: ['high_impact', 'deep_knee_flexion'],
	lower_back: ['spinal_loading'],
	wrist_hand: ['wrist_loading']
};

describe('gentlerFor', () => {
	const commercial = input();

	it('never offers the original or anything harder, for any exercise and area', () => {
		let offered = 0;
		for (const { key } of CATALOGUE) {
			for (const area of BODY_AREAS) {
				const { options } = gentlerFor(key, commercial, area);
				offered += options.length;
				expect(keys(options), `${key} / ${area}`).not.toContain(key);
				for (const option of options) {
					expect(skill(option.key), `${option.key} for ${key}`).toBeLessThanOrEqual(skill(key));
				}
				expect(options.length).toBeLessThanOrEqual(PAIN_RULES.limit.value);
			}
		}
		expect(offered).toBeGreaterThan(1000);
	});

	it('offers only alternatives, so the intent is kept', () => {
		for (const { key } of CATALOGUE) {
			const alternatives = keys(alternativesFor(key, commercial).alternatives);
			for (const area of BODY_AREAS) {
				for (const option of gentlerFor(key, commercial, area).options) {
					expect(alternatives).toContain(option.key);
				}
			}
		}
	});

	it("avoids each area's stress tags", () => {
		for (const [area, tags] of Object.entries(STRESS_TAGS) as [BodyArea, ExerciseTag[]][]) {
			let checked = 0;
			for (const { key } of CATALOGUE) {
				for (const option of gentlerFor(key, commercial, area).options) {
					checked++;
					const has = exercise(option.key).tags.filter((tag) => tags.includes(tag));
					expect(has, `${option.key} for ${key}, ${area}`).toEqual([]);
				}
			}
			expect(checked, area).toBeGreaterThan(50);
		}
	});

	it('swaps an overhead press for a sore shoulder to a press that is not overhead', () => {
		const ordinary = keys(alternativesFor('overhead_press', commercial).alternatives);
		expect(ordinary.some((key) => exercise(key).tags.includes('overhead'))).toBe(true);
		const { options, blocked } = gentlerFor('overhead_press', commercial, 'shoulder');
		expect(keys(options)).toContain('landmine_press');
		expect(blocked).toContainEqual({
			key: 'standing_dumbbell_shoulder_press',
			reasons: ['Pain in your shoulder rules out overhead work']
		});
	});

	it('ranks toward lower skill, then less load and impact, then a machine or cable', () => {
		const rank = (key: string) => {
			const e = exercise(key);
			return [
				skill(key),
				e.tags.filter((tag) => PAIN_RULES.loadTags.value.includes(tag)).length,
				e.equipment.some((item) => PAIN_RULES.supportedEquipment.value.includes(item)) ? 0 : 1
			];
		};
		const ordered = (a: number[], b: number[]) => {
			const at = a.findIndex((value, i) => value !== b[i]);
			return at < 0 || a[at]! < b[at]!;
		};
		for (const { key } of CATALOGUE) {
			for (const area of BODY_AREAS) {
				const ranks = gentlerFor(key, commercial, area).options.map((o) => rank(o.key));
				for (let i = 1; i < ranks.length; i++) {
					expect(ordered(ranks[i - 1]!, ranks[i]!), `${key} / ${area}`).toBe(true);
				}
			}
		}
		// A back squat for a sore lower back: a machine squat that loads no spine comes first.
		const [first] = gentlerFor('back_squat', commercial, 'lower_back').options;
		expect(first).toMatchObject({ key: 'belt_squat', gentler: ['lessLoad', 'supported'] });
		expect(exercise('belt_squat').equipment).toContain('machines');
	});

	it('respects equipment and dislikes', () => {
		const liked = gentlerFor('back_squat', input({ equipment: ['dumbbells'] }), 'shoulder');
		const [best] = keys(liked.options);
		expect(best).toBeDefined();
		const dumbbells = input({ equipment: ['dumbbells'], dislikes: [best!] });
		const { options } = gentlerFor('back_squat', dumbbells, 'shoulder');
		expect(options.length).toBeGreaterThan(0);
		expect(keys(options)).not.toContain(best);
		for (const option of options) {
			expect(exercise(option.key).equipment.every((item) => item === 'dumbbells')).toBe(true);
		}
	});

	it('explains an empty result: the area, a harder movement or the equipment', () => {
		const dumbbells = input({ equipment: ['dumbbells'] });
		expect(gentlerFor('overhead_press', dumbbells, 'shoulder')).toMatchObject({
			options: [],
			why: expect.stringContaining('Pain in your shoulder rules out overhead work')
		});
		const bodyweight = input({ equipment: [] });
		expect(gentlerFor('power_clean', bodyweight, 'knee')).toMatchObject({
			options: [],
			why: expect.stringMatching(/^Needs a barbell\b/)
		});
		expect(gentlerFor('back_squat', commercial, 'knee').why).toBeNull();
	});

	it('throws on an unknown exercise', () => {
		expect(() => gentlerFor('no_such_exercise', commercial, 'knee')).toThrow(RangeError);
	});
});
