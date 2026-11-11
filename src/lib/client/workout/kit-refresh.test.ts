import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { StartKit, StrengthKit } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { clearKitRefresh, KIT_REFRESH_KEY, kitRefreshMarked, markKitRefresh } from './kit-mark';
import { refreshKit, refreshMarked, startAfresh } from './kit-refresh';
import { startKitUrl, startPlanned } from './start';
import { createStore, type WorkoutStore } from './store';

const KITS = workoutDayKits({ date: '2026-11-06' });
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const { strength: STRENGTH } = WORKOUT_DAY_IDS;
const URL = startKitUrl(STRENGTH.lineage);
const SAVED = KITS.strength as StrengthKit;

/** The plan as the server has it now: the squat's sets changed since this device saved the kit. */
const FRESH: StrengthKit = {
	...SAVED,
	units: { weight: 'lb', distance: 'mi' },
	exercises: SAVED.exercises.map((e, i) => (i === 0 ? { ...e, sets: e.sets.slice(0, 1) } : e))
};

/** A fetch answering the kit URL with `answer`, held until `release` when asked. */
function server(answer: StartKit | number | Error, { held = false } = {}) {
	let release!: () => void;
	const gate = held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
	const fetch = vi.fn(async (url: string, _init: RequestInit) => {
		await gate;
		if (url !== URL) return new Response('{}', { status: 404 });
		if (answer instanceof Error) throw answer;
		if (typeof answer === 'number') return new Response('{}', { status: answer });
		return Response.json(answer);
	});
	return { fetch, release: () => release() };
}

let store: WorkoutStore;
let workoutId: string;

beforeEach(async () => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	store = await createStore({ table: strengthTable, now: () => T0, channel: null });
	await store.saveKit(STRENGTH.lineage, SAVED);
	const started = await startPlanned(STRENGTH.lineage, {
		store,
		fetch: server(503).fetch,
		now: () => T0,
		persist: async () => true
	});
	if (started.status !== 'started' || !started.refresh) throw new Error('not started from saved');
	workoutId = started.refresh;
});

afterEach(() => {
	store.close();
	vi.unstubAllGlobals();
});

const kitShown = () => store.snapshot(workoutId)!.view!.kit;
const outboxTypes = async () => (await store.outbox()).map((e) => e.envelope.type);

