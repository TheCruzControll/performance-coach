/**
 * The smoke specs' write guard (e2e/smoke/support.ts) catches a write the page sends after the
 * test body has finished, as a hydrated onMount would. A local spec, never a smoke one: it sends
 * a POST, which a deployed run must not.
 */
import { expect, test } from '@playwright/test';
import { QUIET_MS, test as smokeTest, watchWrites } from './smoke/support';

test.use({ storageState: { cookies: [], origins: [] } });

test('the smoke guard catches a POST the page sends after the test body returns', async ({
	page,
	baseURL
}) => {
	await page.goto('/api/health');
	const watch = watchWrites(page, new URL(baseURL!).origin);
	// Fired after the body would have returned; /api/health takes no POST, so nothing changes.
	await page.evaluate((delay) => {
		setTimeout(() => void fetch('/api/health', { method: 'POST' }), delay);
	}, QUIET_MS / 2);
	expect(await watch.settle()).toEqual(['POST /api/health']);
});

smokeTest(
	'a smoke page refuses a write through page.request or context.request',
	async ({ page }) => {
		expect(() => page.request.post('/api/health')).toThrow(/read-only: POST/);
		expect(() => page.context().request.delete('/api/health')).toThrow(/read-only: DELETE/);
	}
);
