import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKOUT_PATHS } from './kinds';
import { ACTIVE_WORKOUT_KEY, noteWorkout, type FlagStorage } from './active-flag';
import {
	ACTIVE_LAUNCH_TIMEOUT_MS,
	LAUNCH_PATHS,
	LAUNCH_SCRIPT,
	NAVIGATION_TIMEOUT_MS,
	navigationTimeout,
	START_URL
} from './launch';

/** localStorage, as a Map. */
function memoryStorage(entries: Record<string, string> = {}): FlagStorage & {
	map: Map<string, string>;
} {
	const map = new Map(Object.entries(entries));
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, String(value)),
		removeItem: (key) => void map.delete(key)
	};
}

/** Storage that refuses everything, as a blocked or full one does. */
const refusing: FlagStorage = {
	getItem: () => {
		throw new DOMException('denied', 'SecurityError');
	},
	setItem: () => {
		throw new DOMException('full', 'QuotaExceededError');
	},
	removeItem: () => {
		throw new DOMException('denied', 'SecurityError');
	}
};

const W = '00000000-0000-4000-8000-0000000000a1';

/** Runs the inline script at `pathname` with this storage: where it sent the page, if anywhere. */
function launch(storage: FlagStorage, pathname: string): string[] {
	const replaced: string[] = [];
	const location = { pathname, replace: (to: string) => void replaced.push(to) };
	new Function('localStorage', 'location', LAUNCH_SCRIPT)(storage, location);
	return replaced;
}

const flag = (value: unknown) => memoryStorage({ [ACTIVE_WORKOUT_KEY]: JSON.stringify(value) });

describe('the launch script', () => {
	it("sends the start URL and /offline to the workout in progress, the flagged kind's page", () => {
		for (const [kind, path] of Object.entries(WORKOUT_PATHS)) {
			const storage = memoryStorage();
			noteWorkout(
				{ id: W, kind: kind as keyof typeof WORKOUT_PATHS, status: 'in_progress' },
				storage
			);
			expect(launch(storage, START_URL)).toEqual([path]);
			expect(launch(storage, '/offline')).toEqual([path]);
		}
	});

	it('keeps the offline screen anywhere else it is served (a reload of another screen)', () => {
		const storage = flag({ v: 1, workoutId: W, kind: 'strength' });
		for (const pathname of ['/progress', '/profile', '/coach', '/train', '/', '/today/x']) {
			expect(launch(storage, pathname)).toEqual([]);
		}
	});

	it('does nothing without a workout in progress, or with a malformed flag', () => {
		expect(launch(memoryStorage(), START_URL)).toEqual([]);
		for (const value of [
			null,
			'strength',
			{ v: 2, workoutId: W, kind: 'strength' },
			{ v: 1, kind: 'strength' },
			{ v: 1, workoutId: 7, kind: 'strength' },
			{ v: 1, workoutId: W, kind: 'yoga' },
			{ v: 1, workoutId: W, kind: 'toString' },
			{ v: 1, workoutId: W, kind: '__proto__' },
			{ v: 1, workoutId: W }
		]) {
			expect(launch(flag(value), START_URL)).toEqual([]);
		}
		expect(launch(memoryStorage({ [ACTIVE_WORKOUT_KEY]: '{not json' }), START_URL)).toEqual([]);
		expect(launch(refusing, START_URL)).toEqual([]);
	});

	it("knows every kind's page and the manifest's start URL", () => {
		expect(LAUNCH_PATHS).toStrictEqual(WORKOUT_PATHS);
		const manifest = JSON.parse(
			readFileSync(new URL('../../../../static/manifest.webmanifest', import.meta.url), 'utf8')
		) as { start_url: string };
		expect(manifest.start_url).toBe(START_URL);
	});
});

describe("the service worker's navigation timeout", () => {
	it('is shorter for the start URL with a workout in progress', async () => {
		expect(await navigationTimeout(START_URL, async () => true)).toBe(ACTIVE_LAUNCH_TIMEOUT_MS);
		expect(ACTIVE_LAUNCH_TIMEOUT_MS).toBeLessThan(NAVIGATION_TIMEOUT_MS);
	});

	it('keeps the usual timeout without one, when the check fails, and for other pages', async () => {
		expect(await navigationTimeout(START_URL, async () => false)).toBe(NAVIGATION_TIMEOUT_MS);
		const failing = () => Promise.reject(new Error('IndexedDB refused'));
		expect(await navigationTimeout(START_URL, failing)).toBe(NAVIGATION_TIMEOUT_MS);
		let asked = false;
		const active = async () => (asked = true);
		expect(await navigationTimeout('/progress', active)).toBe(NAVIGATION_TIMEOUT_MS);
		expect(await navigationTimeout('/workout', active)).toBe(NAVIGATION_TIMEOUT_MS);
		expect(asked).toBe(false);
	});
});
