/**
 * M2 acceptance 6 on WebKit, the engine behind iOS Safari: signing out clears everything this
 * device holds for the account (the session cookie, every Cache Storage entry except the
 * versioned app shell, every IndexedDB database, the tab's session storage) and keeps device
 * preferences.
 *
 * Chromium proves the same after a real passkey sign-in (auth.e2e.ts). WebKit has no virtual
 * authenticator, so this device's session is minted by the test-only route for this test alone:
 * signing it out must not end the shared session the other WebKit specs run on.
 */
import { expect, test } from '@playwright/test';
import { ORIGIN, query, SAME_ORIGIN, signedOut } from './support';

test.use({ storageState: signedOut });

test('WebKit: sign-out clears the cookie, account caches and IndexedDB, keeps preferences', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName !== 'webkit', 'Chromium runs this after a real passkey sign-in');
	// The context's request client shares the browser's cookie jar: the page is now signed in.
	const minted = await context.request.post('/api/test-support/session', { headers: SAME_ORIGIN });
	expect(minted.status()).toBe(200);
	const { sessionId } = (await minted.json()) as { sessionId: string };

	const storedTheme = () =>
		page.evaluate(() => JSON.parse(localStorage.getItem('pc:prefs:v1') ?? '{}').theme);
	await page.goto('/profile');
	await page.waitForLoadState('networkidle'); // hydrated: a tap before then changes nothing
	await page.getByTestId('theme-control').getByRole('radio', { name: 'Light' }).click();
	await expect.poll(storedTheme).toBe('light'); // a device preference, kept by sign-out
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
		timeout: 15_000
	});
	// Account data a device can hold: cached responses, the offline store (M4), tab scratch state.
	await page.evaluate(async () => {
		sessionStorage.setItem('pc:scratch', 'draft');
		const cache = await caches.open('pc-account-data');
		await cache.put('/api/private', new Response('{"secret":true}'));
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open('pc-offline', 1);
			open.onupgradeneeded = () => open.result.createObjectStore('sets');
			open.onsuccess = () => {
				open.result.close();
				resolve();
			};
			open.onerror = () => reject(open.error);
		});
	});
	const before = await page.evaluate(async () => ({
		caches: await caches.keys(),
		databases: (await indexedDB.databases()).map((d) => d.name)
	}));
	expect(before.caches).toContain('pc-account-data');
	expect(before.caches.some((k) => k.startsWith('pc-shell-'))).toBe(true);
	expect(before.databases).toContain('pc-offline');

	await page.goto('/profile/security');
	await page.waitForLoadState('networkidle'); // hydrated: the button signs out through the client
	const [response] = await Promise.all([
		page.waitForResponse((r) => r.url().endsWith('/api/auth/signout')),
		page.getByTestId('sign-out').click()
	]);
	expect(response.status()).toBe(200);
	expect((await response.allHeaders())['clear-site-data']).toBe('"cache"');
	await expect(page).toHaveURL(/\/\?signedOut=1$/);
	await expect(page.getByTestId('signed-out-notice')).toBeVisible();

	const cookies = await context.cookies(ORIGIN);
	expect(cookies.filter((c) => /session$/.test(c.name))).toEqual([]);
	// Leaving the page lets SvelteKit write its history keys back into session storage; the
	// sign-in page clears it again once it hydrates (src/routes/+page.svelte), so wait for that.
	await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0);
	const left = await page.evaluate(async () => ({
		caches: await caches.keys(),
		databases: (await indexedDB.databases()).map((d) => d.name)
	}));
	expect(left.caches.every((k) => k.startsWith('pc-shell-'))).toBe(true);
	expect(left.caches).toHaveLength(1); // the versioned app shell survives (offline still works)
	expect(left.databases).toEqual([]);
	expect(await storedTheme()).toBe('light');
	expect(
		await query('select revoked_reason from auth_sessions where id = $1', [sessionId])
	).toEqual([{ revoked_reason: 'signout' }]);

	await page.goto('/today');
	await expect(page).toHaveURL(/\/\?next=%2Ftoday$/);
});
