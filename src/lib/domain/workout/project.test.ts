import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import {
	SEQUENCE_COUNT,
	serverSplit,
	strengthSequence
} from '../../../../tests/fixtures/workout-sequences';
import { restRemaining, stopwatchElapsed } from './timers';
import { createMutation, entityKey } from './mutations';
import type { LocalAction, Mutation, MutationInput, MutationOf, MutationType } from './mutations';
import { applyLocal, applyMutation, project, replay, viewOf } from './project';
import type { WorkoutInputs } from './project';
import type { CanonicalWorkout } from './protocol';
import { initialDevice } from './reducers/device';
import { runTable } from './reducers/run';
import { otherTable, strengthTable } from './reducers/tables';
import { previousFor } from './selectors';
import type { DeviceState, KitExerciseMeta, LoggedSet, WorkoutView } from './types';

const DATE = '2026-11-06';
const KIT = workoutDayKits({ date: DATE }).strength;
const W = '00000000-0000-4000-8000-0000000000a1';
const OTHER_W = '00000000-0000-4000-8000-0000000000a2';
const idAt = (position: number) => KIT.exercises[position - 1]!.exercise.id;
const SQUAT = idAt(1);
const LEG_PRESS = idAt(2);
const PULL_UP = idAt(4);
const PLANK = idAt(5);

