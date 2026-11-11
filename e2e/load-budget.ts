import {
	expect,
	type Browser,
	type BrowserContextOptions,
	type Page,
	type TestInfo
} from '@playwright/test';

/**
 * Main-thread budget while a screen loads and hydrates, measured from real long tasks
 * (PerformanceObserver) under DevTools 4× CPU throttling: the sum of each task's time over
 * 50 ms, i.e. total blocking time, over load + 1.5 s. Median of 5 cold loads per screen.
 * perf.e2e.ts measures the app's screens with it, perf-workout-load.e2e.ts the workout screens,
 * perf-coach-load.e2e.ts the coach's and perf-progress-load.e2e.ts M6's.
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
 *
 * Screens measured with `maxShift` are also held to MAX_SHIFT: the sum of layout shifts no input
 * explains, on every load, so a streamed or lazy panel never pushes content once it has painted.
 */
export const TARGET_MS = 200;
export const GUARD_MS = 250;
const LOADS = 5;
const MAX_SHIFT = 0.01;

/** What a screen is measured on, once its data is seeded. */
export interface Seeded {
	url: string;
	restore: () => Promise<void>;
	/** Run in each fresh context before the load: what this device holds. */
	prepare?: (page: Page) => Promise<void>;
	/** The test id the loaded screen shows once it is in the state measured. */
	shows?: string;
	/** Each fresh context's options over the project's: the zone a fixture was seeded in. */
	context?: BrowserContextOptions;
}

/**
 * Loads `seeded.url` LOADS times, each in a fresh context, and expects the median blocking time
 * within GUARD_MS (and, with `maxShift`, every load's layout shift within MAX_SHIFT). Restores the
 * seeded state afterwards, pass or fail. `path` names the screen in the messages.
 */
export async function expectLoadBudget(
	path: string,
	{ url, restore, prepare, shows, context: options }: Seeded,
	{
		browser,
		testInfo,
		maxShift = false
	}: { browser: Browser; testInfo: TestInfo; maxShift?: boolean }
): Promise<void> {
	const samples: number[] = [];
	const shifts: number[] = [];
	try {
		for (let i = 0; i < LOADS; i++) {
			// A fresh context per load: cold caches, no service worker yet. Signed in (the
			// project's storage state), except for the sign-in screen, which only a signed-out
			// browser sees.
			const context = await browser.newContext({
				...testInfo.project.use,
				...(path === '/' ? { storageState: { cookies: [], origins: [] } } : {}),
				...options
			});
			const page = await context.newPage();
			await page.addInitScript(() => {
				const tasks: number[] = [];
				const shifts: number[] = [];
				Object.assign(window, { __longTasks: tasks, __shifts: shifts });
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) tasks.push(entry.duration);
				}).observe({ type: 'longtask', buffered: true });
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as (PerformanceEntry & {
						value: number;
						hadRecentInput: boolean;
					})[]) {
						if (!entry.hadRecentInput) shifts.push(entry.value);
					}
				}).observe({ type: 'layout-shift', buffered: true });
			});
			if (prepare) await prepare(page);
			const cdp = await context.newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await page.goto(url, { waitUntil: 'load' });
			await page.waitForTimeout(1_500);
			// Measured in the state it is listed under, not an empty or failed one.
			if (shows) await expect(page.getByTestId(shows).first()).toBeVisible();
			const observed = await page.evaluate(() => {
				const w = window as unknown as { __longTasks: number[]; __shifts: number[] };
				return { tasks: w.__longTasks, shifts: w.__shifts };
			});
			samples.push(observed.tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
			shifts.push(observed.shifts.reduce((sum, v) => sum + v, 0));
			await context.close();
		}
	} finally {
		await restore();
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)]!;
	const status = median <= TARGET_MS ? 'meets target' : `above the ${TARGET_MS} ms target`;
	testInfo.annotations.push({
		type: 'blocking time (ms)',
		description: `median ${Math.round(median)} (${status}) · runs ${samples.map(Math.round).join(', ')}`
	});
	expect(median, `${path}: ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(GUARD_MS);
	if (maxShift) {
		const worst = Math.max(...shifts);
		testInfo.annotations.push({
			type: 'layout shift',
			description: `worst ${worst.toFixed(4)} · runs ${shifts.map((s) => s.toFixed(4)).join(', ')}`
		});
		expect(worst, `${path}: layout shift on a load`).toBeLessThanOrEqual(MAX_SHIFT);
	}
}
