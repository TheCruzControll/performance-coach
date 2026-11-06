import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { BASELINE_INSTRUCTION } from '../training/describe';
import type { LoadType, Measure } from '../training/vocabulary';
import type { WeightUnit } from '../units';
import { defaultMissedReps, nextSet, RPE_CHIPS, topSetOf } from './prefill';
import type { PerformedExercise, SlotSet } from './prefill';
import type {
	KitAlternative,
	KitExercise,
	KitExerciseMeta,
	KitSet,
	LoggedSet,
	PreviousPerformance
} from './types';

const DATE = '2026-11-06';
const LAST_WEEK = '2026-10-30';
const { strength } = workoutDayKits({ date: DATE });
const [SQUAT, LEG_PRESS, , PULL_UP, PLANK] = strength.exercises as [
	KitExercise,
	KitExercise,
	KitExercise,
	KitExercise,
	KitExercise
];

const meta = (
	key: string,
	name: string,
	measure: Measure,
	loadType: LoadType,
	pattern: KitExerciseMeta['pattern']
): KitExerciseMeta => ({
	id: key,
	key,
	name,
	measure,
	loadType,
	unilateral: false,
	pattern,
	tags: ['compound'],
	restClass: 'compound',
	increment: 2.5
});

const HACK_SQUAT = meta('hack_squat', 'Hack squat', 'reps', 'external', 'squat');
const GOBLET_SQUAT = meta('goblet_squat', 'Goblet squat', 'reps', 'external', 'squat');
const ASSISTED_PULL_UP = meta(
	'assisted_pull_up',
	'Assisted pull-up',
	'reps',
	'assisted',
	'vertical_pull'
);
const SLED_PUSH = meta('sled_push', 'Sled push', 'distance', 'external', 'conditioning');

/** A set as the owner did it; each test fills in what it records. */
const done = (values: Partial<LoggedSet> = {}): LoggedSet => ({
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	...values
});

/** A set logged (or skipped) today at `setIndex` of the slot, on `exercise`. */
const today = (
	setIndex: number,
	exercise: Pick<KitExerciseMeta, 'id'>,
	values: Partial<SlotSet> = {}
): SlotSet => ({ ...done(), isSkipped: false, setIndex, exerciseId: exercise.id, ...values });

/** The slot performs `exercise`, with its previous sets attached on the device when given. */
const performs = (
	exercise: Pick<KitExerciseMeta, 'id' | 'measure' | 'loadType'>,
	attached?: PreviousPerformance | null
): PerformedExercise => ({
	exerciseId: exercise.id,
	measure: exercise.measure,
	loadType: exercise.loadType,
	...(attached !== undefined && { attached })
});

const planned = (kit: KitExercise) => performs(kit.exercise);

/** `kit` with each set changed by `change`. */
const withSets = (kit: KitExercise, change: (set: KitSet, i: number) => Partial<KitSet>) => ({
	...kit,
	sets: kit.sets.map((set, i) => ({ ...set, ...change(set, i) }))
});

const alternative = (
	exercise: KitExerciseMeta,
	lastTopSet: KitAlternative['lastTopSet']
): KitAlternative => ({ exercise, reasons: ['Same pattern'], equipment: [], lastTopSet });

/** The leg press slot at an absolute 100 kg × 10 @ RPE 7, with hack squat as an alternative. */
const legPressAt100 = (hackSquatTop: KitAlternative['lastTopSet']): KitExercise => ({
	...withSets(LEG_PRESS, () => ({
		prescribedWeight: { value: 100, unit: 'kg', basis: 'absolute' },
		load: { kind: 'absolute', fraction: null }
	})),
	previous: { date: LAST_WEEK, sets: [done({ weight: 100, reps: 10, rpe: 7 })] },
	alternatives: [alternative(HACK_SQUAT, hackSquatTop)]
});

/** Back squat as M3 plans week 1 with a blank 1RM: the top set by RPE, back-offs at 70 % of it. */
const squatFromE1rm = (kit = SQUAT) =>
	withSets(kit, (set) =>
		set.role === 'top'
			? { load: { kind: 'rpe_based', fraction: null } }
			: { load: { kind: 'from_e1rm', fraction: 0.7 } }
	);

const topSet100x5 = today(1, SQUAT.exercise, { weight: 100, reps: 5, rpe: 8 });

