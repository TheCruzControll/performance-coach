/**
 * /workout paints the current exercise before the app starts, from the card this device kept
 * (src/lib/client/workout/prepaint.ts): with every script held, the card is there; let through,
 * the app's card replaces it where it stands. A workout finished or discarded never paints one.
 * The desktop layout is workout-prepaint.desktop.e2e.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import type { CanonicalWorkout } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import {
	expectCardBeforeTheApp,
	holdScripts,
	keptCard,
	reloadBeforeTheApp
} from './workout-prepaint-support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	readWorkout,
	seedWorkout,
	workoutDay
} from './workout-support';

/** The page before the app starts paints no card: only the skeleton, and no exercise's name. */
async function expectNoCardBeforeTheApp(page: Page) {
	const release = await reloadBeforeTheApp(page);
	await expect(page.getByTestId('workout-restoring').locator('.skeleton').first()).toBeVisible();
	await expect(page.locator('.prepaint')).toBeHidden();
	await expect(page.locator('.prepaint .card')).toHaveCount(0);
	await expect(page.getByText('Back squat')).toHaveCount(0);
	return release;
}

test.describe('the current exercise before the app starts', () => {
	// Scripts and the sync are held with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a reload paints the card this device kept before any script, and the app replaces it in place', async ({
		page
	}) => {
		await expectCardBeforeTheApp(page);
	});

	test("a reload asks for the workout's rows before any script, and the app reconciles from that answer", async ({
		page
	}) => {
		const { strength: kit } = await workoutDay();
		const workoutId = await seedWorkout(page, kit);
		// The stub never wrote it to Postgres: held, the server's 404 cannot drop it as lost.
		await page.route(`**/api/workouts/${workoutId}`, () => {});
		// Its start acknowledged, so nothing waits to be sent when the page loads again.
		await gotoWorkout(page, 'strength', { sync: 'stub' });
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect.poll(async () => (await readOutbox(page)).length).toBe(0);
		await expect.poll(() => keptCard(page)).not.toBeNull();

		// The server's rows: the workout was finished on another device.
		const { startedAt } = (await readWorkout(page, workoutId)) as { startedAt: string };
		const rows: CanonicalWorkout = {
			v: 1,
			workout: {
				id: workoutId,
				kind: kit.kind,
				title: kit.title,
				sessionType: kit.sessionType,
				discipline: kit.discipline,
				plannedSessionId: kit.plannedSessionId,
				plannedLineage: kit.plannedLineage,
				programId: kit.programId,
				status: 'completed',
				startedAt,
				finishedAt: new Date().toISOString(),
				notes: null,
				sessionRpe: null,
				durationSeconds: null,
				deletedAt: null
			},
			sets: [],
			substitutions: [],
			pain: [],
			run: null,
			other: null,
			exercises: {}
		};
		const gets: string[] = [];
		await page.route(`**/api/workouts/${workoutId}`, (route) => {
			gets.push(route.request().method());
			return route.fulfill({ json: rows });
		});

		// The inline script asks for them with the card: no script of the app has run yet.
		const release = await reloadBeforeTheApp(page);
		await expect.poll(() => gets).toEqual(['GET']);
		await expect(page.locator('main#main')).not.toHaveAttribute('data-ready');

		// The app's reconcile answers from that GET and sends none of its own.
		await release();
		await expect(page.locator('main#main[data-phase="completed"]')).toBeAttached();
		expect(gets).toEqual(['GET']);
	});

	test('a discarded workout never paints its card', async ({ page }) => {
		const kits = await workoutDay();
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect.poll(() => keptCard(page)).not.toBeNull();

		await page.getByTestId('workout-menu-button').click();
		const menu = page.getByTestId('workout-menu');
		await menu.getByTestId('menu-discard').click();
		await menu.getByTestId('confirm-discard').click();
		await expect(page.getByTestId('workout-empty')).toBeVisible();
		expect(await keptCard(page)).toBeNull();

		const release = await expectNoCardBeforeTheApp(page);
		await release();
		await expect(page.getByTestId('workout-empty')).toBeVisible();
	});

	test('a workout finished in another tab never paints its card', async ({ page }) => {
		const kits = await workoutDay();
		const workoutId = await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect.poll(() => keptCard(page)).not.toBeNull();

		const at = new Date().toISOString();
		await injectMutation(page, createMutation('workout.finish', { workoutId, at, payload: {} }));
		await expect(page.locator('main#main[data-phase="completed"]')).toBeAttached();
		expect(await keptCard(page)).toBeNull();

		const release = await expectNoCardBeforeTheApp(page);
		await release();
		await expect(page.locator('main#main[data-phase="completed"]')).toBeAttached();
	});

	test('a page that starts a workout paints no card', async ({ page }) => {
		const kits = await workoutDay();
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await expect.poll(() => keptCard(page)).not.toBeNull();

		const release = await holdScripts(page);
		await page.goto('/workout?new=other', { waitUntil: 'commit' });
		await expect(page.getByTestId('workout-restoring')).toBeAttached();
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await expect(page.locator('.prepaint')).toBeHidden();
		await expect(page.locator('.prepaint .card')).toHaveCount(0);
		await release();
	});
});
