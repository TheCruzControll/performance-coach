import { describe, expect, it } from 'vitest';
import {
	ACTIVE_WORKOUT_KEY,
	clearActiveWorkout,
	noteWorkout,
	workoutGone,
	type FlagStorage
} from './active-flag';

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
const W2 = '00000000-0000-4000-8000-0000000000a2';

describe('the active-workout flag', () => {
	it('is written for a workout in progress and dropped when it ends', () => {
		const storage = memoryStorage();
		noteWorkout({ id: W, kind: 'run', status: 'in_progress' }, storage);
		expect(JSON.parse(storage.map.get(ACTIVE_WORKOUT_KEY)!)).toEqual({
			v: 1,
			workoutId: W,
			kind: 'run'
		});
		noteWorkout({ id: W, kind: 'run', status: 'completed' }, storage);
		expect(storage.map.has(ACTIVE_WORKOUT_KEY)).toBe(false);

		noteWorkout({ id: W, kind: 'strength', status: 'in_progress' }, storage);
		noteWorkout({ id: W, kind: 'strength', status: 'abandoned' }, storage);
		expect(storage.map.has(ACTIVE_WORKOUT_KEY)).toBe(false);
	});

	it("never drops another workout's flag", () => {
		const storage = memoryStorage();
		noteWorkout({ id: W, kind: 'strength', status: 'in_progress' }, storage);
		noteWorkout({ id: W2, kind: 'strength', status: 'completed' }, storage);
		workoutGone(W2, storage);
		expect(JSON.parse(storage.map.get(ACTIVE_WORKOUT_KEY)!)).toMatchObject({ workoutId: W });
		workoutGone(W, storage);
		expect(storage.map.has(ACTIVE_WORKOUT_KEY)).toBe(false);
	});

	it('is cleared whatever it holds, and storage that refuses is never an error', () => {
		const storage = memoryStorage({ [ACTIVE_WORKOUT_KEY]: '{not json' });
		workoutGone(W, storage); // unreadable: not this workout's
		clearActiveWorkout(storage);
		expect(storage.map.has(ACTIVE_WORKOUT_KEY)).toBe(false);
		expect(() =>
			noteWorkout({ id: W, kind: 'strength', status: 'in_progress' }, refusing)
		).not.toThrow();
		expect(() => workoutGone(W, refusing)).not.toThrow();
		expect(() => clearActiveWorkout(refusing)).not.toThrow();
		expect(() =>
			noteWorkout({ id: W, kind: 'strength', status: 'in_progress' }, null)
		).not.toThrow();
	});
});
