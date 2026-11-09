/**
 * Add exercise on /workout (ExercisePicker.svelte, client/workout/library.ts), against the real
 * server:
 * - an ad-hoc strength session starts empty from the empty workout screen; its exercises come
 *   from the library cached on this device, offline too, and their sets land in Postgres with
 *   their exercise id and position once back online
 * - a planned workout adds an exercise after its plan and logs it; the search finds an alias
 *   ('RDL'); an added exercise with no sets is kept on this device across a reload
 * - an added exercise shows its last session inline once online, or 'No previous sets on this
 *   device' offline
 * - with no library on this device and offline, the picker says so; with the server unreachable,
 *   that it couldn't load
 * - axe in both themes, the screens, and the desktop dialog with its keyboard and hover.
 * A spec that fails a request with page.route blocks the service worker (WebKit's page.route
 * does not see a controlled page's requests). Serial: programs, workouts and the profile are the
 * one owner's.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { DB_NAME, LIBRARY_KEY, STORES } from '../src/lib/client/workout/names';
import type { Mutation, StrengthKit, SyncResponse } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ } from './program-support';
import { captureScreen, query, resetTrainingProfile, SAME_ORIGIN } from './support';
import { readOutbox } from './workout-support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const DAY = 24 * 60 * 60 * 1000;

const main = (page: Page) => page.getByTestId('workout-main');
const card = (page: Page) => main(page).getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const picker = (page: Page) => page.getByTestId('exercise-picker');
const search = (page: Page) => picker(page).getByTestId('picker-search');
const options = (page: Page) => picker(page).getByTestId('picker-option');
const logger = (page: Page) => page.getByTestId('set-logger');
const stepper = (page: Page, id: string) => logger(page).getByTestId(id).getByRole('spinbutton');

/** The id of the catalogue exercise with this key. */
async function exerciseId(key: string): Promise<string> {
	const [row] = await query<{ id: string }>(
		'select id from exercises where owner_id is null and key = $1',
		[key]
	);
	if (!row) throw new Error(`no catalogue exercise '${key}'`);
	return row.id;
}

/** Starts a strength session of the owner's own from the empty workout screen. */
async function startAdHocStrength(page: Page): Promise<string> {
	await page.goto('/workout');
	await page.getByTestId('workout-empty').getByRole('link', { name: 'Strength' }).click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(main(page).getByTestId('workout-no-exercises')).toBeVisible();
	const [entry] = await readOutbox(page);
	const id = entry?.envelope.workoutId;
	if (id) return id;
	// Already synced: the one workout in progress on this device.
	const [row] = await query<{ client_id: string }>(
		"select client_id from workouts where status = 'in_progress'"
	);
	return row!.client_id;
}

/** Opens the picker from the empty session's button or Up next's. */
async function openPicker(page: Page) {
	const first = main(page).getByTestId('add-first-exercise');
	await ((await first.isVisible()) ? first : main(page).getByTestId('add-exercise')).click();
	await expect(picker(page)).toBeVisible();
}

/** Opens the picker, searches, and adds the option named `name`. */
async function add(page: Page, text: string, name: string) {
	await openPicker(page);
	await search(page).fill(text);
	await options(page)
		.filter({ has: page.getByText(name, { exact: true }) })
		.click();
	await expect(picker(page)).toBeHidden();
	await expect(heading(page)).toHaveText(name);
}

