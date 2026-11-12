import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { SyncRequest, SyncResponse } from '#lib/domain/workout/index.ts';
import { replay } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { broadcast, openTabChannel } from './channel';
import { goOnline } from './online';
import { EARLY_ROWS, type EarlyRows } from './prepaint';
import { readActive } from './restore';
import { outboxStatus } from './status.svelte';
import { createStore } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000b1';
const CHANNEL = 'pc-workout-online-test';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

const startOf = (workoutId: string) =>
	createMutation(
		'workout.start',
		{
			workoutId,
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

const skipOf = (workoutId: string, setIndex: number) =>
	createMutation(
		'set.skip',
		{
			workoutId,
			at: '2026-11-06T18:05:00.000Z',
			payload: {
				position: 1,
				plannedLineage: KIT.exercises[0]!.plannedLineage,
				setIndex,
				exerciseId: KIT.exercises[0]!.exercise.id,
				unit: 'kg'
			}
		},
		fresh
	);

const kitOf = (workoutId: string) => ({ type: 'kit.attach', workoutId, kit: KIT }) as const;

/** A server that applies everything: the ids of each batch it was sent, in order. */
function server() {
	const batches: string[][] = [];
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const { mutations } = JSON.parse(init.body as string) as SyncRequest;
		batches.push(mutations.map((m) => m.id));
		const body: SyncResponse = {
			v: 1,
			results: mutations.map(({ id }) => ({ id, status: 'applied' }))
		};
		return Response.json(body);
	});
	return { batches, fetch };
}

/** This page's window and document, as far as the engine listens to them. */
const pageEvents = () => ({
	window: new EventTarget(),
	document: Object.assign(new EventTarget(), { visibilityState: 'visible' as const })
});

/** This page: the store on the test channel, and an engine with no lock. */
const open = (
	fetch: ReturnType<typeof server>['fetch'],
	events: ReturnType<typeof pageEvents> | null = null
) =>
	goOnline(
		{ table: strengthTable, channel: openTabChannel(CHANNEL) },
		{ fetch, locks: null, events, online: () => true, leaving: () => false }
	);

/** Another tab, without an engine of its own. */
const otherTab = () => createStore({ table: strengthTable, channel: openTabChannel(CHANNEL) });

