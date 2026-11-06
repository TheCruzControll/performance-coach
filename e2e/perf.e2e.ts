import { expect, test } from '@playwright/test';
import { resetPrograms, seedProgram } from './program-support';

/**
 * Main-thread budget while a screen loads and hydrates, measured from real long tasks
 * (PerformanceObserver) under DevTools 4× CPU throttling: the sum of each task's time over
 * 50 ms, i.e. total blocking time, over load + 1.5 s. Median of 5 cold loads per screen.
 *
 * This is the CI regression guard for hydration cost: it measures real work, while
 * Lighthouse's TBT is a simulation (×4 of observed task time) that amplifies VM noise
 * (docs/performance.md).
 *
 * Two numbers, deliberately separate:
 * - TARGET_MS is the product target (Lighthouse's "good" TBT). Every run reports the median
 *   against it; screens above it are listed in docs/performance.md as open work.
 * - GUARD_MS fails the build. It sits above today's measured medians (≤ ~175 ms, with
 *   single loads up to ~260 ms on a 4-vCPU VM) so it catches real regressions without failing
 *   on scheduler noise. Lower it as screens get cheaper; never raise it without a measured
 *   reason recorded in docs/performance.md.
 */
const TARGET_MS = 200;
const GUARD_MS = 250;
const LOADS = 5;
/** The hybrid fixture's week-1 strength session, whose lineage is known once it is seeded. */
const STRENGTH_SESSION = '/train/session/<strength>';
const SCREENS = [
	'/',
	'/today',
	'/train',
	STRENGTH_SESSION,
	'/progress',
	'/coach',
	'/profile',
	'/profile/security',
	'/profile/equipment'
];

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(() => resetPrograms());

	for (const path of SCREENS) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			// Train is measured in its program state: a hybrid week, strength, runs and Muay Thai;
			// the session screen on that week's strength session, its longest.
			let url = path;
			if (path === '/train' || path === STRENGTH_SESSION) {
				const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
				const strength = seeded.sessions.find((s) => s.title === 'Full body');
				if (path === STRENGTH_SESSION) url = `/train/session/${strength!.lineage}`;
			}
			const samples: number[] = [];
			for (let i = 0; i < LOADS; i++) {
				// A fresh context per load: cold caches, no service worker yet. Signed in (the
				// project's storage state), except for the sign-in screen, which only a signed-out
				// browser sees.
				const context = await browser.newContext(
					path === '/'
						? { ...testInfo.project.use, storageState: { cookies: [], origins: [] } }
						: testInfo.project.use
				);
				const page = await context.newPage();
				await page.addInitScript(() => {
					const tasks: number[] = [];
					Object.assign(window, { __longTasks: tasks });
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries()) tasks.push(entry.duration);
					}).observe({ type: 'longtask', buffered: true });
				});
				const cdp = await context.newCDPSession(page);
				await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
				await page.goto(url, { waitUntil: 'load' });
				await page.waitForTimeout(1_500);
				const tasks = await page.evaluate(
					() => (window as unknown as { __longTasks: number[] }).__longTasks
				);
				samples.push(tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
				await context.close();
			}
			samples.sort((a, b) => a - b);
			const median = samples[Math.floor(samples.length / 2)]!;
			const status = median <= TARGET_MS ? 'meets target' : `above the ${TARGET_MS} ms target`;
			testInfo.annotations.push({
				type: 'blocking time (ms)',
				description: `median ${Math.round(median)} (${status}) · runs ${samples.map(Math.round).join(', ')}`
			});
			expect(median, `${path}: ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(
				GUARD_MS
			);
		});
	}
});
