import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { afterSet, groups, SUPERSET_FLOW } from './flow';
import { upNext } from './up-next';
import type { AfterSet } from './flow';
import { createMutation } from './mutations';
import type { LocalAction, Mutation, MutationInput, MutationType } from './mutations';
import { nextSet } from './prefill';
import { applyLocal, replay, viewOf } from './project';
import { strengthTable } from './reducers/tables';
import type {
	KitExercise,
	KitExerciseMeta,
	KitSet,
	SlotView,
	StrengthKit,
	WorkoutView
} from './types';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000f1';
/** The fixture by position: the superset is A1 pull-up 3 × 6–10, then A2 plank 3 × 45 s. */
const [SQUAT, LEG_PRESS, RDL, A1, A2] = [1, 2, 3, 4, 5] as const;

/** A device action of this test's workout. */
type Action = LocalAction extends infer A
	? A extends unknown
		? Omit<A, 'workoutId'>
		: never
	: never;

/** At a position: log its next set, skip it, or log an extra set. */
type Step = number | { skip: number } | { extra: number };

let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 18, 0, n)).toISOString();

const make = <T extends MutationType>(type: T, input: Omit<MutationInput<T>, 'workoutId' | 'at'>) =>
	createMutation(type, { workoutId: W, at: at(ids), ...input }, fresh);

/**
 * The kit's workout with each step done in order, each at its slot's next set index, then the
 * device actions applied.
 */
function workout(kit: StrengthKit, steps: Step[], ...actions: Action[]): WorkoutView {
	const start = make('workout.start', {
		entityId: W,
		payload: {
			kind: 'strength',
			title: kit.title,
			sessionType: kit.sessionType,
			discipline: kit.discipline,
			plannedSessionId: kit.plannedSessionId,
			plannedLineage: kit.plannedLineage,
			programId: kit.programId
		}
	});
	const added = actions.flatMap((a) => (a.type === 'exercise.add' ? [a.exercise] : []));
	const counts = new Map<number, number>();
	const sets: Mutation[] = steps.map((step) => {
		const position = typeof step === 'number' ? step : 'skip' in step ? step.skip : step.extra;
		const slot = kit.exercises.find((e) => e.position === position);
		const exercise = slot?.exercise ?? added.find((a) => a.position === position)!.exercise;
		const setIndex = (counts.get(position) ?? 0) + 1;
		counts.set(position, setIndex);
		const place = {
			position,
			plannedLineage: slot?.plannedLineage ?? null,
			setIndex,
			exerciseId: exercise.id
		};
		if (typeof step !== 'number' && 'skip' in step) {
			return make('set.skip', { payload: { ...place, unit: 'kg' } });
		}
		return make('set.log', {
			payload: {
				...place,
				reps: exercise.measure === 'reps' ? 8 : null,
				seconds: exercise.measure === 'time' ? 45 : null,
				metres: null,
				weight: null,
				assistance: null,
				unit: 'kg',
				rpe: 8,
				missedReps: 0,
				isWarmup: false,
				isExtra: typeof step !== 'number'
			}
		});
	});
	const state = actions.reduce(
		(s, a) => applyLocal(strengthTable, s, { workoutId: W, ...a } as LocalAction),
		replay(strengthTable, { workoutId: W, kit, canonical: null, pending: [start, ...sets] })
	);
	return viewOf(strengthTable, state)!;
}

const view = (steps: Step[], ...actions: Action[]) => workout(KIT, steps, ...actions);

/** Every planned set of each position, in order. */
const allOf = (kit: StrengthKit, ...positions: number[]): number[] =>
	positions.flatMap((p) => Array(kit.exercises[p - 1]!.sets.length).fill(p) as number[]);

/** The kit with one exercise changed. */
const withExercise = (
	kit: StrengthKit,
	position: number,
	change: (e: KitExercise) => Partial<KitExercise>
): StrengthKit => ({
	...kit,
	exercises: kit.exercises.map((e) => (e.position === position ? { ...e, ...change(e) } : e))
});