/** Lets every round that could have started finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	broadcast({ type: 'signed-out' }, CHANNEL); // every store closes its channel
	vi.unstubAllGlobals();
});

describe('goOnline', () => {
	it("flushes a change this page saves at once, with no view triggering it, until it's sent", async () => {
		const { batches, fetch } = server();
		const page = await open(fetch);
		await settle();
		expect(batches).toEqual([]); // app start: nothing to send

		const start = startOf(W);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id]));
		await vi.waitFor(async () => expect(await page.store.outbox()).toEqual([]));

		const skip = skipOf(W, 1);
		expect(await page.store.dispatch(skip).saved).toBe('saved');
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id, skip.id]));
		page.stop();
	});

	it("sends through the page's fetch when none is given", async () => {
		const { batches, fetch } = server();
		vi.stubGlobal('fetch', fetch);
		const page = await goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{ locks: null, events: null, online: () => true, leaving: () => false }
		);
		const start = startOf(W);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id]));
		page.stop();
	});

	it("flushes another tab's write to a workout this page holds", async () => {
		const { batches, fetch } = server();
		const other = await otherTab();
		const start = startOf(W);
		expect(await other.dispatch(start, kitOf(W)).saved).toBe('saved');

		const page = await open(fetch);
		// App start sends what is already queued.
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id]));
		expect((await page.store.getActive())?.workoutId).toBe(W);

		await other.load(W);
		const skip = skipOf(W, 1);
		expect(await other.dispatch(skip).saved).toBe('saved');
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id, skip.id]));
		page.stop();
	});

	it("sends nothing more once stopped, on a change or the page's events, and the store keeps every change", async () => {
		const { batches, fetch } = server();
		const events = pageEvents();
		const page = await open(fetch, events);
		const start = startOf(W);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		await vi.waitFor(() => expect(batches.flat()).toEqual([start.id]));

		page.stop();
		const skip = skipOf(W, 1);
		expect(await page.store.dispatch(skip).saved).toBe('saved');
		events.window.dispatchEvent(new Event('online'));
		events.document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(batches.flat()).toEqual([start.id]);
		expect((await page.store.outbox()).map((e) => e.envelope.id)).toEqual([skip.id]);
	});
});

describe('reconcile, when a screen opens online', () => {
	it("flushes first, then stores the active workout's rows, so another device's set shows", async () => {
		const start = startOf(W);
		const elsewhere = skipOf(W, 2); // logged on another device
		const calls: string[] = [];
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			calls.push(`${init.method ?? 'GET'} ${url}`);
			if (init.method === 'POST') {
				const { mutations } = JSON.parse(init.body as string) as SyncRequest;
				return Response.json({
					v: 1,
					results: mutations.map(({ id }) => ({ id, status: 'applied' }))
				});
			}
			const rows = replay(strengthTable, {
				workoutId: W,
				kit: null,
				canonical: null,
				pending: [start, elsewhere]
			}).rows;
			return Response.json(rows);
		});
		const page = await goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{ fetch, locks: null, events: null, online: () => true, leaving: () => false }
		);
		await page.reconciled; // nothing active yet: nothing fetched
		expect(calls).toEqual([]);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		const again = await goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{ fetch, locks: null, events: null, online: () => true, leaving: () => false }
		);
		page.stop();

		await again.reconciled;

		expect(calls.at(-1)).toBe(`GET /api/workouts/${W}`);
		expect(calls.slice(0, -1).every((call) => call.startsWith('POST'))).toBe(true);
		const sets = (await again.store.load(W))!.view!.slots[0]!.sets;
		expect(sets.map((s) => s.id)).toEqual([elsewhere.id]);
		again.stop();
	});

	/** A planned workout, started and synced on this device: the server's rows and its pinned kit. */
	async function plannedOnServer() {
		const start = createMutation(
			'workout.start',
			{
				workoutId: W,
				at: '2026-11-06T18:00:00.000Z',
				payload: {
					...startOf(W).payload,
					plannedSessionId: KIT.plannedSessionId!,
					plannedLineage: KIT.plannedLineage!,
					programId: KIT.programId!
				}
			},
			fresh
		);
		const rows = replay(strengthTable, {
			workoutId: W,
			kit: null,
			canonical: null,
			pending: [start]
		}).rows;
		const calls: string[] = [];
		let answer = 200;
		let gate: ((method: string) => Promise<number>) | null = null;
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			calls.push(`${init.method ?? 'GET'} ${url}`);
			const status = gate ? await gate(init.method ?? 'GET') : answer;
			if (status !== 200) return Response.json({ error: 'unauthenticated' }, { status });
			if (init.method !== 'POST') return Response.json(url.includes('/kit?') ? KIT : rows);
			const { mutations } = JSON.parse(init.body as string) as SyncRequest;
			return Response.json({
				v: 1,
				results: mutations.map(({ id }) => ({ id, status: 'applied', canonical: rows }))
			});
		});
		const page = await goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{ fetch, locks: null, events: null, online: () => true, leaving: () => false }
		);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		await vi.waitFor(async () => expect(await page.store.outbox()).toEqual([]));
		// Its own reconcile GET, sent once that flush has ended, is out before a test counts calls.
		await page.reconciled;
		page.stop();
		const reopen = () =>
			goOnline(
				{ table: strengthTable, channel: openTabChannel(CHANNEL) },
				{ fetch, locks: null, events: null, online: () => true, leaving: () => false }
			);
		return {
			calls,
			reopen,
			signOut: () => (answer = 401),
			/** From now on each request waits for the status its method's gate answers. */
			hold: (g: (method: string) => Promise<number>) => (gate = g)
		};
	}

	it.each([
		['the POST 401, then the GET 200', ['POST', 401], ['GET', 200]],
		['the GET 200, then the POST 401', ['GET', 200], ['POST', 401]],
		['the GET 401, then the POST 200 with its rows', ['GET', 401], ['POST', 200]]
	] as const)(
		'a 401 is final for the page: nothing restores what it deleted, %s',
		async (...[, ...order]) => {
			const server = await plannedOnServer();
			const answers = {
				GET: Promise.withResolvers<number>(),
				POST: Promise.withResolvers<number>()
			};
			server.hold((method) => answers[method as keyof typeof answers].promise);
			const sent = server.calls.length;
			const page = await server.reopen();
			// This page's reconcile GET is out before the POST: both are in flight together.
			await vi.waitFor(() => expect(server.calls.slice(sent)).toEqual([`GET /api/workouts/${W}`]));
			await page.store.load(W);
			expect(await page.store.dispatch(skipOf(W, 1)).saved).toBe('saved');
			await vi.waitFor(() => expect(server.calls.at(-1)).toBe('POST /api/workouts/sync'));

			for (const [method, status] of order) {
				answers[method].resolve(status);
				if (status === 401)
					await vi.waitFor(async () => expect(await page.store.signedOut()).toBe(true));
			}
			await page.reconciled;
			await settle();
			page.stop();

			expect(await page.store.signedOut()).toBe(true);
			const read = await readActive(); // the next page, offline
			expect(read).toMatchObject({ status: 'found', signedOut: true });
			const { inputs } = read as Extract<typeof read, { status: 'found' }>;
			expect([inputs.kit, inputs.canonical]).toEqual([null, null]);
			const offline = await goOnline(
				{ table: strengthTable, channel: openTabChannel(CHANNEL) },
				{ fetch: vi.fn(), locks: null, events: null, online: () => false, leaving: () => false }
			);
			await settle();
			expect(outboxStatus.current).toEqual({ state: 'signed-out', waiting: 1 }); // Shell hides it
			offline.stop();
		}
	);

	it('a 401 with nothing to send signs the page out and deletes what the server holds', async () => {
		const server = await plannedOnServer();
		server.signOut();

		const page = await server.reopen();
		await page.reconciled;

		expect(server.calls.at(-1)).toBe(`GET /api/workouts/${W}`);
		expect(outboxStatus.current).toEqual({ state: 'signed-out', waiting: 0 });
		expect(await page.store.signedOut()).toBe(true);
		expect((await page.store.getActive())!.view).toBeNull();
		page.stop();
	});

	it('signing back in refills a purged planned workout with its pinned kit', async () => {
		const server = await plannedOnServer();
		await (await otherTab()).purgeServerCopies(); // a 401

		const page = await server.reopen();
		await page.reconciled;

		const view = (await page.store.getActive())!.view!;
		expect(view.kit).toStrictEqual(KIT);
		expect(view.slots).toHaveLength(KIT.exercises.length);
		expect(await page.store.signedOut()).toBe(false);
		expect(outboxStatus.current).toEqual({ state: 'synced' });
		page.stop();
	});
});

