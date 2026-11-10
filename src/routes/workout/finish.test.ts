import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import { createStore, type WorkoutStore } from '#lib/client/workout/store.ts';
import { estimateOneRepMax } from '#lib/domain/e1rm.ts';
import { formatWeight } from '#lib/domain/units.ts';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { LoggedSet, Mutation, SyncResult } from '#lib/domain/workout/index.ts';
import { project, replay } from '#lib/domain/workout/project.ts';
import { initialDevice } from '#lib/domain/workout/reducers/device.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import {
	finishMutation,
	finishValues,
	finishWorkout,
	openSets,
	summaryOf,
	summaryWords,
	valuesOf
} from './finish';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000f1';
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const at = (minutes = 0) => new Date(T0 + minutes * 60_000).toISOString();

const start = createMutation(
	'workout.start',
	{
		workoutId: W,
		at: at(),
		payload: {
			kind: 'strength',
			title: KIT.title,
			sessionType: KIT.sessionType,
			discipline: KIT.discipline,
			plannedSessionId: KIT.plannedSessionId,
			plannedLineage: KIT.plannedLineage,
			programId: KIT.programId
		}
	},
	fresh
);

const NONE: LoggedSet = {
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
};

/** A set of the exercise at `position` in the fixture: the squat, the pull-up, the plank… */
function log(position: number, setIndex: number, values: Partial<LoggedSet>) {
	const slot = KIT.exercises[position - 1]!;
	return createMutation(
		'set.log',
		{
			workoutId: W,
			at: at(setIndex),
			payload: {
				position,
				plannedLineage: slot.plannedLineage,
				setIndex,
				exerciseId: slot.exercise.id,
				...NONE,
				...values
			}
		},
		fresh
	);
}

/** The view after `pending`, its stopwatch started at T0 and running. */
const viewOf = (pending: Mutation[]) =>
	project(strengthTable, {
		workoutId: W,
		kit: KIT,
		canonical: null,
		pending: [start, ...pending],
		device: {
			...initialDevice(),
			stopwatch: { startedAt: T0, accumulatedMs: 0, runningSince: T0 }
		}
	})!;

describe('finishing a workout', () => {
	it('counts the planned sets still open, every exercise’s', () => {
		const planned = KIT.exercises.reduce((n, e) => n + e.sets.length, 0);
		expect(openSets(viewOf([]))).toBe(planned);
		expect(
			openSets(
				viewOf([log(1, 1, { reps: 5, weight: 100, rpe: 8 }), log(1, 2, { reps: 5, weight: 95 })])
			)
		).toBe(planned - 2);
	});

	it('starts from the stopwatch’s duration, and carries the session RPE and notes in the finish', () => {
		const view = viewOf([]);
		expect(finishValues(view, T0 + 52 * 60_000 + 20_400)).toEqual({
			durationSeconds: 52 * 60 + 20,
			sessionRpe: null,
			notes: null
		});
		const finish = finishMutation(
			W,
			{ durationSeconds: 3120, sessionRpe: 8, notes: '  Felt strong \n' },
			T0
		);
		expect(finish).toMatchObject({
			v: 1,
			type: 'workout.finish',
			workoutId: W,
			entityId: W,
			at: at(),
			payload: { durationSeconds: 3120, sessionRpe: 8, notes: 'Felt strong' }
		});
		expect(finish.id).not.toBe(W);
		expect(
			finishMutation(W, { durationSeconds: 60, sessionRpe: null, notes: '   ' }, T0).payload.notes
		).toBeNull();
	});

	it('opens a refused finish with its own values over the workout’s', () => {
		const refused = createMutation(
			'workout.finish',
			{ workoutId: W, at: at(60), payload: { sessionRpe: 11, notes: 'Heavy' } },
			fresh
		);
		expect(valuesOf(refused, viewOf([]), T0 + 30 * 60_000)).toEqual({
			durationSeconds: 1800,
			sessionRpe: 11,
			notes: 'Heavy'
		});
	});
});

