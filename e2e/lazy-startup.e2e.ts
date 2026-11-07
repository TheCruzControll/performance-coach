/**
 * The toasts' code and the root layout's preference start load after the first render
 * (docs/performance.md). A toast shown before its code arrives still gets its whole time on
 * screen, and a screen that shows units shows the saved ones even if the preference start never
 * loads.
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

test('a toast shown while its code is held past its duration appears once, for its whole time', async ({
	page
}) => {
	await page.addInitScript(() => {
		const toasts = new Map<Element, { added: number; removed?: number }>();
		new MutationObserver(() => {
			const now = performance.now();
			const present = new Set(document.querySelectorAll('.toaster .toast'));
			for (const el of present) if (!toasts.has(el)) toasts.set(el, { added: now });
			for (const [el, t] of toasts) if (!present.has(el)) t.removed ??= now;
		}).observe(document, { childList: true, subtree: true });
		Object.assign(window, { toastTimes: () => [...toasts.values()] });
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let asked!: () => void;
	const requested = new Promise<void>((resolve) => (asked = resolve));
	await onChunk(page, /Dismiss notification/, async (_, pass) => {
		asked();
		await held;
		await pass();
	});

	// The held chunk delays the load event: wait for it to be asked for, after mount, instead.
	await page.goto('/design', { waitUntil: 'commit' });
	await requested;
	await page.getByRole('tab', { name: 'Feedback' }).click();
	await page.getByRole('button', { name: 'Toast', exact: true }).click();
	await page.waitForTimeout(5_000);
	release();

	const toast = toastWith(page, 'Set logged');
	await expect(toast).toBeVisible();
	await expect(toast).toHaveCount(0, { timeout: 10_000 });
	const times = await page.evaluate(() =>
		(window as unknown as { toastTimes: () => { added: number; removed: number }[] }).toastTimes()
	);
	const onScreen = times.map((t) => t.removed - t.added);
	expect(onScreen).toHaveLength(1);
	expect(Math.min(...onScreen)).toBeGreaterThanOrEqual(4_000);
});

test('Progress and Today show the saved units when the preference start fails to load', async ({
	page
}) => {
	await page.addInitScript(() =>
		localStorage.setItem('pc:prefs:v1', '{"theme":"dark","units":"lb","distance":"mi"}')
	);
	await onChunk(page, /as startPreferences\}/, (route) => route.abort());

	await gotoHydrated(page, '/progress');
	await expect(page.getByText('lb / wk', { exact: true })).toBeVisible();

	await gotoHydrated(page, '/today');
	await expect(page.getByText('mi', { exact: true })).toBeVisible();
});
