import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type { CanonicalWorkout, StartKit } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { stopwatchElapsed } from '#lib/domain/workout/timers.ts';
import {
	discardInProgress,
	fetchKit,
	inProgress,
	KIT_TIMEOUT_MS,
	LIBRARY_URL,
	localDay,
	saveKits,
	startAdHoc,
	startKitUrl,
	startPlanned,
	startRequestOf,
	UNSAVED_KIT_TIMEOUT_MS,
	type StartOptions
} from './start';
import { createStore, type WorkoutStore } from './store';

const KITS = workoutDayKits({ date: '2026-11-06' });
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const UNITS = { weight: 'lb', distance: 'mi' } as const;
const { strength: STRENGTH, run: RUN } = WORKOUT_DAY_IDS;

/** A fetch that answers each URL from `answers` (a status, a body, or a thrown error). */
function server(answers: Record<string, number | StartKit | Error | object>) {
	const calls: string[] = [];
	const fetch = vi.fn(async (url: string, _init: RequestInit) => {
		calls.push(url);
		const answer = answers[url];
		if (answer === undefined) return new Response('{}', { status: 404 });
		if (answer instanceof Error) throw answer;
		if (typeof answer === 'number') return new Response('{}', { status: answer });
		return Response.json(answer);
	});
	return { fetch, calls };
}

let store: WorkoutStore;
let persist: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
const options = (fetch: StartOptions['fetch']): StartOptions => ({
	store,
	fetch,
	now: () => T0,
	persist
});

beforeEach(async () => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	store = await createStore({ table: strengthTable, now: () => T0, channel: null });
	persist = vi.fn(async () => true);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const outboxTypes = async () => (await store.outbox()).map((e) => e.envelope.type);

describe('startRequestOf', () => {
	it('reads ?start as a lineage, ahead of ?new', () => {
		expect(startRequestOf('?start=abc&new=run')).toEqual({ lineage: 'abc' });
	});

	it('reads ?new=strength, ?new=run and ?new=other as ad-hoc kinds, and nothing else', () => {
		expect(startRequestOf('?new=strength')).toEqual({ kind: 'strength' });
		expect(startRequestOf('?new=run')).toEqual({ kind: 'run' });
		expect(startRequestOf('?new=other')).toEqual({ kind: 'other' });
		expect(startRequestOf('?new=planned')).toBeNull();
		expect(startRequestOf('?start=')).toBeNull();
		expect(startRequestOf('')).toBeNull();
	});
});

describe('fetchKit', () => {
	const url = startKitUrl(STRENGTH.lineage);

	it('answers the kit, or why not: a 401 signed out, a 404 missing, anything else unreachable', async () => {
		expect(await fetchKit(STRENGTH.lineage, server({ [url]: KITS.strength }))).toEqual({
			ok: true,
			kit: KITS.strength
		});
		for (const [answer, reason] of [
			[401, 'signed-out'],
			[404, 'missing'],
			[503, 'unreachable'],
			[403, 'unreachable'],
			[new TypeError('Failed to fetch'), 'unreachable']
		] as const) {
			expect(await fetchKit(STRENGTH.lineage, server({ [url]: answer }))).toEqual({
				ok: false,
				reason
			});
		}
	});

	it('gives up after 4 s: the request is aborted and reads as unreachable', async () => {
		let abort: (() => void) | null = null;
		let delay = 0;
		const fetch = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal!.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
			});
		const answer = fetchKit(STRENGTH.lineage, {
			fetch,
			setTimeout: (run, ms) => ((abort = run), (delay = ms)),
			clearTimeout: () => {}
		});
		expect(delay).toBe(KIT_TIMEOUT_MS);
		expect(KIT_TIMEOUT_MS).toBe(4_000);
		abort!();
		expect(await answer).toEqual({ ok: false, reason: 'unreachable' });
	});

	it('gives up after the timeout it is given', async () => {
		let delay = 0;
		await fetchKit(STRENGTH.lineage, {
			...server({ [url]: KITS.strength }),
			setTimeout: (_run, ms) => (delay = ms),
			clearTimeout: () => {},
			timeoutMs: 1_234
		});
		expect(delay).toBe(1_234);
	});
});