let ids = 0;
const fresh = () => `fresh-${++ids}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 18, 0, second)).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'> & { workoutId?: string; second?: number }
): MutationOf<T> {
	const { workoutId = W, second = 0, ...rest } = input;
	return createMutation(type, { workoutId, at: at(second), ...rest }, fresh);
}

const start = (workoutId = W) =>
	make('workout.start', {
		workoutId,
		entityId: workoutId,
		payload: {
			kind: 'strength',
			title: KIT.title,
			sessionType: KIT.sessionType,
			discipline: KIT.discipline,
			plannedSessionId: KIT.plannedSessionId,
			plannedLineage: KIT.plannedLineage,
			programId: KIT.programId
		}
	});

const set = (fields: Partial<LoggedSet> = {}): LoggedSet => ({
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	...fields
});

/** set.log of set `id` at a position (squat by default). */
function log(
	id: string,
	setIndex: number,
	fields: Partial<LoggedSet> = {},
	{ position = 1, exerciseId = SQUAT, second = setIndex, workoutId = W } = {}
) {
	const plannedLineage = KIT.exercises[position - 1]?.plannedLineage ?? null;
	return make('set.log', {
		workoutId,
		entityId: id,
		second,
		payload: { position, plannedLineage, setIndex, exerciseId, ...set(fields) }
	});
}

const edit = (id: string, fields: Partial<LoggedSet>, second = 30) =>
	make('set.edit', { entityId: id, second, payload: set(fields) });
const remove = (id: string, second = 40) =>
	make('set.delete', { entityId: id, second, payload: {} });

function inputs(
	pending: readonly Mutation[],
	canonical: CanonicalWorkout | null = null,
	device?: DeviceState
): WorkoutInputs {
	return { workoutId: W, kit: KIT, canonical, pending, device };
}

const view = (...args: Parameters<typeof inputs>) => project(strengthTable, inputs(...args));

/** The server's rows after it applied `mutations`: the same reducers on the canonical shape. */
const serverModel = (mutations: readonly Mutation[]) =>
	replay(strengthTable, inputs(mutations)).rows;

const live = (v: WorkoutView | null) => v!.slots.flatMap((slot) => slot.sets);

/** The view with every pending flag cleared: what the rows say, whatever is still unsent. */
function settled(v: WorkoutView | null): WorkoutView | null {
	const done = <R extends { pending: boolean }>(row: R): R => ({ ...row, pending: false });
	return (
		v && {
			...v,
			workout: done(v.workout),
			slots: v.slots.map((slot) => ({
				...slot,
				substitution: slot.substitution && done(slot.substitution),
				sets: slot.sets.map(done)
			})),
			run: v.run && { ...done(v.run), segments: v.run.segments.map(done) },
			other: v.other && done(v.other)
		}
	);
}

const LOGGED = [
	start(),
	log('s1', 1, { reps: 5, weight: 100 }),
	log('s2', 2, { reps: 5, weight: 100 }),
	log('s3', 1, { reps: 10, weight: 140 }, { position: 2, exerciseId: LEG_PRESS }),
	edit('s2', { reps: 4, weight: 100, missedReps: 1 }),
	remove('s1'),
	make('workout.update', { second: 50, payload: { notes: 'Felt quick' } })
];

describe('project', () => {
	it("shows nothing until the server's rows or the outbox hold the workout's start", () => {
		expect(view([])).toBeNull();
		expect(view([log('s1', 1)])).toBeNull();

		const v = view([start()])!;
		expect(v.workout).toMatchObject({ id: W, status: 'in_progress', startedAt: at(0) });
		expect(v.workout.pending).toBe(true);
		expect(v.slots.map((s) => [s.position, s.exerciseId, s.state])).toEqual([
			[1, SQUAT, 'planned'],
			[2, LEG_PRESS, 'planned'],
			[3, KIT.exercises[2]!.exercise.id, 'planned'],
			[4, PULL_UP, 'planned'],
			[5, PLANK, 'planned']
		]);
		expect(v.slots[3]!.superset).toBe(1);
		expect(v.device).toStrictEqual(initialDevice());
		expect(v.exercises[SQUAT]).toStrictEqual({
			name: 'Back squat',
			measure: 'reps',
			loadType: 'external',
			unilateral: false
		});
	});

	it('gives the same view when a pending list is replayed twice', () => {
		expect(view([...LOGGED, ...LOGGED])).toStrictEqual(view(LOGGED));
		const canonical = serverModel(LOGGED);
		expect(view(LOGGED, canonical)).toStrictEqual(view(LOGGED));
		expect(settled(view([], canonical))).toStrictEqual(settled(view(LOGGED)));
	});

	it('gives the same view whatever order the canonical rows come in', () => {
		const canonical = serverModel([
			...LOGGED,
			log('s4', 1, { reps: null, seconds: 45, weight: null }, { position: 5, exerciseId: PLANK }),
			make('exercise.create', { entityId: 'x1', payload: customExercise('Keg carry') })
		])!;
		const reversed: CanonicalWorkout = {
			...canonical,
			sets: [...canonical.sets].reverse(),
			exercises: Object.fromEntries(Object.entries(canonical.exercises).reverse())
		};
		expect(canonical.sets.map((s) => s.id)).not.toEqual(reversed.sets.map((s) => s.id));
		expect(view([], reversed)).toStrictEqual(view([], canonical));
		expect(view([edit('s3', { reps: 8 })], reversed)).toStrictEqual(
			view([edit('s3', { reps: 8 })], canonical)
		);
	});

	it('shows a pending create the canonical rows already hold once, marked pending', () => {
		const canonical = serverModel([start(), log('s1', 1)]);
		const sets = live(view([log('s1', 1)], canonical));
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({ id: 's1', pending: true });
		expect(live(view([], canonical))[0]!.pending).toBe(false);
	});

	it("keeps another device's rows when this device's workout.start is replayed on them", () => {
		const elsewhere = [
			log('s2', 2, { reps: 3 }),
			make('workout.update', { second: 50, payload: { notes: 'Sent from the laptop' } })
		];
		const canonical = serverModel([start(), log('s1', 1), ...elsewhere])!;
		const v = view([start(), log('s1', 1)], canonical)!;
		expect(live(v).map((s) => [s.id, s.pending])).toEqual([
			['s1', true],
			['s2', false]
		]);
		expect(v.workout).toMatchObject({ notes: 'Sent from the laptop', pending: true });
		expect(settled(v)).toStrictEqual(settled(view([], canonical)));
	});

	it('applies an edit after its create, from the outbox or on top of the server rows', () => {
		const logged = log('s1', 1, { reps: 5, weight: 100, rpe: 8 });
		const edited = edit('s1', { reps: 4, weight: 102.5, rpe: 9, missedReps: 1 });
		const expected = {
			id: 's1',
			reps: 4,
			weight: 102.5,
			rpe: 9,
			missedReps: 1,
			setIndex: 1,
			performedAt: at(1),
			isSkipped: false,
			e1rmKg: null,
			pending: true
		};
		expect(live(view([start(), logged, edited]))).toEqual([expect.objectContaining(expected)]);
		const canonical = serverModel([start(), logged]);
		expect(live(view([edited], canonical))).toEqual([expect.objectContaining(expected)]);
	});

	it('hides a deleted set, and a replayed create of the deleted set stays deleted', () => {
		const logged = log('s1', 1);
		expect(live(view([start(), logged, remove('s1')]))).toEqual([]);
		expect(live(view([start(), logged, remove('s1'), logged]))).toEqual([]);

		const canonical = serverModel([start(), logged, remove('s1')])!;
		expect(canonical.sets).toEqual([expect.objectContaining({ id: 's1', deletedAt: at(40) })]);
		expect(live(view([logged], canonical))).toEqual([]);
		expect(live(view([logged, edit('s1', { reps: 9 })], canonical))).toEqual([]);
		expect(serverModel([start(), logged, remove('s1'), remove('s1', 90)])!.sets[0]!.deletedAt).toBe(
			at(40)
		);
	});

	it('keeps an edit of a set not known yet pending without throwing, and applies it once the set arrives', () => {
		const early = edit('s9', { reps: 3 });
		expect(() => view([start(), early])).not.toThrow();
		expect(live(view([start(), early]))).toEqual([]);
		expect(serverModel([start(), early])).toStrictEqual(serverModel([start()]));

		const elsewhere = serverModel([start(), log('s9', 1, { reps: 5 })]);
		expect(live(view([early], elsewhere))).toEqual([
			expect.objectContaining({ id: 's9', reps: 3, pending: true })
		]);
	});

	it('changes nothing for a mutation or a device action of another workout', () => {
		const others: Mutation[] = [
			start(OTHER_W),
			log('o1', 1, {}, { workoutId: OTHER_W }),
			make('workout.finish', { workoutId: OTHER_W, payload: {} })
		];
		expect(view([...LOGGED, ...others])).toStrictEqual(view(LOGGED));
		expect(view(others)).toBeNull();

		const state = replay(strengthTable, inputs(LOGGED));
		const away: LocalAction = { workoutId: OTHER_W, type: 'goTo', position: 3 };
		expect(applyLocal(strengthTable, state, away)).toBe(state);
		expect(applyMutation(strengthTable, state, others[1]!)).toBe(state);
	});

	it('never lets a device action change a synced field, or a mutation the device state', () => {
		const state = replay(strengthTable, inputs(LOGGED));
		const added = { position: 6, exercise: meta('x1', 'Keg carry'), addedAt: at(60) };
		const actions: LocalAction[] = [
			{ workoutId: W, type: 'goTo', position: 3 },
			{ workoutId: W, type: 'draft', position: 1, setIndex: 3, draft: { reps: 6 } },
			{ workoutId: W, type: 'exercise.add', exercise: added },
			{ workoutId: W, type: 'kit.attach', kit: KIT },
			{ workoutId: W, type: 'kit.attach', exerciseId: 'x1', previous: null },
			{ workoutId: W, type: 'rest.start', at: 1_000, durationMs: 90_000 },
			{ workoutId: W, type: 'rest.add', at: 2_000, ms: 30_000 },
			{ workoutId: W, type: 'rest.pause', at: 3_000 },
			{ workoutId: W, type: 'rest.resume', at: 4_000 },
			{ workoutId: W, type: 'rest.reset', at: 5_000 },
			{ workoutId: W, type: 'rest.skip', at: 6_000 },
			{ workoutId: W, type: 'stopwatch.start', at: 1_000 },
			{ workoutId: W, type: 'stopwatch.pause', at: 2_000 },
			{ workoutId: W, type: 'stopwatch.resume', at: 3_000 },
			{ workoutId: W, type: 'stopwatch.reset', at: 4_000 }
		];
		let local = state;
		for (const action of actions) {
			const next = applyLocal(strengthTable, local, action);
			expect(next.rows, action.type).toBe(state.rows);
			expect(next.pending, action.type).toBe(state.pending);
			local = next;
		}
		expect(local.device).not.toStrictEqual(state.device);

		const mutations: Mutation[] = [
			log('s7', 3),
			edit('s2', { reps: 2 }),
			remove('s3'),
			make('set.skip', {
				payload: { position: 4, plannedLineage: null, setIndex: 1, exerciseId: PULL_UP, unit: 'kg' }
			}),
			make('exercise.create', { entityId: 'x2', payload: customExercise('Bulgarian bag spin') }),
			make('workout.update', { payload: { sessionRpe: 8 } }),
			make('workout.finish', { payload: {} })
		];
		for (const m of mutations) {
			const next = applyMutation(strengthTable, local, m);
			expect(next.device, m.type).toBe(local.device);
			expect(next.kit, m.type).toBe(local.kit);
			expect(next.rows, m.type).not.toBe(local.rows);
		}
	});

	it('renders an exercise.create and a set.log on that exercise together', () => {
		const create = make('exercise.create', {
			entityId: 'x1',
			payload: customExercise('Keg carry')
		});
		const carry = log(
			'c1',
			1,
			{ reps: null, metres: 40, weight: 32 },
			{ position: 6, exerciseId: 'x1' }
		);
		for (const v of [
			view([start(), create, carry]),
			view([carry], serverModel([start(), create]))
		]) {
			expect(v!.exercises.x1).toStrictEqual({
				name: 'Keg carry',
				measure: 'distance',
				loadType: 'external',
				unilateral: false
			});
			const slot = v!.slots.find((s) => s.position === 6)!;
			expect(slot).toMatchObject({ exerciseId: 'x1', kit: null, state: 'added', superset: null });
			expect(slot.sets).toEqual([expect.objectContaining({ id: 'c1', metres: 40, weight: 32 })]);
		}
		const renamed = { ...customExercise('Keg carry'), name: 'Renamed' };
		const again = make('exercise.create', { entityId: 'x1', payload: renamed });
		expect(view([start(), create, again])!.exercises.x1!.name).toBe('Keg carry');

		const withName = {
			...serverModel([start()])!,
			exercises: { [SQUAT]: { ...renamed, unilateral: true } }
		};
		expect(view([], withName)!.exercises[SQUAT]).toMatchObject({
			name: 'Renamed',
			unilateral: true
		});
	});

	it("shows one exercise's attached previous sets through previousFor, across re-projections", () => {
		const keg = meta('x1', 'Keg carry');
		const previous = { date: '2026-10-30', sets: [set({ reps: null, metres: 30, weight: 24 })] };
		let state = replay(strengthTable, inputs(LOGGED));
		state = applyLocal(strengthTable, state, {
			workoutId: W,
			type: 'exercise.add',
			exercise: { position: 6, exercise: keg, addedAt: at(60) }
		});
		expect(previousFor(viewOf(strengthTable, state)!, 6)).toBeNull();
		const attached = applyLocal(strengthTable, state, {
			workoutId: W,
			type: 'kit.attach',
			exerciseId: 'x1',
			previous
		});
		expect(attached.rows).toBe(state.rows);
		expect(attached.kit).toBe(state.kit);
		expect(previousFor(viewOf(strengthTable, attached)!, 6)).toStrictEqual(previous);

		const reloaded = view(LOGGED, serverModel(LOGGED.slice(0, 3)), attached.device)!;
		expect(previousFor(reloaded, 6)).toStrictEqual(previous);
		expect(reloaded.slots.find((s) => s.position === 6)).toMatchObject({
			exerciseId: 'x1',
			state: 'added',
			kit: null
		});
		expect(reloaded.workout).toStrictEqual(view(LOGGED)!.workout);
		expect(live(reloaded)).toStrictEqual(live(view(LOGGED)));
	});

	it('gives the optimistic one-mutation step the view a full projection gives', () => {
		const next = log('s5', 3, { reps: 3 });
		const state = replay(strengthTable, inputs(LOGGED, serverModel(LOGGED.slice(0, 2))));
		const optimistic = viewOf(strengthTable, applyMutation(strengthTable, state, next));
		expect(optimistic).toStrictEqual(view([...LOGGED, next], serverModel(LOGGED.slice(0, 2))));
	});
});

describe('sets', () => {
	it('orders sets by position, set index, time performed and id', () => {
		const pending = [
			start(),
			log('b', 2, {}, { second: 9 }),
			log('z', 1, {}, { position: 2, exerciseId: LEG_PRESS, second: 1 }),
			log('c', 1, {}, { second: 5 }),
			log('a', 1, {}, { second: 5 }),
			log('d', 1, {}, { second: 2 })
		];
		const order = (v: WorkoutView | null) => v!.slots.map((s) => s.sets.map((x) => x.id));
		expect(order(view(pending))).toEqual([['d', 'a', 'c', 'b'], ['z'], [], [], []]);
		expect(order(view([pending[0]!, ...pending.slice(1).reverse()]))).toEqual(order(view(pending)));
	});

	it('records whichever amount and load a set carries, with missed reps and extra sets', () => {
		const pending = [
			start(),
			log('squat', 1, { reps: 1, missedReps: 4, weight: 140, rpe: 10 }),
			log('extra', 5, { reps: 5, weight: 90, isExtra: true }),
			log(
				'warm',
				1,
				{ reps: 10, weight: 40, rpe: null, isWarmup: true },
				{ position: 2, exerciseId: LEG_PRESS }
			),
			log('bw', 1, { reps: 8, weight: null }, { position: 4, exerciseId: PULL_UP }),
			log('added', 2, { reps: 6, weight: 10 }, { position: 4, exerciseId: PULL_UP }),
			log(
				'plank',
				1,
				{ reps: null, seconds: 50, weight: null, rpe: null },
				{ position: 5, exerciseId: PLANK }
			),
			log('help', 1, { reps: 6, weight: null, assistance: 25 }, { position: 6, exerciseId: 'x9' }),
			log(
				'lb',
				1,
				{ reps: null, metres: 40, weight: 70, unit: 'lb' },
				{ position: 7, exerciseId: 'x8' }
			)
		];
		const rows = serverModel(pending)!;
		const byId = Object.fromEntries(rows.sets.map((s) => [s.id, s]));
		expect(byId.squat).toStrictEqual({
			id: 'squat',
			position: 1,
			plannedLineage: KIT.exercises[0]!.plannedLineage,
			setIndex: 1,
			exerciseId: SQUAT,
			...set({ reps: 1, missedReps: 4, weight: 140, rpe: 10 }),
			isSkipped: false,
			e1rmKg: null,
			performedAt: at(1),
			deletedAt: null
		});
		expect(byId.extra).toMatchObject({ setIndex: 5, isExtra: true });
		expect(byId.warm).toMatchObject({ isWarmup: true, rpe: null });
		expect(byId.bw).toMatchObject({ reps: 8, weight: null, assistance: null });
		expect(byId.added).toMatchObject({ reps: 6, weight: 10 });
		expect(byId.plank).toMatchObject({ reps: null, seconds: 50, weight: null });
		expect(byId.help).toMatchObject({ reps: 6, weight: null, assistance: 25 });
		expect(byId.lb).toMatchObject({ metres: 40, weight: 70, unit: 'lb' });
		expect(view(pending)!.slots.map((s) => s.sets.length)).toEqual([2, 1, 0, 2, 1, 1, 1]);
	});

	it('records a skipped set with no values, and an edit never un-skips it', () => {
		const skip = make('set.skip', {
			entityId: 'k1',
			second: 3,
			payload: { position: 2, plannedLineage: null, setIndex: 3, exerciseId: LEG_PRESS, unit: 'lb' }
		});
		const [row] = serverModel([start(), skip])!.sets;
		expect(row).toStrictEqual({
			id: 'k1',
			position: 2,
			plannedLineage: null,
			setIndex: 3,
			exerciseId: LEG_PRESS,
			...set({ reps: null, weight: null, rpe: null, unit: 'lb' }),
			isSkipped: true,
			e1rmKg: null,
			performedAt: at(3),
			deletedAt: null
		});
		expect(serverModel([start(), skip, skip])).toStrictEqual(serverModel([start(), skip]));
		expect(serverModel([start(), skip, edit('k1', {})])!.sets[0]!.isSkipped).toBe(true);
	});

	it("keeps the server's e1RM until this device changes the set", () => {
		const canonical = serverModel([start(), log('s1', 1)])!;
		const withE1rm = { ...canonical, sets: [{ ...canonical.sets[0]!, e1rmKg: 116.7 }] };
		expect(live(view([], withE1rm))[0]!.e1rmKg).toBe(116.7);
		expect(live(view([log('s1', 1)], withE1rm))[0]!.e1rmKg).toBe(116.7);
		expect(live(view([edit('s1', { reps: 3 })], withE1rm))[0]!.e1rmKg).toBeNull();
	});
});

describe('the workout row', () => {
	it('sets only the fields an update carries, absolutely', () => {
		const rows = serverModel([
			start(),
			make('workout.update', { payload: { notes: 'Felt quick', sessionRpe: 7 } }),
			make('workout.update', { payload: { sessionRpe: 8 } }),
			make('workout.update', { payload: { notes: null } })
		])!;
		expect(rows.workout).toMatchObject({ notes: null, sessionRpe: 8, durationSeconds: null });
		const sneaky = make('workout.update', {
			payload: { notes: 'x', status: 'completed' } as never
		});
		expect(serverModel([start(), sneaky])!.workout.status).toBe('in_progress');
	});

	it('finishes and abandons at the mutation time, and a replay changes nothing', () => {
		const finish = make('workout.finish', {
			second: 59,
			payload: { durationSeconds: 3600, sessionRpe: 8 }
		});
		const done = serverModel([start(), finish])!;
		expect(done.workout).toMatchObject({
			status: 'completed',
			finishedAt: at(59),
			durationSeconds: 3600,
			sessionRpe: 8
		});
		expect(view([finish], done)).toStrictEqual(view([start(), finish]));
		const abandon = make('workout.abandon', { second: 20, payload: {} });
		expect(serverModel([start(), abandon])!.workout).toMatchObject({
			status: 'abandoned',
			finishedAt: at(20)
		});
		expect(serverModel([start(), start()])).toStrictEqual(serverModel([start()]));
	});

	it('shows the slots of a workout from another device from its sets, until its kit is attached', () => {
		const canonical = serverModel([
			start(),
			log('s1', 1),
			log('s2', 1, {}, { position: 2, exerciseId: LEG_PRESS }),
			log('s3', 1, {}, { position: 6, exerciseId: 'x1' })
		]);
		const bare = project(strengthTable, { workoutId: W, kit: null, canonical, pending: [] })!;
		expect(bare.kit).toBeNull();
		expect(bare.slots.map((s) => [s.position, s.exerciseId, s.state, s.kit])).toEqual([
			[1, SQUAT, 'planned', null],
			[2, LEG_PRESS, 'planned', null],
			[6, 'x1', 'added', null]
		]);
		const state = applyLocal(
			strengthTable,
			replay(strengthTable, { workoutId: W, kit: null, canonical, pending: [] }),
			{ workoutId: W, type: 'kit.attach', kit: KIT }
		);
		const adopted = viewOf(strengthTable, state)!;
		expect(adopted.slots.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(adopted.slots[0]!.kit).toBe(KIT.exercises[0]);
	});
});

describe('runs and other sessions', () => {
	const KITS = workoutDayKits({ date: DATE });
	const fields = (position: number) => ({
		position,
		kind: 'interval' as const,
		distanceMetres: 400,
		durationSeconds: 90,
		avgHr: null,
		rpe: null
	});
	const segment = (id: string, position: number) => ({
		id,
		...fields(position),
		paceSecondsPerKm: 225
	});
	const rows = (kind: 'run' | 'other'): CanonicalWorkout => {
		const started = serverModel([start()])!;
		return { ...started, workout: { ...started.workout, kind } };
	};
	const runRows: CanonicalWorkout = {
		...rows('run'),
		run: {
			distanceMetres: null,
			durationSeconds: null,
			avgHr: null,
			rpe: null,
			notes: null,
			paceSecondsPerKm: null,
			segments: [segment('g3', 3), segment('g1', 1), segment('g2', 2)]
		}
	};
	const other = { kind: 'class' as const, durationMinutes: 90, rpe: 7, metrics: [], notes: null };
	const otherRows: CanonicalWorkout = { ...rows('other'), other };
	const runView = (pending: Mutation[]) =>
		project(runTable, { workoutId: W, kit: KITS.run, canonical: runRows, pending })!;
	const otherView = (pending: Mutation[]) =>
		project(otherTable, { workoutId: W, kit: KITS.other, canonical: otherRows, pending })!;

	it("shows a run's segments in order, each marked pending while a change to it is unsent", () => {
		const edit = make('run.segment', { entityId: 'g2', payload: fields(2) });
		const v = runView([edit]);
		expect(v.slots).toEqual([]);
		expect(v.run!.pending).toBe(false);
		expect(v.run!.segments.map((g) => [g.id, g.pending])).toEqual([
			['g1', false],
			['g2', true],
			['g3', false]
		]);
		expect(runView([make('run.log', { payload: { distanceMetres: 5000 } })]).run!.pending).toBe(
			true
		);
	});

	it("shows an other session's record, pending while an other.log is unsent", () => {
		expect(otherView([]).other).toStrictEqual({ ...other, pending: false });
		expect(otherView([make('other.log', { payload: { ...other, rpe: 8 } })]).other!.pending).toBe(
			true
		);
	});
});

describe('device actions', () => {
	const state0 = replay(strengthTable, inputs([start()]));
	const apply = (...actions: LocalAction[]) =>
		actions.reduce((state, a) => applyLocal(strengthTable, state, a), state0);

	it('moves between exercises and keeps drafts until they are cleared', () => {
		const state = apply(
			{ workoutId: W, type: 'goTo', position: 4 },
			{ workoutId: W, type: 'draft', position: 4, setIndex: 1, draft: { reps: 7 } },
			{ workoutId: W, type: 'draft', position: 4, setIndex: 2, draft: { reps: 6 } },
			{ workoutId: W, type: 'draft', position: 4, setIndex: 1, draft: { reps: 8, rpe: 9 } }
		);
		expect(state.device.position).toBe(4);
		expect(state.device.drafts).toStrictEqual({ '4:1': { reps: 8, rpe: 9 }, '4:2': { reps: 6 } });
		const cleared = applyLocal(strengthTable, state, {
			workoutId: W,
			type: 'draft',
			position: 4,
			setIndex: 1,
			draft: null
		});
		expect(cleared.device.drafts).toStrictEqual({ '4:2': { reps: 6 } });
		expect(applyLocal(strengthTable, state, { workoutId: W, type: 'goTo', position: 4 })).toBe(
			state
		);
	});

	it("keeps an other session's unsaved fields, each draft replacing the last, until cleared", () => {
		const state = apply(
			{ workoutId: W, type: 'session.draft', draft: { durationMinutes: 90 } },
			{ workoutId: W, type: 'session.draft', draft: { durationMinutes: 85, rpe: 8 } }
		);
		expect(state.device.session).toStrictEqual({ durationMinutes: 85, rpe: 8 });
		const cleared = applyLocal(strengthTable, state, {
			workoutId: W,
			type: 'session.draft',
			draft: null
		});
		expect(cleared.device.session).toBeNull();
		expect(apply({ workoutId: W, type: 'session.draft', draft: null })).toBe(state0);
	});

	it('runs the rest timer and the stopwatch through timers.ts', () => {
		const state = apply(
			{ workoutId: W, type: 'rest.start', at: 10_000, durationMs: 90_000 },
			{ workoutId: W, type: 'rest.add', at: 20_000, ms: 30_000 },
			{ workoutId: W, type: 'rest.pause', at: 40_000 },
			{ workoutId: W, type: 'stopwatch.start', at: 5_000 },
			{ workoutId: W, type: 'stopwatch.start', at: 60_000 }
		);
		expect(restRemaining(state.device.rest!, 500_000)).toBe(90_000);
		expect(stopwatchElapsed(state.device.stopwatch, 65_000)).toBe(60_000);
		const skipped = applyLocal(strengthTable, state, {
			workoutId: W,
			type: 'rest.skip',
			at: 50_000
		});
		expect(restRemaining(skipped.device.rest!, 50_000)).toBe(0);
		expect(apply({ workoutId: W, type: 'rest.pause', at: 1 })).toBe(state0);
	});

	it('adds an exercise at a free position only', () => {
		const exercise = { position: 6, exercise: meta('x1', 'Keg carry'), addedAt: at(60) };
		const state = apply(
			{ workoutId: W, type: 'exercise.add', exercise },
			{
				workoutId: W,
				type: 'exercise.add',
				exercise: { ...exercise, exercise: meta('x2', 'Other') }
			},
			{ workoutId: W, type: 'exercise.add', exercise: { ...exercise, position: 2 } }
		);
		expect(state.device.added).toStrictEqual([exercise]);
		const v = viewOf(strengthTable, state)!;
		expect(v.slots.at(-1)).toMatchObject({ position: 6, exerciseId: 'x1', state: 'added' });
		expect(v.exercises.x1).toMatchObject({ name: 'Keg carry', measure: 'distance' });
	});
});

describe('convergence', () => {
	const keysOf = (m: Mutation) =>
		m.type === 'exercise.skip'
			? [entityKey(m), ...m.payload.sets.map((s) => `set:${s.id}`)]
			: [entityKey(m)];

	it(`folds ${SEQUENCE_COUNT} seeded strength sequences to one view, however the server and the outbox overlap`, () => {
		let overlaps = 0;
		for (let seed = 1; seed <= SEQUENCE_COUNT; seed++) {
			const { workoutId, mutations: M } = strengthSequence(seed, KIT);
			const projectOf = (i: WorkoutInputs) => project(strengthTable, i);
			const fold = settled(projectOf({ workoutId, kit: KIT, canonical: null, pending: M }));
			const { k, applied, random } = serverSplit(seed, M);
			const server = replay(strengthTable, {
				workoutId,
				kit: KIT,
				canonical: null,
				pending: applied
			}).rows;
			const canonical = server && {
				...server,
				sets: random.shuffle(server.sets),
				exercises: Object.fromEntries(random.shuffle(Object.entries(server.exercises)))
			};
			for (let i = 0; i <= k + 1; i++) {
				const pending = M.slice(i);
				const v = projectOf({ workoutId, kit: KIT, canonical, pending });
				expect(settled(v), `seed ${seed}, k ${k}, i ${i}`).toStrictEqual(fold);
				const touched = new Set(pending.flatMap(keysOf));
				expect(v!.workout.pending).toBe(touched.has(`workout:${workoutId}`));
				for (const s of live(v)) expect(s.pending).toBe(touched.has(`set:${s.id}`));
				if (i <= k) overlaps++;
			}
		}
		expect(overlaps).toBeGreaterThan(SEQUENCE_COUNT);
	}, 30_000);

	it('generates sequences that exercise every strength family this slice reduces', () => {
		const types = new Set<string>();
		const amounts = {
			reps: 0,
			seconds: 0,
			metres: 0,
			weight: 0,
			assistance: 0,
			missed: 0,
			extra: 0
		};
		for (let seed = 1; seed <= SEQUENCE_COUNT; seed++) {
			for (const m of strengthSequence(seed, KIT).mutations) {
				types.add(m.type);
				if (m.type !== 'set.log') continue;
				const p = m.payload;
				if (p.reps !== null) amounts.reps++;
				if (p.seconds !== null) amounts.seconds++;
				if (p.metres !== null) amounts.metres++;
				if (p.weight !== null) amounts.weight++;
				if (p.assistance !== null) amounts.assistance++;
				if (p.missedReps > 0) amounts.missed++;
				if (p.isExtra) amounts.extra++;
			}
		}
		expect([...types].sort()).toEqual([
			'exercise.create',
			'set.delete',
			'set.edit',
			'set.log',
			'set.skip',
			'workout.abandon',
			'workout.finish',
			'workout.start',
			'workout.update'
		]);
		for (const [amount, count] of Object.entries(amounts)) {
			expect(count, amount).toBeGreaterThan(20);
		}
		expect(strengthSequence(7, KIT)).toStrictEqual(strengthSequence(7, KIT));
	});
});

function customExercise(name: string): MutationOf<'exercise.create'>['payload'] {
	return {
		name,
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['forearms'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: null,
		repMax: null,
		defaultSeconds: null,
		unilateral: false,
		measure: 'distance',
		loadType: 'external',
		tags: [],
		disciplines: []
	};
}

function meta(id: string, name: string): KitExerciseMeta {
	return {
		id,
		key: null,
		name,
		measure: 'distance',
		loadType: 'external',
		unilateral: false,
		pattern: 'carry',
		tags: [],
		restClass: 'compound',
		increment: 2.5
	};
}
