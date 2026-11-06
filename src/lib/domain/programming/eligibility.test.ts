/**
 * eligibility.ts: only available equipment, injuries and movements to avoid ruled out, dislikes
 * never prescribed, likes and skill ranked, and a reason for every exclusion and empty slot.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueByKey } from '../exercises/index';
import { LIFTS } from '../profile/catalog';
import type { Equipment } from '../profile/catalog';
import type { TrainingProfile } from '../profile/types';
import { SKILL_LEVELS } from '../training/vocabulary';
import {
	avoidanceFor,
	candidates,
	isEligible,
	NOTHING_IN_LIBRARY,
	skillCap,
	whyNothingFits
} from './eligibility';
import type { Slot } from './eligibility';
import { buildProgrammingInput } from './input';
import type { InputInjury, ProgrammingInput } from './input';
import { GYM_PRESETS } from './rules/defaults';

/** A fresh input each call, as the eligibility caches are per input object. */
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

const injury = (over: Partial<InputInjury>): InputInjury => ({
	bodyArea: 'shoulder',
	side: 'left',
	severity: 'moderate',
	avoid: [],
	...over
});

const exercise = (key: string) => {
	const found = catalogueByKey.get(key);
	if (!found) throw new Error(`No catalogue exercise '${key}'`);
	return found;
};

/** The reasons `key` is not eligible, or [] when it is. */
const reasonsFor = (key: string, of: ProgrammingInput) => {
	const result = isEligible(exercise(key), of);
	return result.ok ? [] : result.reasons;
};
const eligible = (key: string, of: ProgrammingInput) => isEligible(exercise(key), of).ok;

describe('equipment', () => {
	const dumbbellsOnly = input({ equipment: ['dumbbells'] });
	const needs = (e: (typeof CATALOGUE)[number], item: Equipment) => e.equipment.includes(item);

	it('with dumbbells only, allows dumbbell and bodyweight work and nothing else', () => {
		const allowed = CATALOGUE.filter((e) => e.equipment.every((item) => item === 'dumbbells'));
		expect(allowed.some((e) => e.equipment.length === 0)).toBe(true);
		expect(allowed.some((e) => e.equipment.includes('dumbbells'))).toBe(true);
		for (const e of CATALOGUE) {
			expect(isEligible(e, dumbbellsOnly).ok, e.key).toBe(allowed.includes(e));
		}
	});

	it('with dumbbells only, excludes barbell, machine and cable work, naming what is missing', () => {
		const words = { barbell: 'a barbell', machines: 'a machine', cables: 'a cable station' };
		for (const [item, text] of Object.entries(words) as [Equipment, string][]) {
			const needing = CATALOGUE.filter((e) => needs(e, item));
			expect(needing.length, item).toBeGreaterThan(5);
			for (const e of needing) {
				const result = isEligible(e, dumbbellsOnly);
				expect(result.ok, e.key).toBe(false);
				const [reason] = result.ok ? [] : result.reasons;
				expect(reason).toMatchObject({ kind: 'equipment' });
				expect(reason?.text, e.key).toContain(text);
			}
		}
		expect(reasonsFor('back_squat', dumbbellsOnly)).toEqual([
			{
				kind: 'equipment',
				text: 'Needs a barbell and a squat rack',
				missing: ['barbell', 'squat_rack']
			}
		]);
		expect(reasonsFor('dumbbell_bench_press', dumbbellsOnly)).toEqual([
			{ kind: 'equipment', text: 'Needs a bench', missing: ['bench'] }
		]);
	});
});

