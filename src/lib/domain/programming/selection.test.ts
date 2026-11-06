/**
 * selection.ts: every slot filled from the eligible candidates by key, so equipment, injuries,
 * movements to avoid and dislikes hold; a lift slot takes compound work and an accessory slot an
 * accessory whenever one is eligible; likes win among equals; a lift that may not be done
 * gives way to one that keeps its intent; an empty slot, a dislike and an unread avoidance each
 * say why; the same input gives the same week; sets follow the split's style.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueByKey, SUBSTITUTION_GROUPS } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type { DecisionPlan } from '../training/types';
import { DecisionLog } from './decisions';
import { candidates } from './eligibility';
import type { LibraryExercise } from './eligibility';
import { buildProgrammingInput } from './input';
import type { InputCustomExercise, ProgrammingInput } from './input';
import { isAccessory, SLOT_KINDS, STYLES } from './rules/strength';
import type { SlotKind } from './rules/strength';
import { SCENARIOS } from './scenarios';
import type { ScenarioKey } from './scenarios';
import { exerciseOf, plannedExercise, selectWeek } from './selection';
import type { DaySelection, Selected } from './selection';
import { chooseSplit } from './splits';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** A week's selection for `input` on `days` strength days, with its decisions. */
function select(input: ProgrammingInput, days: number) {
	const log = new DecisionLog();
	const week = selectWeek(chooseSplit(input, days), input, log);
	return { week, decisions: log.list() };
}

const keysOf = (week: DaySelection[]) =>
	week.flatMap((d) => d.exercises.map((e) => e.exercise.key));
const ofKind = (decisions: DecisionPlan[], kind: DecisionPlan['kind']) =>
	decisions.filter((d) => d.kind === kind);