describe("a cold /workout load: the GET the page's inline script started (prepaint.ts)", () => {
	/**
	 * A workout started and synced here, so nothing waits to be sent; the server's rows also hold
	 * a set another device logged. The calls each later page sends, and its rows.
	 */
	async function syncedHere() {
		const start = startOf(W);
		const elsewhere = skipOf(W, 2);
		const rows = replay(strengthTable, {
			workoutId: W,
			kit: null,
			canonical: null,
			pending: [start, elsewhere]
		}).rows;
		const calls: string[] = [];
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			calls.push(`${init.method ?? 'GET'} ${url}`);
			if (init.method !== 'POST') return Response.json(rows);
			const { mutations } = JSON.parse(init.body as string) as SyncRequest;
			return Response.json({
				v: 1,
				results: mutations.map(({ id }) => ({ id, status: 'applied' }))
			});
		});
		const page = await goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{ fetch, locks: null, events: null, online: () => true, leaving: () => false }
		);
		expect(await page.store.dispatch(start, kitOf(W)).saved).toBe('saved');
		await vi.waitFor(async () => expect(await page.store.outbox()).toEqual([]));
		await page.reconciled;
		page.stop();
		calls.length = 0;
		return { calls, fetch, rows, elsewhere };
	}

	/** What the inline script leaves on the page: a GET of `workoutId`'s rows, answered with `rows`. */
	function leaveEarly(workoutId: string, rows: unknown): EarlyRows {
		const early = {
			workoutId,
			controller: new AbortController(),
			response: Promise.resolve(Response.json(rows))
		};
		vi.stubGlobal(EARLY_ROWS, early);
		return early;
	}

	const reopen = (fetch: ReturnType<typeof vi.fn>, online = true) =>
		goOnline(
			{ table: strengthTable, channel: openTabChannel(CHANNEL) },
			{
				fetch: fetch as never,
				locks: null,
				events: null,
				online: () => online,
				leaving: () => false
			}
		);

	const setIdsOf = async (page: Awaited<ReturnType<typeof goOnline>>) =>
		(await page.store.load(W))!.view!.slots.flatMap((slot) => slot.sets.map((set) => set.id));

	it('stores its rows, with no GET of its own, when nothing was sent or changed since it left', async () => {
		const { calls, fetch, rows, elsewhere } = await syncedHere();
		const early = leaveEarly(W, rows);

		const page = await reopen(fetch);
		await page.reconciled;

		expect(calls).toEqual([]);
		expect(early.controller.signal.aborted).toBe(false);
		expect(EARLY_ROWS in globalThis).toBe(false); // no later page takes it
		expect(await setIdsOf(page)).toEqual([elsewhere.id]);
		page.stop();
	});

	it('is aborted, and the reconcile sends its own GET after the flush, when the page had a change to send', async () => {
		const { calls, fetch, rows } = await syncedHere();
		// A set saved on the last page whose send never left: the early GET predates its answer.
		const last = await otherTab();
		await last.load(W);
		expect(await last.dispatch(skipOf(W, 1)).saved).toBe('saved');
		last.close();
		const early = leaveEarly(W, { ...rows, sets: [] });

		const page = await reopen(fetch);
		await page.reconciled;

		expect(early.controller.signal.aborted).toBe(true);
		expect(calls).toEqual(['POST /api/workouts/sync', `GET /api/workouts/${W}`]);
		page.stop();
	});

	it('is aborted when the store reported a change before the reconcile asked for it', async () => {
		const { calls, fetch, rows } = await syncedHere();
		const early = leaveEarly(W, rows);

		const page = await reopen(fetch);
		// A tap on this page that sends nothing (the view moves to the next exercise).
		await page.store.load(W);
		page.store.dispatch({ type: 'goTo', workoutId: W, position: 2 });
		await page.reconciled;

		expect(early.controller.signal.aborted).toBe(true);
		expect(calls).toEqual([`GET /api/workouts/${W}`]);
		page.stop();
	});

	it('is aborted for a workout that is not the one in progress, or offline', async () => {
		const { calls, fetch, rows } = await syncedHere();
		const other = leaveEarly('00000000-0000-4000-8000-0000000000b2', rows);
		const page = await reopen(fetch);
		await page.reconciled;
		expect(other.controller.signal.aborted).toBe(true);
		expect(calls).toEqual([`GET /api/workouts/${W}`]);
		page.stop();

		const offline = leaveEarly(W, rows);
		const away = await reopen(fetch, false);
		await away.reconciled;
		expect(offline.controller.signal.aborted).toBe(true);
		expect(calls).toHaveLength(1);
		away.stop();
	});
});
