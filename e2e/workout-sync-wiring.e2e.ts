/**
 * The workout page's one sync engine, from the page to Postgres (sync 'real'): started on idle by
 * the Shell, and flushed by every change the store reports. The set mutations are injected in
 * their contract shape (injectMutation, as another tab's dispatch), and each test asserts only its
 * own workout's rows, by client id.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { setE1rm } from '../src/lib/domain/training/metrics';
import type { MutationPayloads, StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { SYNC_LOCK, SYNC_URL } from '../src/lib/client/workout/sync';
import { ORIGIN, query } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	seedWorkout,
	workoutDay
} from './workout-support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');

/**
 * The chunk the sync engine (sync.ts) is built into, in the build under test: online.ts's, which
 * the page loads on idle with the store, or one it imports, as sign-out's shutdown.ts shares
 * sync.ts with it (Vite's manifest).
 */
function syncChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string; imports?: string[] } | undefined
	>;
	const online = manifest['src/lib/client/workout/online.ts'];
	if (!online) throw new Error('online.ts is not in the build under test');
	const files = [online.file, ...(online.imports ?? []).flatMap((k) => manifest[k]?.file ?? [])];
	const file = files.find((f) => readFileSync(`${CLIENT}/${f}`, 'utf8').includes(SYNC_LOCK));
	if (!file) throw new Error('sync.ts is not in online.ts or its imports');
	return file;
}

let kit: StrengthKit;
test.beforeAll(async () => {
	const { strength } = await workoutDay();
	// Ad hoc: the fixture's planned session is not in this database.
	kit = { ...strength, plannedLineage: null, plannedSessionId: null, programId: null };
	kit.exercises = kit.exercises.map((e) => ({ ...e, plannedLineage: null }));
});

const slotOf = (key: string) => {
	const slot = kit.exercises.find((e) => e.exercise.key === key);
	if (!slot) throw new Error(`the kit has no ${key}`);
	return { position: slot.position, exerciseId: slot.exercise.id };
};

const DONE = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const satisfies MutationPayloads['set.edit'];

const now = () => new Date().toISOString();

const logOf = (
	workoutId: string,
	key: string,
	setIndex: number,
	over: Partial<MutationPayloads['set.log']> = {}
) =>
	createMutation('set.log', {
		workoutId,
		at: now(),
		payload: { ...slotOf(key), plannedLineage: null, setIndex, ...DONE, ...over }
	});

interface SetRow {
	weight: number | null;
	reps: number | null;
	seconds: number | null;
	rpe: number | null;
	missed_reps: number;
	is_extra: boolean;
	is_skipped: boolean;
	e1rm_kg: number | null;
	deleted: boolean;
	audits: number;
}

/** A set's row by its client id, or undefined while it has not landed. */
async function setRow(clientId: string): Promise<SetRow | undefined> {
	const [row] = await query<SetRow>(
		`select s.weight::float8 as weight, s.reps, s.seconds, s.rpe::float8 as rpe, s.missed_reps,
			s.is_extra, s.is_skipped, s.e1rm_kg::float8 as e1rm_kg, s.deleted_at is not null as deleted,
			(select count(*)::int from training_audit a
				where a.table_name = 'set_records' and a.row_id = s.id::text) as audits
		from set_records s where s.client_mutation_id = $1`,
		[clientId]
	);
	return row;
}

const workoutRow = async (clientId: string) =>
	(
		await query<{ title: string; status: string }>(
			'select title, status from workouts where client_id = $1',
			[clientId]
		)
	)[0];

const e1rmOf = (weight: number, reps: number, rpe: number) =>
	setE1rm({ weight, unit: 'kg', reps, rpe, isWarmup: false, isSkipped: false })!.value;

/** Requests to the sync endpoint, as the page sends them. */
function syncRequests(page: Page): Request[] {
	const sent: Request[] = [];
	page.on('request', (r) => {
		if (new URL(r.url()).pathname === SYNC_URL) sent.push(r);
	});
	return sent;
}

