/**
 * The brief's journeys 2 and 3 end to end, with exact Postgres counts after each phase (brief
 * acceptance 2): sets logged, edited and deleted offline survive a reload, reconnecting syncs them
 * once with their final values, replays (from the outbox or straight through the API) create no
 * duplicates, two tabs logging alternately share every set, and a failed sync recovers: a 500
 * then a pass, an answer lost after the commit, and a refused change discarded with nothing left.
 *
 * The reload offline needs the service worker's precache, and Playwright emulates offline for
 * service-worker traffic only in Chromium, so that step runs there alone; WebKit runs everything
 * else with the worker blocked (its page.route does not see a controlled page's requests, and its
 * offline emulation does not reach the worker). Each test asserts only its own workout's rows,
 * by client id. Serial: it writes workouts of the one owner.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SYNC_URL } from '../src/lib/client/workout/sync';
import type {
	Mutation,
	MutationPayloads,
	StrengthKit,
	SyncRequest,
	SyncResponse
} from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { query, SAME_ORIGIN } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	seedWorkout,
	workoutDay
} from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	const { strength } = await workoutDay();
	// Ad hoc: the fixture's planned session is not in this database.
	kit = { ...strength, plannedLineage: null, plannedSessionId: null, programId: null };
	kit.exercises = kit.exercises.map((e) => ({ ...e, plannedLineage: null }));
});

/** Pages whose HTML holds the owner's data: never in Cache Storage. */
const DYNAMIC_PAGES = ['/', '/today', '/train', '/progress', '/profile', '/coach'];
/** The build under test's prerendered pages (the same HTML for everyone). */
const PRERENDERED = path.resolve(import.meta.dirname, '../.svelte-kit/output/prerendered/pages');
type ManifestChunk = { file: string; css?: string[]; imports?: string[] };
const EDITOR = 'src/routes/workout/SetEditor.svelte';
/**
 * The set editor's lazy chunk and every stylesheet Vite's preload waits for before importing it
 * (its own and, recursively, its imports'), from the client build's Vite manifest.
 */
function editorAssets() {
	const manifest = JSON.parse(
		readFileSync(
			path.resolve(import.meta.dirname, '../.svelte-kit/output/client/.vite/manifest.json'),
			'utf8'
		)
	) as Record<string, ManifestChunk>;
	const css = new Set<string>();
	const seen = new Set<string>();
	const walk = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		const chunk = manifest[key]!;
		for (const file of chunk.css ?? []) css.add(`/${file}`);
		for (const imported of chunk.imports ?? []) walk(imported);
	};
	walk(EDITOR);
	return { js: `/${manifest[EDITOR]!.file}`, css: [...css] };
}

const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');
const editor = (page: Page) => page.getByTestId('set-editor');
const pill = (page: Page) => page.getByTestId('sync-pill');
const issue = (page: Page) => page.getByTestId('sync-sheet').getByTestId('sync-issue');
const complete = (page: Page) => logger(page).getByTestId('complete-set').click();
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
const editSet = (page: Page, index: number) =>
	rows(page)
		.nth(index)
		.getByRole('button', { name: /^Edit set/ })
		.click();

interface SetRow {
	id: string;
	set_index: number;
	reps: number | null;
	weight: number | null;
	deleted: boolean;
}

/** Every set row Postgres holds for the workout with this client id, deleted ones included. */
const setsOf = (workoutId: string) =>
	query<SetRow>(
		`select r.client_mutation_id as id, r.set_index, r.reps, r.weight::float8 as weight,
		        r.deleted_at is not null as deleted
		   from set_records r join workouts w on w.id = r.workout_id
		  where w.client_id = $1
		  order by r.exercise_position, r.set_index, r.client_mutation_id`,
		[workoutId]
	);

const workoutCount = async (workoutId: string) =>
	(
		await query<{ n: number }>('select count(*)::int as n from workouts where client_id = $1', [
			workoutId
		])
	)[0]!.n;

/** The outbox's mutations of one type, in order. */
async function queued<T extends Mutation['type']>(page: Page, type: T) {
	return (await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: T }> => m.type === type);
}

/** Opens /workout against the real server, the store connected. */
async function open(page: Page) {
	await gotoWorkout(page, 'strength', { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

/** A seeded workout whose start has synced, open on the page: its client id. */
async function syncedWorkout(page: Page) {
	const workoutId = await seedWorkout(page, kit);
	await open(page);
	await synced(page);
	expect(await workoutCount(workoutId)).toBe(1);
	return workoutId;
}

/** Every HTML document in Cache Storage, by path and query. */
const cachedHtml = (page: Page) =>
	page.evaluate(async () => {
		const found: string[] = [];
		for (const key of await caches.keys()) {
			const cache = await caches.open(key);
			for (const request of await cache.keys()) {
				const response = await cache.match(request);
				if (!response?.headers.get('content-type')?.includes('text/html')) continue;
				const url = new URL(request.url);
				found.push(url.pathname + url.search);
			}
		}
		return found;
	});

/** The prerendered pages' paths ('/workout' for workout.html, '/' for index.html). */
function prerenderedPaths(dir = PRERENDERED, prefix = ''): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory())
			return prerenderedPaths(path.join(dir, entry.name), `${prefix}/${entry.name}`);
		if (!entry.name.endsWith('.html')) return [];
		const name = entry.name.slice(0, -'.html'.length);
		return [name === 'index' ? prefix || '/' : `${prefix}/${name}`];
	});
}

