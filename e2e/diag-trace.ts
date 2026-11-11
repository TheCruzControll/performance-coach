/**
 * TEMPORARY diagnostics (reverted once read): a Chrome trace of a measured window, attached to the
 * test, so CI shows what its main thread did.
 */
import type { Page, TestInfo } from '@playwright/test';

const CATEGORIES = [
	'devtools.timeline',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'disabled-by-default-v8.cpu_profiler',
	'v8.execute',
	'blink.user_timing',
	'toplevel',
	'latencyInfo',
	'benchmark',
	'cc',
	'viz',
	'gpu'
];

export async function traced<T>(
	page: Page,
	testInfo: TestInfo,
	name: string,
	work: () => Promise<T>
): Promise<T> {
	const cdp = await page.context().newCDPSession(page);
	const events: unknown[] = [];
	cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
	await cdp.send('Tracing.start', {
		transferMode: 'ReportEvents',
		traceConfig: { includedCategories: CATEGORIES, excludedCategories: ['*'] }
	});
	await page.evaluate((mark) => performance.mark(mark), `diag:${name}`);
	try {
		return await work();
	} finally {
		const origin = await page.evaluate((mark) => {
			const m = performance.getEntriesByName(mark, 'mark')[0];
			return {
				now: performance.now(),
				mark: m?.startTime ?? null,
				timeOrigin: performance.timeOrigin
			};
		}, `diag:${name}`);
		const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
		await cdp.send('Tracing.end');
		await done;
		await testInfo.attach(`trace ${name}`, {
			body: JSON.stringify({ origin, traceEvents: events }),
			contentType: 'application/json'
		});
		await cdp.detach().catch(() => {});
	}
}