/** Each of the exercise's sets with its rest changed. */
const resting = (seconds: number | null) => (e: KitExercise) => ({
	sets: e.sets.map((s) => ({ ...s, restSeconds: seconds }))
});

/** The kit's exercises in a new order, renumbered from 1. */
const reordered = (kit: StrengthKit, ...positions: number[]): StrengthKit => ({
	...kit,
	exercises: positions.map((p, i) => ({ ...kit.exercises[p - 1]!, position: i + 1 }))
});

/** The view with one slot changed, as the structure reducers would leave it. */
const withSlot = (v: WorkoutView, position: number, change: Partial<SlotView>): WorkoutView => ({
	...v,
	slots: v.slots.map((s) => (s.position === position ? { ...s, ...change } : s))
});

const step = (position: number, setIndex: number) => ({ position, setIndex });
const rest = (seconds: number) => ({ seconds });

const LEG_EXTENSION: KitExerciseMeta = {
	id: 'leg_extension',
	key: 'leg_extension',
	name: 'Leg extension',
	measure: 'reps',
	loadType: 'external',
	unilateral: false,
	pattern: 'isolation',
	tags: [],
	restClass: 'isolation',
	increment: 2.5
};

describe('groups', () => {
	it("labels the fixture's superset A1 and A2, and its straight exercises not at all", () => {
		expect(groups(KIT)).toEqual([
			{ letter: null, members: [{ position: SQUAT, label: null }] },
			{ letter: null, members: [{ position: LEG_PRESS, label: null }] },
			{ letter: null, members: [{ position: RDL, label: null }] },
			{
				letter: 'A',
				members: [
					{ position: A1, label: 'A1' },
					{ position: A2, label: 'A2' }
				]
			}
		]);
	});

	it('gives two supersets A1, A2 and B1, B2 in workout order, straight exercises between them none', () => {
		const supersets = [1, 1, null, 2, 2];
		const kit = {
			exercises: KIT.exercises.map((e, i) => ({ ...e, superset: supersets[i]! }))
		};
		const labels = groups(kit).flatMap((g) => g.members.map((m) => m.label));
		expect(labels).toEqual(['A1', 'A2', null, 'B1', 'B2']);
		expect(groups(kit).map((g) => g.letter)).toEqual(['A', null, 'B']);
	});

	it('groups only consecutive exercises with one number; one exercise alone is straight', () => {
		const exercises = [1, 1, null, 1, 2, 3, 3].map((superset, i) => ({
			position: i + 1,
			superset
		}));
		expect(groups({ exercises }).map((g) => g.members.map((m) => m.label))).toEqual([
			['A1', 'A2'],
			[null],
			[null],
			[null],
			['B1', 'B2']
		]);
	});

	it('follows Z with AA, and orders exercises by position whatever order they come in', () => {
		// 27 pairs, numbered 1, 2, 1, 2… so that no two pairs run together; listed last first.
		const exercises = Array.from({ length: 54 }, (_, i) => 54 - i).map((position) => ({
			position,
			superset: Math.floor((position - 1) / 2) % 2 === 0 ? 1 : 2
		}));
		const found = groups({ exercises });
		expect(found.map((g) => g.letter).slice(24)).toEqual(['Y', 'Z', 'AA']);
		expect(found[0]!.members).toEqual([
			{ position: 1, label: 'A1' },
			{ position: 2, label: 'A2' }
		]);
		expect(found.at(-1)!.members.map((m) => m.label)).toEqual(['AA1', 'AA2']);
	});
});