/** set.log of the squat's first set, as the logger sends it. */
const logSquat = () => {
	const slot = SAVED.exercises[0]!;
	return createMutation('set.log', {
		workoutId,
		at: new Date(T0 + 60_000).toISOString(),
		payload: {
			position: slot.position,
			plannedLineage: slot.plannedLineage,
			setIndex: 1,
			exerciseId: slot.exercise.id,
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
};

describe('refreshKit', () => {
	it('replaces a kit that changed while nothing is done yet, and saves the fresh copy with its units', async () => {
		const { fetch } = server(FRESH);
		expect(await refreshKit(store, workoutId, { fetch })).toBe('attached');
		expect(fetch).toHaveBeenCalledOnce();
		expect(kitShown()).toEqual(FRESH);
		expect(await store.getKit(STRENGTH.lineage)).toEqual(FRESH);
		expect(await store.getUnits()).toEqual(FRESH.units);
		// It survives a reload: read back from IndexedDB, as the next page load does.
		const reopened = await createStore({ table: strengthTable, now: () => T0, channel: null });
		expect((await reopened.getActive())!.view!.kit).toEqual(FRESH);
		reopened.close();
		// Device state only: nothing is sent.
		expect(await outboxTypes()).toEqual(['workout.start']);
	});

	it('leaves a kit that has not changed', async () => {
		const dispatch = vi.spyOn(store, 'dispatch');
		expect(await refreshKit(store, workoutId, server(SAVED))).toBe('unchanged');
		expect(dispatch).not.toHaveBeenCalled();
		expect(kitShown()).toEqual(SAVED);
	});

	it('keeps the kit the workout started with once a set is logged while the kit was on its way', async () => {
		const { fetch, release } = server(FRESH, { held: true });
		const refreshed = refreshKit(store, workoutId, { fetch });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		await store.dispatch(logSquat()).saved;
		release();
		expect(await refreshed).toBe('saved');
		expect(kitShown()).toEqual(SAVED);
		expect(await store.getKit(STRENGTH.lineage)).toEqual(FRESH);
	});

	const done = {
		'a set logged': () => store.dispatch(logSquat()),
		'a value typed': () =>
			store.dispatch({ type: 'draft', workoutId, position: 1, setIndex: 1, draft: { reps: 6 } }),
		'an exercise added': () =>
			store.dispatch({
				type: 'exercise.add',
				workoutId,
				exercise: {
					position: 99,
					exercise: SAVED.exercises[0]!.exercise,
					addedAt: new Date(T0).toISOString()
				}
			})
	};

	it.each(Object.keys(done) as (keyof typeof done)[])(
		'asks nothing once anything is done: %s',
		async (what) => {
			await done[what]().saved;
			const { fetch } = server(FRESH);
			expect(await refreshKit(store, workoutId, { fetch })).toBe('skipped');
			expect(fetch).not.toHaveBeenCalled();
			expect(kitShown()).toEqual(SAVED);
		}
	);

	const moved = { ...FRESH, plannedSessionId: '00000000-0000-4000-8000-0000000000aa' };

	it('keeps the kit when the fresh one pins another planned session, and says it was replanned', async () => {
		expect(await refreshKit(store, workoutId, server(moved))).toBe('replanned');
		expect(kitShown()).toEqual(SAVED);
		expect(await store.getKit(STRENGTH.lineage)).toEqual(moved);
	});

	it('starts a replanned workout again from the fresh kit, while nothing is done in it', async () => {
		await refreshKit(store, workoutId, server(moved));
		expect(await startAfresh(store, workoutId)).toBe(
			`/workout?start=${encodeURIComponent(STRENGTH.lineage)}`
		);
		expect(await store.getActive()).toBeNull();
		const again = await startPlanned(STRENGTH.lineage, {
			store,
			fetch: server(503).fetch,
			now: () => T0,
			persist: async () => true
		});
		if (again.status !== 'started' || !again.refresh) throw new Error('not started from saved');
		expect(store.snapshot(again.refresh)!.view!.kit).toEqual(moved);
	});

	it('keeps a replanned workout once a set is logged in it', async () => {
		await refreshKit(store, workoutId, server(moved));
		await store.dispatch(logSquat()).saved;
		expect(await startAfresh(store, workoutId)).toBeNull();
		expect((await store.getActive())?.workoutId).toBe(workoutId);
	});

	it('changes nothing when the server cannot be reached, or answers 401 or 404', async () => {
		for (const [answer, refreshed] of [
			[new TypeError('offline'), 'unreachable'],
			[503, 'unreachable'],
			[401, 'skipped'],
			[404, 'skipped']
		] as const) {
			expect(await refreshKit(store, workoutId, server(answer))).toBe(refreshed);
			expect(kitShown()).toEqual(SAVED);
			expect(await store.getKit(STRENGTH.lineage)).toEqual(SAVED);
		}
		expect(await store.signedOut()).toBe(false);
	});

	it('asks nothing on a device a 401 purged: the workout stays, without its kit', async () => {
		await store.purgeServerCopies();
		expect((await store.getActive())?.workoutId).toBe(workoutId);
		expect(kitShown()).toBeNull();
		const { fetch } = server(FRESH);
		expect(await refreshKit(store, workoutId, { fetch })).toBe('skipped');
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('the mark', () => {
	const storage = () => {
		const map = new Map<string, string>();
		return {
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => void map.set(key, value),
			removeItem: (key: string) => void map.delete(key),
			map
		};
	};

	it('names one workout, and storage that refuses is never an error', () => {
		const held = storage();
		markKitRefresh('w1', held);
		expect(held.map.get(KIT_REFRESH_KEY)).toBe('w1');
		expect(kitRefreshMarked('w1', held)).toBe(true);
		expect(kitRefreshMarked('w2', held)).toBe(false);
		clearKitRefresh(held);
		expect(kitRefreshMarked('w1', held)).toBe(false);

		const refusing = {
			getItem: () => {
				throw new DOMException('', 'SecurityError');
			},
			setItem: () => {
				throw new DOMException('', 'QuotaExceededError');
			},
			removeItem: () => {
				throw new DOMException('', 'SecurityError');
			}
		};
		expect(() => markKitRefresh('w1', refusing)).not.toThrow();
		expect(kitRefreshMarked('w1', refusing)).toBe(false);
		expect(() => clearKitRefresh(refusing)).not.toThrow();
	});

	it('stays after an unreachable refresh, so a later load asks again, and goes once answered', async () => {
		const held = storage();
		markKitRefresh(workoutId, held);
		expect(
			await refreshMarked(store, workoutId, { ...server(new TypeError('offline')), storage: held })
		).toBe('unreachable');
		expect(kitRefreshMarked(workoutId, held)).toBe(true);
		expect(await refreshMarked(store, workoutId, { ...server(FRESH), storage: held })).toBe(
			'attached'
		);
		expect(kitRefreshMarked(workoutId, held)).toBe(false);
	});
});
