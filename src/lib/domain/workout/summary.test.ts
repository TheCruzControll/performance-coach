import { describe, expect, expectTypeOf, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { estimateOneRepMax } from '../e1rm';
import { sessionLoad } from '../load';
import { setE1rm } from '../training/metrics';
import { cleanFloat, convertWeight, paceSecondsPer } from '../units';
import { e1rmOf } from './logging';
import { createMutation } from './mutations';
import type { Mutation, MutationInput, MutationOf, MutationType } from './mutations';
import { project, replay } from './project';
import type { AnyTable } from './project';
import type { CanonicalOther, CanonicalRun, CanonicalWorkout } from './protocol';
import { initialDevice } from './reducers/device';
import { otherTable, runTable, strengthTable } from './reducers/tables';
import { bestsOf, kitBests, summarizeWorkout } from './summary';
import type { ExerciseBests, PriorBests } from './summary';
import type {
	DeviceState,
	ExerciseSummary,
	KitExercise,
	KitUnits,
	LoggedSet,
	StartKit
} from './types';

const KITS = workoutDayKits({ date: '2026-11-06' });
const KIT = KITS.strength;
const W = '00000000-0000-4000-8000-0000000000b1';
const idAt = (position: number) => KIT.exercises[position - 1]!.exercise.id;
const SQUAT = idAt(1);
const LEG_PRESS = idAt(2);
const PULL_UP = idAt(4);
const PLANK = idAt(5);
const ASSISTED = 'assisted_pull_up';
const ASSISTED_PULL_UP: ExerciseSummary = {
	name: 'Assisted pull-up',
	measure: 'reps',
	loadType: 'assisted',
	unilateral: false
};
const KG: KitUnits = { weight: 'kg', distance: 'km' };
const LB: KitUnits = { weight: 'lb', distance: 'mi' };

let ids = 0;
const fresh = () => `m-${++ids}`;
let clock = 0;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 18, 0, second)).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'>
): MutationOf<T> {
	return createMutation(type, { workoutId: W, at: at(++clock), ...input }, fresh);
}

const start = (kit: StartKit = KIT) =>
	make('workout.start', {
		entityId: W,
		payload: {
			kind: kit.kind,
			title: kit.title,
			sessionType: kit.sessionType,
			discipline: kit.discipline,
			plannedSessionId: kit.plannedSessionId,
			plannedLineage: kit.plannedLineage,
			programId: kit.programId
		}
	});