describe('startPlanned', () => {
	it('creates the workout from the fetched kit: workout.start pinned to the planned session, the kit and the stopwatch, then persistent storage', async () => {
		const { fetch } = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		const outcome = await startPlanned(RUN.lineage, options(fetch));
		expect(outcome).toEqual({ status: 'started', path: '/workout/run' });

		const [entry] = await store.outbox();
		expect(entry!.envelope).toMatchObject({
			type: 'workout.start',
			at: new Date(T0).toISOString(),
			payload: {
				kind: 'run',
				title: KITS.run.title,
				plannedSessionId: RUN.session,
				plannedLineage: RUN.lineage,
				programId: WORKOUT_DAY_IDS.programId
			}
		});
		expect(entry!.envelope.id).toBe(entry!.envelope.workoutId);
		const active = await store.getActive();
		expect(active!.workoutId).toBe(entry!.envelope.workoutId);
		expect(active!.view!.kit).toEqual(KITS.run);
		expect(stopwatchElapsed(active!.view!.device.stopwatch, T0 + 60_000)).toBe(60_000);
		expect(persist).toHaveBeenCalledOnce();
	});

	it('the created workout is not marked for a refresh: its kit is the fresh one', async () => {
		const { fetch } = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		expect(await startPlanned(RUN.lineage, options(fetch))).not.toHaveProperty('refresh');
	});

	it('a kit saved on this device starts it at once, with no request, and names the workout whose kit to refresh', async () => {
		await store.saveKit(STRENGTH.lineage, KITS.strength);
		// A server that never answers: a start that waited on it would never resolve.
		const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
		const outcome = await startPlanned(STRENGTH.lineage, options(fetch));
		const active = (await store.getActive())!;
		expect(outcome).toEqual({ status: 'started', path: '/workout', refresh: active.workoutId });
		expect(fetch).not.toHaveBeenCalled();
		expect(active.view!.kit).toEqual(KITS.strength);
		expect(await outboxTypes()).toEqual(['workout.start']);
		expect(persist).toHaveBeenCalledOnce();
	});

	it('with no kit saved, the request is given up on after 1.5 s, not 4 s', async () => {
		let abort: (() => void) | null = null;
		let delay = 0;
		const fetch = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal!.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
			});
		const outcome = startPlanned(STRENGTH.lineage, {
			...options(fetch),
			setTimeout: (run, ms) => ((abort = run), (delay = ms)),
			clearTimeout: () => {}
		});
		await vi.waitFor(() => expect(abort).not.toBeNull());
		expect(delay).toBe(UNSAVED_KIT_TIMEOUT_MS);
		expect(UNSAVED_KIT_TIMEOUT_MS).toBe(1_500);
		abort!();
		expect(await outcome).toEqual({ status: 'unreachable' });
	});

	it('unreachable with no saved kit: nothing is written', async () => {
		const { fetch } = server({ [startKitUrl(STRENGTH.lineage)]: 503 });
		expect(await startPlanned(STRENGTH.lineage, options(fetch))).toEqual({
			status: 'unreachable'
		});
		expect(await store.getActive()).toBeNull();
		expect(await store.outbox()).toEqual([]);
		expect(persist).not.toHaveBeenCalled();
	});

	it('with no saved kit, a 404 says missing', async () => {
		const url = startKitUrl(STRENGTH.lineage);
		expect(await startPlanned(STRENGTH.lineage, options(server({ [url]: 404 }).fetch))).toEqual({
			status: 'missing'
		});
		expect(await store.outbox()).toEqual([]);
	});

	it('with no saved kit, a 401 asks for a sign-in and purges what the server holds, as the sync engine does', async () => {
		await store.saveKit(RUN.lineage, KITS.run);
		await store.saveUnits(UNITS);
		const url = startKitUrl(STRENGTH.lineage);
		expect(await startPlanned(STRENGTH.lineage, options(server({ [url]: 401 }).fetch))).toEqual({
			status: 'signed-out'
		});
		expect(await store.getKit(RUN.lineage)).toBeNull();
		expect(await store.getUnits()).toBeNull();
		expect(await store.signedOut()).toBe(true);
		expect(await store.outbox()).toEqual([]);
	});

	it('with a workout in progress: the conflict, before anything is fetched; its own link resumes it', async () => {
		const first = server({ [startKitUrl(STRENGTH.lineage)]: KITS.strength });
		await startPlanned(STRENGTH.lineage, options(first.fetch));

		const second = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		const outcome = await startPlanned(RUN.lineage, options(second.fetch));
		const [start] = await store.outbox();
		expect(outcome).toEqual({
			status: 'conflict',
			active: {
				workoutId: start!.envelope.workoutId,
				kind: 'strength',
				title: KITS.strength.title,
				startedAt: new Date(T0).toISOString(),
				plannedLineage: STRENGTH.lineage,
				startSeq: start!.seq
			}
		});
		expect(second.calls).toEqual([]);
		expect(await outboxTypes()).toEqual(['workout.start']);

		expect(await startPlanned(STRENGTH.lineage, options(second.fetch))).toEqual({
			status: 'started',
			path: '/workout'
		});
		expect(await outboxTypes()).toEqual(['workout.start']);
	});
});