/** Loads the picker's code online, so it opens offline as a device with it precached does. */
async function warmPicker(page: Page) {
	await openPicker(page);
	await expect(options(page).first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(picker(page)).toBeHidden();
}

async function enter(page: Page, id: string, value: string) {
	const field = stepper(page, id);
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

const setsOf = (workoutId: string) =>
	query<{ position: number; exercise_id: string; lineage: string | null; set_index: number }>(
		`select r.exercise_position as position, r.exercise_id, r.set_index,
		        r.planned_exercise_lineage_id::text as lineage
		   from set_records r join workouts w on w.id = r.workout_id
		  where w.client_id = $1 and r.deleted_at is null
		  order by r.exercise_position, r.set_index`,
		[workoutId]
	);

/** A finished ad-hoc workout yesterday with one set of `key`, through the real sync API. */
async function history(page: Page, key: string, weight: number, reps: number) {
	const workoutId = crypto.randomUUID();
	const at = (minutes: number) => new Date(Date.now() - DAY + minutes * 60_000).toISOString();
	const mutations: Mutation[] = [
		createMutation('workout.start', {
			workoutId,
			at: at(0),
			payload: {
				kind: 'strength',
				title: 'Legs',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		}),
		createMutation('set.log', {
			workoutId,
			at: at(5),
			payload: {
				position: 1,
				plannedLineage: null,
				setIndex: 1,
				exerciseId: await exerciseId(key),
				reps,
				seconds: null,
				metres: null,
				weight,
				assistance: null,
				unit: 'kg',
				rpe: 8,
				missedReps: 0,
				isWarmup: false,
				isExtra: false
			}
		}),
		createMutation('workout.finish', { workoutId, at: at(30), payload: {} })
	];
	const response = await page.request.post('/api/workouts/sync', {
		headers: SAME_ORIGIN,
		data: { v: 1, mutations }
	});
	expect(response.status()).toBe(200);
	const { results } = (await response.json()) as SyncResponse;
	expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
}

/** Whether this device holds the exercise library. */
const libraryCached = (page: Page) =>
	page.evaluate(
		async ({ name, store, key }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const get = db.transaction(store, 'readonly').objectStore(store).get(key);
			const found = await new Promise<boolean>((resolve) => {
				get.onsuccess = () => resolve(get.result !== undefined);
			});
			db.close();
			return found;
		},
		{ name: DB_NAME, store: STORES.library, key: LIBRARY_KEY }
	);

/** axe in the dark and the light theme, the page as it is. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
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

const offline = (context: BrowserContext, on: boolean) => context.setOffline(on);

test.describe('ad hoc', () => {
	test('a strength session of your own is built and logged offline, and syncs once back online', async ({
		page,
		context
	}, testInfo) => {
		const workoutId = await startAdHocStrength(page);
		await audit(page, 'the empty session');
		expect(await libraryCached(page)).toBe(true);
		await warmPicker(page);

		await offline(context, true);
		await openPicker(page);
		await search(page).fill('goblet');
		await expect(options(page).first()).toHaveText(/Goblet squat/);
		await captureScreen(page, testInfo, 'workout-add-exercise');
		await audit(page, 'the picker');
		await options(page).first().click();
		await expect(heading(page)).toHaveText('Goblet squat');
		await expect(card(page).getByTestId('exercise-previous')).toHaveText(
			'No previous sets on this device'
		);

		await enter(page, 'logger-load', '24');
		await enter(page, 'logger-amount', '10');
		await logger(page).getByTestId('complete-set').click();
		await expect(card(page).getByTestId('set')).toHaveCount(1);
		await logger(page).getByTestId('complete-set').click();
		await expect(card(page).getByTestId('set')).toHaveCount(2);
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(expect.arrayContaining(['set.log', 'set.log']));

		await offline(context, false);
		await synced(page);
		const goblet = await exerciseId('goblet_squat');
		expect(await setsOf(workoutId)).toEqual([
			{ position: 1, exercise_id: goblet, set_index: 1, lineage: null },
			{ position: 1, exercise_id: goblet, set_index: 2, lineage: null }
		]);
	});

	test('an added exercise shows its last session once online', async ({ page }) => {
		await history(page, 'goblet_squat', 24, 10);
		await startAdHocStrength(page);
		await add(page, 'goblet', 'Goblet squat');
		const previous = card(page).getByTestId('exercise-previous');
		await expect(previous).toContainText(/Last time · (yesterday|today|\d+ days ago)/);
		await expect(previous).toContainText('24 kg × 10');
	});

	test('an added exercise with no sets is kept on this device across a reload', async ({
		page
	}) => {
		await startAdHocStrength(page);
		await add(page, 'goblet', 'Goblet squat');
		await add(page, 'RDL', 'Romanian deadlift');
		// Device state only: nothing is sent for an exercise until its first set.
		expect((await readOutbox(page)).map((e) => e.envelope.type)).not.toContain('exercise.add');

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(card(page)).toContainText('Exercise 2 of 2');
		await main(page).getByTestId('exercise-prev').click();
		await expect(heading(page)).toHaveText('Goblet squat');
	});
});

test.describe('a planned workout', () => {
	test('adds an exercise after its plan and logs it', async ({ page, request }) => {
		const { workoutId, kit } = await startFromKit(page, request);
		const exercises = (kit as StrengthKit).exercises;
		const last = Math.max(...exercises.map((e) => e.position));
		await add(page, 'goblet', 'Goblet squat');
		await expect(card(page)).toContainText(
			`Exercise ${exercises.length + 1} of ${exercises.length + 1}`
		);
		await enter(page, 'logger-load', '20');
		await enter(page, 'logger-amount', '12');
		await logger(page).getByTestId('complete-set').click();
		await synced(page);
		const goblet = await exerciseId('goblet_squat');
		expect((await setsOf(workoutId)).filter((s) => s.exercise_id === goblet)).toEqual([
			{ position: last + 1, exercise_id: goblet, set_index: 1, lineage: null }
		]);
	});

	test('the search finds an exercise by its alias', async ({ page, request }) => {
		await startFromKit(page, request);
		await openPicker(page);
		await search(page).fill('RDL');
		await expect(options(page).first()).toHaveText(/^Romanian deadlift/);
		await search(page).fill('zzzz');
		await expect(picker(page).getByTestId('picker-none')).toContainText('No exercise matches');
	});
});

test.describe('with the library blocked', () => {
	test.use({ serviceWorkers: 'block' });

	test('the picker says it could not load, and offline that the list is not on this device', async ({
		page,
		context
	}, testInfo) => {
		await page.route('**/api/exercises', (route) => route.abort('internetdisconnected'));
		await startAdHocStrength(page);
		expect(await libraryCached(page)).toBe(false);

		await openPicker(page);
		await expect(picker(page).getByTestId('picker-failed')).toContainText(
			"Your exercise list couldn't load"
		);
		await page.keyboard.press('Escape');
		await expect(picker(page)).toBeHidden();

		await offline(context, true);
		await openPicker(page);
		const none = picker(page).getByTestId('picker-no-library');
		await expect(none).toContainText("Your exercise list isn't on this device yet");
		await expect(none).toContainText('Connect once to download it');
		await expect(none.getByRole('button', { name: 'Try again' })).toBeVisible();
		await captureScreen(page, testInfo, 'workout-add-exercise-no-library');
		await audit(page, 'no library');

		// Back online with the library reachable: Try again lists it.
		await offline(context, false);
		await page.unroute('**/api/exercises');
		await none.getByRole('button', { name: 'Try again' }).click();
		await expect(options(page).first()).toBeVisible();
	});
});