describe('selectWeek', () => {
	it('keeps an injured shoulder clear of overhead work, the overhead press giving way with a decision', () => {
		const { week, decisions } = select(inputOf(SCENARIOS.injuredShoulder()), 4);
		const chosen = week.flatMap((d) => d.exercises.map((e) => e.exercise));
		expect(chosen.filter((e) => e.tags.includes('overhead'))).toEqual([]);
		const pressing = chosen.filter((e) => e.pattern === 'vertical_push');
		expect(pressing.length).toBeGreaterThan(0);
		for (const e of pressing) expect(e.substitutionGroup).toBe('vertical_press_shoulder_friendly');
		const press = ofKind(decisions, 'exercise_substituted').find(
			(d) => d.evidence.original === 'Overhead press'
		);
		expect(press?.why).toContain(
			'Overhead press would be the usual choice, but your moderate left shoulder injury rules out overhead work.'
		);
		expect(press?.evidence.intent).toBe(SUBSTITUTION_GROUPS.vertical_press_shoulder_friendly);
	});

	it('gives a lift the equipment rules out a stand-in that keeps its intent, every time it comes up', () => {
		const { week, decisions } = select(inputOf(SCENARIOS.dumbbellsOnly()), 3);
		for (const e of week.flatMap((d) => d.exercises)) {
			expect(e.exercise.equipment.every((item) => ['dumbbells', 'bench'].includes(item))).toBe(
				true
			);
		}
		const squats = week.map((d) =>
			d.exercises.find((e) => e.role === 'main' && e.kind === 'squat')
		);
		expect(squats[0]?.exercise.key).toBe(squats[2]?.exercise.key);
		expect(squats[0]?.exercise.substitutionGroup).toBe('knee_dominant_bilateral');
		const squat = ofKind(decisions, 'exercise_substituted').find(
			(d) => d.evidence.original === 'Back squat'
		)!;
		expect(squat.evidence).toEqual({
			exercise: squats[0]!.exercise.name,
			original: 'Back squat',
			reason: 'it needs a barbell and a squat rack',
			intent: SUBSTITUTION_GROUPS.knee_dominant_bilateral
		});
		// A substituted lift is recorded once, by its substitution.
		expect(ofKind(decisions, 'exercise_selected').map((d) => d.evidence.exercise)).not.toContain(
			squats[0]!.exercise.name
		);
	});

	it('records each main lift and why it fills its slot', () => {
		const reasons = (key: ScenarioKey, days: number) =>
			ofKind(select(inputOf(SCENARIOS[key]()), days).decisions, 'exercise_selected').map(
				(d) => `${d.summary}: ${d.ruleKey}`
			);
		expect(reasons('minimal', 3)).toEqual([
			'Back squat for the main squat: strength.baseline',
			'Bench press for the main horizontal push: strength.baseline',
			'Deadlift for the main hinge: strength.baseline',
			'Overhead press for the main vertical push: strength.baseline'
		]);
		expect(reasons('powerlifter', 4)).toEqual([
			'Back squat for the main squat: strength.competition',
			'Bench press for the main horizontal push: strength.competition',
			'Deadlift for the main hinge: strength.competition'
		]);
		expect(reasons('injuredShoulder', 4)).toContain(
			'Back squat for the main squat: strength.measured'
		);
		const [decision] = ofKind(
			select(inputOf(SCENARIOS.powerlifter()), 4).decisions,
			'exercise_selected'
		);
		expect(decision).toMatchObject({
			why: 'Back squat fills the main squat slot: it is the competition lift, practised as it is tested.',
			refs: ['blocks.0']
		});
	});

	it('prefers a liked exercise among equals', () => {
		const input = inputOf(SCENARIOS.minimal());
		const core = (week: DaySelection[]) => week[0]!.exercises.find((e) => e.kind === 'core')!;
		const usual = core(select(input, 3).week).exercise.key;
		const slot = { key: 'test', patterns: SLOT_KINDS.core.patterns };
		const other = candidates(slot, input).keys.find(
			(key) => key !== usual && isAccessory(exerciseOf(input, key)!)
		)!;
		expect(core(select({ ...input, likes: [other] }, 3).week).exercise.key).toBe(other);
	});

	it.each([
		['minimal', 3],
		['dumbbellsOnly', 3],
		['injuredShoulder', 4],
		['hybrid', 2]
	] as const)(
		'%s: lifts fill lift slots and accessories fill accessory slots, when they can',
		(key, days) => {
			const input = inputOf(SCENARIOS[key]());
			const titles = chooseSplit(input, days).days.map((day) => day.title);
			select(input, days).week.forEach(({ exercises }, d) => {
				for (const { role, kind, exercise } of exercises) {
					const { patterns, muscles }: SlotKind = SLOT_KINDS[kind];
					const eligible = candidates({ key: 'test', patterns }, input)
						.keys.map((k) => exerciseOf(input, k)!)
						.filter((e) => !muscles || e.primaryMuscles.some((m) => muscles.includes(m)));
					const ofItsKind = (e: LibraryExercise) => (role === 'accessory') === isAccessory(e);
					if (!eligible.some(ofItsKind)) continue;
					expect({
						day: titles[d],
						slot: kind,
						exercise: exercise.key,
						ofItsKind: ofItsKind(exercise)
					}).toMatchObject({ ofItsKind: true });
				}
			});
		}
	);

	it('never selects a disliked exercise, saying so once for each', () => {
		const input = inputOf(SCENARIOS.minimal());
		const usual = keysOf(select(input, 3).week);
		const disliked = { ...input, dislikes: [...new Set(usual)] };
		const { week, decisions } = select(disliked, 3);
		const chosen = keysOf(week);
		expect(chosen.length).toBe(usual.length);
		expect(chosen.filter((key) => usual.includes(key))).toEqual([]);
		expect(ofKind(decisions, 'exercise_excluded').map((d) => d.evidence)).toEqual(
			[...new Set(usual)].map((key) => ({
				exercise: catalogueByKey.get(key)!.name,
				reason: 'you said you don’t like it'
			}))
		);
		expect(
			ofKind(decisions, 'exercise_substituted').find((d) => d.evidence.original === 'Back squat')
				?.evidence.reason
		).toBe('you said you don’t like it');
	});

	it('leaves a slot nothing can fill empty, with a slot_empty decision that says why', () => {
		const p = SCENARIOS.injuredShoulder();
		p.equipment = {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: null,
			updatedAt: new Date(0)
		};
		const input = inputOf(p);
		expect(input.equipment).toEqual([]);
		const { week, decisions } = select(input, 3);
		const pressing = week
			.flatMap((d) => d.exercises)
			.filter((e) => e.exercise.pattern === 'vertical_push');
		expect(pressing).toEqual([]);
		const empty = ofKind(decisions, 'slot_empty').find(
			(d) => d.evidence.slot === 'main vertical push'
		)!;
		expect(empty.summary).toBe('Nothing fits the main vertical push slot');
		expect(empty.evidence.sessions).toBe('Full body B');
		expect(empty.evidence.reason).toContain('Needs a barbell');
		expect(empty.evidence.reason).toContain(
			'Your moderate left shoulder injury rules out overhead work'
		);
		expect(empty.why).toMatch(
			/^Nothing in the library can fill the main vertical push slot in Full body B\. Needs .+\. The rest of the session goes ahead\.$/
		);
		// The rest of Full body B goes ahead.
		expect(week[1]!.exercises.length).toBeGreaterThan(0);
	});

	it('fills a slot with one of the owner’s own exercises by its key when it is liked', () => {
		const own: InputCustomExercise = {
			key: 'custom:00000000-0000-4000-8000-000000000900',
			name: 'Sandbag squat',
			aliases: [],
			pattern: 'squat',
			primaryMuscles: ['quads', 'glutes'],
			secondaryMuscles: [],
			equipment: [],
			substitutionGroup: null,
			skillLevel: 'beginner',
			repMin: 8,
			repMax: 12,
			defaultSeconds: null,
			unilateral: false,
			measure: 'reps',
			loadType: 'external',
			tags: ['compound'],
			disciplines: []
		};
		const p = SCENARIOS.minimal();
		p.goals[0]!.disciplines = ['hypertrophy'];
		const input = { ...inputOf(p), customExercises: [own], likes: [own.key] };
		const { week, decisions } = select(input, 3);
		const squat = week[0]!.exercises.find((e) => e.kind === 'squat')!;
		expect(squat.exercise.key).toBe(own.key);
		expect(plannedExercise(squat, chooseSplit(input, 3), 7).exercise).toEqual({
			customId: '00000000-0000-4000-8000-000000000900'
		});
		expect(ofKind(decisions, 'exercise_selected')[0]).toMatchObject({
			summary: 'Sandbag squat for the main squat',
			ruleKey: 'strength.liked'
		});
	});

	it('records each movement to avoid that it could not read', () => {
		const p = SCENARIOS.injuredShoulder();
		p.injuries[0]!.avoid = ['overhead pressing', 'trampolines'];
		const { decisions } = select(inputOf(p), 4);
		expect(ofKind(decisions, 'unmapped_avoidance').map((d) => d.summary)).toEqual([
			'Could not match “trampolines”'
		]);
	});

	it('uses an exercise once a day and gives the same week for the same input', () => {
		for (const [key, days] of [
			['minimal', 3],
			['powerlifter', 4],
			['hybrid', 2],
			['dumbbellsOnly', 3],
			['injuredShoulder', 4]
		] as const) {
			const once = select(inputOf(SCENARIOS[key]()), days);
			for (const day of once.week) {
				const keys = day.exercises.map((e) => e.exercise.key);
				expect(new Set(keys).size).toBe(keys.length);
			}
			expect(select(structuredClone(inputOf(SCENARIOS[key]())), days)).toEqual(once);
		}
	});
});