describe('injuries and movements to avoid', () => {
	it('a moderate shoulder injury plus “overhead pressing” rules out overhead pressing only', () => {
		const shoulder = input({ injuries: [injury({ avoid: ['overhead pressing'] })] });
		for (const key of [
			'overhead_press',
			'push_press',
			'push_jerk',
			'split_jerk',
			'handstand_push_up'
		]) {
			const reasons = reasonsFor(key, shoulder);
			expect(
				reasons.map((r) => r.kind),
				key
			).toEqual(['injury', 'avoid']);
			expect(reasons[0]?.text).toMatch(/^Your moderate left shoulder injury rules out /);
			expect(reasons[1]?.text).toBe('You asked to avoid “overhead pressing”');
		}
		expect(reasonsFor('overhead_press', shoulder)[0]?.text).toBe(
			'Your moderate left shoulder injury rules out overhead work'
		);
		expect(eligible('landmine_press', shoulder)).toBe(true);
		expect(eligible('half_kneeling_landmine_press', shoulder)).toBe(true);
		const horizontal = CATALOGUE.filter((e) => e.pattern === 'horizontal_push');
		expect(horizontal.length).toBeGreaterThan(5);
		for (const e of horizontal) expect(isEligible(e, shoulder).ok, e.key).toBe(true);
	});

	it('a knee injury plus “jumping” rules out impact plyometrics, the text adding the rest', () => {
		const gym = { equipment: [...GYM_PRESETS.commercial, 'plyo_box' as const] };
		const knee = input({
			...gym,
			injuries: [injury({ bodyArea: 'knee', side: 'right', severity: 'mild', avoid: ['jumping'] })]
		});
		const plyometrics = CATALOGUE.filter((e) => e.pattern === 'plyometric');
		const impact = CATALOGUE.filter((e) => e.tags.includes('high_impact'));
		expect(impact.filter((e) => e.pattern === 'plyometric').length).toBeGreaterThan(5);
		for (const e of [...plyometrics, ...impact]) expect(isEligible(e, knee).ok, e.key).toBe(false);
		expect(reasonsFor('squat_jump', knee)).toEqual([
			{ kind: 'injury', text: 'Your mild right knee injury rules out hard landings' },
			{ kind: 'avoid', text: 'You asked to avoid “jumping”' }
		]);
		// A box jump lands on the box: only the movement to avoid leaves it out.
		expect(reasonsFor('box_jump', knee).map((r) => r.kind)).toEqual(['avoid']);
		const kneeAlone = input({ ...gym, injuries: [injury({ bodyArea: 'knee', severity: 'mild' })] });
		expect(eligible('box_jump', kneeAlone)).toBe(true);
		expect(eligible('squat_jump', kneeAlone)).toBe(false);
		expect(eligible('goblet_squat', knee)).toBe(true);
	});

	it('a resolved injury excludes nothing', () => {
		const shoulder = {
			bodyArea: 'shoulder',
			side: 'left',
			severity: 'severe',
			notes: null
		} as const;
		const profile = (active: boolean): TrainingProfile => ({
			profile: {
				name: 'Niko',
				weightUnit: 'kg',
				distanceUnit: 'km',
				timeZone: 'UTC',
				birthYear: null,
				nutritionPhase: null,
				targetWeight: null,
				targetDate: null,
				baselinesUnknown: false,
				onboarding: { current: 'review', completed: ['review'], skipped: [], completedAt: null },
				updatedAt: new Date(0)
			},
			bodyWeight: [],
			goals: [],
			experience: [],
			baselines: [],
			running: null,
			muayThai: null,
			equipment: null,
			injuries: [
				{
					...shoulder,
					id: '00000000-0000-4000-8000-000000000001',
					avoid: ['overhead pressing', 'jumping'],
					active,
					since: null,
					updatedAt: new Date(0)
				}
			],
			exercises: [],
			schedule: {
				daysPerWeek: 3,
				availableDays: [],
				preferredTimes: [],
				sessionMinutes: null,
				constraints: null,
				commitments: [],
				updatedAt: new Date(0)
			}
		});
		const resolved = buildProgrammingInput(profile(false), { catalogue: CATALOGUE });
		expect(avoidanceFor(resolved)).toEqual({ exclusions: [], unmatched: [] });
		for (const e of CATALOGUE) {
			expect(
				reasonsFor(e.key, resolved).filter((r) => r.kind !== 'equipment'),
				e.key
			).toEqual([]);
		}
		const active = buildProgrammingInput(profile(true), { catalogue: CATALOGUE });
		expect(eligible('overhead_press', active)).toBe(false);
		expect(eligible('bench_press', active)).toBe(false);
	});
});

