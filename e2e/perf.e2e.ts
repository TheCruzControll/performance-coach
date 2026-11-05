import { expect, test } from '@playwright/test';

/**
 * Main-thread budget while a screen loads and hydrates, measured from real long tasks
 * (PerformanceObserver) under DevTools 4× CPU throttling: the sum of each task's time over
 * 50 ms, i.e. total blocking time, over load + 1.5 s. Median of 3 cold loads per screen.
 *
 * This is the tight CI regression guard for hydration cost: it measures real work, while
 * Lighthouse's TBT is a simulation (×4 of observed task time) that amplifies VM noise
 * (docs/performance.md).
 */
const BUDGET_MS = 200; // the TBT target
const LOADS = 3;
const SCREENS = ['/', '/today', '/train', '/progress', '/coach', '/profile'];

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');

	for (const path of SCREENS) {
		test(`${path} blocks the main thread ≤ ${BUDGET_MS} ms while loading`, async ({
			browser
		}, testInfo) => {
			const samples: number[] = [];
			for (let i = 0; i < LOADS; i++) {
				// A fresh context per load: cold caches, no service worker yet.
				const context = await browser.newContext(testInfo.project.use);
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
				await page.goto(path, { waitUntil: 'load' });
				await page.waitForTimeout(1_500);
				const tasks = await page.evaluate(
					() => (window as unknown as { __longTasks: number[] }).__longTasks
				);
				samples.push(tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
				await context.close();
			}
			samples.sort((a, b) => a - b);
			const median = samples[Math.floor(samples.length / 2)]!;
			testInfo.annotations.push({
				type: 'blocking time (ms)',
				description: `median ${Math.round(median)} · runs ${samples.map(Math.round).join(', ')}`
			});
			expect(median, `${path}: ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(
				BUDGET_MS
			);
		});
	}
});