describe('afterSet: straight exercises', () => {
	it('stays on the exercise until its planned sets are done, resting what each prescribes', () => {
		expect(afterSet(view([LEG_PRESS]), LEG_PRESS)).toEqual({
			next: step(LEG_PRESS, 2),
			rest: rest(120)
		});
		expect(afterSet(view([LEG_PRESS, LEG_PRESS]), LEG_PRESS)).toEqual({
			next: step(LEG_PRESS, 3),
			rest: rest(120)
		});
		expect(afterSet(view([SQUAT]), SQUAT)).toEqual({ next: step(SQUAT, 2), rest: rest(180) });
	});

	it("is 'exercise-done' after the last planned set; an extra set never moves on by itself", () => {
		const done = view(allOf(KIT, LEG_PRESS));
		expect(afterSet(done, LEG_PRESS)).toEqual({ next: 'exercise-done', rest: rest(120) });
		const extra = view([...allOf(KIT, LEG_PRESS), { extra: LEG_PRESS }]);
		expect(afterSet(extra, LEG_PRESS)).toEqual({ next: 'exercise-done', rest: rest(120) });
	});

	it('names the set the prefill offers next, whatever the sets logged so far', () => {
		const slot = KIT.exercises[LEG_PRESS - 1]!;
		const performed = {
			exerciseId: slot.exercise.id,
			measure: 'reps',
			loadType: 'external'
		} as const;
		const gap = (v: WorkoutView) =>
			withSlot(v, LEG_PRESS, {
				sets: v.slots[LEG_PRESS - 1]!.sets.filter((s) => s.setIndex !== 2)
			});
		const states: WorkoutView[] = [
			view([]),
			view([LEG_PRESS]),
			view([LEG_PRESS, { skip: LEG_PRESS }]),
			view([LEG_PRESS, { extra: LEG_PRESS }]),
			gap(view(allOf(KIT, LEG_PRESS)))
		];
		for (const v of states) {
			const prefilled = nextSet(performed, v.slots[LEG_PRESS - 1]!.sets, slot, 'kg').setIndex;
			expect(afterSet(v, LEG_PRESS).next).toEqual(step(LEG_PRESS, prefilled));
		}
	});

	it('counts no set past the plan toward it', () => {
		// A fourth set not marked extra rests as the third, the last planned one.
		const past = view([...allOf(KIT, LEG_PRESS), LEG_PRESS]);
		expect(afterSet(past, LEG_PRESS, { defaults: { compound: 150 } })).toEqual({
			next: 'exercise-done',
			rest: rest(120)
		});
	});

	it('advances past a skipped set as past a logged one', () => {
		expect(afterSet(view([{ skip: LEG_PRESS }]), LEG_PRESS)).toEqual({
			next: step(LEG_PRESS, 2),
			rest: rest(120)
		});
	});

	it('takes the first planned set not done, so a set deleted or missed is done next', () => {
		const v = view(allOf(KIT, LEG_PRESS));
		const gap = withSlot(v, LEG_PRESS, {
			sets: v.slots[LEG_PRESS - 1]!.sets.filter((s) => s.setIndex !== 2)
		});
		expect(afterSet(gap, LEG_PRESS).next).toEqual(step(LEG_PRESS, 2));
	});

	it("is 'workout-done', with no rest, once every exercise is done", () => {
		const everything = allOf(KIT, SQUAT, LEG_PRESS, RDL, A1, A2);
		expect(afterSet(view(everything), A2)).toEqual({ next: 'workout-done', rest: null });
		const skipped = withSlot(view(allOf(KIT, SQUAT, LEG_PRESS, A1, A2)), RDL, { state: 'skipped' });
		expect(afterSet(skipped, A2)).toEqual({ next: 'workout-done', rest: null });
	});

	it("rests the device's default for the exercise performed when the prescription names none", () => {
		const kit = withExercise(KIT, LEG_PRESS, resting(null));
		const v = workout(kit, [LEG_PRESS]);
		expect(afterSet(v, LEG_PRESS)).toEqual({ next: step(LEG_PRESS, 2), rest: rest(120) });
		expect(afterSet(v, LEG_PRESS, { defaults: { compound: 150 } }).rest).toEqual(rest(150));

		// Swapped for an isolation exercise: its class, not the planned one's.
		const option = { exercise: LEG_EXTENSION, reasons: [], equipment: [], lastTopSet: null };
		const swapped = withSlot(
			workout(
				withExercise(kit, LEG_PRESS, () => ({ alternatives: [option] })),
				[LEG_PRESS]
			),
			LEG_PRESS,
			{ exerciseId: LEG_EXTENSION.id, state: 'swapped' }
		);
		expect(afterSet(swapped, LEG_PRESS, { defaults: { isolation: 75 } }).rest).toEqual(rest(75));
	});

	it('takes a prescribed 0 as no rest', () => {
		const v = workout(withExercise(KIT, LEG_PRESS, resting(0)), [LEG_PRESS]);
		expect(afterSet(v, LEG_PRESS)).toEqual({ next: step(LEG_PRESS, 2), rest: null });
	});

	it("is done after an added exercise's first set, resting its class's default", () => {
		const added: Action = {
			type: 'exercise.add',
			exercise: { position: 6, exercise: LEG_EXTENSION, addedAt: at(0) }
		};
		const v = view([6], added);
		expect(afterSet(v, 6)).toEqual({ next: 'exercise-done', rest: rest(90) });

		// Before its first set it is still to do: the workout is not done, and it is up next.
		const planDone = view(allOf(KIT, SQUAT, LEG_PRESS, RDL, A1, A2), added);
		expect(afterSet(planDone, A2)).toEqual({ next: 'exercise-done', rest: rest(90) });
		expect(upNext(planDone)).toEqual({
			position: 6,
			setIndex: 1,
			exerciseId: LEG_EXTENSION.id,
			label: null,
			partner: false,
			target: null
		});
	});

	it('names nothing to do at a position with no exercise', () => {
		expect(afterSet(view([]), 9)).toEqual({ next: 'exercise-done', rest: null });
	});
});