test.describe('journey 2: offline logging, reconnect sync and replays', () => {
	// Chromium keeps its service worker for the reload offline; WebKit blocks it (see the header).
	test.use({
		serviceWorkers: async ({ browserName }, use) =>
			use(browserName === 'chromium' ? 'allow' : 'block')
	});

	test('four sets logged offline, one edited and one deleted: they survive a reload, sync once with the final values, and every replay is a duplicate', async ({
		page,
		context,
		browserName
	}) => {
		// Several waits of up to 15 s each: the default 30 s is too tight on a slow CI leg.
		test.slow();
		const workoutId = await syncedWorkout(page);
		const withWorker = browserName === 'chromium';
		if (withWorker) {
			await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
				timeout: 15_000
			});
		}

		// The editor is fetched on a row's first intent; without the worker's precache (WebKit) that
		// fetch would fail offline. Vite's preload first waits for the editor's stylesheets and skips
		// one only when a <link rel=stylesheet> for it is already in the document, so link each and
		// await its load, then import the chunk so the app's import resolves from the module map.
		await page.evaluate(async ({ js, css }) => {
			for (const href of css) {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = href;
				const loaded = new Promise((resolve, reject) => {
					link.addEventListener('load', resolve);
					link.addEventListener('error', () => reject(new Error(`stylesheet ${href} failed`)));
				});
				document.head.append(link);
				await loaded;
			}
			await import(js);
		}, editorAssets());

		// 1. Offline mid-workout: four sets, set 2 edited to 4 reps, set 4 deleted.
		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		for (let set = 0; set < 4; set += 1) await complete(page);
		await expect(rows(page)).toHaveCount(4);
		for (let set = 0; set < 4; set += 1) {
			await expect(rows(page).nth(set)).toHaveAttribute('data-state', 'done');
		}
		await editSet(page, 1);
		const amount = editor(page).getByTestId('edit-amount').getByRole('spinbutton');
		await amount.click();
		await amount.fill('4');
		await amount.press('Enter');
		await editor(page).getByTestId('save-set').click();
		await expect(editor(page)).toBeHidden();
		await expect(rows(page).nth(1)).toContainText('× 4 reps');
		await editSet(page, 3);
		await editor(page).getByTestId('delete-set').click();
		await editor(page).getByTestId('confirm-delete').click();
		await expect(editor(page)).toBeHidden();
		await expect(rows(page).nth(3)).not.toHaveAttribute('data-state', 'done');

		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['set.log', 'set.log', 'set.log', 'set.log', 'set.edit', 'set.delete']);
		await expect(pill(page)).toHaveText('Offline · 6 pending');
		const batch = (await readOutbox(page)).map((e) => e.envelope);
		const logs = await queued(page, 'set.log');
		expect(logs).toHaveLength(4);
		expect(await setsOf(workoutId), 'nothing reaches Postgres offline').toEqual([]);

		// 2. A reload offline: the precached shell serves /workout, with every set.
		if (withWorker) {
			await page.reload();
			await expect(page.locator('main#main[data-store]')).toBeAttached();
			for (let set = 0; set < 3; set += 1) {
				await expect(rows(page).nth(set)).toHaveAttribute('data-state', 'done');
			}
			await expect(rows(page).nth(1)).toContainText('× 4 reps');
			await expect(rows(page).nth(3)).not.toHaveAttribute('data-state', 'done');
			expect((await readOutbox(page)).map((e) => e.envelope)).toEqual(batch);
		}

		// 3. Online: the outbox empties, one row per set, with the final values.
		await context.setOffline(false);
		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		const expected: SetRow[] = logs.map((log, i) => ({
			id: log.entityId,
			set_index: i + 1,
			reps: i === 1 ? 4 : log.payload.reps,
			weight: log.payload.weight,
			deleted: i === 3
		}));
		expect(await setsOf(workoutId)).toEqual(expected);
		expect(await workoutCount(workoutId)).toBe(1);

		// 4. An already-synced mutation back in the outbox: answered, removed, still one row.
		await injectMutation(page, logs[0]!);
		await synced(page);
		expect(await setsOf(workoutId)).toEqual(expected);

		// 5. The same batch straight through the API: every result is a duplicate.
		const response = await page.request.post(SYNC_URL, {
			headers: SAME_ORIGIN,
			data: { v: 1, mutations: batch } satisfies SyncRequest
		});
		expect(response.status()).toBe(200);
		const { results } = (await response.json()) as SyncResponse;
		expect(results.map((r) => [r.id, r.status])).toEqual(batch.map((m) => [m.id, 'duplicate']));
		expect(await setsOf(workoutId)).toEqual(expected);

		// 7. Cache Storage holds no dynamic HTML, after the app's pages were opened.
		if (withWorker) {
			for (const visit of ['/today', '/profile', '/workout']) await page.goto(visit);
			await expect(page.locator('main#main[data-ready]')).toBeAttached();
			const html = await cachedHtml(page);
			const prerendered = prerenderedPaths();
			expect(html).toContain('/workout');
			expect(prerendered).toContain('/workout');
			expect(
				html.filter((p) => !prerendered.includes(p)),
				'only prerendered HTML'
			).toEqual([]);
			for (const dynamic of DYNAMIC_PAGES) expect(html).not.toContain(dynamic);
		}
	});

	test('two tabs logging alternately: one row per set, and both tabs show every set', async ({
		page,
		context
	}) => {
		const workoutId = await syncedWorkout(page);
		const other = await context.newPage();
		await open(other);
		const tabs = [page, other, page, other];

		for (const [i, tab] of tabs.entries()) {
			// The tab about to log has seen the set before it, from the other tab.
			if (i > 0) await expect(rows(tab).nth(i - 1)).toHaveAttribute('data-state', 'done');
			await expect(logger(tab)).toContainText(`Set ${i + 1} of 4`);
			await complete(tab);
			await expect(rows(tab).nth(i)).toHaveAttribute('data-state', 'done');
		}
		for (const tab of [page, other]) {
			for (let set = 0; set < 4; set += 1) {
				await expect(rows(tab).nth(set)).toHaveAttribute('data-state', 'done');
			}
		}

		await synced(page);
		await synced(other);
		const sets = await setsOf(workoutId);
		expect(sets.map((s) => [s.set_index, s.deleted])).toEqual([
			[1, false],
			[2, false],
			[3, false],
			[4, false]
		]);
		expect(new Set(sets.map((s) => s.id)).size).toBe(4);
		await other.close();
	});
});

