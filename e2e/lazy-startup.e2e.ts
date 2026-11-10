/**
 * The root layout's preference start loads after the first render (docs/performance.md): a
 * screen that shows units shows the saved ones even if it never loads. The toasts are in the
 * initial JS, so none waits on the network.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { gotoHydrated, toastWith } from './support';

// Every request reaches page.route: none is answered from the service worker's precache.
test.use({ serviceWorkers: 'block' });

/** Answers every JS request, handing those whose code matches `marker` to `handle`. */
async function onChunk(
	page: Page,
	marker: RegExp,
	handle: (route: Route, pass: () => Promise<void>) => Promise<void>
) {
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch();
		const body = await response.text();
		const pass = () => route.fulfill({ response, body });
		await (marker.test(body) ? handle(route, pass) : pass());
	});
}

// Progress formats on the server in the profile's units (M6), so only Today reads the device's.
test('Today shows the saved units when the preference start fails to load', async ({ page }) => {
	await page.addInitScript(() =>
		localStorage.setItem('pc:prefs:v1', '{"theme":"dark","units":"lb","distance":"mi"}')
	);
	await onChunk(page, /as startPreferences\}/, (route) => route.abort());

	await gotoHydrated(page, '/today');
	await expect(page.getByText('mi', { exact: true })).toBeVisible();
});

test('toasts need no network: one shown offline appears whole, and reconnecting neither repeats it nor stops the next', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		const inserted: string[] = [];
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (node instanceof Element && node.matches('.toaster .toast'))
						inserted.push(node.querySelector('.message')?.textContent ?? '');
		}).observe(document, { childList: true, subtree: true });
		Object.assign(window, { inserted });
	});

	await gotoHydrated(page, '/design');
	await page.getByRole('tab', { name: 'Feedback' }).click();
	const show = page.getByRole('button', { name: 'Toast', exact: true });
	await expect(show).toBeVisible();
	await context.setOffline(true);
	await show.click();
	const offline = toastWith(page, 'Set logged');
	await expect(offline.getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
	await expect(offline).toHaveCSS('animation-name', /toast-in/);

	await context.setOffline(false);
	await page.waitForTimeout(500);
	await expect(offline).toHaveCount(1);
	await page.getByRole('button', { name: 'Error toast', exact: true }).click();
	const next = toastWith(page, 'Sync failed');
	await expect(next.getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
	await expect(next.getByRole('button', { name: 'Retry' })).toBeVisible();
	await expect(offline).toHaveCount(0, { timeout: 10_000 });

	const inserted = await page.evaluate(
		() => (window as unknown as { inserted: string[] }).inserted
	);
	expect(inserted).toEqual(['Set logged · 140 kg × 5 @ 8', 'Sync failed — will retry']);
});

test('a real-user monitoring load that fails, as offline or after a deploy, is dropped without a page error', async ({
	page
}) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (err) => pageErrors.push(err.message));
	let failed = false;
	// Only vitals.ts posts to /api/vitals; the shell imports it once the page is idle.
	await onChunk(page, /["'`]\/api\/vitals["'`]/, (route) => {
		failed = true;
		return route.abort('internetdisconnected');
	});

	await gotoHydrated(page, '/today');
	await expect.poll(() => failed, { timeout: 10_000 }).toBe(true);
	await page.waitForTimeout(500); // an unhandled rejection surfaces after the failed fetch
	expect(pageErrors).toEqual([]);
});
