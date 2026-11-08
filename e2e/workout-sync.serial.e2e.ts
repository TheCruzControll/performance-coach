/**
 * The workout's sync status, Fix and Discard, and a lost session, against the real server (sync
 * 'real'): transient failures retry and land once; a refusal or a change that keeps failing is
 * shown in words with Fix, Try again and Discard; a 401 leaves no workout details and loses no
 * change; a recovery session keeps everything. Each test asserts only its own workout's rows, by
 * client id. Serial: the session tests mint and revoke sessions of the one owner.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { SYNC_URL } from '../src/lib/client/workout/sync';
import type { MutationPayloads, StrengthKit, SyncRequest } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP } from './desktop';
import { captureScreen, query, SAME_ORIGIN, signedOut } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	readWorkout,
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

const SQUAT = 'back_squat';
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

const logOf = (
	workoutId: string,
	setIndex: number,
	over: Partial<MutationPayloads['set.log']> = {}
) => {
	const slot = kit.exercises.find((e) => e.exercise.key === SQUAT)!;
	return createMutation('set.log', {
		workoutId,
		at: new Date().toISOString(),
		payload: {
			position: slot.position,
			exerciseId: slot.exercise.id,
			plannedLineage: null,
			setIndex,
			...DONE,
			...over
		}
	});
};

/** The rows Postgres holds for these set client ids: one per id that landed. */
const rowsOf = async (ids: string[]) =>
	query<{ id: string; weight: number | null }>(
		'select client_mutation_id as id, weight::float8 as weight from set_records where client_mutation_id = any($1)',
		[ids]
	);

const workoutRow = async (clientId: string) =>
	(
		await query<{ planned_session_id: string | null }>(
			'select planned_session_id from workouts where client_id = $1',
			[clientId]
		)
	)[0];

const pill = (page: Page) => page.getByTestId('sync-pill');
const sheet = (page: Page) => page.getByTestId('sync-sheet');
const issue = (page: Page) => sheet(page).getByTestId('sync-issue');
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

/** Opens the workout page against the real server, the store connected. */
async function open(page: Page) {
	await gotoWorkout(page, 'strength', { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

/** axe in both themes: the page as it is, then in the light theme. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		// The colours ease to the new theme: axe reads them once they have settled.
		await page.waitForFunction(() =>
			document
				.getAnimations()
				.every(
					(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
				)
		);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** Every text the pill showed, in order: a state that lasts a moment is still seen. */
const recordPill = (page: Page) =>
	page.addInitScript(() => {
		const seen: string[] = [];
		Object.assign(window, { __pill: seen });
		new MutationObserver(() => {
			const text = document.querySelector('[data-testid="sync-pill"]')?.textContent?.trim();
			if (text && seen.at(-1) !== text) seen.push(text);
		}).observe(document, { subtree: true, childList: true, characterData: true });
	});
const pillTexts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __pill: string[] }).__pill);

const idsOf = (route: Route) =>
	(route.request().postDataJSON() as SyncRequest).mutations.map((m) => m.id);

/** A workout whose start has synced, open on the page. */
async function syncedWorkout(page: Page) {
	const workoutId = await seedWorkout(page, kit);
	await open(page);
	await synced(page);
	return workoutId;
}