const SQUAT = 'back_squat';
const refused = (workoutId: string) => {
	const slot = kit.exercises.find((e) => e.exercise.key === SQUAT)!;
	return createMutation('set.log', {
		workoutId,
		at: new Date().toISOString(),
		payload: {
			position: slot.position,
			exerciseId: slot.exercise.id,
			plannedLineage: null,
			setIndex: 1,
			reps: 5,
			seconds: null,
			metres: null,
			weight: 1001,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		} satisfies MutationPayloads['set.log']
	});
};

test.describe('journey 3: a failed sync recovers', () => {
	// page.route fails and drops answers: on WebKit only without a service worker.
	test.use({ serviceWorkers: 'block' });

	test('the sync answers 500, then 200: retried, and the sets land once', async ({ page }) => {
		let sent = 0;
		await page.route(`**${SYNC_URL}`, (route) =>
			++sent <= 2
				? route.fulfill({ status: 500, json: { error: 'unavailable' } })
				: route.continue()
		);
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await complete(page);
		await complete(page);
		await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'done');

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(sent).toBeGreaterThanOrEqual(3);
		expect(await workoutCount(workoutId)).toBe(1);
		expect((await setsOf(workoutId)).map((s) => [s.set_index, s.deleted])).toEqual([
			[1, false],
			[2, false]
		]);
	});

	test('an answer lost after the server committed: answered duplicate on the resend, one row', async ({
		page
	}) => {
		const workoutId = await syncedWorkout(page);
		const answers: string[][] = [];
		await page.route(`**${SYNC_URL}`, async (route) => {
			const response = await route.fetch();
			const { results } = (await response.json()) as SyncResponse;
			answers.push(results.map((r) => r.status));
			return answers.length === 1 ? route.abort() : route.fulfill({ response });
		});
		await complete(page);

		await synced(page);
		expect(answers).toEqual([['applied'], ['duplicate']]);
		expect((await setsOf(workoutId)).map((s) => [s.set_index, s.deleted])).toEqual([[1, false]]);
	});

	test('a permanently invalid change is shown with its reason, then discarded: nothing in Postgres', async ({
		page
	}) => {
		const workoutId = await syncedWorkout(page);
		const bad = refused(workoutId);
		await injectMutation(page, bad);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await expect(issue(page)).toHaveCount(1);
		await expect(issue(page)).toContainText('Weight: Up to 1000 kg');
		await issue(page).getByTestId('discard-change').click();
		await issue(page).getByTestId('confirm-discard').click();

		await expect(issue(page)).toHaveCount(0);
		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(await setsOf(workoutId)).toEqual([]);
		await expect
			.poll(() => query('select type from sync_mutations where mutation_id = $1', [bad.id]))
			.toEqual([{ type: 'discarded' }]);
	});
});
