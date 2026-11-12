import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { openTabChannel, TAB_CHANNEL } from './workout/channel';
import type { StoreChange } from './workout/store';
import { DB_NAME, STORES } from './workout/names';
import { pendingCount } from './workout/probe';
import { ACTIVE_WORKOUT_KEY } from './workout/active-flag';
import { PREPAINT_KEY } from './workout/prepaint';
import { DESIGN_KEY } from './design';
import { createStore } from './workout/store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000e1';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** signout.ts as a fresh module, with the app's version. */
async function load() {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ version: 'test' }));
	return import('./signout');
}

/** A started workout with a skipped set (two changes waiting) and a saved kit. */
async function seedWorkout() {
	const store = await createStore({ table: strengthTable, channel: null });
	const start = createMutation(
		'workout.start',
		{
			workoutId: W,
			at: '2026-11-06T18:00:00.000Z',
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
		fresh
	);
	const skip = createMutation(
		'set.skip',
		{
			workoutId: W,
			at: '2026-11-06T18:05:00.000Z',
			payload: {
				position: 1,
				plannedLineage: KIT.exercises[0]!.plannedLineage,
				setIndex: 1,
				exerciseId: KIT.exercises[0]!.exercise.id,
				unit: 'kg'
			}
		},
		fresh
	);
	await store.dispatch(start, { type: 'kit.attach', workoutId: W, kit: KIT }).saved;
	await store.dispatch(skip).saved;
	await store.saveKit('lineage-1', KIT);
	expect(await pendingCount()).toBe(2);
}

/** sessionStorage, in memory. */
function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, String(value)),
		removeItem: (key) => void items.delete(key),
		clear: () => items.clear()
	};
}

/** Cache Storage, as far as sign-out uses it. */
function memoryCaches(names: string[]) {
	const held = new Set(names);
	return {
		keys: async () => [...held],
		delete: async (name: string) => held.delete(name)
	};
}

const databases = async () => (await indexedDB.databases()).map((d) => d.name);

let storage: Storage;
let cacheStorage: ReturnType<typeof memoryCaches>;
const replace = vi.fn();

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	storage = memoryStorage();
	cacheStorage = memoryCaches(['pc-shell-test', 'pc-account-data']);
	vi.stubGlobal('sessionStorage', storage);
	vi.stubGlobal('caches', cacheStorage);
	vi.stubGlobal('location', { replace });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
	vi.doUnmock('./workout/shutdown.ts');
	replace.mockReset();
});

describe('signOut', () => {
	it('signOut tells other tabs, clears the device, then leaves the marker', async () => {
		const { signOut, SIGNED_OUT_MARKER } = await load();
		await seedWorkout();
		const fetch = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal('fetch', fetch);
		// Another tab's store, on the app's channel, and what the channel carries.
		const other = await createStore({ table: strengthTable, channel: openTabChannel() });
		const changes: StoreChange[] = [];
		other.onChange((change) => changes.push(change));
		const heard: unknown[] = [];
		const listener = new BroadcastChannel(TAB_CHANNEL);
		listener.onmessage = ({ data }) => heard.push(data);
		storage.setItem('pc:scratch', 'draft');

		try {
			await signOut();

			expect(fetch).toHaveBeenCalledWith(
				'/api/auth/signout',
				expect.objectContaining({ method: 'POST' })
			);
			await vi.waitFor(() => expect(heard).toContainEqual({ type: 'signed-out' }));
			expect(changes).toContainEqual({ type: 'closed', reason: 'deleted' });
			expect(other.closed).toBe('deleted');
			expect(await databases()).toEqual([]);
			expect(await cacheStorage.keys()).toEqual(['pc-shell-test']);
			// The marker survives the clear of session storage: it is written after it.
			expect(storage.getItem('pc:scratch')).toBeNull();
			expect(storage.getItem(SIGNED_OUT_MARKER)).not.toBeNull();
			expect(replace).toHaveBeenCalledWith('/?signedOut=1');
		} finally {
			listener.close();
		}
	});

	it('signOut forgets the screens this page kept in memory', async () => {
		const { signOut } = await load();
		const { screens } = await import('./screen-memory');
		screens.keep(new URL('https://coach.test/today'), []);
		serverSignsOut();

		await signOut();

		expect(screens.size).toBe(0);
		expect(replace).toHaveBeenCalledWith('/?signedOut=1');
	});

	it('signOut changes nothing when the server refuses', async () => {
		const { signOut, SIGNED_OUT_MARKER } = await load();
		const { screens } = await import('./screen-memory');
		screens.keep(new URL('https://coach.test/today'), []);
		await seedWorkout();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 403 }))
		);

		await expect(signOut()).rejects.toThrow('sign-out failed (403)');

		expect(await databases()).toEqual([DB_NAME]);
		expect(await pendingCount()).toBe(2);
		expect(storage.getItem(SIGNED_OUT_MARKER)).toBeNull();
		expect(await cacheStorage.keys()).toContain('pc-account-data');
		expect(screens.size).toBe(1);
		expect(replace).not.toHaveBeenCalled();
	});
});

