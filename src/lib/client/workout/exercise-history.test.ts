import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchExerciseHistory,
	HISTORY_TIMEOUT_MS,
	sessionsOf,
	type ExerciseHistory,
	type HistorySet
} from './exercise-history.ts';

const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';

const set = (id: number, workoutId: string, setIndex: number, at: string): HistorySet => ({
	id,
	workoutId,
	setIndex,
	performedAt: at,
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
	isSkipped: false
});

const HISTORY: ExerciseHistory = {
	exercise: { id: 'back_squat', name: 'Back squat' },
	previous: null,
	sets: [set(2, W1, 2, '2026-11-05T18:10:00.000Z'), set(1, W1, 1, '2026-11-05T18:05:00.000Z')],
	next: 1,
	records: { bestE1rm: null, repMaxes: [] }
};

const answer = (status: number, body: unknown) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
	vi.useRealTimers();
});

describe('fetchExerciseHistory', () => {
	it('reads a page of the exercise’s history, and the page after a `next`', async () => {
		const fetch = answer(200, HISTORY);
		expect(await fetchExerciseHistory('back squat', { fetch, online: true })).toEqual({
			state: 'ready',
			history: HISTORY
		});
		await fetchExerciseHistory('back squat', { before: 41, fetch, online: true });
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			'/api/exercises/back%20squat/history',
			'/api/exercises/back%20squat/history?before=41'
		]);
	});

	it('asks nothing offline', async () => {
		const fetch = answer(200, HISTORY);
		expect(await fetchExerciseHistory('back_squat', { fetch, online: false })).toEqual({
			state: 'offline'
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('reads a 404 as an exercise it does not know, and a 500 or a network failure as failed', async () => {
		const online = true;
		expect(await fetchExerciseHistory('x', { fetch: answer(404, {}), online })).toEqual({
			state: 'not-found'
		});
		expect(await fetchExerciseHistory('x', { fetch: answer(500, {}), online })).toEqual({
			state: 'failed'
		});
		const offline = vi.fn<typeof fetch>(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await fetchExerciseHistory('x', { fetch: offline, online })).toEqual({
			state: 'failed'
		});
	});

	it(`gives up after ${HISTORY_TIMEOUT_MS} ms without an answer, aborting the request`, async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const hung = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					signal = init!.signal!;
					signal.addEventListener('abort', () => reject(signal!.reason));
				})
		);
		let settled: unknown = 'pending';
		void fetchExerciseHistory('x', { fetch: hung, online: true }).then((r) => (settled = r));
		await vi.advanceTimersByTimeAsync(HISTORY_TIMEOUT_MS - 1);
		expect(settled).toBe('pending');
		expect(signal!.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal!.aborted).toBe(true);
		expect(settled).toEqual({ state: 'failed' });
	});
});

describe('sessionsOf', () => {
	it('groups sets, newest first, into their sessions, newest first, each in the order done', () => {
		const sets = [
			set(5, W2, 3, '2026-11-08T18:12:00.000Z'),
			set(4, W2, 2, '2026-11-08T18:08:00.000Z'),
			set(3, W2, 1, '2026-11-08T18:04:00.000Z'),
			set(2, W1, 2, '2026-11-05T18:10:00.000Z'),
			set(1, W1, 1, '2026-11-05T18:05:00.000Z')
		];
		const sessions = sessionsOf(sets);
		expect(sessions.map((s) => [s.workoutId, s.at, s.sets.map((x) => x.setIndex)])).toEqual([
			[W2, '2026-11-08T18:12:00.000Z', [1, 2, 3]],
			[W1, '2026-11-05T18:10:00.000Z', [1, 2]]
		]);
		expect(
			sets.map((s) => s.id),
			'the pages are left as they came'
		).toEqual([5, 4, 3, 2, 1]);
	});

	it('continues a session a page split', () => {
		const first = [set(3, W2, 2, '2026-11-08T18:08:00.000Z')];
		const second = [
			set(2, W2, 1, '2026-11-08T18:04:00.000Z'),
			set(1, W1, 1, '2026-11-05T18:05:00.000Z')
		];
		expect(sessionsOf([...first, ...second]).map((s) => s.sets.map((x) => x.id))).toEqual([
			[2, 3],
			[1]
		]);
		expect(sessionsOf([])).toEqual([]);
	});

	it('keeps one session per workout when two workouts interleave in time', () => {
		const sets = [
			set(4, W2, 2, '2026-11-08T18:12:00.000Z'),
			set(3, W1, 2, '2026-11-08T18:10:00.000Z'),
			set(2, W2, 1, '2026-11-08T18:08:00.000Z'),
			set(1, W1, 1, '2026-11-08T18:05:00.000Z')
		];
		expect(sessionsOf(sets).map((s) => [s.workoutId, s.sets.map((x) => x.id)])).toEqual([
			[W2, [2, 4]],
			[W1, [1, 3]]
		]);
	});
});
