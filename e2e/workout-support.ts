/**
 * IndexedDB helpers for the workout specs (the M4 plan's decision 25): a spec seeds the shared kit
 * fixture (tests/fixtures/workout-day.ts) into 'pc-offline' as the app stores it, opens a workout
 * page, and reads back what the page wrote, so the screens never wait for the server chain.
 * Everything here is built on names.ts, so a spec cannot drift from what the app opens.
 *
 * gotoWorkout's sync modes, for /api/workouts/*:
 * - 'hold' (the default): left unanswered, so a spec never writes Postgres
 * - 'stub': every mutation answered 'applied', with no rows
 * - 'real': the server under test
 * A held or stubbed request is a page.route: on WebKit, use it with `serviceWorkers: 'block'`.
 */
import { expect, type Page } from '@playwright/test';
import { TAB_CHANNEL } from '../src/lib/client/workout/channel';
import { WORKOUT_PATHS } from '../src/lib/client/workout/kinds';
import { DB_NAME, DB_VERSION, LAYOUT, STORES } from '../src/lib/client/workout/names';
import type { SessionKind } from '../src/lib/domain/training/types';
import type { Mutation, StartKit, SyncRequest, SyncResponse } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { workoutDayKits, type WorkoutDayKits } from '../tests/fixtures/workout-day';
import { query } from './support';

/** The fixture's catalogue keys, every kind's. */
const FIXTURE_KEYS = ['back_squat', 'leg_press', 'romanian_deadlift', 'pull_up', 'plank'];

/** Today's start kits of the fixture, with exercise ids resolved by catalogue key in SQL. */
export async function workoutDay(date = new Date().toISOString().slice(0, 10)) {
	const rows = await query<{ id: string; key: string }>(
		'select id, key from exercises where owner_id is null and key = any($1)',
		[FIXTURE_KEYS]
	);
	const ids = new Map(rows.map((row) => [row.key, row.id]));
	const exerciseId = (key: string) => {
		const id = ids.get(key);
		if (!id) throw new Error(`the catalogue has no exercise '${key}'`);
		return id;
	};
	return workoutDayKits({ date, exerciseId }) satisfies WorkoutDayKits;
}

/** A workout as the store keeps it (or none), and outbox entries without their seq. */
interface Seed {
	record: Record<string, unknown> | null;
	entries: Record<string, unknown>[];
	/** Saved start kits, as Today saves them (kits store). */
	kits?: Record<string, unknown>[];
}

/**
 * Writes a seed into 'pc-offline' in one transaction, creating the database as the app declares
 * it (names.ts) when it does not exist, then posts `message` to the open tabs.
 */
async function writeDb(page: Page, seed: Seed, message: object | null) {
	await page.evaluate(
		async ({ name, version, layout, stores, seed, channel, message }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name, version);
				request.onupgradeneeded = () => {
					for (const [store, { keyPath, autoIncrement, indexes }] of Object.entries(layout)) {
						if (request.result.objectStoreNames.contains(store)) continue;
						const created = request.result.createObjectStore(store, {
							keyPath,
							autoIncrement: autoIncrement ?? false
						});
						for (const [index, options] of Object.entries(indexes ?? {})) {
							created.createIndex(index, options.keyPath, { unique: options.unique });
						}
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const tx = db.transaction([stores.workouts, stores.outbox, stores.kits], 'readwrite');
			if (seed.record) tx.objectStore(stores.workouts).put(seed.record);
			for (const entry of seed.entries) tx.objectStore(stores.outbox).add(entry);
			for (const kit of seed.kits ?? []) tx.objectStore(stores.kits).put(kit);
			await new Promise((resolve, reject) => {
				tx.oncomplete = resolve;
				tx.onerror = () => reject(tx.error);
			});
			db.close();
			if (message) {
				const tabs = new BroadcastChannel(channel);
				tabs.postMessage(message);
				tabs.close();
			}
		},
		{
			name: DB_NAME,
			version: DB_VERSION,
			layout: LAYOUT,
			stores: STORES,
			seed,
			channel: TAB_CHANNEL,
			message
		}
	);
}

/** On the app's origin (a static file), so IndexedDB is the app's, without opening the app. */
async function onOrigin(page: Page) {
	if (!page.url().startsWith('http')) await page.goto('/robots.txt');
}

const entryOf = (envelope: Mutation) => ({
	envelope,
	attempts: 0,
	failingSince: null,
	nextAt: null
});

/**
 * Start kits saved on this device, in this order, as Today saves today's (start.ts saveKits): what
 * a launch with no signal starts from. Seed before the page opens the store.
 */
export async function seedKits(page: Page, kits: readonly StartKit[]): Promise<void> {
	await onOrigin(page);
	const savedAt = Date.now();
	const saved = kits.map((kit, i) => ({ lineage: kit.plannedLineage, kit, savedAt: savedAt + i }));
	await writeDb(page, { record: null, entries: [], kits: saved }, null);
}

/**
 * A workout in progress on this device, as workout.start leaves it: its record with the kit and
 * the stopwatch running from the start, and its workout.start in the outbox. Seed before the page
 * opens the store. Returns the workout's id.
 */
export async function seedWorkout(
	page: Page,
	kit: StartKit,
	{ startedMinutesAgo = 12 }: { startedMinutesAgo?: number } = {}
): Promise<string> {
	await onOrigin(page);
	const workoutId = crypto.randomUUID();
	const started = Date.now() - startedMinutesAgo * 60_000;
	const startedAt = new Date(started).toISOString();
	const { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId } = kit;
	const start = createMutation('workout.start', {
		workoutId,
		at: startedAt,
		payload: { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId }
	});
	const record = {
		id: workoutId,
		kind,
		title,
		startedAt,
		status: 'in_progress',
		finishedAt: null,
		kit,
		canonical: null,
		device: {
			position: 1,
			drafts: {},
			rest: null,
			stopwatch: { startedAt: started, accumulatedMs: 0, runningSince: started },
			added: [],
			attached: {}
		}
	};
	await writeDb(page, { record, entries: [entryOf(start)] }, null);
	return workoutId;
}

/** Adds a mutation to the outbox and tells the open tabs, as another tab's dispatch would. */
export async function injectMutation(page: Page, mutation: Mutation): Promise<void> {
	await onOrigin(page);
	await writeDb(
		page,
		{ record: null, entries: [entryOf(mutation)] },
		{ type: 'changed', workoutId: mutation.workoutId }
	);
}

async function readStore<T>(page: Page, store: string, key?: string): Promise<T> {
	return page.evaluate(
		async ({ name, store, key }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const objects = db.transaction(store, 'readonly').objectStore(store);
				const request = key === undefined ? objects.getAll() : objects.get(key);
				return await new Promise<T>((resolve, reject) => {
					request.onsuccess = () => resolve(request.result as T);
					request.onerror = () => reject(request.error);
				});
			} finally {
				db.close();
			}
		},
		{ name: DB_NAME, store, key }
	);
}

