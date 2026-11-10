import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type {
	ActiveWorkout,
	ActiveWorkouts,
	CanonicalWorkout,
	Mutation
} from '#lib/domain/workout/index.ts';
import { replay } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { activeSummary, type ActiveSummary } from '#lib/client/workout/probe.ts';
import { kitUrl, workoutUrl } from '#lib/client/workout/reconcile.ts';
import { createStore } from '#lib/client/workout/store.ts';
import {
	ACTIVE_WORKOUTS_URL,
	continueHere,
	findResume,
	hasPending,
	NOTHING,
	REMOTE_TIMEOUT_MS,
	type ResumeOptions
} from './resume';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const W = '00000000-0000-4000-8000-0000000000a1';
const R = '00000000-0000-4000-8000-0000000000b1';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

const start = (workoutId: string) =>
	createMutation(
		'workout.start',
		{
			workoutId,
			entityId: workoutId,
			at: new Date(T0).toISOString(),
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
const finish = (workoutId: string) =>
	createMutation(
		'workout.finish',
		{ workoutId, at: new Date(T0 + 3_600_000).toISOString(), payload: {} },
		fresh
	);

/** A workout started on this device, its workout.start not synced yet. */
async function startHere(workoutId = W) {
	const store = await createStore({ table: strengthTable, now: () => T0 });
	const kit = { type: 'kit.attach', workoutId, kit: KIT } as const;
	expect(await store.dispatch(start(workoutId), kit).saved).toBe('saved');
	return store;
}

/** The rows the server holds for a workout started on another device. */
const remoteRows = (mutations: Mutation[]): CanonicalWorkout =>
	replay(strengthTable, { workoutId: R, kit: KIT, canonical: null, pending: mutations }).rows!;

const remote: ActiveWorkout = {
	id: R,
	kind: 'strength',
	title: KIT.title,
	sessionType: KIT.sessionType,
	discipline: KIT.discipline,
	plannedSessionId: KIT.plannedSessionId,
	plannedLineage: KIT.plannedLineage,
	programId: KIT.programId,
	startedAt: new Date(T0).toISOString()
};

/** A server answering by URL; every request is recorded. */
function server(routes: Record<string, () => Response | Promise<Response>>) {
	const urls: string[] = [];
	const fetch = vi.fn(async (url: string) => {
		urls.push(url);
		const answer = routes[url];
		return answer ? answer() : new Response('not found', { status: 404 });
	});
	return { fetch, urls };
}

const activeList = (workouts: ActiveWorkout[]) => () =>
	Response.json({ v: 1, workouts } satisfies ActiveWorkouts);

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('findResume', () => {
	it('offers nothing and creates no database on a device that never started a workout', async () => {
		const { fetch } = server({});
		for (const path of ['/train', '/progress', '/coach', '/profile', '/profile/security']) {
			expect(await findResume(path, { fetch, online: () => true })).toEqual(NOTHING);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('offers the workout in progress here on every screen, with its time and changes waiting, and never asks the server', async () => {
		await startHere();
		const { fetch } = server({ [ACTIVE_WORKOUTS_URL]: activeList([remote]) });

		for (const path of ['/today', '/train', '/offline']) {
			expect(await findResume(path, { fetch, online: () => true })).toEqual({
				type: 'active',
				workout: {
					workoutId: W,
					kind: 'strength',
					title: KIT.title,
					startedAt: new Date(T0).toISOString(),
					plannedLineage: KIT.plannedLineage,
					pending: 1,
					stopwatch: { startedAt: null, accumulatedMs: 0, runningSince: null }
				}
			});
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it('offers the changes of a workout finished here until they sync, even offline', async () => {
		const store = await startHere();
		expect(await store.dispatch(finish(W)).saved).toBe('saved');
		const { fetch } = server({ [ACTIVE_WORKOUTS_URL]: activeList([remote]) });

		const waiting = { type: 'waiting', pending: 2 };
		expect(await findResume('/today', { fetch, online: () => true })).toEqual(waiting);
		expect(await findResume('/profile', { fetch, online: () => false })).toEqual(waiting);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('on Today alone, with nothing here, offers the newest workout in progress on another device, from one request', async () => {
		const older = { ...remote, id: fresh(), startedAt: new Date(T0 - 86_400_000).toISOString() };
		const { fetch, urls } = server({ [ACTIVE_WORKOUTS_URL]: activeList([remote, older]) });

		expect(await findResume('/today', { fetch, online: () => true })).toEqual({
			type: 'remote',
			workout: remote
		});
		expect(urls).toEqual([ACTIVE_WORKOUTS_URL]);

		for (const path of ['/train', '/progress', '/coach', '/profile', '/today/x']) {
			expect(await findResume(path, { fetch, online: () => true })).toEqual(NOTHING);
		}
		expect(urls).toEqual([ACTIVE_WORKOUTS_URL]);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('never asks the server offline', async () => {
		const { fetch } = server({ [ACTIVE_WORKOUTS_URL]: activeList([remote]) });
		expect(await findResume('/today', { fetch, online: () => false })).toEqual(NOTHING);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('offers nothing when the server has none, fails, answers something else or is unreachable', async () => {
		const answers: Record<string, () => Response | Promise<Response>> = {
			none: activeList([]),
			error: () => new Response('down', { status: 503 }),
			signedOut: () => Response.json({ error: 'unauthenticated' }, { status: 401 }),
			garbage: () => Response.json({ v: 2, workouts: [remote] }),
			network: () => Promise.reject(new TypeError('Failed to fetch'))
		};
		for (const [what, answer] of Object.entries(answers)) {
			const { fetch } = server({ [ACTIVE_WORKOUTS_URL]: answer });
			expect(await findResume('/today', { fetch, online: () => true }), what).toEqual(NOTHING);
		}
	});

	it(`gives up on the remote check after ${REMOTE_TIMEOUT_MS / 1000} s`, async () => {
		let abort: () => void = () => {};
		const timers: { run: () => void; ms: number }[] = [];
		const options: ResumeOptions = {
			online: () => true,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					abort = () => reject(new DOMException('aborted', 'AbortError'));
					init.signal?.addEventListener('abort', abort);
				}),
			setTimeout: (run, ms) => timers.push({ run, ms }),
			clearTimeout: () => {}
		};
		const finding = findResume('/today', options);
		await vi.waitFor(() => expect(timers).toHaveLength(1));
		expect(timers[0]!.ms).toBe(REMOTE_TIMEOUT_MS);
		timers[0]!.run();
		expect(await finding).toEqual(NOTHING);
	});
});

describe('hasPending', () => {
	it('is true for changes waiting, here or in the workout in progress', () => {
		const workout: ActiveSummary = {
			workoutId: W,
			kind: 'strength',
			title: 'A',
			startedAt: '',
			plannedLineage: null,
			pending: 0,
			stopwatch: { startedAt: null, accumulatedMs: 0, runningSince: null }
		};
		expect(hasPending({ type: 'waiting', pending: 3 })).toBe(true);
		expect(hasPending({ type: 'active', workout: { ...workout, pending: 2 } })).toBe(true);
		expect(hasPending({ type: 'active', workout })).toBe(false);
		expect(hasPending({ type: 'remote', workout: remote })).toBe(false);
		expect(hasPending(NOTHING)).toBe(false);
	});
});

describe('continueHere', () => {
	const rows = remoteRows([start(R)]);

	it("builds the other device's workout here from its rows and pinned kit, so its page opens with it", async () => {
		const { fetch, urls } = server({
			[workoutUrl(R)]: () => Response.json(rows),
			[kitUrl(KIT.plannedSessionId!)]: () => Response.json(KIT)
		});

		expect(await continueHere(R, { fetch, online: () => true })).toBe('opened');
		expect(urls).toEqual([workoutUrl(R), kitUrl(KIT.plannedSessionId!)]);
		expect(await activeSummary()).toMatchObject({ workoutId: R, title: KIT.title, pending: 0 });
	});

	it('opens the page when this device already holds a workout in progress (the page shows it)', async () => {
		await startHere();
		const { fetch } = server({
			[workoutUrl(R)]: () => Response.json(rows),
			[kitUrl(KIT.plannedSessionId!)]: () => Response.json(KIT)
		});

		expect(await continueHere(R, { fetch, online: () => true })).toBe('opened');
		expect(await activeSummary()).toMatchObject({ workoutId: W });
	});

	it('is gone when the workout was finished or abandoned meanwhile', async () => {
		const ended = remoteRows([start(R), finish(R)]);
		for (const answer of [
			() => Response.json(ended),
			() => new Response('not found', { status: 404 })
		]) {
			const { fetch } = server({ [workoutUrl(R)]: answer });
			expect(await continueHere(R, { fetch, online: () => true })).toBe('gone');
		}
		expect(await activeSummary()).toBeNull();
	});

	it('fails, keeping nothing, offline, on a failed request, or where the browser cannot keep a workout', async () => {
		const { fetch } = server({ [workoutUrl(R)]: () => new Response('down', { status: 503 }) });
		expect(await continueHere(R, { fetch, online: () => true })).toBe('failed');
		expect(await continueHere(R, { fetch, online: () => false })).toBe('failed');
		expect(await activeSummary()).toBeNull();

		vi.stubGlobal('indexedDB', {
			open: () => {
				throw new DOMException('denied', 'SecurityError');
			}
		});
		expect(await continueHere(R, { fetch, online: () => true })).toBe('failed');
	});
});