test.describe('the workout sync engine', () => {
	// Every request reaches the network, and page.route sees them on WebKit too.
	test.use({ serviceWorkers: 'block' });

	test('a seeded workout with a pending start and set reaches Postgres once the page is idle', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		const set = logOf(workoutId, 'back_squat', 1);
		await injectMutation(page, set);
		expect(await readOutbox(page)).toHaveLength(2);

		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
		expect(await workoutRow(workoutId)).toEqual({ title: kit.title, status: 'in_progress' });
		expect(await setRow(set.id)).toMatchObject({ weight: 100, reps: 5, rpe: 8, deleted: false });
	});

	test('changes made while the page is open flush without a reload, each with the right columns', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
		// A marker a reload would lose.
		await page.evaluate(() => Object.assign(window, { __samePage: true }));

		const squat = logOf(workoutId, 'back_squat', 1);
		const bodyweight = logOf(workoutId, 'pull_up', 1, { weight: null, reps: 8 });
		const added = logOf(workoutId, 'pull_up', 2, { weight: 10, reps: 6 });
		const plank = logOf(workoutId, 'plank', 1, {
			weight: null,
			reps: null,
			seconds: 45,
			rpe: null
		});
		const toEdit = logOf(workoutId, 'back_squat', 2);
		const edit = createMutation('set.edit', {
			workoutId,
			entityId: toEdit.entityId,
			at: now(),
			payload: { ...DONE, reps: 4, rpe: 9 }
		});
		const skip = createMutation('set.skip', {
			workoutId,
			at: now(),
			payload: { ...slotOf('back_squat'), plannedLineage: null, setIndex: 3, unit: 'kg' }
		});
		const missed = logOf(workoutId, 'back_squat', 4, { reps: 3, missedReps: 2 });
		const extra = logOf(workoutId, 'back_squat', 5, { isExtra: true });
		const toDelete = logOf(workoutId, 'back_squat', 6);
		const remove = createMutation('set.delete', {
			workoutId,
			entityId: toDelete.entityId,
			at: now(),
			payload: {}
		});
		for (const m of [squat, bodyweight, added, plank, toEdit, edit, skip, missed, extra]) {
			await injectMutation(page, m);
		}
		await injectMutation(page, toDelete);
		await injectMutation(page, remove);

		await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
		expect(await page.evaluate(() => '__samePage' in window)).toBe(true);

		expect(await setRow(squat.id)).toMatchObject({
			weight: 100,
			reps: 5,
			rpe: 8,
			e1rm_kg: expect.closeTo(e1rmOf(100, 5, 8), 6)
		});
		expect(await setRow(bodyweight.id)).toMatchObject({ weight: null, reps: 8, e1rm_kg: null });
		expect(await setRow(added.id)).toMatchObject({ weight: 10, reps: 6, e1rm_kg: null });
		expect(await setRow(plank.id)).toMatchObject({
			seconds: 45,
			reps: null,
			weight: null,
			e1rm_kg: null
		});
		expect(await setRow(toEdit.id)).toMatchObject({
			weight: 100,
			reps: 4,
			rpe: 9,
			e1rm_kg: expect.closeTo(e1rmOf(100, 4, 9), 6),
			audits: 1
		});
		expect(await setRow(skip.id)).toMatchObject({
			is_skipped: true,
			reps: null,
			weight: null,
			e1rm_kg: null
		});
		expect(await setRow(missed.id)).toMatchObject({ reps: 3, missed_reps: 2, is_skipped: false });
		expect(await setRow(extra.id)).toMatchObject({ is_extra: true, is_skipped: false });
		expect(await setRow(toDelete.id)).toMatchObject({ deleted: true });
	});

	test('offline, nothing is sent; back online, it flushes at once', async ({ page, context }) => {
		const workoutId = await seedWorkout(page, kit);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
		const sent = syncRequests(page);

		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		const set = logOf(workoutId, 'back_squat', 1);
		await injectMutation(page, set);
		// Long enough for a flush the change triggered to have gone out.
		await page.waitForTimeout(1500);
		expect(sent).toEqual([]);
		expect(await readOutbox(page)).toHaveLength(1);
		expect(await setRow(set.id)).toBeUndefined();

		const back = Date.now();
		await context.setOffline(false);
		await expect.poll(() => readOutbox(page), { timeout: 5_000 }).toEqual([]);
		expect(Date.now() - back).toBeLessThan(5_000);
		expect(sent).toHaveLength(1);
		expect(await setRow(set.id)).toMatchObject({ weight: 100, reps: 5 });
	});

	test('sync.ts is requested after the first render, never before hydration', async ({ page }) => {
		const chunk = syncChunk();
		// When the page first showed what it restored: after hydration and the restore.
		await page.addInitScript(() => {
			new MutationObserver((_, observer) => {
				if (!document.querySelector('main#main[data-ready]')) return;
				Object.assign(window, { __readyAt: performance.now() });
				observer.disconnect();
			}).observe(document, { subtree: true, childList: true, attributes: true });
		});
		const requested: string[] = [];
		page.on('request', (r) => requested.push(new URL(r.url()).pathname));

		const html = await (await page.request.get('/workout')).text();
		expect(html).not.toContain(chunk);

		await seedWorkout(page, kit);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect.poll(() => requested.filter((p) => p.endsWith(chunk))).toHaveLength(1);
		const { readyAt, syncAt } = await page.evaluate((file) => {
			const entry = performance
				.getEntriesByType('resource')
				.find((e) => new URL(e.name).pathname.endsWith(file));
			return {
				readyAt: (window as unknown as { __readyAt?: number }).__readyAt ?? null,
				syncAt: entry?.startTime ?? null
			};
		}, chunk);
		expect(readyAt).not.toBeNull();
		expect(syncAt).toBeGreaterThan(readyAt!);
		await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
	});
});