const done = (fields: Partial<LoggedSet>): LoggedSet => ({
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

const place = (position: number, setIndex: number, exerciseId = idAt(position)) => ({
	position,
	plannedLineage: KIT.exercises[position - 1]?.plannedLineage ?? null,
	setIndex,
	exerciseId
});

/** set.log at a slot: the back squat's first set by default. */
function log(
	fields: Partial<LoggedSet> = {},
	{ position = 1, setIndex = 1, exerciseId = idAt(position), id = fresh() } = {}
) {
	return make('set.log', {
		entityId: id,
		payload: { ...place(position, setIndex, exerciseId), ...done(fields) }
	});
}

const skip = (position: number, setIndex: number) =>
	make('set.skip', { payload: { ...place(position, setIndex), unit: 'kg' } });
const remove = (id: string) => make('set.delete', { entityId: id, payload: {} });
const update = (payload: { sessionRpe?: number; durationSeconds?: number }) =>
	make('workout.update', { payload });

const plank = (seconds: number, setIndex: number) =>
	log({ reps: null, weight: null, seconds, rpe: null }, { position: 5, setIndex });

/** The device's view: the kit, and every mutation still in the outbox. */
function onDevice(mutations: Mutation[], device?: DeviceState) {
	return project(strengthTable, {
		workoutId: W,
		kit: KIT,
		canonical: null,
		pending: [start(), ...mutations],
		device
	})!;
}

const KIT_EXERCISES = Object.fromEntries(
	KIT.exercises.map(({ exercise: { id, name, measure, loadType, unilateral } }) => [
		id,
		{ name, measure, loadType, unilateral }
	])
);

/**
 * The server's rows for the same mutations, as GET /api/workouts/[id] returns them: every set's
 * e1rmKg filled in, and every exercise the rows name in the map.
 */
function serverRows(
	mutations: Mutation[],
	{
		table = strengthTable as AnyTable,
		kit = KIT as StartKit,
		exercises = {} as Record<string, ExerciseSummary>
	} = {}
): CanonicalWorkout {
	const pending = [start(kit), ...mutations];
	const rows = replay(table, { workoutId: W, kit: null, canonical: null, pending }).rows!;
	const named = { ...KIT_EXERCISES, ...exercises };
	const e1rmKg = (set: CanonicalWorkout['sets'][number]) =>
		e1rmOf(set, named[set.exerciseId]!)?.value ?? null;
	return { ...rows, sets: rows.sets.map((s) => ({ ...s, e1rmKg: e1rmKg(s) })), exercises: named };
}

/** The server's view of its rows: no kit, no outbox, an idle device. */
const onServer = (rows: CanonicalWorkout, table: AnyTable = strengthTable) =>
	project(table, { workoutId: W, kit: null, canonical: rows, pending: [] })!;

const bests = (values: Partial<ExerciseBests> = {}): ExerciseBests => ({
	e1rmKg: null,
	repMaxes: [],
	mostReps: null,
	...values
});

const summarize = (mutations: Mutation[], prior: PriorBests = {}, units = KG) =>
	summarizeWorkout(onDevice(mutations), prior, units);

/** M3's setE1rm of a working kg set: what a prior best e1RM holds. */
const e1rm = (weight: number, reps = 5, rpe = 8) =>
	setE1rm({ weight, reps, rpe, unit: 'kg', isWarmup: false, isSkipped: false })!.value;

describe('summarizeWorkout: what counts', () => {
	it('never counts a warm-up, a skipped set or a deleted set', () => {
		const deleted = fresh();
		const prior = { [SQUAT]: bests({ e1rmKg: 125, repMaxes: [{ reps: 5, weightKg: 100 }] }) };
		const s = summarize(
			[
				log({ weight: 150, rpe: null, isWarmup: true }, { setIndex: 1 }),
				log({ weight: 100, rpe: 8 }, { setIndex: 2 }),
				log({ weight: 180, rpe: 9 }, { setIndex: 3, id: deleted }),
				remove(deleted),
				skip(1, 4)
			],
			prior
		);

		expect(s.exercises).toHaveLength(1);
		expect(s.exercises[0]).toMatchObject({
			exerciseId: SQUAT,
			name: 'Back squat',
			sets: { done: 1, skipped: 1 },
			volume: 500,
			totals: { reps: 5, seconds: 0, metres: 0 },
			best: { setIndex: 2, weight: 100, reps: 5 },
			firstTime: false
		});
		expect(s.sets).toEqual({ done: 1, skipped: 1 });
		expect(s.volume).toBe(500);
		// The 150 kg warm-up and the deleted 180 kg set would each beat both bests.
		expect(s.prs).toEqual([]);
	});

	it('converts an lb entry exactly, into either unit', () => {
		const mutations = [log({ weight: 225, unit: 'lb', reps: 5, rpe: 8 })];
		const inLb = summarize(mutations, {}, LB);
		expect(inLb.volume).toBe(1125);
		expect(inLb.exercises[0]!.volume).toBe(1125);
		expect(inLb.exercises[0]!.best!.e1rm!.value).toBe(
			cleanFloat(estimateOneRepMax({ weight: 225, reps: 5, rpe: 8 })!.value)
		);
		expect(summarize(mutations, {}, KG).volume).toBe(
			cleanFloat(convertWeight(225, 'lb', 'kg') * 5)
		);

		// 230 lb is 104.3262451 kg exactly, as Postgres's numeric holds it; the float product
		// (104.32624510000001) carries noise that must not read as a heavier lift.
		const prior = { [SQUAT]: bests({ repMaxes: [{ reps: 5, weightKg: 104.3262451 }] }) };
		const squats = (weight: number) => [log({ weight, unit: 'lb', reps: 5, rpe: 5 })];
		expect(summarize(squats(230), prior, LB).prs).toEqual([]);
		expect(summarize(squats(235), prior, LB).prs).toEqual([
			expect.objectContaining({ kind: 'rep_max', reps: 5, value: 235, previous: 230 })
		]);
	});

	it('reports a plank in seconds, with no volume', () => {
		const s = summarize([plank(45, 1), plank(50, 2), plank(45, 3)]);
		expect(s.exercises[0]).toMatchObject({
			exerciseId: PLANK,
			measure: 'time',
			volume: null,
			totals: { reps: 0, seconds: 140, metres: 0 },
			best: { setIndex: 2, seconds: 50, e1rm: null }
		});
		expect(s.volume).toBeNull();
		expect(s.totals).toEqual({ reps: 0, seconds: 140, metres: 0 });
	});

	it('counts volume on a pull-up only for weight added, and reps either way', () => {
		const pullUp = (weight: number | null, reps: number, setIndex: number) =>
			log({ weight, reps, rpe: 9 }, { position: 4, setIndex });
		const s = summarize([log({ weight: 100 }), pullUp(null, 10, 1), pullUp(10, 8, 2)]);
		expect(s.exercises[1]).toMatchObject({
			exerciseId: PULL_UP,
			volume: 80,
			totals: { reps: 18 },
			best: { setIndex: 2, weight: 10, e1rm: null }
		});
		expect(s.volume).toBe(580);
		expect(s.totals.reps).toBe(23);

		expect(summarize([pullUp(null, 10, 1)]).exercises[0]).toMatchObject({
			volume: null,
			totals: { reps: 10 }
		});
	});

	it('shows the set with the highest e1RM as the best, not the heaviest', () => {
		expect(e1rm(100, 8, 9)).toBeGreaterThan(e1rm(110, 3, 9));
		const s = summarize([
			log({ weight: 110, reps: 3, rpe: 9 }, { setIndex: 1 }),
			log({ weight: 100, reps: 8, rpe: 9 }, { setIndex: 2 }),
			log({ weight: 120, reps: 1, rpe: 5 }, { setIndex: 3 })
		]);
		expect(s.exercises[0]!.best).toMatchObject({
			setIndex: 2,
			e1rm: { kind: 'estimated', value: cleanFloat(e1rm(100, 8, 9)) }
		});
	});

	it('gives each exercise a line in slot order, under the exercise its sets name', () => {
		const HACK_SQUAT = 'hack_squat';
		const hack: ExerciseSummary = { ...KIT_EXERCISES[LEG_PRESS]!, name: 'Hack squat' };
		const rows = serverRows(
			[
				plank(45, 1),
				log({ weight: 10, reps: 8 }, { position: 4 }),
				log({ weight: 140, reps: 10 }, { position: 2 }),
				// The rest of the slot on a substitute: its sets name it, not the planned leg press.
				log({ weight: 120, reps: 10 }, { position: 2, setIndex: 2, exerciseId: HACK_SQUAT }),
				log()
			],
			{ exercises: { [HACK_SQUAT]: hack } }
		);
		const s = summarizeWorkout(onServer(rows), {}, KG);
		expect(s.exercises.map((e) => [e.exerciseId, e.name, e.volume])).toEqual([
			[SQUAT, 'Back squat', 500],
			[LEG_PRESS, 'Leg press', 1400],
			[HACK_SQUAT, 'Hack squat', 1200],
			[PULL_UP, 'Pull-up', 80],
			[PLANK, 'Plank', null]
		]);
	});
});

describe('summarizeWorkout: PRs', () => {
	const prior = {
		[SQUAT]: bests({ e1rmKg: e1rm(100), repMaxes: [{ reps: 5, weightKg: 100 }] })
	};

	it('sets a PR only strictly above the prior best', () => {
		expect(summarize([log({ weight: 100 })], prior).prs).toEqual([]);
		expect(summarize([log({ weight: 102.5 })], prior).prs).toEqual([
			{
				kind: 'e1rm',
				label: 'Estimated 1RM',
				exerciseId: SQUAT,
				name: 'Back squat',
				reps: null,
				value: cleanFloat(e1rm(102.5)),
				previous: cleanFloat(e1rm(100)),
				estimated: true
			},
			{
				kind: 'rep_max',
				label: 'Rep max',
				exerciseId: SQUAT,
				name: 'Back squat',
				reps: 5,
				value: 102.5,
				previous: 100,
				estimated: false
			}
		]);
		// A rep count never lifted before has no best to beat; RPE 5 gives no e1RM.
		expect(summarize([log({ weight: 200, reps: 3, rpe: 5 })], prior).prs).toEqual([]);
	});

	it("reads a first performance as 'first time', never a PR", () => {
		const mutations = [log({ weight: 100 })];
		const first = summarize(mutations, { [SQUAT]: null });
		expect(first.exercises[0]!.firstTime).toBe(true);
		expect(first.prs).toEqual([]);

		// Bests this device does not hold (a substitute's) are unknown: no PR, and no first time.
		const unknown = summarize(mutations, {});
		expect(unknown.exercises[0]!.firstTime).toBe(false);
		expect(unknown.prs).toEqual([]);
	});

	it('labels every e1RM and e1RM PR estimated, never measured, a single at RPE 10 included', () => {
		const s = summarize([log({ weight: 140, reps: 1, rpe: 10 })], prior);
		expect(s.exercises[0]!.best!.e1rm).toMatchObject({ kind: 'estimated', value: 140 });
		expect(s.prs).toEqual([
			expect.objectContaining({ kind: 'e1rm', label: 'Estimated 1RM', estimated: true })
		]);
		expect(JSON.stringify(s)).not.toMatch(/measured/i);
	});

	it('never gives an assisted pull-up a PR or an e1RM', () => {
		const assisted = (assistance: number, reps: number, setIndex: number) =>
			log(
				{ weight: null, assistance, reps, rpe: 8 },
				{ position: 6, setIndex, exerciseId: ASSISTED }
			);
		const rows = serverRows([assisted(20, 8, 1), assisted(10, 6, 2)], {
			exercises: { [ASSISTED]: ASSISTED_PULL_UP }
		});
		const strong = bests({ e1rmKg: 1, repMaxes: [{ reps: 6, weightKg: 1 }], mostReps: 1 });
		const s = summarizeWorkout(onServer(rows), { [ASSISTED]: strong }, KG);

		expect(s.exercises[0]).toMatchObject({
			exerciseId: ASSISTED,
			volume: null,
			totals: { reps: 14 },
			// The least help is the hardest set.
			best: { setIndex: 2, assistance: 10, e1rm: null }
		});
		expect(s.prs).toEqual([]);
	});

	it("beats a prior 10 with 12 unweighted pull-ups as 'Most reps'", () => {
		const pullUps = { [PULL_UP]: bests({ mostReps: 10 }) };
		const pullUp = (weight: number | null, reps: number, setIndex: number) =>
			log({ weight, reps, rpe: 9 }, { position: 4, setIndex });

		// The weighted set of 14 competes for nothing: 'Most reps' is bodyweight alone.
		expect(summarize([pullUp(null, 12, 1), pullUp(10, 14, 2)], pullUps).prs).toEqual([
			{
				kind: 'most_reps',
				label: 'Most reps',
				exerciseId: PULL_UP,
				name: 'Pull-up',
				reps: null,
				value: 12,
				previous: 10,
				estimated: false
			}
		]);
		expect(summarize([pullUp(null, 10, 1)], pullUps).prs).toEqual([]);
	});
});

describe('summarizeWorkout: duration and session load', () => {
	/** 10 minutes banked, running again since t = 1000 s. */
	const running: DeviceState = {
		...initialDevice(),
		stopwatch: { startedAt: 0, accumulatedMs: 600_000, runningSince: 1_000_000 }
	};

	it('loads as sessionLoad(minutes, RPE), timed by the stopwatch until a duration is set', () => {
		const rated = onDevice([update({ sessionRpe: 8 })], running);
		expect(summarizeWorkout(rated, {}, KG, 1_000_000 + 3_000_000)).toMatchObject({
			durationSeconds: 3600,
			sessionRpe: 8,
			sessionLoad: sessionLoad(60, 8)
		});
		// Without a clock a running stopwatch cannot be read, so there is no duration or load.
		expect(summarizeWorkout(rated, {}, KG)).toMatchObject({
			durationSeconds: null,
			sessionLoad: null
		});
		// A paused one needs no clock.
		const paused = { ...running, stopwatch: { ...running.stopwatch, runningSince: null } };
		expect(summarizeWorkout(onDevice([], paused), {}, KG).durationSeconds).toBe(600);

		// The recorded duration (the finish sheet's edit, the server's row) wins over the stopwatch.
		const recorded = onDevice([update({ sessionRpe: 7.5, durationSeconds: 2700 })], running);
		expect(summarizeWorkout(recorded, {}, KG, 99_000_000)).toMatchObject({
			durationSeconds: 2700,
			sessionLoad: sessionLoad(45, 7.5)
		});
		// No load until the session RPE is in.
		const unrated = onDevice([update({ durationSeconds: 2700 })]);
		expect(summarizeWorkout(unrated, {}, KG).sessionLoad).toBeNull();
	});
});

describe('summarizeWorkout: runs and other sessions', () => {
	function view(table: AnyTable, kit: StartKit, change: Partial<CanonicalWorkout>) {
		const rows = serverRows([update({ sessionRpe: 7, durationSeconds: 3000 })], { table, kit });
		return onServer({ ...rows, ...change }, table);
	}
	const RUN: CanonicalRun = {
		distanceMetres: 8000,
		durationSeconds: 2400,
		avgHr: 152,
		rpe: 7,
		notes: null,
		// A device's own row has no pace until the server's returns: the summary never reads it.
		paceSecondsPerKm: null,
		segments: []
	};

	it("gives a run its totals and M1's average pace, per km or per mile", () => {
		const run = view(runTable, KITS.run, { run: RUN });
		const s = summarizeWorkout(run, {}, KG);
		expect(s).toMatchObject({ kind: 'run', exercises: [], volume: null, prs: [] });
		expect(s.run).toEqual({
			distanceMetres: 8000,
			durationSeconds: 2400,
			pace: paceSecondsPer(2400, 8000, 'km'),
			avgHr: 152
		});
		expect(s.run!.pace).toBe(300);
		expect(summarizeWorkout(run, {}, LB).run!.pace).toBe(paceSecondsPer(2400, 8000, 'mi'));
		expect(s.sessionLoad).toBe(sessionLoad(50, 7));

		const unfinished = view(runTable, KITS.run, { run: { ...RUN, distanceMetres: null } });
		expect(summarizeWorkout(unfinished, {}, KG).run).toMatchObject({ pace: null });
	});

	it('gives an other session its load as sessionLoad(minutes, RPE), and its metrics', () => {
		const metrics = [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }];
		const other: CanonicalOther = {
			kind: 'class',
			durationMinutes: 90,
			rpe: 8,
			metrics,
			notes: null
		};
		const s = summarizeWorkout(view(otherTable, KITS.other, { other }), {}, KG);
		expect(s.other).toEqual({
			kind: 'class',
			durationMinutes: 90,
			rpe: 8,
			load: sessionLoad(90, 8),
			metrics
		});
		expect(s.run).toBeNull();

		const unrated = view(otherTable, KITS.other, { other: { ...other, rpe: null } });
		expect(summarizeWorkout(unrated, {}, KG).other!.load).toBeNull();
	});
});

describe('summarizeWorkout: one definition on the device and the server', () => {
	it('gives the same summary from the outbox on the device as from the rows on the server', () => {
		const mutations = [
			log({ weight: 60, rpe: null, isWarmup: true }, { setIndex: 1 }),
			log({ weight: 107.5, rpe: 8 }, { setIndex: 2 }),
			log({ weight: 225, unit: 'lb', rpe: 8.5 }, { setIndex: 3 }),
			skip(1, 4),
			log({ weight: 140, reps: 10, rpe: 7 }, { position: 2 }),
			log({ weight: null, reps: 11, rpe: 9 }, { position: 4 }),
			plank(45, 1),
			update({ sessionRpe: 8, durationSeconds: 3900 })
		];
		const prior = { ...kitBests(KIT), [PULL_UP]: bests({ mostReps: 10 }) };
		const device = summarizeWorkout(onDevice(mutations), prior, KG);

		expect(summarizeWorkout(onServer(serverRows(mutations)), prior, KG)).toEqual(device);
		expect(device.prs.map((pr) => pr.kind)).toEqual(['e1rm', 'rep_max', 'most_reps']);
		expect(device.exercises[1]!.firstTime).toBe(true);
	});
});

describe('kitBests', () => {
	it("holds the bests a strength kit carried, and null for an exercise's first time", () => {
		const prior = kitBests(KIT);
		expect(prior[SQUAT]).toEqual({
			e1rmKg: 125,
			repMaxes: KIT.exercises[0]!.priorBests,
			mostReps: null
		});
		expect(prior[LEG_PRESS]).toBeNull();
		expect(Object.keys(prior)).toEqual(KIT.exercises.map((e) => e.exercise.id));

		const pullUp = KIT.exercises[3]!;
		const kitOf = (exercise: typeof pullUp) => ({ ...KIT, exercises: [exercise] });
		expect(kitBests(kitOf({ ...pullUp, mostReps: 10 }))[PULL_UP]).toEqual(bests({ mostReps: 10 }));
		// Done before with no best of any kind (every set weighted): known, so not a first time.
		const previous = { date: '2026-10-30', sets: [done({ weight: 10, reps: 8 })] };
		expect(kitBests(kitOf({ ...pullUp, previous }))[PULL_UP]).toEqual(bests());

		expect(kitBests(KITS.run)).toEqual({});
		expect(kitBests(null)).toEqual({});
		// pnpm check: a kit must carry mostReps, so start-kit cannot leave 'Most reps' unknown.
		expectTypeOf<KitExercise['mostReps']>().toEqualTypeOf<number | null>();
	});
});

describe('bestsOf', () => {
	it('keeps the bests each PR kind competes on, from working sets only', () => {
		const sets = onDevice([
			log({ weight: 150, isWarmup: true }, { setIndex: 1 }),
			log({ weight: 100, reps: 5, rpe: 8 }, { setIndex: 2 }),
			log({ weight: 110, reps: 3, rpe: 5 }, { setIndex: 3 })
		]).slots[0]!.sets;
		expect(bestsOf(sets, KIT.exercises[0]!.exercise)).toEqual({
			e1rmKg: e1rm(100),
			repMaxes: [
				{ reps: 3, weightKg: 110 },
				{ reps: 5, weightKg: 100 }
			],
			mostReps: null
		});
	});
});
