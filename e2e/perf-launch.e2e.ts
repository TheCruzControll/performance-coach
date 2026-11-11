/**
 * Launch to a usable logger (performance council item 4): nothing else measures the time from the
 * launch to the moment a tap on Complete set shows the set done; perf-workout.e2e.ts starts its
 * clock once the store is open. A device that holds a workout in progress (the shared kit fixture,
 * seeded into IndexedDB) and an installed service worker is launched cold, offline, at 4× CPU, five
 * times: every page closed and the worker stopped (CDP ServiceWorker.stopAllWorkers), then a new
 * page opens /workout, which the worker serves from its precache. Each launch is timed from the
 * navigation's start (performance.now()'s origin) to the first frame that shows Complete set
 * enabled with the store open (data-store): before the store opens a tap is kept and replayed
 * (ActiveWorkout.write), but the row shows done only once it has. pc:logger-ready and
 * pc:store-open (Logger.svelte, Shell.svelte) are reported beside it.
 *
 * Gate: median of 5 ≤ LAUNCH_MS (1000 ms), the offline reviewer's target for this launch. No run of
 * this spec existed before it, so the number is the target, not a margin over a measurement;
 * every run annotates the five launches and the marks. A home-screen launch opens start_url,
 * /today, which needs the server: offline it shows the offline screen with Try again only, and
 * the logger is a navigation away (item 1). This spec launches /workout, where the workout lives
 * (a reload, a restored tab, the resume bar's link); perf-journey.e2e.ts measures /today's launch.
 * WebKit has no CDP: launch-webkit.e2e.ts reads the same marks there, unthrottled.
 */
import { expect, test } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { markAt, ms, usableAt } from './launch';
import { resetPrograms } from './program-support';
import { seedWorkout, workoutDay } from './workout-support';

/** The offline reviewer's target for an offline cold launch to a usable logger, at 4× CPU. */
const LAUNCH_MS = 1_000;
const LAUNCHES = 5;

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});
test.afterAll(() => resetPrograms());

test.describe('cold launch to a usable logger (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');

	test(`an offline cold launch of /workout, served by the service worker, is usable in ≤ ${LAUNCH_MS} ms (median of ${LAUNCHES})`, async ({
		page,
		context
	}, testInfo) => {
		test.setTimeout(120_000);
		// The device: the worker installed and in control, the workout in progress in IndexedDB.
		await page.goto('/workout');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await seedWorkout(page, kit);
		await page.close();
		await context.setOffline(true);

		const usable: number[] = [];
		const rows: string[] = [];
		try {
			for (let launch = 0; launch < LAUNCHES; launch++) {
				const current = await context.newPage();
				const cdp = await context.newCDPSession(current);
				// A launch starts the worker too: stop it, as the OS does to an app in the background.
				await cdp.send('ServiceWorker.enable');
				await cdp.send('ServiceWorker.stopAllWorkers');
				await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
				await current.goto('/workout', { waitUntil: 'commit' });
				const { at } = await usableAt(current);
				const controlled = await current.evaluate(
					() => navigator.serviceWorker.controller !== null
				);
				expect(controlled, 'the service worker serves the launch').toBe(true);
				// The workout in progress, restored from the device.
				await expect(
					current.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', {
						level: 2
					})
				).toHaveText(kit.exercises[0]!.exercise.name);
				const logger = await markAt(current, 'pc:logger-ready');
				const store = await markAt(current, 'pc:store-open');
				expect(logger, 'pc:logger-ready was marked').not.toBeNull();
				expect(store, 'pc:store-open was marked').not.toBeNull();
				usable.push(at);
				rows.push(`usable ${ms(at)} (logger-ready ${ms(logger)}, store-open ${ms(store)})`);
				await current.close();
			}
		} finally {
			await context.setOffline(false);
		}

		const sorted = [...usable].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)]!;
		testInfo.annotations.push({
			type: 'offline cold launch to usable (ms)',
			description: `median ${Math.round(median)} · ${rows.map((r, i) => `launch ${i + 1}: ${r}`).join(' | ')}`
		});
		expect(median, `launch to usable: ${usable.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(
			LAUNCH_MS
		);
	});
});