/** Every outbox entry, in seq order. */
export const readOutbox = (page: Page) =>
	readStore<{ seq: number; envelope: Mutation }[]>(page, STORES.outbox);

/** A workout's History detail. */
const DETAIL = /\/progress\/workouts\/[0-9a-f-]{36}$/;

/**
 * After Done, online: the History detail, which Done opens itself when the server takes the
 * finish within about 300 ms (finish.ts FINISH_SYNC_WAIT_MS), else the completed state's 'View in
 * History' once the sync confirms. A slower CI server takes either path; both end on the detail.
 */
export async function historyAfterDone(page: Page): Promise<void> {
	const view = page.getByTestId('workout-summary').getByTestId('view-in-history');
	const detail = () => DETAIL.test(new URL(page.url()).pathname);
	await expect
		.poll(async () => detail() || (await view.isVisible()), {
			message: 'Done opens History, or offers View in History',
			timeout: 15_000
		})
		.toBe(true);
	// Done's own navigation can win the race with the click and detach the link: the URL decides.
	if (!detail()) await view.click({ timeout: 5_000 }).catch(() => {});
	await page.waitForURL(DETAIL);
}

/** A workout's stored record, or undefined. */
export const readWorkout = (page: Page, workoutId: string) =>
	readStore<Record<string, unknown> | undefined>(page, STORES.workouts, workoutId);

/** Safe-area insets in px, forced through the tokens (no browser here has a notch). */
export async function forceSafeArea(
	page: Page,
	insets: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>
): Promise<void> {
	await page.evaluate((sides) => {
		for (const [side, px] of Object.entries(sides)) {
			document.documentElement.style.setProperty(`--safe-${side}`, `${px}px`);
		}
	}, insets);
}

export type SyncMode = 'hold' | 'stub' | 'real';

/** Opens a kind's workout page and waits until it has restored (data-ready). */
export async function gotoWorkout(
	page: Page,
	kind: SessionKind = 'strength',
	{ sync = 'hold', search = '' }: { sync?: SyncMode; search?: string } = {}
): Promise<void> {
	if (sync === 'hold') await page.route('**/api/workouts/**', () => {});
	if (sync === 'stub') {
		await page.route('**/api/workouts/sync', (route) => {
			const { mutations } = route.request().postDataJSON() as SyncRequest;
			const body: SyncResponse = {
				v: 1,
				results: mutations.map(({ id }) => ({ id, status: 'applied' }))
			};
			return route.fulfill({ json: body });
		});
	}
	await page.goto(`${WORKOUT_PATHS[kind]}${search}`);
	await expect(page.locator('main#main[data-ready]')).toBeAttached();
}

/** Where Next (or Previous) was before a tap on it, in the first frame after, and once settled. */
export interface WatchedMove {
	before: number;
	first: number;
	after: number;
	/** The slides running on its block (the strength view's navigation) in that first frame. */
	sliding: number;
}

/**
 * Taps Previous or Next in the page and reads where the button is (its top as seen, a slide
 * included): before, in the first frame the change paints, and once its block's slides have ended.
 * The first frame is read after the strength view's own (flip.ts), as the browser paints it.
 */
export function watchMove(page: Page, testId: 'exercise-next' | 'exercise-prev') {
	return page.evaluate(async (id): Promise<WatchedMove> => {
		const button = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
		const block = button.closest<HTMLElement>('.navigation')!;
		const top = () => button.getBoundingClientRect().top;
		const frame = () => new Promise((done) => requestAnimationFrame(done));
		await frame();
		const before = top();
		// The change's DOM written (its effects have run, each frame request made), then a frame.
		const changed = new Promise<void>((done) => {
			const observer = new MutationObserver(() => {
				observer.disconnect();
				done();
			});
			observer.observe(document.getElementById('main')!, {
				subtree: true,
				childList: true,
				characterData: true
			});
		});
		button.click();
		await changed;
		await frame();
		const first = top();
		const sliding = block.getAnimations().length;
		await Promise.all(block.getAnimations().map((animation) => animation.finished));
		return { before, first, after: top(), sliding };
	}, testId);
}
