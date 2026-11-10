/**
 * Signing out with workout changes this device has not synced (the offline workout sync ADR,
 * 'Losing the session'): sign-out flushes first, then asks before it deletes what is left, on
 * Security and on the recovery screen; "Stay signed in" keeps every change. A signed-out URL
 * without sign-out's one-shot marker (typed, from history, the no-JavaScript sign-out) keeps the
 * unsynced changes until the owner deletes them.
 *
 * WebKit, the engine behind iOS Safari, where the owner signs out. Each signed-in case mints a
 * session of its own through the test-only route, so signing it out ends no other spec's session.
 * The service worker is blocked: on WebKit a routed request needs it (e2e/workout-support.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated, query, SAME_ORIGIN, signedOut } from './support';
import { readOutbox, seedWorkout, workoutDay } from './workout-support';

test.use({ storageState: signedOut, serviceWorkers: 'block' });

test.beforeEach(({ browserName }) => {
	test.skip(browserName !== 'webkit', 'the owner signs out on iOS Safari; WebKit covers it');
});

const databases = (page: Page) =>
	page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));

test('asks before deleting unsynced workout changes', async ({ page, context }) => {
	const minted = await context.request.post('/api/test-support/session', { headers: SAME_ORIGIN });
	expect(minted.status()).toBe(200);
	const { sessionId } = (await minted.json()) as { sessionId: string };
	const { strength } = await workoutDay();
	await seedWorkout(page, strength);
	// The flush never reaches the server: the change stays unsynced.
	await page.route('**/api/workouts/sync', (route) => route.abort());

	await gotoHydrated(page, '/profile/security');
	const sheet = page.getByTestId('signout-pending-sheet');
	await page.getByTestId('sign-out').click();
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText('1 workout change on this device hasn’t reached the server.');

	await page.getByTestId('signout-stay').click();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/profile\/security$/);
	expect(await databases(page)).toContain('pc-offline');
	expect(await readOutbox(page)).toHaveLength(1);

	// Another change arrives while the sheet is up: it asks again, with the new count.
	await page.getByTestId('sign-out').click();
	await expect(sheet).toContainText('1 workout change');
	await seedWorkout(page, strength);
	await page.getByTestId('signout-delete').click();
	await expect(sheet).toContainText('2 workout changes on this device haven’t reached the server.');
	expect(await readOutbox(page)).toHaveLength(2);

	await page.getByTestId('signout-delete').click();
	await expect(page).toHaveURL(/\/\?signedOut=1$/);
	await expect(page.getByTestId('signed-out-notice')).toBeVisible();
	expect(await databases(page)).toEqual([]);
	expect(
		await query('select revoked_reason from auth_sessions where id = $1', [sessionId])
	).toEqual([{ revoked_reason: 'signout' }]);
});

test('keeps unsynced changes on a signed-out URL without the marker', async ({ page }) => {
	// No session: the sign-in page sends a signed-in visitor away (src/routes/+page.server.ts).
	await seedWorkout(page, (await workoutDay()).strength);

	await page.goto('/?signedOut=1');
	await expect(page.getByTestId('signed-out-kept')).toBeVisible();
	await expect(page.getByTestId('signed-out-notice')).toHaveCount(0);
	expect(await databases(page)).toContain('pc-offline');
	expect(await readOutbox(page)).toHaveLength(1);

	await page.getByTestId('delete-kept').click();
	await expect(page.getByTestId('signed-out-kept')).toHaveCount(0);
	await expect.poll(() => databases(page)).toEqual([]);
});

test('the recovery screen asks too, after its sync is refused', async ({ page, context }) => {
	// A recovery session without burning a code: a test session given the columns
	// redeemRecoveryCode sets (as auth-screens.desktop.e2e.ts does). Its sync gets 403.
	const minted = await context.request.post('/api/test-support/session', { headers: SAME_ORIGIN });
	expect(minted.status()).toBe(200);
	const { sessionId } = (await minted.json()) as { sessionId: string };
	try {
		await query(
			`update auth_sessions
			 set kind = 'recovery', method = 'recovery',
			     expires_at = created_at + interval '15 minutes',
			     absolute_expires_at = created_at + interval '15 minutes'
			 where id = $1`,
			[sessionId]
		);
		await seedWorkout(page, (await workoutDay()).strength);

		await gotoHydrated(page, '/recover/passkey');
		const sheet = page.getByTestId('signout-pending-sheet');
		const [refused] = await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/workouts/sync')),
			page.getByTestId('recover-cancel').click()
		]);
		expect(refused.status()).toBe(403);
		await expect(sheet).toContainText('1 workout change on this device hasn’t reached the server.');

		await page.getByTestId('signout-stay').click();
		await expect(sheet).toBeHidden();
		await expect(page).toHaveURL(/\/recover\/passkey$/);
		expect(await readOutbox(page)).toHaveLength(1);

		await page.getByTestId('recover-cancel').click();
		await page.getByTestId('signout-delete').click();
		await expect(page).toHaveURL(/\/\?signedOut=1$/);
		expect(await databases(page)).toEqual([]);
	} finally {
		await query(
			`update auth_sessions set revoked_at = now(), revoked_reason = 'signout'
			 where id = $1 and revoked_at is null`,
			[sessionId]
		);
	}
});