describe('dislikes and likes', () => {
	const rotation: Slot = { key: 'core.rotation', patterns: ['rotation'] };
	const bodyweight = { equipment: [] };

	it('a disliked exercise is never eligible, even when liked too or the only option', () => {
		expect(candidates(rotation, input(bodyweight))).toEqual({
			keys: ['russian_twist'],
			excluded: [
				{ key: 'cable_woodchop', reasons: [expect.objectContaining({ kind: 'equipment' })] },
				{ key: 'landmine_rotation', reasons: [expect.objectContaining({ kind: 'equipment' })] }
			],
			why: null
		});
		const disliked = input({
			...bodyweight,
			dislikes: ['russian_twist'],
			likes: ['russian_twist']
		});
		expect(reasonsFor('russian_twist', disliked)).toEqual([
			{ kind: 'dislike', text: 'You said you don’t like it' }
		]);
		const empty = candidates(rotation, disliked);
		expect(empty.keys).toEqual([]);
		expect(empty.excluded.map((e) => e.key)).toEqual([
			'cable_woodchop',
			'landmine_rotation',
			'russian_twist'
		]);
		expect(empty.why).toBe(
			'Needs a barbell or a cable station. You said you don’t like Russian twist'
		);
	});

	it('says why a slot is empty when equipment, an injury and a dislike empty it', () => {
		const shoulder = input({
			equipment: ['dumbbells'],
			injuries: [injury({})],
			dislikes: ['landmine_press']
		});
		const press = candidates(
			{ key: 'upper.vertical_press', patterns: ['vertical_push'] },
			shoulder
		);
		expect(press.keys).toEqual([]);
		expect(press.why).toBe(
			[
				'Needs a barbell, a squat rack, a bench or kettlebells',
				'Your moderate left shoulder injury rules out overhead work',
				'You said you don’t like Landmine press'
			].join('. ')
		);
		expect(
			press.excluded.find((e) => e.key === 'landmine_press')?.reasons.map((r) => r.kind)
		).toEqual(['equipment', 'dislike']);
		expect(candidates({ key: 'nothing', patterns: [] }, shoulder)).toEqual({
			keys: [],
			excluded: [],
			why: NOTHING_IN_LIBRARY
		});
		expect(whyNothingFits([], shoulder)).toBe(NOTHING_IN_LIBRARY);
	});

	const squat: Slot = { key: 'lower.squat', patterns: ['squat'] };
	const seeds = ['lower.squat', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];

	it('ranks a liked exercise first among equals, whatever the seed', () => {
		const liked = input({ likes: ['goblet_squat'] });
		const plain = input();
		for (const key of seeds) {
			expect(candidates({ ...squat, key }, liked).keys[0], key).toBe('goblet_squat');
		}
		const firsts = new Set(seeds.map((key) => candidates({ ...squat, key }, plain).keys[0]));
		expect(firsts.size).toBeGreaterThan(1);
	});

	it('ranks exercises within the owner’s skill before harder ones, unless liked', () => {
		const skill = (key: string) => SKILL_LEVELS.indexOf(exercise(key).skillLevel);
		for (const key of seeds) {
			const keys = candidates({ ...squat, key }, input()).keys;
			const harder = keys.findIndex((k) => skill(k) > 0);
			expect(harder, key).toBeGreaterThan(0);
			expect(
				keys.slice(harder).every((k) => skill(k) > 0),
				key
			).toBe(true);
		}
		expect(candidates(squat, input({ likes: ['front_squat'] })).keys[0]).toBe('front_squat');
		const advanced = input({ experience: { strength: 'new', weightlifting: 'advanced' } });
		expect(skillCap(advanced)).toBe(2);
		expect(skillCap(advanced, 'strength')).toBe(0);
		expect(skillCap(advanced, 'muay_thai')).toBe(2);
		expect(skillCap(input({ experience: {} }))).toBe(0);
	});

	it('gives one order for one seed, and the same set under another seed', () => {
		const first = candidates(squat, input());
		expect(candidates(squat, input())).toEqual(first);
		const other = candidates({ ...squat, key: 'upper.squat' }, input());
		expect(other.keys).not.toEqual(first.keys);
		expect([...other.keys].sort()).toEqual([...first.keys].sort());
		expect(first.keys.length).toBeGreaterThan(5);
	});
});
