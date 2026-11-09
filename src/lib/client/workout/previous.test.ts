import { describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type { PreviousPerformance, SlotView, WorkoutView } from '#lib/domain/workout/index.ts';
import { attachPrevious, fetchPrevious, needsPrevious } from './previous.ts';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const LEG_PRESS = KIT.exercises[1]!;
const W = '00000000-0000-4000-8000-0000000000f1';

const PREVIOUS: PreviousPerformance = {
	date: '2026-11-01',
	sets: [
		{
			reps: 8,
			seconds: null,
			metres: null,
			weight: 140,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		}
	]
};

const slot = (exerciseId: string, kit = LEG_PRESS): SlotView => ({
	position: 2,
	plannedLineage: kit?.plannedLineage ?? null,
	superset: null,
	exerciseId,
	kit,
	state: exerciseId === kit?.exercise.id ? 'planned' : 'swapped',
	substitution: null,
	sets: []
});

const viewWith = (attached: WorkoutView['device']['attached'] = {}) =>
	({ workout: { id: W }, device: { attached } }) as unknown as WorkoutView;

const answer = (status: number, body: unknown) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('needsPrevious', () => {
	it('asks for a substitute’s and an added exercise’s last session until one is attached', () => {
		expect(needsPrevious(viewWith(), slot('leg_press'))).toBe(false);
		expect(needsPrevious(viewWith(), slot('hack_squat'))).toBe(true);
		expect(needsPrevious(viewWith(), { ...slot('hack_squat'), kit: null })).toBe(true);
		expect(needsPrevious(viewWith({ hack_squat: null }), slot('hack_squat'))).toBe(false);
		expect(needsPrevious(viewWith({ hack_squat: PREVIOUS }), slot('hack_squat'))).toBe(false);
	});
});

describe('fetchPrevious', () => {
	it('reads the exercise’s previous session from its history', async () => {
		const fetch = answer(200, { previous: PREVIOUS, sets: [], next: null });
		expect(await fetchPrevious('hack squat', { fetch, online: true })).toEqual(PREVIOUS);
		expect(fetch.mock.calls[0]![0]).toBe('/api/exercises/hack%20squat/history');
	});

	it('says none when the server has none, or does not know the exercise', async () => {
		expect(await fetchPrevious('x', { fetch: answer(200, { previous: null }), online: true })).toBe(
			null
		);
		expect(
			await fetchPrevious('x', { fetch: answer(404, { error: 'not_found' }), online: true })
		).toBe(null);
	});

	it('is unavailable offline (without asking), on a failure, and past its timeout', async () => {
		const unused = answer(200, { previous: PREVIOUS });
		expect(await fetchPrevious('x', { fetch: unused, online: false })).toBe('unavailable');
		expect(unused).not.toHaveBeenCalled();
		expect(await fetchPrevious('x', { fetch: answer(500, {}), online: true })).toBe('unavailable');
		const down = vi.fn<typeof fetch>(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await fetchPrevious('x', { fetch: down, online: true })).toBe('unavailable');
		// A server that never answers: the request is aborted at the timeout.
		const hung = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
				)
		);
		expect(await fetchPrevious('x', { fetch: hung, online: true, timeoutMs: 20 })).toBe(
			'unavailable'
		);
	});
});

describe('attachPrevious', () => {
	const store = () => ({
		dispatch: vi.fn(() => ({ saved: Promise.resolve('saved') }) as never)
	});

	it('attaches what it found to the workout, none included', async () => {
		for (const previous of [PREVIOUS, null]) {
			const s = store();
			const fetch = answer(200, { previous });
			const done = await attachPrevious(s, viewWith(), slot('hack_squat'), { fetch, online: true });
			expect(done).toBe('attached');
			expect(s.dispatch).toHaveBeenCalledWith({
				type: 'kit.attach',
				workoutId: W,
				exerciseId: 'hack_squat',
				previous
			});
		}
	});

	it('attaches nothing when it could not ask', async () => {
		const s = store();
		const done = await attachPrevious(s, viewWith(), slot('hack_squat'), { online: false });
		expect(done).toBe('unavailable');
		expect(s.dispatch).not.toHaveBeenCalled();
	});
});