describe('discardInProgress', () => {
	async function startStrength() {
		await startPlanned(
			STRENGTH.lineage,
			options(server({ [startKitUrl(STRENGTH.lineage)]: KITS.strength }).fetch)
		);
		return (await inProgress(store))!;
	}

	it('drops a workout whose start has not synced, then the new one starts', async () => {
		const active = await startStrength();
		expect(active.startSeq).not.toBeNull();
		expect(await discardInProgress(active, { store, now: () => T0 })).toBe(true);
		expect(await store.getActive()).toBeNull();
		expect(await store.outbox()).toEqual([]);

		const run = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		expect(await startPlanned(RUN.lineage, options(run.fetch))).toEqual({
			status: 'started',
			path: '/workout/run'
		});
	});

	it('abandons a workout the server holds, then the new one starts after it in the outbox', async () => {
		const started = await startStrength();
		const [entry] = await store.outbox();
		// The server's answer carries its rows, as the sync endpoint's does.
		const { pending: _pending, ...workout } = store.snapshot(started.workoutId)!.view!.workout;
		const canonical: CanonicalWorkout = {
			v: 1,
			workout,
			sets: [],
			substitutions: [],
			pain: [],
			run: null,
			other: null,
			exercises: {}
		};
		await store.acknowledge([{ id: entry!.envelope.id, status: 'applied', canonical }]);
		const active = (await inProgress(store))!;
		expect(active).toEqual({ ...started, startSeq: null });

		expect(await discardInProgress(active, { store, now: () => T0 + 1000 })).toBe(true);
		const abandoned = await store.load(active.workoutId);
		expect(abandoned!.view!.workout.status).toBe('abandoned');
		expect(await store.getActive()).toBeNull();

		const run = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		await startPlanned(RUN.lineage, options(run.fetch));
		expect(await outboxTypes()).toEqual(['workout.abandon', 'workout.start']);
	});
});

describe('startAdHoc', () => {
	const DEVICE = { weight: 'kg', distance: 'km' } as const;
	const kitUnits = async () => (await store.getActive())!.view!.kit!.units;

	it('starts a run from a kit built here, linked to no plan', async () => {
		const outcome = await startAdHoc('run', UNITS, options(server({}).fetch));
		expect(outcome).toEqual({ status: 'started', path: '/workout/run' });
		const [entry] = await store.outbox();
		expect(entry!.envelope.payload).toEqual({
			kind: 'run',
			title: 'Run',
			sessionType: 'easy_run',
			discipline: 'running',
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		});
		const kit = (await store.getActive())!.view!.kit!;
		expect(kit).toMatchObject({ kind: 'run', units: UNITS, date: localDay(T0) });
		expect(persist).toHaveBeenCalledOnce();
	});

	it('uses the training profile’s units over this device’s, and keeps them for offline', async () => {
		const library = server({ [LIBRARY_URL]: { v: 1, units: UNITS, exercises: [] } });
		await startAdHoc('run', DEVICE, options(library.fetch));
		expect(library.calls).toEqual([LIBRARY_URL]);
		expect(await kitUnits()).toEqual(UNITS);
		await discardInProgress((await inProgress(store))!, { store });

		await startAdHoc(
			'run',
			DEVICE,
			options(server({ [LIBRARY_URL]: new TypeError('offline') }).fetch)
		);
		expect(await kitUnits()).toEqual(UNITS);
	});

	it('offline, keeps the training profile’s units a planned start brought', async () => {
		const planned = server({ [startKitUrl(RUN.lineage)]: KITS.run });
		await startPlanned(RUN.lineage, options(planned.fetch));
		await discardInProgress((await inProgress(store))!, { store });

		const offline = server({ [LIBRARY_URL]: new TypeError('offline') });
		await startAdHoc('run', UNITS, options(offline.fetch));
		expect(await kitUnits()).toEqual(KITS.run.units);
	});

	it('answers the conflict while another workout is in progress', async () => {
		await startAdHoc('other', UNITS, options(server({}).fetch));
		const outcome = await startAdHoc('run', UNITS, options(server({}).fetch));
		expect(outcome).toMatchObject({ status: 'conflict', active: { kind: 'other' } });
		expect(await outboxTypes()).toEqual(['workout.start']);
	});
});

