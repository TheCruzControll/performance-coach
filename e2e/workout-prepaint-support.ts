/**
 * /workout's current exercise, painted before the app starts (src/lib/client/workout/prepaint.ts):
 * helpers for workout-prepaint.e2e.ts and its desktop spec. Every JavaScript request is held, so
 * what the page shows is the server's HTML, its stylesheets and the inline script alone. A held
 * request is a page.route: on WebKit, use these with `serviceWorkers: 'block'`.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { PREPAINT_KEY } from '../src/lib/client/workout/prepaint';
import { boxOf, layoutShiftDuring } from './desktop';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

/** Holds every script of the app until the returned function lets them through. */
export async function holdScripts(page: Page): Promise<() => Promise<void>> {
	const held: Route[] = [];
	let holding = true;
	await page.route('**/_app/immutable/**/*.js', (route) =>
		holding ? void held.push(route) : route.fallback()
	);
	return async () => {
		holding = false;
		for (const route of held.splice(0)) await route.fallback();
	};
}

/** What this device keeps for the next load, or null. */
export const keptCard = (page: Page) =>
	page.evaluate((key) => localStorage.getItem(key), PREPAINT_KEY);

/** Reloads with every script held: the page as it stands before the app starts. */
export async function reloadBeforeTheApp(page: Page): Promise<() => Promise<void>> {
	const release = await holdScripts(page);
	await page.reload({ waitUntil: 'commit' });
	await expect(page.getByTestId('workout-restoring')).toBeAttached();
	// Fonts are not held; WebKit settles document.fonts.ready only after the load event.
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	return release;
}

/** The prepainted card's parts, and the hydrated card's same parts. */
function parts(page: Page) {
	const prepaint = page.locator('.prepaint');
	const card = page.getByTestId('exercise');
	return {
		prepaint: {
			card: prepaint.locator('.card'),
			name: prepaint.locator('h2'),
			options: prepaint.locator('.btn'),
			lines: prepaint.locator('.lines'),
			previous: prepaint.locator('.previous'),
			rows: prepaint.locator('.sets > li')
		},
		hydrated: {
			card,
			name: card.locator('#exercise-name'),
			options: card.getByTestId('exercise-actions'),
			lines: card.getByTestId('exercise-target').locator('.lines'),
			previous: card.getByTestId('exercise-previous'),
			rows: card.getByTestId('set')
		}
	};
}

type Part = Exclude<keyof ReturnType<typeof parts>['prepaint'], 'rows'>;
const PARTS: Part[] = ['card', 'name', 'options', 'lines', 'previous'];

async function boxesOf(locators: Locator[]) {
	const boxes = [];
	for (const locator of locators) boxes.push(await boxOf(locator));
	return boxes;
}

/**
 * A strength workout seeded and opened once (so the view keeps its card), then reloaded with
 * every script held: the card is painted from what the device kept, with no script of the app,
 * in the skeleton's place. Let through, the app starts and its card replaces the painted one
 * where it stands: every part's box within 1 px, and nothing on the page moves.
 */
export async function expectCardBeforeTheApp(page: Page): Promise<void> {
	const kits = await workoutDay();
	await seedWorkout(page, kits.strength);
	await gotoWorkout(page);
	await expect(page.getByTestId('exercise')).toBeVisible();
	await expect.poll(() => keptCard(page)).not.toBeNull();

	const release = await reloadBeforeTheApp(page);
	const { prepaint, hydrated } = parts(page);
	await expect(prepaint.card).toBeVisible();
	await expect(prepaint.name).toHaveText('Back squat');
	await expect(page.locator('.prepaint .place')).toHaveText(/^Exercise 1 of \d+$/);
	await expect(prepaint.rows.first()).toHaveAttribute('data-state', 'current');
	// No script of the app has run: the page is still the server's, restoring.
	await expect(page.locator('main#main')).not.toHaveAttribute('data-ready');
	await expect(hydrated.card).toHaveCount(0);
	await expect(page.getByTestId('workout-restoring').locator('.skeleton')).toHaveCount(3);
	await expect(page.getByTestId('workout-restoring').locator('.skeleton').first()).toBeHidden();

	const rows = await prepaint.rows.count();
	const header = page.getByTestId('workout-header');
	const before = await boxesOf([
		header,
		...PARTS.map((p) => prepaint[p]),
		...(await prepaint.rows.all())
	]);
	const start = async () => {
		await release();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(hydrated.card).toBeVisible();
	};
	// Chromium reports layout shifts (WebKit does not: there the boxes below decide). Not
	// expectNoShift: it waits for the network to go idle, and the sync stays held here.
	if (page.context().browser()?.browserType().name() === 'chromium') {
		const shift = await layoutShiftDuring(page, start);
		expect(shift, 'layout shift as the app starts').toBeLessThanOrEqual(0.01);
	} else {
		await start();
	}
	await expect(page.locator('.prepaint')).toHaveCount(0);
	await expect(hydrated.rows).toHaveCount(rows);
	const after = await boxesOf([
		header,
		...PARTS.map((p) => hydrated[p]),
		...(await hydrated.rows.all())
	]);
	const names = ['header', ...PARTS, ...Array.from({ length: rows }, (_, i) => `set ${i + 1}`)];
	const moved = names.flatMap((name, i) =>
		(['x', 'y', 'width', 'height'] as const)
			.filter((key) => Math.abs(after[i]![key] - before[i]![key]) > 1)
			.map((key) => `${name}: ${key} ${before[i]![key]} → ${after[i]![key]}`)
	);
	expect(moved, 'the hydrated card replaces the painted one where it stands').toEqual([]);
}