test.describe('the workout sync status', () => {
	// page.route holds, fails and rewrites requests: on WebKit only without a service worker.
	test.use({ serviceWorkers: 'block' });

	test('a 500 twice, then a pass: Retrying, then Saved, and one row per set', async ({ page }) => {
		await recordPill(page);
		let sent = 0;
		await page.route(`**${SYNC_URL}`, (route) =>
			++sent <= 2
				? route.fulfill({ status: 500, json: { error: 'unavailable' } })
				: route.continue()
		);
		const workoutId = await seedWorkout(page, kit);
		const set = logOf(workoutId, 1);
		await injectMutation(page, set);

		await open(page);
		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(sent).toBe(3);
		expect(await pillTexts(page)).toContainEqual(expect.stringMatching(/^Retrying in \d+ s$/));
		expect(await rowsOf([set.id])).toHaveLength(1);
	});

	test('an answer lost after the server committed: resent, answered duplicate, one row', async ({
		page
	}) => {
		const answers: string[][] = [];
		await page.route(`**${SYNC_URL}`, async (route) => {
			const response = await route.fetch();
			const { results } = (await response.json()) as { results: { status: string }[] };
			answers.push(results.map((r) => r.status));
			return answers.length === 1 ? route.abort() : route.fulfill({ response });
		});
		const workoutId = await seedWorkout(page, kit);
		const set = logOf(workoutId, 1);
		await injectMutation(page, set);

		await open(page);
		await synced(page);
		expect(answers).toEqual([
			['applied', 'applied'],
			['duplicate', 'duplicate']
		]);
		expect(await rowsOf([set.id])).toHaveLength(1);
		await expect(pill(page)).toHaveText('Saved');
	});

	test('a set the server refuses needs attention; the sheet says why; Discard, confirmed, removes it for good', async ({
		page
	}, testInfo) => {
		const workoutId = await syncedWorkout(page);
		const bad = logOf(workoutId, 1, { weight: 1001 });
		await injectMutation(page, bad);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await expect(issue(page)).toHaveCount(1);
		await expect(issue(page)).toContainText('Set 1 of Back squat · 1,001 kg × 5');
		await expect(issue(page)).toContainText('Weight: Up to 1000 kg');
		await captureScreen(page, testInfo, 'workout-sync-error');
		await audit(page, 'the sheet');

		await issue(page).getByTestId('discard-change').click();
		await expect(issue(page)).toContainText('Discard this change? Discard removes the set.');
		await audit(page, 'the confirmation');
		await issue(page).getByTestId('confirm-discard').click();

		await expect(issue(page)).toHaveCount(0);
		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		await expect(page.getByTestId('workout-main').getByTestId('set').first()).not.toContainText(
			'1,001'
		);
		// The discarded id reached the server, so no request still carrying it can land it.
		await expect
			.poll(() => query('select type from sync_mutations where mutation_id = $1', [bad.id]))
			.toEqual([{ type: 'discarded' }]);
		expect(await rowsOf([bad.id])).toEqual([]);
	});

	test('a refused set, fixed in the set editor: re-queued under its id, one row with the fix', async ({
		page
	}) => {
		const workoutId = await syncedWorkout(page);
		const bad = logOf(workoutId, 1, { weight: 1001 });
		await injectMutation(page, bad);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await issue(page).getByTestId('fix-change').click();
		const editor = page.getByTestId('set-editor');
		await expect(editor.getByTestId('fix-reason')).toHaveText('Not synced · Weight: Up to 1000 kg');
		const load = editor.getByTestId('edit-load').getByRole('spinbutton');
		await load.click();
		await load.fill('100');
		await load.press('Enter');
		await editor.getByTestId('save-set').click();

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(await rowsOf([bad.id])).toEqual([{ id: bad.id, weight: 100 }]);
	});

	test('a start refused for a planned session that does not exist lands, with its set, kept unplanned', async ({
		page
	}) => {
		const planned = {
			...kit,
			plannedSessionId: crypto.randomUUID(),
			plannedLineage: crypto.randomUUID(),
			programId: crypto.randomUUID()
		};
		const workoutId = await seedWorkout(page, planned);
		const set = logOf(workoutId, 1);
		await injectMutation(page, set);
		await open(page);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await expect(issue(page)).toContainText(`Workout started · ${kit.title}`);
		await expect(issue(page)).toContainText('Planned session: No such planned session');
		await issue(page)
			.getByRole('button', { name: 'Keep it as a session not linked to the plan' })
			.click();

		await synced(page);
		expect(await workoutRow(workoutId)).toEqual({ planned_session_id: null });
		expect(await rowsOf([set.id])).toHaveLength(1);
		const [start] = await query<{ id: string }>(
			'select mutation_id as id from sync_mutations where mutation_id = $1',
			[workoutId]
		);
		expect(start).toEqual({ id: workoutId }); // the same id, re-queued
	});

	test('a change answered retry for ever is parked after the cap; Try again re-sends it; Discard removes it', async ({
		page
	}, testInfo) => {
		await page.clock.install();
		const workoutId = await syncedWorkout(page);
		const stuck = logOf(workoutId, 1);
		let tries = 0;
		await page.route(`**${SYNC_URL}`, (route) => {
			if (!idsOf(route).includes(stuck.id)) return route.continue();
			tries += 1;
			return route.fulfill({
				json: { v: 1, results: [{ id: stuck.id, status: 'retry', code: 'unavailable' }] }
			});
		});
		await injectMutation(page, stuck);
		await expect.poll(() => tries).toBeGreaterThan(0);

		await page.clock.fastForward('24:00:01');
		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await expect(issue(page)).toContainText("Couldn't sync for a day: the server is busy");
		await captureScreen(page, testInfo, 'workout-sync-stuck');
		await audit(page, 'a stuck change');

		const before = tries;
		await issue(page).getByTestId('try-again').click();
		await expect.poll(() => tries).toBeGreaterThan(before);
		await expect(sheet(page).getByTestId('sync-pending')).toHaveText([
			'Set 1 of Back squat · 100 kg × 5'
		]);

		await page.clock.fastForward('24:00:01');
		await expect(issue(page).getByTestId('discard-change')).toBeVisible();
		await issue(page).getByTestId('discard-change').click();
		await issue(page).getByTestId('confirm-discard').click();
		await synced(page);
		expect(await rowsOf([stuck.id])).toEqual([]);
	});

	test('a first request that never answers is aborted at 15 s and retried; it and a set logged meanwhile land once', async ({
		page
	}) => {
		await page.clock.install();
		let held = 0;
		let sent = 0;
		await page.route(`**${SYNC_URL}`, (route) => {
			sent += 1;
			if (++held === 1) return; // no answer, ever
			return route.continue();
		});
		const workoutId = await seedWorkout(page, kit);
		const first = logOf(workoutId, 1);
		await injectMutation(page, first);
		await open(page);
		await expect.poll(() => sent).toBe(1);

		const meanwhile = logOf(workoutId, 2);
		await injectMutation(page, meanwhile);
		await page.clock.fastForward(15_000);
		await page.clock.fastForward(2_000);

		await synced(page);
		expect(sent).toBe(2);
		expect((await rowsOf([first.id, meanwhile.id])).map((r) => r.id).sort()).toEqual(
			[first.id, meanwhile.id].sort()
		);
	});

	test('offline: Offline · N pending, in words, then Saved once back', async ({
		page,
		context
	}, testInfo) => {
		const workoutId = await syncedWorkout(page);
		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		await injectMutation(page, logOf(workoutId, 1));
		await injectMutation(page, logOf(workoutId, 2));

		await expect(pill(page)).toHaveText('Offline · 2 pending');
		await captureScreen(page, testInfo, 'workout-offline');
		await audit(page, 'offline');

		await context.setOffline(false);
		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
	});
});