/** A server that signs out, and what it was asked. */
function serverSignsOut() {
	const fetch = vi.fn(async () => Response.json({ ok: true }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

describe('signOutIfSynced', () => {
	it('signOutIfSynced signs out when the flush leaves nothing', async () => {
		const flush = vi.fn(async () => 0);
		vi.doMock('./workout/shutdown.ts', () => ({ unsyncedAfterFlush: flush }));
		const { signOutIfSynced } = await load();
		const fetch = serverSignsOut();

		expect(await signOutIfSynced()).toBe(0);

		expect(flush).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			'/api/auth/signout',
			expect.objectContaining({ method: 'POST' })
		);
		expect(replace).toHaveBeenCalledWith('/?signedOut=1');
	});

	it('signOutIfSynced answers what the flush left and signs nothing out', async () => {
		vi.doMock('./workout/shutdown.ts', () => ({ unsyncedAfterFlush: async () => 2 }));
		const { signOutIfSynced } = await load();
		await seedWorkout();
		const fetch = serverSignsOut();

		expect(await signOutIfSynced()).toBe(2);

		expect(fetch).not.toHaveBeenCalled();
		expect(await pendingCount()).toBe(2);
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('signOutDeleting', () => {
	it('signOutDeleting signs out and deletes what it asked about', async () => {
		const { signOutDeleting } = await load();
		await seedWorkout();
		const order: string[] = [];
		const fetch = vi.fn(async () => {
			order.push('server');
			return Response.json({ ok: true });
		});
		vi.stubGlobal('fetch', fetch);

		expect(await signOutDeleting(2, () => order.push('leaving'))).toBe(0);

		// The screen closes its sheet before the server is asked.
		expect(order).toEqual(['leaving', 'server']);
		expect(await databases()).toEqual([]);
		expect(replace).toHaveBeenCalledWith('/?signedOut=1');
	});

	it('signOutDeleting answers the new count when more changes arrived since it asked', async () => {
		const { signOutDeleting } = await load();
		await seedWorkout();
		const fetch = serverSignsOut();
		const leaving = vi.fn();

		expect(await signOutDeleting(1, leaving)).toBe(2);

		expect(leaving).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(await pendingCount()).toBe(2);
		expect(replace).not.toHaveBeenCalled();
	});

	it('signOutDeleting changes nothing when the server refuses', async () => {
		const { signOutDeleting } = await load();
		await seedWorkout();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 503 }))
		);

		await expect(signOutDeleting(2)).rejects.toThrow('sign-out failed (503)');

		expect(await pendingCount()).toBe(2);
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('clearAfterSignedOutUrl', () => {
	it('clearAfterSignedOutUrl consumes the marker and clears', async () => {
		const { clearAfterSignedOutUrl, SIGNED_OUT_MARKER } = await load();
		await seedWorkout();
		storage.setItem(SIGNED_OUT_MARKER, '1');

		expect(await clearAfterSignedOutUrl()).toEqual({ kept: 0 });

		expect(storage.getItem(SIGNED_OUT_MARKER)).toBeNull();
		expect(await databases()).toEqual([]);
		expect(await cacheStorage.keys()).toEqual(['pc-shell-test']);
	});

	it('clearAfterSignedOutUrl without the marker keeps pending workout changes', async () => {
		const { clearAfterSignedOutUrl } = await load();
		await seedWorkout();
		storage.setItem('pc:scratch', 'draft');

		expect(await clearAfterSignedOutUrl()).toEqual({ kept: 2 });

		const db = await openDB(DB_NAME);
		try {
			expect(await db.count(STORES.outbox)).toBe(2);
			expect(await db.getAll(STORES.kits)).toEqual([]);
		} finally {
			db.close();
		}
		expect(await cacheStorage.keys()).toEqual(['pc-shell-test']);
		expect(storage.length).toBe(0);
	});

	it('clearAfterSignedOutUrl without the marker and nothing pending clears everything', async () => {
		const { clearAfterSignedOutUrl } = await load();
		// The M2 sign-out specs' database: not the workout store, so nothing reads as pending.
		(await openDB(DB_NAME, 1, { upgrade: (db) => void db.createObjectStore('sets') })).close();
		(await openDB('pc-other', 1)).close();

		expect(await clearAfterSignedOutUrl()).toEqual({ kept: 0 });

		expect(await databases()).toEqual([]);
		expect(await cacheStorage.keys()).toEqual(['pc-shell-test']);
	});
});

describe('clearDeviceAccountData', () => {
	it("deletes /workout's prepainted card, blocked or not, keeping workouts or not, and keeps the device's preferences and design", async () => {
		const { clearDeviceAccountData } = await load();
		for (const keepWorkouts of [false, true]) {
			for (const held of [
				'{"v":1,"workoutId":"w","rest":false,"card":{}}',
				'{"v":1,"blocked":true}'
			]) {
				const map = new Map([
					[PREPAINT_KEY, held],
					['pc:prefs:v1', '{"theme":"light"}'],
					[DESIGN_KEY, 'graphite']
				]);
				vi.stubGlobal('localStorage', {
					getItem: (key: string) => map.get(key) ?? null,
					setItem: (key: string, value: string) => void map.set(key, value),
					removeItem: (key: string) => void map.delete(key)
				});

				await clearDeviceAccountData({ keepWorkouts });

				// The theme, units and design are this device's, not the account's.
				expect([...map.keys()]).toEqual(['pc:prefs:v1', DESIGN_KEY]);
			}
		}
	});

	it('deletes the launch flag, so a launch offline never opens a workout after sign-out', async () => {
		const { clearDeviceAccountData } = await load();
		for (const keepWorkouts of [false, true]) {
			const map = new Map([
				[ACTIVE_WORKOUT_KEY, '{"v":1,"workoutId":"w","kind":"strength"}'],
				['pc:prefs:v1', '{"theme":"light"}']
			]);
			vi.stubGlobal('localStorage', {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				removeItem: (key: string) => void map.delete(key)
			});

			await clearDeviceAccountData({ keepWorkouts });

			expect([...map.keys()]).toEqual(['pc:prefs:v1']);
		}
	});
});