describe('the summary in words', () => {
	it('marks the best set’s e1RM estimated, as M1 estimates it, and sets no PR at or under the kit’s bests', () => {
		const view = viewOf([
			log(1, 1, { reps: 5, weight: 100, rpe: 8 }),
			log(1, 2, { reps: 5, weight: 95, rpe: 7 })
		]);
		const words = summaryWords(summaryOf(view, T0 + 40 * 60_000));
		const e1rm = estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 })!.value;
		expect(words.exercises[0]).toEqual({
			key: KIT.exercises[0]!.exercise.id,
			name: 'Back squat',
			done: '2 sets · 975 kg',
			best: `100 kg × 5 · Estimated 1RM ${formatWeight(e1rm, 'kg')}`
		});
		// 123.3 kg is under the 125 kg best, and 100 kg × 5 only ties the 5-rep best.
		expect(words.prs).toEqual([]);
		expect(words.stats).toEqual([
			{ label: 'Duration', value: '40 min' },
			{ label: 'Sets', value: '2 done' },
			{ label: 'Volume', value: '975 kg' }
		]);
	});

	it('names a PR only above the kit’s best, as estimated, and gives the plank its seconds, not volume', () => {
		const view = viewOf([
			log(1, 1, { reps: 5, weight: 110, rpe: 8 }),
			log(5, 1, { seconds: 50 }),
			log(5, 2, { seconds: 40 }),
			createMutation(
				'set.skip',
				{
					workoutId: W,
					at: at(9),
					payload: {
						position: 5,
						plannedLineage: KIT.exercises[4]!.plannedLineage,
						setIndex: 3,
						exerciseId: KIT.exercises[4]!.exercise.id,
						unit: 'kg'
					}
				},
				fresh
			)
		]);
		const words = summaryWords(summaryOf(view, T0 + 60 * 60_000));
		const e1rm = estimateOneRepMax({ weight: 110, reps: 5, rpe: 8 })!.value;
		expect(words.prs.map(({ title, detail }) => ({ title, detail }))).toEqual([
			{
				title: 'New estimated best · Back squat',
				detail: `Estimated 1RM ${formatWeight(e1rm, 'kg')}, was 125 kg`
			},
			{ title: 'New best for its reps · Back squat', detail: '5 reps at 110 kg, was 100 kg' }
		]);
		const plank = words.exercises.find((e) => e.name === 'Plank')!;
		expect(plank.done).toBe('2 sets · 1 skipped · 1:30');
		expect(plank.done).not.toMatch(/kg/);
		expect(plank.best).toBe('0:50 · First time');
		expect(words.stats).toContainEqual({ label: 'Sets', value: '3 done · 1 skipped' });
		expect(JSON.stringify(words)).not.toMatch(/record/i);
	});

	it('shows the duration the owner set, in place of the stopwatch’s', () => {
		const summary = { ...summaryOf(viewOf([]), T0 + 10 * 60_000), durationSeconds: 3900 };
		expect(summaryWords(summary).stats[0]).toEqual({ label: 'Duration', value: '1 h 05 min' });
	});

	it('reads no session RPE or duration a refused finish holds out of range, so Fix still opens', () => {
		const refused = createMutation(
			'workout.finish',
			{ workoutId: W, at: at(30), payload: { sessionRpe: 11, durationSeconds: -60 } },
			fresh
		);
		const view = viewOf([refused]);
		expect(view.workout.sessionRpe).toBe(11);
		const summary = summaryOf(view, T0 + 30 * 60_000);
		expect(summary).toMatchObject({ sessionRpe: null, sessionLoad: null, durationSeconds: 1800 });
	});
});

describe('Done', () => {
	let store: WorkoutStore;

	beforeEach(async () => {
		vi.stubGlobal('indexedDB', new IDBFactory());
		store = await createStore({ table: strengthTable, channel: null });
		const begun = store.dispatch(
			start,
			{ type: 'kit.attach', workoutId: W, kit: KIT },
			{ type: 'stopwatch.start', workoutId: W, at: T0 }
		);
		expect(await begun.saved).toBe('saved');
	});

	afterEach(() => vi.unstubAllGlobals());

	const finish = () =>
		finishMutation(W, { durationSeconds: 3000, sessionRpe: 8, notes: null }, T0 + 50 * 60_000);

	/** The server's answer to every change in the outbox: applied, or `status` for the finish. */
	async function answer(status: SyncResult['status'] = 'applied') {
		const sent = (await store.outbox()).map((e) => e.envelope);
		const canonical = replay(strengthTable, {
			workoutId: W,
			kit: KIT,
			canonical: null,
			pending: sent
		}).rows!;
		return store.acknowledge(
			sent.map((m, i): SyncResult =>
				m.type === 'workout.finish' && status !== 'applied'
					? { id: m.id, status, code: 'invalid', errors: { 'payload.sessionRpe': 'Too high' } }
					: { id: m.id, status: 'applied', ...(i === sent.length - 1 && { canonical }) }
			)
		);
	}

	it('offline: writes the finish and pauses the stopwatch, and stays on the completed state', async () => {
		const now = T0 + 50 * 60_000;
		expect(await finishWorkout(store, finish(), { online: () => false, now: () => now })).toBe(
			'stay'
		);
		const view = store.snapshot(W)!.view!;
		expect(view.workout).toMatchObject({
			status: 'completed',
			sessionRpe: 8,
			durationSeconds: 3000
		});
		expect(view.device.stopwatch).toEqual({
			startedAt: T0,
			accumulatedMs: 50 * 60_000,
			runningSince: null
		});
		expect((await store.outbox()).map((e) => e.envelope.type)).toEqual([
			'workout.start',
			'workout.finish'
		]);
	});

	it('online: opens History once the server has the finish, and the workout has left the device', async () => {
		const done = finishWorkout(store, finish(), { online: () => true, waitMs: 5_000 });
		await vi.waitFor(async () => expect(await store.outbox()).toHaveLength(2));
		await answer();
		expect(await done).toBe('history');
		expect(await store.load(W)).toBeNull();
	});

	it('online: stays when the server refuses the finish, or has not answered in time', async () => {
		const refused = finishWorkout(store, finish(), { online: () => true, waitMs: 5_000 });
		await vi.waitFor(async () => expect(await store.outbox()).toHaveLength(2));
		await answer('rejected');
		expect(await refused).toBe('stay');

		const slow = finishWorkout(store, finish(), { online: () => true, waitMs: 20 });
		expect(await slow).toBe('stay');
	});
});