/** A session for this browser context alone, minted by the test-only route: its id. */
async function mintSession(page: Page): Promise<string> {
	const res = await page.request.post('/api/test-support/session', { headers: SAME_ORIGIN });
	expect(res.status()).toBe(200);
	return ((await res.json()) as { sessionId: string }).sessionId;
}

/** Writes copies of what the server holds, as Today and History leave them on the device. */
async function seedServerCopies(page: Page) {
	await page.evaluate(
		async ({ name, stores, kit }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const tx = db.transaction([stores.kits, stores.library, stores.workouts], 'readwrite');
			tx.objectStore(stores.kits).put({ lineage: crypto.randomUUID(), kit, savedAt: Date.now() });
			tx.objectStore(stores.library).put({
				id: 'exercises',
				digest: 'test',
				exercises: [],
				savedAt: Date.now()
			});
			const finishedAt = new Date().toISOString();
			tx.objectStore(stores.workouts).put({
				id: crypto.randomUUID(),
				kind: 'strength',
				title: 'Yesterday',
				startedAt: finishedAt,
				status: 'completed',
				finishedAt,
				kit,
				canonical: null,
				device: {}
			});
			await new Promise((resolve) => (tx.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, stores: STORES, kit }
	);
}

const countOf = (page: Page, store: string) =>
	page.evaluate(
		async ({ name, store }) => {
			const db = await new Promise<IDBDatabase>((resolve) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
			});
			const count = db.transaction(store, 'readonly').objectStore(store).count();
			const n = await new Promise<number>(
				(resolve) => (count.onsuccess = () => resolve(count.result))
			);
			db.close();
			return n;
		},
		{ name: DB_NAME, store }
	);

test.describe('losing the session', () => {
	test.use({ storageState: signedOut, serviceWorkers: 'block' });

	test('a 401 leaves no workout details and no server copies, keeps both changes, and a sign-in brings it back', async ({
		page
	}, testInfo) => {
		const session = await mintSession(page);
		const workoutId = await syncedWorkout(page);
		await expect(page.getByTestId('workout-header')).toContainText(kit.title);
		await seedServerCopies(page);

		await query(
			"update auth_sessions set revoked_at = now(), revoked_reason = 'test' where id = $1",
			[session]
		);
		const sets = [logOf(workoutId, 1), logOf(workoutId, 2)];
		for (const set of sets) await injectMutation(page, set);

		await expect(page.getByTestId('workout-signed-out')).toContainText('Signed out on this device');
		await expect(page.getByTestId('workout-signed-out')).toContainText('2 changes waiting');
		await expect(pill(page)).toHaveText('Sign in to sync · 2 waiting');
		const main = page.locator('main#main');
		await expect(main).not.toContainText(kit.title);
		await expect(main).not.toContainText('Back squat');
		await captureScreen(page, testInfo, 'workout-signed-out');
		await audit(page, 'signed out');

		expect(await countOf(page, STORES.kits)).toBe(0);
		expect(await countOf(page, STORES.library)).toBe(0);
		expect(await countOf(page, STORES.workouts)).toBe(1);
		expect(await readWorkout(page, workoutId)).toMatchObject({ kit: null, canonical: null });
		expect((await readOutbox(page)).map((e) => e.envelope.id)).toEqual(sets.map((s) => s.id));
		expect(await rowsOf(sets.map((s) => s.id))).toEqual([]);

		// Signing in again: the changes sync, and the workout is rebuilt from the server.
		await mintSession(page);
		await page.reload();
		await synced(page);
		await expect(page.getByTestId('workout-header')).toContainText(kit.title);
		await expect(pill(page)).toHaveText('Saved');
		expect(await rowsOf(sets.map((s) => s.id))).toHaveLength(2);
	});

	const revoke = (session: string) =>
		query("update auth_sessions set revoked_at = now(), revoked_reason = 'test' where id = $1", [
			session
		]);

	test('a 401 closes an open sync sheet and its Fix editor', async ({ page }) => {
		const session = await mintSession(page);
		const workoutId = await syncedWorkout(page);
		await injectMutation(page, logOf(workoutId, 1, { weight: 1001 }));
		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		await issue(page).getByTestId('fix-change').click();
		const editor = page.getByTestId('set-editor');
		await expect(editor).toBeVisible();

		await revoke(session);
		await injectMutation(page, logOf(workoutId, 2));

		await expect(page.getByTestId('workout-signed-out')).toContainText('2 changes waiting');
		await expect(editor).toBeHidden();
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator('body')).not.toContainText('Back squat');
	});

	test('a page reloaded after a 401 shows no workout details while the server is out of reach', async ({
		page
	}) => {
		const session = await mintSession(page);
		await seedWorkout(page, kit); // its start not sent yet
		await revoke(session);
		await open(page);
		await expect(page.getByTestId('workout-signed-out')).toContainText('1 change waiting');

		await page.route('**/api/workouts/**', (route) => route.abort());
		// Never shown, not even before the sync engine loads.
		await page.addInitScript((title) => {
			new MutationObserver(() => {
				if (document.querySelector('main')?.textContent?.includes(title)) {
					Object.assign(window, { __shown: true });
				}
			}).observe(document, { subtree: true, childList: true, characterData: true });
		}, kit.title);
		await page.reload();

		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(page.getByTestId('workout-signed-out')).toContainText('1 change waiting');
		await expect(page.locator('main#main')).not.toContainText(kit.title);
		expect(await page.evaluate(() => '__shown' in window)).toBe(false);
	});

	test('a recovery session: Finish adding your passkey, and nothing is deleted', async ({
		page
	}) => {
		const session = await mintSession(page);
		await query("update auth_sessions set kind = 'recovery' where id = $1", [session]);
		const workoutId = await seedWorkout(page, kit);
		await open(page);

		await expect(pill(page)).toHaveText('Finish adding your passkey');
		await pill(page).click();
		await expect(sheet(page)).toContainText('Add a passkey');
		await audit(page, 'a recovery session');
		expect(await readOutbox(page)).toHaveLength(1);
		expect(await readWorkout(page, workoutId)).toMatchObject({ kit: { title: kit.title } });
		await expect(page.getByTestId('workout-signed-out')).toHaveCount(0);
	});
});