describe('afterSet: supersets', () => {
	it('alternates by default (the open question): the owner can switch to straight sets', () => {
		expect(SUPERSET_FLOW).toBe('alternate');
	});

	it('after A1 set 1, A2 set 1 with no rest; after A2 set 1, 90 s, then A1 set 2', () => {
		expect(afterSet(view([A1]), A1)).toEqual({ next: step(A2, 1), rest: null });
		expect(afterSet(view([A1, A2]), A2)).toEqual({ next: step(A1, 2), rest: rest(90) });
	});

	it('rests 90 s after each round, the last one included, then the exercise is done', () => {
		const followed: AfterSet[] = [];
		const steps: Step[] = [];
		let position: number = A1;
		for (let i = 0; i < 6; i += 1) {
			steps.push(position);
			const result = afterSet(view(steps), position);
			followed.push(result);
			if (typeof result.next === 'object') position = result.next.position;
		}
		expect(steps).toEqual([A1, A2, A1, A2, A1, A2]);
		expect(followed.map((f) => f.rest)).toEqual([null, rest(90), null, rest(90), null, rest(90)]);
		expect(followed.at(-1)!.next).toBe('exercise-done');
	});

	it("continues a member with more sets as straight sets, with that set's own rest", () => {
		const fourth: KitSet = { ...KIT.exercises[A1 - 1]!.sets[0]!, restSeconds: 60 };
		const kit = withExercise(KIT, A1, (e) => ({ sets: [...e.sets, fourth] }));
		const rounds = [A1, A2, A1, A2, A1, A2];
		expect(afterSet(workout(kit, rounds), A2)).toEqual({ next: step(A1, 4), rest: rest(90) });
		expect(afterSet(workout(kit, [...rounds, A1]), A1)).toEqual({
			next: 'exercise-done',
			rest: rest(60)
		});
	});

	it("starts the round's rest after a skipped A2 set", () => {
		expect(afterSet(view([A1, { skip: A2 }]), A2)).toEqual({ next: step(A1, 2), rest: rest(90) });
	});

	it('after going to A2 by hand, logging A2 returns to A1 at the right set', () => {
		const byHand = view([A1, A2, A2], { type: 'goTo', position: A2 });
		expect(afterSet(byHand, A2)).toEqual({ next: step(A1, 2), rest: null });
		expect(afterSet(byHand, A2)).toEqual(afterSet(view([A1, A2, A2]), A2));
		const caughtUp = view([A1, A2, A2, A1], { type: 'goTo', position: A1 });
		expect(afterSet(caughtUp, A1)).toEqual({ next: step(A1, 3), rest: rest(90) });
	});

	it("starting with A2 by hand, A1 follows without rest, then the round rests A2's 90 s", () => {
		expect(afterSet(view([A2], { type: 'goTo', position: A2 }), A2)).toEqual({
			next: step(A1, 1),
			rest: null
		});
		expect(afterSet(view([A2, A1]), A1)).toEqual({ next: step(A1, 2), rest: rest(90) });
		// The last member's rest, not that of the member done last, even when it is longer.
		const longerA1 = withExercise(KIT, A1, resting(120));
		expect(afterSet(workout(longerA1, [A2, A1]), A1).rest).toEqual(rest(90));
	});

	it('goes round a superset of three in turn, A1 → A2 → A3, even after starting at A2', () => {
		// Romanian deadlift, pull-up and plank as one superset: A1 rests 120 s, A2 0 s, A3 90 s.
		const [M1, M2, M3] = [RDL, A1, A2];
		const supersets = [null, null, 1, 1, 1];
		const three = {
			...KIT,
			exercises: KIT.exercises.map((e, i) => ({ ...e, superset: supersets[i]! }))
		};
		const flow = (...steps: number[]) => afterSet(workout(three, steps), steps.at(-1)!);
		expect(
			groups(three)
				.at(-1)!
				.members.map((m) => m.label)
		).toEqual(['A1', 'A2', 'A3']);
		expect(flow(M1)).toEqual({ next: step(M2, 1), rest: null });
		expect(flow(M1, M2)).toEqual({ next: step(M3, 1), rest: null });
		expect(flow(M1, M2, M3)).toEqual({ next: step(M1, 2), rest: rest(90) });
		expect(flow(M2)).toEqual({ next: step(M3, 1), rest: null });
		expect(flow(M2, M3)).toEqual({ next: step(M1, 1), rest: null });
		expect(flow(M2, M3, M1)).toEqual({ next: step(M1, 2), rest: rest(90) });
	});

	it('rests the longest in the round when its last member prescribes none', () => {
		const a2Unset = withExercise(withExercise(KIT, A1, resting(75)), A2, resting(null));
		expect(afterSet(workout(a2Unset, [A1, A2]), A2).rest).toEqual(rest(75));
		// The rest written on the first member instead: A2's 0 leaves it to A1's.
		const onA1 = withExercise(withExercise(KIT, A1, resting(90)), A2, resting(0));
		expect(afterSet(workout(onA1, [A1]), A1)).toEqual({ next: step(A2, 1), rest: null });
		expect(afterSet(workout(onA1, [A1, A2]), A2).rest).toEqual(rest(90));

		// None prescribed: the longer of the members' device defaults (compound, timed).
		const noneSet = withExercise(withExercise(KIT, A1, resting(null)), A2, resting(null));
		const v = workout(noneSet, [A1, A2]);
		expect(afterSet(v, A2).rest).toEqual(rest(120));
		expect(afterSet(v, A2, { defaults: { compound: 100, timed: 130 } }).rest).toEqual(rest(130));
	});

	it("rests a set of a member the plan gives no sets by the exercise's default", () => {
		const unplanned = withExercise(KIT, A2, () => ({ sets: [] }));
		expect(afterSet(workout(unplanned, [A2]), A2)).toEqual({ next: step(A1, 1), rest: rest(60) });
	});

	it('continues as straight sets once its partner has stopped, with its own rest', () => {
		const stopped = withSlot(view([A1, A2, A1]), A2, { state: 'stopped' });
		// A1 prescribes 0 s, which assumed the plank followed.
		expect(afterSet(stopped, A1)).toEqual({ next: step(A1, 3), rest: null });
	});

	it("as straight sets (the owner's alternative), each member stays current and rests the round's rest", () => {
		const straight = { supersets: 'straight' } as const;
		expect(afterSet(view([A1]), A1, straight)).toEqual({ next: step(A1, 2), rest: rest(90) });
		expect(afterSet(view(allOf(KIT, A1)), A1, straight)).toEqual({
			next: 'exercise-done',
			rest: rest(90)
		});
		expect(
			groups(KIT)
				.at(-1)!
				.members.map((m) => m.label)
		).toEqual(['A1', 'A2']);
	});
});