/** What a page sent as it was left, kept in sessionStorage so the next page can read it. */
interface Left {
	keepalive: { url: string; bytes: number; ids: string[] }[];
	beacons: { url: string; queued: boolean; body: string }[];
}

/**
 * Records every keepalive fetch and sendBeacon call into sessionStorage, synchronously: Playwright
 * does not see the requests of a page being left, so the page tells the next one.
 */
const recordLeaving = (page: Page) =>
	page.addInitScript(() => {
		const read = (): Left =>
			JSON.parse(sessionStorage.getItem('left') ?? '{"keepalive":[],"beacons":[]}');
		const write = (left: Left) => sessionStorage.setItem('left', JSON.stringify(left));
		const texts = new WeakMap<Blob, string>();
		const NativeBlob = Blob;
		window.Blob = class extends NativeBlob {
			constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
				super(parts, options);
				if (parts?.every((p) => typeof p === 'string')) texts.set(this, parts.join(''));
			}
		};
		const fetch = window.fetch;
		window.fetch = (input, init) => {
			if (init?.keepalive && typeof init.body === 'string') {
				const left = read();
				const { mutations } = JSON.parse(init.body) as { mutations: { id: string }[] };
				const url = String(input);
				left.keepalive.push({ url, bytes: init.body.length, ids: mutations.map((m) => m.id) });
				write(left);
			}
			return fetch(input, init);
		};
		const sendBeacon = Navigator.prototype.sendBeacon;
		Navigator.prototype.sendBeacon = function (url, data) {
			const queued = sendBeacon.call(this, url, data);
			const left = read();
			const body = data instanceof NativeBlob ? (texts.get(data) ?? '') : String(data);
			left.beacons.push({ url: String(url), queued, body });
			write(left);
			return queued;
		};
	});

test.describe('leaving the workout page', () => {
	test.use({ serviceWorkers: 'block' });
	// Chromium only: the keepalive check is one of Playwright's Chromium-only checks (the plan).
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'the keepalive check is Chromium-only'
	);

	test('delivers a pending set by keepalive, at most 48 KB, beside the queued RUM beacon', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		const set = logOf(workoutId, 'back_squat', 1);
		await injectMutation(page, set);
		await recordLeaving(page);

		// The engine's first flush is held, so the set is still pending when the page is left.
		let held = 0;
		await page.route(`**${SYNC_URL}`, (route) => {
			if (++held > 1) return route.continue();
		});

		await page.goto('/workout');
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready', { timeout: 10_000 });
		await expect.poll(() => held).toBe(1);
		// TTFB and FCP are queued once RUM has started.
		await page.waitForFunction(() => performance.getEntriesByType('paint').length > 0);
		expect(await setRow(set.id)).toBeUndefined();

		await page.goto('/robots.txt');
		const left = await page.evaluate(() => JSON.parse(sessionStorage.getItem('left')!) as Left);
		const sync = left.keepalive.filter((k) => new URL(k.url, ORIGIN).pathname === SYNC_URL);
		expect(sync).toHaveLength(1);
		expect(sync[0]!.ids).toContain(set.id);
		expect(sync[0]!.bytes).toBeLessThanOrEqual(48 * 1024);
		const beacons = left.beacons.filter((b) => new URL(b.url, ORIGIN).pathname === '/api/vitals');
		expect(beacons.length).toBeGreaterThan(0);
		expect(beacons.every((b) => b.queued)).toBe(true);

		// Postgres has the set, and the beacon's metrics for the workout route.
		await expect.poll(() => setRow(set.id), { timeout: 10_000 }).toMatchObject({ reps: 5 });
		const ids = beacons.flatMap((b) => (JSON.parse(b.body) as { id: string }[]).map((m) => m.id));
		expect(ids.length).toBeGreaterThan(0);
		const routes = async () =>
			(
				await query<{ route_id: string }>(
					'select route_id from web_vitals where metric_id = any($1)',
					[ids]
				)
			).map((r) => r.route_id);
		await expect.poll(routes, { timeout: 10_000 }).toContain('/workout');
	});
});