test.describe('on a desktop window', () => {
	test.use({ ...DESKTOP, serviceWorkers: 'block' });

	test('the pill has hover and focus states, and the sheet is a dialog: focus moves in, Escape closes, focus returns', async ({
		page
	}, testInfo) => {
		const workoutId = await syncedWorkout(page);
		await injectMutation(page, logOf(workoutId, 1, { weight: 1001 }));
		await expect(pill(page)).toHaveText('1 needs attention');

		const face = pill(page).locator('.pill');
		const background = () => face.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await pill(page).hover();
		await expect.poll(background).not.toBe(resting);
		await page.mouse.move(0, 0);

		await page.locator('main#main').focus();
		for (
			let i = 0;
			i < 10 && !(await pill(page).evaluate((el) => el === document.activeElement));
			i++
		) {
			await page.keyboard.press('Tab');
		}
		await expect(pill(page)).toBeFocused();
		expect(await face.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		const box = (await pill(page).boundingBox())!;
		expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);

		await page.keyboard.press('Enter');
		await expect(sheet(page)).toBeVisible();
		await expect
			.poll(() => sheet(page).evaluate((dialog) => dialog.contains(document.activeElement)))
			.toBe(true);
		await captureScreen(page, testInfo, 'workout-sync-error-desktop');
		const fix = issue(page).getByTestId('fix-change');
		await fix.focus();
		expect(await fix.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(pill(page)).toBeFocused();
	});
});
