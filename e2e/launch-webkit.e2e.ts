/**
 * WebKit's launch marks (performance council item 4). CPU throttling is CDP's, so the perf project
 * runs Chromium only, and nothing timed a launch on the engine behind iOS Safari. Here, on WebKit, a
 * device that holds a workout in progress (the shared kit fixture in IndexedDB) and an installed
 * service worker opens /workout in a new page LAUNCHES times, the previous page closed first. Each
 * launch reports, from the navigation's start, pc:logger-ready (Logger.svelte), pc:store-open
 * (Shell.svelte) and the first frame that shows Complete set enabled with the store open
 * (launch.ts usableAt).
 *
 * Unthrottled, and beside other specs (a main leg runs two workers), so the times are reported,
 * not gated: perf-launch.e2e.ts gates the launch at 4× CPU on Chromium. What it gates is that the
 * marks keep working on WebKit: the service worker serves the launch, both marks are set, and the
 * logger and the store come no later than the usable frame. Offline emulation does not reach
 * WebKit's worker, so the launch is online; /workout is precached and served cache-first. Nothing
 * is routed and the worker is not blocked (page.route misses a controlled page's requests there).
 */
import { expect, test } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { markAt, ms, usableAt } from './launch';
import { seedWorkout, workoutDay } from './workout-support';

const LAUNCHES = 3;

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

test('WebKit: a service-worker launch of /workout marks the logger and the store, then shows Complete set usable', async ({
	page,
	context,
	browserName
}, testInfo) => {
	test.skip(
		browserName === 'chromium',
		'Chromium launches are timed at 4× CPU: perf-launch.e2e.ts'
	);
	await page.goto('/workout');
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
		timeout: 15_000
	});
	await seedWorkout(page, kit);
	await page.close();

	const rows: string[] = [];
	for (let launch = 0; launch < LAUNCHES; launch++) {
		const current = await context.newPage();
		await current.goto('/workout', { waitUntil: 'commit' });
		const { at } = await usableAt(current);
		expect(
			await current.evaluate(() => navigator.serviceWorker.controller !== null),
			'the service worker serves the launch'
		).toBe(true);
		await expect(
			current.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 })
		).toHaveText(kit.exercises[0]!.exercise.name);
		const logger = await markAt(current, 'pc:logger-ready');
		const store = await markAt(current, 'pc:store-open');
		expect(logger, 'pc:logger-ready was marked').not.toBeNull();
		expect(store, 'pc:store-open was marked').not.toBeNull();
		expect(logger!, 'the logger, by the usable frame').toBeLessThanOrEqual(at);
		expect(store!, 'the store, by the usable frame').toBeLessThanOrEqual(at);
		rows.push(`usable ${ms(at)} (logger-ready ${ms(logger)}, store-open ${ms(store)})`);
		await current.close();
	}
	testInfo.annotations.push({
		type: 'WebKit launch (ms)',
		description: rows.map((r, i) => `launch ${i + 1}: ${r}`).join(' | ')
	});
});