describe('RPE_CHIPS', () => {
	it('runs from 6 to 10 in halves', () => {
		expect(RPE_CHIPS).toEqual([6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
	});
});

describe('nextSet: which set comes next', () => {
	it('is the first planned set not yet logged or skipped, then a set beyond the plan', () => {
		const kit = LEG_PRESS;
		const at = (...sets: SlotSet[]) => nextSet(planned(kit), sets, kit, 'kg');

		expect(at().setIndex).toBe(1);
		expect(at().planned).toBe(kit.sets[0]);
		expect(at(today(1, kit.exercise)).setIndex).toBe(2);
		// A skipped set is done; a deleted one (gone from the slot) is to do again.
		expect(at(today(1, kit.exercise, { isSkipped: true })).setIndex).toBe(2);
		expect(at(today(1, kit.exercise), today(3, kit.exercise)).setIndex).toBe(2);

		const extra = at(today(1, kit.exercise), today(2, kit.exercise), today(3, kit.exercise));
		expect(extra).toMatchObject({ setIndex: 4, planned: null });
		expect(extra.values.isExtra).toBe(true);
		expect(at().values.isExtra).toBe(false);
	});

	it('marks a warm-up or a ramp set as a warm-up', () => {
		const kit = withSets(LEG_PRESS, (_, i) => ({
			role: i === 0 ? 'warm_up' : i === 1 ? 'ramp' : 'working'
		}));
		const values = (setIndex: number) =>
			nextSet(
				planned(kit),
				Array.from({ length: setIndex - 1 }, (_, i) => today(i + 1, kit.exercise)),
				kit,
				'kg'
			).values.isWarmup;
		expect([values(1), values(2), values(3)]).toEqual([true, true, false]);
	});

	it('preselects the target RPE, and none when the target is off the chips', () => {
		expect(nextSet(planned(LEG_PRESS), [], LEG_PRESS, 'kg').values.rpe).toBe(7);
		const easy = withSets(LEG_PRESS, () => ({ targetRpe: 5 }));
		expect(nextSet(planned(easy), [], easy, 'kg').values.rpe).toBeNull();
	});
});

describe('nextSet: the weight, by load kind', () => {
	const UNITS: WeightUnit[] = ['kg', 'lb'];

	it.each([
		['kg', 100],
		['lb', 220]
	] as const)('absolute: as prescribed, in a %s profile', (unit, weight) => {
		const kit = legPressAt100(null);
		const prefill = nextSet(planned(kit), [], kit, unit);
		expect(prefill.values).toMatchObject({ weight, unit, reps: 10 });
		expect(prefill).toMatchObject({
			loadKind: 'absolute',
			loadFrom: 'prescribed',
			instruction: null
		});
	});

	it('a 102.5 kg prescription shows as 225 lb in a lb profile, and 225 lb stays 225 lb', () => {
		const at = (value: number, from: WeightUnit, unit: WeightUnit) => {
			const kit = withSets(LEG_PRESS, () => ({
				prescribedWeight: { value, unit: from, basis: 'absolute' },
				load: { kind: 'absolute', fraction: null }
			}));
			return nextSet(planned(kit), [], kit, unit).values.weight;
		};
		expect(at(102.5, 'kg', 'lb')).toBe(225);
		expect(at(225, 'lb', 'lb')).toBe(225);
		expect(at(225, 'lb', 'kg')).toBe(102.5);
		// In the owner's unit a prescription is never re-rounded.
		expect(at(101, 'kg', 'kg')).toBe(101);
	});

	it.each([
		['kg', 87.5],
		['lb', 195]
	] as const)('percent_1rm: as the kit computed it, in a %s profile', (unit, weight) => {
		const kit = withSets(SQUAT, () => ({
			prescribedWeight: { value: 87.5, unit: 'kg', basis: 'measured' },
			load: { kind: 'percent_1rm', fraction: 0.7 }
		}));
		// Even with today's top set logged, a percent_1rm load stays the kit's.
		const prefill = nextSet(planned(kit), [topSet100x5], kit, unit);
		expect(prefill.values.weight).toBe(weight);
		expect(prefill).toMatchObject({ loadKind: 'percent_1rm', loadFrom: 'prescribed' });
	});

	it.each([
		['kg', 100],
		['lb', 220]
	] as const)(
		'from_e1rm: the kit’s latest estimate until today’s top set is logged (%s)',
		(unit, weight) => {
			const kit = squatFromE1rm();
			const prefill = nextSet(
				planned(kit),
				[today(1, kit.exercise, { isSkipped: true })],
				kit,
				unit
			);
			expect(prefill).toMatchObject({ setIndex: 2, loadKind: 'from_e1rm', loadFrom: 'prescribed' });
			expect(prefill.values.weight).toBe(weight);
		}
	);

	it.each([
		['kg', 97.5],
		['lb', 215]
	] as const)(
		'a logged 100 kg × 5 @ RPE 8 top set gives the fixture’s back-offs at 80 % of its e1RM (%s)',
		(unit, weight) => {
			// The shared kit as start-kit builds it, unmodified: back-offs from_e1rm at 80 %.
			// setE1rm: 100 / 0.811 = 123.3 kg; 80 % is 98.6 kg, or 217.5 lb, rounded to 2.5 kg or 5 lb.
			const kit = SQUAT;
			const prefill = nextSet(planned(kit), [topSet100x5], kit, unit);
			expect(prefill).toMatchObject({
				setIndex: 2,
				loadKind: 'from_e1rm',
				loadFrom: 'top_set_today'
			});
			expect(prefill.values).toMatchObject({ weight, unit, reps: 5 });

			const second = nextSet(
				planned(kit),
				[topSet100x5, today(2, kit.exercise, { weight, unit, reps: 5 })],
				kit,
				unit
			);
			expect(second.values.weight).toBe(weight);
		}
	);

	it('from_e1rm: a top set with no e1RM (RPE under 6, or a warm-up) leaves the kit’s estimate', () => {
		const kit = squatFromE1rm();
		for (const top of [
			today(1, kit.exercise, { weight: 100, reps: 5, rpe: 5 }),
			today(1, kit.exercise, { weight: 100, reps: 5, rpe: 8, isWarmup: true })
		]) {
			expect(nextSet(planned(kit), [top], kit, 'kg')).toMatchObject({
				loadFrom: 'prescribed',
				values: { weight: 100 }
			});
		}
	});

	it.each(UNITS)(
		'rpe_based: nothing with no history, and the baseline instruction instead (%s)',
		(unit) => {
			const kit = { ...squatFromE1rm(), previous: null };
			const prefill = nextSet(planned(kit), [], kit, unit);
			expect(prefill.values).toMatchObject({ weight: null, reps: 5, rpe: 7 });
			expect(prefill).toMatchObject({
				loadKind: 'rpe_based',
				loadFrom: null,
				instruction: BASELINE_INSTRUCTION
			});
		}
	);

	it('rpe_based: with history, the previous session’s matching set', () => {
		// Last week's sets: 100 × 5 @ 8, then three back-offs at 85 kg.
		const kit = squatFromE1rm();
		const top = nextSet(planned(kit), [], kit, 'kg');
		expect(top.values.weight).toBe(100);
		expect(top).toMatchObject({ loadFrom: 'last_session', instruction: null });

		const lb = nextSet(planned(kit), [], kit, 'lb');
		expect(lb.values).toMatchObject({ weight: 220, unit: 'lb' });

		// Working sets match working sets and warm-ups warm-ups, whichever were logged last week.
		const warmed = {
			...LEG_PRESS,
			sets: [{ ...LEG_PRESS.sets[0]!, role: 'warm_up' as const }, ...LEG_PRESS.sets],
			previous: {
				date: LAST_WEEK,
				sets: [
					done({ weight: 50, reps: 10, isWarmup: true }),
					done({ weight: 80, reps: 10 }),
					done({ weight: 90, reps: 10 })
				]
			}
		};
		const warmUpFirst = nextSet(planned(warmed), [], warmed, 'kg');
		expect(warmUpFirst.values).toMatchObject({ weight: 50, isWarmup: true });
		const warmUp = today(1, warmed.exercise, { weight: 40, reps: 10, isWarmup: true });
		const first = nextSet(planned(warmed), [warmUp], warmed, 'kg');
		expect(first).toMatchObject({ setIndex: 2, loadFrom: 'last_session' });
		expect(first.values).toMatchObject({ weight: 80, isWarmup: false });
		// The third working set, with two skipped before it: last week's last working set.
		const skipped = [2, 3].map((i) => today(i, warmed.exercise, { isSkipped: true }));
		const last = nextSet(planned(warmed), [warmUp, ...skipped], warmed, 'kg');
		expect(last).toMatchObject({ setIndex: 4, loadFrom: 'last_session' });
		expect(last.values.weight).toBe(90);
	});

	it('rpe_based: the previous set today comes first', () => {
		const kit = {
			...LEG_PRESS,
			previous: { date: LAST_WEEK, sets: [done({ weight: 90, reps: 10, rpe: 7 })] }
		};
		const prefill = nextSet(
			planned(kit),
			[today(1, kit.exercise, { weight: 92.5, reps: 10, rpe: 7 })],
			kit,
			'kg'
		);
		expect(prefill).toMatchObject({ setIndex: 2, loadFrom: 'previous_set' });
		expect(prefill.values.weight).toBe(92.5);
		// With no history at all, a set without an instruction of its own asks by its RPE.
		const blank = nextSet(planned(LEG_PRESS), [], LEG_PRESS, 'kg');
		expect(blank.values.weight).toBeNull();
		expect(blank.instruction).toBe('Pick a load that feels like RPE 7');
	});

	it('null whenever a weight cannot be computed', () => {
		// from_e1rm with no estimate yet, and no top set today: never last week's or today's sets.
		const noEstimate = withSets(squatFromE1rm(), (set) =>
			set.role === 'top' ? {} : { prescribedWeight: null }
		);
		const backOff = nextSet(
			planned(noEstimate),
			[today(1, noEstimate.exercise, { weight: 100, reps: 5, rpe: 5 })],
			noEstimate,
			'kg'
		);
		expect(backOff).toMatchObject({ setIndex: 2, loadKind: 'from_e1rm', loadFrom: null });
		expect(backOff.values.weight).toBeNull();

		// absolute or percent_1rm with nothing computed: null, not a logged weight.
		for (const kind of ['absolute', 'percent_1rm'] as const) {
			const kit = {
				...withSets(LEG_PRESS, () => ({
					prescribedWeight: null,
					load: { kind, fraction: kind === 'absolute' ? null : 0.7 }
				})),
				previous: { date: LAST_WEEK, sets: [done({ weight: 90, reps: 10 })] }
			};
			expect(nextSet(planned(kit), [], kit, 'kg').values.weight).toBeNull();
		}
	});
});

describe('nextSet: substitutes', () => {
	it('leg press at an absolute 100 kg, swapped for hack squat: hack squat’s last top set, never 100 kg', () => {
		const kit = legPressAt100({ ...done({ weight: 80, reps: 10, rpe: 8 }), date: LAST_WEEK });
		const legPressToday = today(1, kit.exercise, { weight: 100, reps: 10, rpe: 7 });
		const prefill = nextSet(performs(HACK_SQUAT), [legPressToday], kit, 'kg');
		expect(prefill).toMatchObject({ setIndex: 2, loadKind: 'rpe_based', loadFrom: 'last_top_set' });
		expect(prefill.values).toMatchObject({ weight: 80, reps: 10, rpe: 7 });
	});

	it('with no last top set: nothing, and the RPE instruction', () => {
		const kit = legPressAt100(null);
		const prefill = nextSet(performs(HACK_SQUAT), [], kit, 'kg');
		expect(prefill.values).toMatchObject({ weight: null, reps: 10, rpe: 7 });
		expect(prefill).toMatchObject({
			loadKind: 'rpe_based',
			loadFrom: null,
			instruction: 'Pick a load that feels like RPE 7'
		});
		// Attached and empty: still nothing.
		expect(nextSet(performs(HACK_SQUAT, null), [], kit, 'kg').values.weight).toBeNull();
	});

	it('hack squat’s previous sets, attached after the swap, prefill its last top set', () => {
		const kit = legPressAt100({ ...done({ weight: 70, reps: 10 }), date: '2026-10-01' });
		const attached: PreviousPerformance = {
			date: LAST_WEEK,
			sets: [
				done({ weight: 90, reps: 5, isWarmup: true }),
				done({ weight: 80, reps: 10, rpe: 7 }),
				done({ weight: 85, reps: 8, rpe: 8.5 }),
				done({ weight: 80, reps: 9, rpe: 8 })
			]
		};
		const prefill = nextSet(performs(HACK_SQUAT, attached), [], kit, 'kg');
		expect(prefill).toMatchObject({ loadFrom: 'last_top_set', instruction: null });
		expect(prefill.values).toMatchObject({ weight: 85, reps: 10 });

		// Once one hack squat set is logged today, the next starts from it.
		const second = nextSet(
			performs(HACK_SQUAT, attached),
			[today(1, HACK_SQUAT, { weight: 82.5, reps: 10, rpe: 7 })],
			kit,
			'kg'
		);
		expect(second).toMatchObject({ setIndex: 2, loadFrom: 'previous_set' });
		expect(second.values.weight).toBe(82.5);
	});

	it('back squat at 70 % of 1RM, swapped for goblet squat: rpe_based at the same RPE', () => {
		const kit = {
			...withSets(SQUAT, () => ({
				targetRpe: 7,
				prescribedWeight: { value: 87.5, unit: 'kg', basis: 'measured' } as const,
				load: { kind: 'percent_1rm', fraction: 0.7 } as const
			})),
			alternatives: [alternative(GOBLET_SQUAT, null)]
		};
		for (const logged of [[], [today(1, kit.exercise, { weight: 87.5, reps: 5, rpe: 7 })]]) {
			const prefill = nextSet(performs(GOBLET_SQUAT), logged, kit, 'kg');
			expect(prefill.values).toMatchObject({ weight: null, rpe: 7 });
			expect(prefill).toMatchObject({
				loadKind: 'rpe_based',
				instruction: 'Pick a load that feels like RPE 7'
			});
		}
		// Nor a from_e1rm back-off worked out from the squat's top set.
		const fromE1rm = { ...squatFromE1rm(), alternatives: [alternative(GOBLET_SQUAT, null)] };
		const backOff = nextSet(performs(GOBLET_SQUAT), [topSet100x5], fromE1rm, 'kg');
		expect(backOff).toMatchObject({ setIndex: 2, loadKind: 'rpe_based', loadFrom: null });
		expect(backOff.values.weight).toBeNull();
	});
});

describe('nextSet: the field, by load type', () => {
	it('pull-up: a last added weight of 10 kg prefills 10 kg; with none logged, bodyweight only', () => {
		const set1 = today(1, PULL_UP.exercise, { weight: 10, reps: 8, rpe: 8 });
		const after = nextSet(planned(PULL_UP), [set1], PULL_UP, 'kg');
		expect(after.fields).toMatchObject({ load: 'added', labels: { blank: 'Bodyweight' } });
		expect(after).toMatchObject({ setIndex: 2, loadFrom: 'previous_set' });
		expect(after.values.weight).toBe(10);

		const lastWeek = {
			...PULL_UP,
			previous: { date: LAST_WEEK, sets: [done({ weight: 10, reps: 8 })] }
		};
		expect(nextSet(planned(lastWeek), [], lastWeek, 'kg').values.weight).toBe(10);

		const none = nextSet(planned(PULL_UP), [], PULL_UP, 'kg');
		expect(none.values).toMatchObject({ weight: null, assistance: null, reps: 6 });
		// Blank means bodyweight only: nothing to ask for.
		expect(none.instruction).toBeNull();
		const unweighted = today(1, PULL_UP.exercise, { reps: 8 });
		expect(nextSet(planned(PULL_UP), [unweighted], PULL_UP, 'kg').values.weight).toBeNull();
	});

	it('pull-up swapped for assisted pull-up asks for assistance, never weight', () => {
		const kit = {
			...PULL_UP,
			previous: { date: LAST_WEEK, sets: [done({ weight: 10, reps: 8 })] },
			alternatives: [
				alternative(ASSISTED_PULL_UP, { ...done({ assistance: 25, reps: 8 }), date: LAST_WEEK })
			]
		};
		const pullUpToday = today(1, kit.exercise, { weight: 10, reps: 8 });
		const prefill = nextSet(performs(ASSISTED_PULL_UP), [pullUpToday], kit, 'kg');
		expect(prefill.fields).toMatchObject({ load: 'assistance', labels: { load: 'Assistance' } });
		expect(prefill.values).toMatchObject({ weight: null, assistance: 25, reps: 6 });

		const none = { ...kit, alternatives: [alternative(ASSISTED_PULL_UP, null)] };
		const blank = nextSet(performs(ASSISTED_PULL_UP), [pullUpToday], none, 'kg');
		expect(blank.values).toMatchObject({ weight: null, assistance: null });
		expect(blank.instruction).toBeNull();

		// Assistance in another unit converts like a weight.
		expect(nextSet(performs(ASSISTED_PULL_UP), [], kit, 'lb').values.assistance).toBe(55);
	});

	it('an unloaded exercise asks for no load at all', () => {
		const deadBug = meta('dead_bug', 'Dead bug', 'reps', 'none', 'anti_extension');
		const kit = {
			...withSets(LEG_PRESS, () => ({})),
			exercise: deadBug,
			previous: { date: LAST_WEEK, sets: [done({ reps: 12, weight: 5 })] }
		};
		const prefill = nextSet(planned(kit), [], kit, 'kg');
		expect(prefill.fields.load).toBeNull();
		expect(prefill.values).toMatchObject({ weight: null, assistance: null, reps: 10 });
		expect(prefill).toMatchObject({ loadFrom: null, instruction: null });
	});
});

describe('nextSet: the amount, by measure', () => {
	it('plank prefills 45 s; sled push its metres', () => {
		const plank = nextSet(planned(PLANK), [], PLANK, 'kg');
		expect(plank.values).toMatchObject({ seconds: 45, reps: null, metres: null, weight: null });
		expect(plank.fields.amount).toBe('seconds');

		const sled = withSets(LEG_PRESS, () => ({ repsMin: null, repsMax: null, metres: 20 }));
		const sledKit = { ...sled, exercise: SLED_PUSH };
		const push = nextSet(planned(sledKit), [], sledKit, 'kg');
		expect(push.values).toMatchObject({ metres: 20, reps: null, seconds: null });
		expect(push.fields.amount).toBe('metres');
	});

	it('an 8–12 range prefills 8', () => {
		const kit = withSets(LEG_PRESS, () => ({ repsMin: 8, repsMax: 12 }));
		expect(nextSet(planned(kit), [], kit, 'kg').values.reps).toBe(8);
		// The fixture's pull-up range, 6–10, prefills 6.
		expect(nextSet(planned(PULL_UP), [], PULL_UP, 'kg').values.reps).toBe(6);
	});

	it('an added exercise, with no prescription, starts from its own sets', () => {
		const attached = { date: LAST_WEEK, sets: [done({ weight: 70, reps: 12 })] };
		const first = nextSet(performs(HACK_SQUAT, attached), [], null, 'kg');
		expect(first).toMatchObject({ setIndex: 1, planned: null, loadKind: null });
		expect(first).toMatchObject({ loadFrom: 'last_session', instruction: null });
		expect(first.values).toMatchObject({ weight: 70, reps: 12, rpe: null, isExtra: false });

		const second = nextSet(
			performs(HACK_SQUAT, attached),
			[today(1, HACK_SQUAT, { weight: 72.5, reps: 11 })],
			null,
			'kg'
		);
		expect(second.values).toMatchObject({ weight: 72.5, reps: 11, isExtra: false });

		expect(nextSet(performs(HACK_SQUAT), [], null, 'kg').values).toMatchObject({
			weight: null,
			reps: null
		});
	});
});

describe('topSetOf', () => {
	it('is the working set with the most load, the most reps among equals', () => {
		const sets = [
			done({ weight: 100, reps: 3, isWarmup: true }),
			done({ weight: 80, reps: 8 }),
			done({ weight: 80, reps: 10 }),
			done({ weight: 175, reps: 9, unit: 'lb' })
		];
		expect(topSetOf(sets, 'external')).toBe(sets[2]);
		expect(topSetOf(sets.slice(0, 1), 'external')).toBeNull();
	});

	it('on an assisted exercise, the least assistance: lower is harder', () => {
		const sets = [done({ assistance: 30, reps: 8 }), done({ assistance: 20, reps: 6 })];
		expect(topSetOf(sets, 'assisted')).toBe(sets[1]);
	});
});

describe('defaultMissedReps', () => {
	it('is max(0, repsMin − reps)', () => {
		const fives = { repsMin: 5 };
		expect(defaultMissedReps(fives, 3)).toBe(2);
		expect(defaultMissedReps(fives, 5)).toBe(0);
		expect(defaultMissedReps(fives, 7)).toBe(0);
		expect(defaultMissedReps({ repsMin: 8 }, 0)).toBe(8);
	});

	it('is 0 for a set with no reps target, or no reps entered', () => {
		expect(defaultMissedReps({ repsMin: null }, 3)).toBe(0);
		expect(defaultMissedReps(null, 3)).toBe(0);
		expect(defaultMissedReps({ repsMin: 5 }, null)).toBe(0);
	});
});