describe('saveKits', () => {
	it('saves each kit the server answers with the owner’s units, and skips a missing one', async () => {
		const { fetch } = server({
			[startKitUrl(STRENGTH.lineage)]: KITS.strength,
			[startKitUrl(RUN.lineage)]: KITS.run
		});
		const lineages = ['missing-lineage', STRENGTH.lineage, RUN.lineage];
		expect(await saveKits(lineages, { store, fetch })).toEqual([STRENGTH.lineage, RUN.lineage]);
		expect(await store.getKit(RUN.lineage)).toEqual(KITS.run);
		expect(await store.getUnits()).toEqual(KITS.run.units);
	});

	it('a 401 stops it and purges what the server holds, keeping the unsynced changes', async () => {
		await startAdHoc('run', UNITS, options(server({}).fetch));
		const { fetch, calls } = server({
			[startKitUrl(STRENGTH.lineage)]: KITS.strength,
			[startKitUrl(RUN.lineage)]: 401,
			[startKitUrl(WORKOUT_DAY_IDS.other.lineage)]: KITS.other
		});
		const lineages = [STRENGTH.lineage, RUN.lineage, WORKOUT_DAY_IDS.other.lineage];
		expect(await saveKits(lineages, { store, fetch })).toEqual([]);
		expect(calls).toHaveLength(2);
		expect(await store.getKit(STRENGTH.lineage)).toBeNull();
		expect(await store.getUnits()).toBeNull();
		expect(await store.signedOut()).toBe(true);
		expect(await outboxTypes()).toEqual(['workout.start']);
	});
});

describe('on a device a 401 marked signed out', () => {
	/** An unsynced run in progress, then a 401's purge, as the sync engine leaves them. */
	async function purgedWithARun() {
		await startAdHoc('run', UNITS, options(server({}).fetch));
		await store.purgeServerCopies();
		expect(await inProgress(store)).toMatchObject({ kind: 'run', title: 'Run' });
	}

	it('another start link shows nothing of the held workout until the server answers as the owner', async () => {
		await purgedWithARun();
		const url = startKitUrl(STRENGTH.lineage);
		for (const answer of [401, new TypeError('offline')]) {
			expect(
				await startPlanned(STRENGTH.lineage, options(server({ [url]: answer }).fetch))
			).toEqual({ status: 'signed-out' });
			expect(
				await startAdHoc('other', UNITS, options(server({ [LIBRARY_URL]: answer }).fetch))
			).toEqual({ status: 'signed-out' });
		}
		expect(await store.signedOut()).toBe(true);

		// A kit saved here starts nothing either, before the server answers as the owner.
		await store.saveKit(STRENGTH.lineage, KITS.strength);
		const offline = server({ [url]: new TypeError('offline') });
		expect(await startPlanned(STRENGTH.lineage, options(offline.fetch))).toEqual({
			status: 'signed-out'
		});
		expect(offline.calls).toEqual([url]);

		const owner = server({ [url]: KITS.strength });
		expect(await startPlanned(STRENGTH.lineage, options(owner.fetch))).toMatchObject({
			status: 'conflict',
			active: { kind: 'run' }
		});
		expect(await store.signedOut()).toBe(false);
		expect(await outboxTypes()).toEqual(['workout.start']);
	});
});

describe('localDay', () => {
	it('is the device’s calendar day', () => {
		const d = new Date(2026, 0, 5, 23, 30);
		expect(localDay(d.getTime())).toBe('2026-01-05');
	});
});
