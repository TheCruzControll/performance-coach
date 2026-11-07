import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { SyncRequest, SyncResponse } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { broadcast, openTabChannel } from './channel';
import { goOnline } from './online';
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