describe('upNext', () => {
	it('names the next exercise and its first target', () => {
		expect(upNext(view([]))).toEqual({
			position: LEG_PRESS,
			setIndex: 1,
			exerciseId: KIT.exercises[LEG_PRESS - 1]!.exercise.id,
			label: null,
			partner: false,
			target: KIT.exercises[LEG_PRESS - 1]!.sets[0]
		});
	});

	it('names the partner inside a round', () => {
		const onA1 = upNext(view([], { type: 'goTo', position: A1 }));
		expect(onA1).toMatchObject({ position: A2, setIndex: 1, label: 'A2', partner: true });
		expect(onA1!.target).toMatchObject({ seconds: 45, line: '3 × 0:45' });
		const onA2 = upNext(view([A1], { type: 'goTo', position: A2 }));
		expect(onA2).toMatchObject({ position: A1, setIndex: 2, label: 'A1', partner: true });
	});

	it('names a superset by the member it starts with, from the exercise before it', () => {
		expect(upNext(view([], { type: 'goTo', position: RDL }))).toMatchObject({
			position: A1,
			setIndex: 1,
			label: 'A1',
			partner: false
		});
	});

	it('names the next exercise after the group once its last round is under way', () => {
		const kit = reordered(KIT, SQUAT, A1, A2, LEG_PRESS);
		const lastRound = workout(kit, [2, 3, 2, 3, 2], { type: 'goTo', position: 3 });
		expect(upNext(lastRound)).toMatchObject({ position: 4, label: null, partner: false });
		expect(upNext(lastRound)!.exerciseId).toBe(KIT.exercises[LEG_PRESS - 1]!.exercise.id);
		// A member done while its partner still has a set names the partner.
		const a2Left = workout(kit, [2, 3, 2, 3, 2], { type: 'goTo', position: 2 });
		expect(upNext(a2Left)).toMatchObject({ position: 3, setIndex: 3, partner: true });
	});

	it('passes over exercises already done, then comes back to any left before this one', () => {
		const legPressDone = view(allOf(KIT, LEG_PRESS));
		expect(upNext(legPressDone)).toMatchObject({ position: RDL, setIndex: 1 });
		const onA2 = view(allOf(KIT, LEG_PRESS, RDL, A1), { type: 'goTo', position: A2 });
		expect(upNext(onA2)).toMatchObject({ position: SQUAT, setIndex: 1, partner: false });
	});

	it('is null when nothing else is left, and with no exercises', () => {
		const lastLeft = view(allOf(KIT, SQUAT, LEG_PRESS, RDL, A1, A2).slice(0, -1), {
			type: 'goTo',
			position: A2
		});
		expect(upNext(lastLeft)).toBeNull();
		expect(upNext({ ...view([]), slots: [] })).toBeNull();
	});

	it('as straight sets, names A2 as the next exercise, not as a partner', () => {
		const straight = { supersets: 'straight' } as const;
		expect(upNext(view([], { type: 'goTo', position: A1 }), straight)).toMatchObject({
			position: A2,
			partner: false
		});
	});
});

describe('afterSet and upNext together', () => {
	it('walk the whole fixture workout in the planned order, resting where it prescribes', () => {
		const steps: Step[] = [];
		const walked: string[] = [];
		let position: number = SQUAT;
		for (let i = 0; i < 40; i += 1) {
			steps.push(position);
			const { next, rest: r } = afterSet(view(steps), position);
			walked.push(`${position}${r ? `:${r.seconds}` : ''}`);
			if (next === 'workout-done') break;
			if (next === 'exercise-done') {
				position = upNext(view(steps, { type: 'goTo', position }))!.position;
			} else position = next.position;
		}
		expect(walked).toEqual([
			...['1:180', '1:180', '1:180', '1:180'],
			...['2:120', '2:120', '2:120'],
			...['3:120', '3:120', '3:120'],
			...['4', '5:90', '4', '5:90', '4', '5']
		]);
	});
});
