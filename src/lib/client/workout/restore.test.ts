import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { MutationInput, MutationOf, MutationType } from '#lib/domain/workout/index.ts';
import { project } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { DB_NAME } from './names';
import { readActive } from './restore';
import { createStore } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

const make = <T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'at'>,
	at = '2026-11-06T18:00:00.000Z'
): MutationOf<T> => createMutation(type, { at, ...input }, fresh);

const start = (workoutId: string, at?: string) =>
	make(
		'workout.start',
		{
			workoutId,
			payload: {
				kind: 'strength',
				title: KIT.title,
				sessionType: KIT.sessionType,
				discipline: KIT.discipline,
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		},
		at
	);

const squat = (workoutId: string, setIndex: number) =>
	make('set.log', {
		workoutId,
		payload: {
			position: 1,
			plannedLineage: KIT.exercises[0]!.plannedLineage,
			setIndex,
			exerciseId: KIT.exercises[0]!.exercise.id,
			reps: 5,
			seconds: null,
			metres: null,
			weight: 100,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		}
	});

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('readActive', () => {
	it('reads none, and creates nothing, on a device without the database', async () => {
		await expect(readActive()).resolves.toEqual({ status: 'none' });
		expect(await indexedDB.databases()).toEqual([]);
	});

	it("reads none from a 'pc-offline' without the workout stores (M2's sign-out specs)", async () => {
		const foreign = await openDB(DB_NAME, 1, { upgrade: (db) => db.createObjectStore('sets') });
		foreign.close();
		await expect(readActive()).resolves.toEqual({ status: 'none' });
	});

	it('restores exactly what the store shows: the newest workout in progress, its outbox in order', async () => {
		const store = await createStore({ table: strengthTable, channel: null });
		// An older workout, finished: not the active one.
		expect(await store.dispatch(start(W2, '2026-11-05T18:00:00.000Z')).saved).toBe('saved');
		const finish = make('workout.finish', { workoutId: W2, payload: {} });
		expect(await store.dispatch(finish).saved).toBe('saved');

		const attach = { type: 'kit.attach', workoutId: W, kit: KIT } as const;
		expect(await store.dispatch(start(W), attach).saved).toBe('saved');
		expect(await store.dispatch(squat(W, 1)).saved).toBe('saved');
		expect(await store.dispatch(squat(W, 2)).saved).toBe('saved');
		expect(await store.dispatch({ type: 'goTo', workoutId: W, position: 2 }).saved).toBe('saved');

		const read = await readActive();
		expect(read.status).toBe('found');
		if (read.status !== 'found') return;
		expect(read.inputs.workoutId).toBe(W);
		expect(read.inputs.pending.map((m) => m.type)).toEqual(['workout.start', 'set.log', 'set.log']);
		const view = project(strengthTable, read.inputs);
		expect(view).toEqual(store.snapshot(W)?.view);
		expect(view?.device.position).toBe(2);
		expect(view?.slots[0]?.sets.map((s) => s.setIndex)).toEqual([1, 2]);
	});

	it('reads none when no workout is in progress', async () => {
		const store = await createStore({ table: strengthTable, channel: null });
		expect(await store.dispatch(start(W)).saved).toBe('saved');
		expect(await store.dispatch(make('workout.abandon', { workoutId: W, payload: {} })).saved).toBe(
			'saved'
		);
		await expect(readActive()).resolves.toEqual({ status: 'none' });
	});

	it('reads a database a newer app has upgraded as upgraded', async () => {
		const newer = await openDB(DB_NAME, 2);
		newer.close();
		await expect(readActive()).resolves.toEqual({ status: 'upgraded' });
	});

	it('rejects when this browser refuses IndexedDB', async () => {
		vi.stubGlobal('indexedDB', {
			open: () => {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			}
		});
		await expect(readActive()).rejects.toThrow('insecure');
	});
});
