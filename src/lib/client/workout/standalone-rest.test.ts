import { afterEach, describe, expect, it } from 'vitest';
import { addRest, pauseRest, startRest } from '#lib/domain/workout/timers.ts';
import {
	readStandaloneRest,
	STALE_REST_MS,
	STANDALONE_REST_KEY,
	writeStandaloneRest
} from './standalone-rest';

/** A localStorage over a Map; a second reader over the same entries is the page after a reload. */
function memoryStorage(initial: Record<string, string> = {}) {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => void entries.set(key, value),
		removeItem: (key: string) => void entries.delete(key)
	};
}

const T0 = 1_700_000_000_000;
const holding = (value: unknown) => memoryStorage({ [STANDALONE_REST_KEY]: JSON.stringify(value) });

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('the standalone rest: a reload', () => {
	it('is kept under pc:rest:v1, apart from the workout settings', () => {
		expect(STANDALONE_REST_KEY).toBe('pc:rest:v1');
		const storage = memoryStorage();
		expect(writeStandaloneRest(startRest(T0, 90_000), storage)).toBe(true);
		expect([...storage.entries.keys()]).toEqual(['pc:rest:v1']);
	});

	it('reads back the same timestamps, running, paused or with time added', () => {
		const storage = memoryStorage();
		for (const rest of [
			startRest(T0, 90_000),
			pauseRest(startRest(T0, 90_000), T0 + 20_000),
			addRest(startRest(T0, 90_000), T0 + 5_000)
		]) {
			writeStandaloneRest(rest, storage);
			const reloaded = memoryStorage(Object.fromEntries(storage.entries));
			expect(readStandaloneRest(T0 + 30_000, reloaded)).toEqual(rest);
		}
	});

	it('forgets the rest once it is skipped', () => {
		const storage = memoryStorage();
		writeStandaloneRest(startRest(T0, 90_000), storage);
		expect(writeStandaloneRest(null, storage)).toBe(true);
		expect(storage.entries.size).toBe(0);
		expect(readStandaloneRest(T0, storage)).toBeNull();
	});

	it('uses the page’s localStorage by default', () => {
		const storage = memoryStorage();
		Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
		writeStandaloneRest(startRest(T0, 60_000));
		expect(storage.entries.has(STANDALONE_REST_KEY)).toBe(true);
		expect(readStandaloneRest(T0 + 1_000)).toEqual(startRest(T0, 60_000));
	});
});

describe('the standalone rest: what reads as none', () => {
	it('reads a rest that ended within the hour as over, and an older one as none', () => {
		const rest = startRest(T0, 60_000);
		const storage = holding(rest);
		expect(readStandaloneRest(T0 + 60_000 + STALE_REST_MS, storage)).toEqual(rest);
		expect(readStandaloneRest(T0 + 60_000 + STALE_REST_MS + 1, storage)).toBeNull();
		expect(STALE_REST_MS).toBe(3_600_000);
	});

	it('counts the time added into when it ended', () => {
		const added = addRest(startRest(T0, 60_000), T0 + 1_000);
		const end = T0 + 90_000;
		expect(readStandaloneRest(end + STALE_REST_MS, holding(added))).toEqual(added);
		expect(readStandaloneRest(end + STALE_REST_MS + 1, holding(added))).toBeNull();
	});

	it('keeps a paused rest however long ago it was paused', () => {
		const paused = pauseRest(startRest(T0, 60_000), T0 + 10_000);
		expect(readStandaloneRest(T0 + 10 * STALE_REST_MS, holding(paused))).toEqual(paused);
	});

	it('reads anything that is not a rest as none', () => {
		const rest = startRest(T0, 60_000);
		for (const value of [
			null,
			42,
			'rest',
			[rest],
			{ ...rest, startedAt: 'now' },
			{ ...rest, durationMs: -1 },
			{ ...rest, addedMs: null },
			{ ...rest, pausedAt: undefined },
			{ startedAt: T0, durationMs: 60_000, pausedAt: null }
		]) {
			expect(readStandaloneRest(T0, holding(value)), JSON.stringify(value)).toBeNull();
		}
		expect(
			readStandaloneRest(T0, memoryStorage({ [STANDALONE_REST_KEY]: '{not json' }))
		).toBeNull();
	});

	it('never throws on storage that is missing, blocked or full', () => {
		const blocked = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {
				throw new Error('SecurityError');
			}
		};
		expect(readStandaloneRest(T0, null)).toBeNull();
		expect(readStandaloneRest(T0, blocked)).toBeNull();
		expect(writeStandaloneRest(startRest(T0, 1_000), null)).toBe(false);
		expect(writeStandaloneRest(startRest(T0, 1_000), blocked)).toBe(false);
		expect(writeStandaloneRest(null, blocked)).toBe(false);
		Object.defineProperty(globalThis, 'localStorage', {
			get: () => {
				throw new Error('SecurityError');
			},
			configurable: true
		});
		expect(readStandaloneRest(T0)).toBeNull();
		expect(writeStandaloneRest(startRest(T0, 1_000))).toBe(false);
	});
});