describe('plannedExercise', () => {
	const input = inputOf(SCENARIOS.minimal());
	const split = chooseSplit(input, 3);
	const as = (role: Selected['role'], key: string): Selected => ({
		role,
		kind: 'squat',
		exercise: exerciseOf(input, key)!
	});

	it('gives a main lift a top set at the week’s cap and back-offs a point under it', () => {
		const planned = plannedExercise(as('main', 'back_squat'), split, 7.5);
		expect(planned).toMatchObject({
			exercise: { key: 'back_squat' },
			baselineLift: 'back_squat',
			substitutedFrom: null,
			superset: null
		});
		expect(
			planned.sets.map((s) => [s.role, s.sets, s.repsMin, s.repsMax, s.targetRpe, s.restSeconds])
		).toEqual([
			['top', 1, 5, 5, 7.5, STYLES.strength.main.rest],
			['back_off', STYLES.strength.main.sets, 5, 5, 6.5, STYLES.strength.main.rest]
		]);
		expect(planned.sets.every((s) => s.loadKind === 'rpe_based' && s.loadValue === null)).toBe(
			true
		);
		// A lift whose range starts above the style's reps is held to its own range.
		expect(plannedExercise(as('main', 'goblet_squat'), split, 7).sets[0]).toMatchObject({
			repsMin: 8,
			repsMax: 8
		});
	});

	it('clamps secondary reps into the exercise’s range and gives accessories their own', () => {
		const secondary = plannedExercise(as('secondary', 'romanian_deadlift'), split, 8.5).sets;
		expect(secondary).toMatchObject([
			{ role: 'working', sets: 3, repsMin: 6, repsMax: 8, targetRpe: 7, restSeconds: 90 }
		]);
		const accessory = plannedExercise(as('accessory', 'face_pull'), split, 6).sets;
		expect(accessory).toMatchObject([{ role: 'working', repsMin: 12, repsMax: 20, targetRpe: 6 }]);
	});

	it('measures a hold in its seconds and a carry in metres', () => {
		expect(plannedExercise(as('accessory', 'plank'), split, 7).sets[0]).toMatchObject({
			repsMin: null,
			repsMax: null,
			seconds: 45,
			metres: null
		});
		expect(plannedExercise(as('accessory', 'farmers_carry'), split, 7).sets[0]).toMatchObject({
			repsMin: null,
			seconds: null,
			metres: 40
		});
	});
});