test.describe('desktop', () => {
	test.use(DESKTOP);

	test('the picker is a dialog: search and results by keyboard, with hover and focus states', async ({
		page,
		request
	}, testInfo) => {
		await startFromKit(page, request);
		const sideAdd = page.getByTestId('workout-side').getByTestId('side-add-exercise');
		await expect(sideAdd).toBeVisible();
		await sideAdd.click();
		const dialog = page.getByRole('dialog', { name: 'Add exercise' });
		await expect(dialog).toBeVisible();
		await expect(search(page)).toBeFocused();

		await page.keyboard.type('squat');
		await expect(options(page).first()).toBeVisible();
		const count = await options(page).count();
		expect(count).toBeGreaterThan(2);
		await page.keyboard.press('ArrowDown');
		await expect(options(page).first()).toBeFocused();
		await expect(options(page).first()).toHaveCSS('outline-style', 'solid');
		await page.keyboard.press('ArrowDown');
		await expect(options(page).nth(1)).toBeFocused();
		await page.keyboard.press('End');
		await expect(options(page).nth(count - 1)).toBeFocused();
		await page.keyboard.press('Home');
		await expect(options(page).first()).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(search(page)).toBeFocused();

		// Hover strengthens an option's border.
		const second = options(page).nth(1);
		const before = await second.evaluate((el) => getComputedStyle(el).borderTopColor);
		await second.hover();
		await expect
			.poll(() => second.evaluate((el) => getComputedStyle(el).borderTopColor))
			.not.toBe(before);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-add-exercise-desktop');

		// Enter in the search adds the first result.
		const first = (await options(page).first().locator('.name').textContent())!.trim();
		await search(page).focus();
		await page.keyboard.press('Enter');
		await expect(dialog).toBeHidden();
		await expect(heading(page)).toHaveText(first);
		await expect(page.getByTestId('workout-side').locator('[aria-current]')).toContainText(first);
	});
});
