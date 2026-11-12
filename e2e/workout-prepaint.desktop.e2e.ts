/**
 * /workout's current exercise before the app starts, in a desktop window (1440 × 900): the card
 * this device kept is painted where the view's main column puts it, beside the side list's empty
 * place, and the app's card replaces it there (workout-prepaint.e2e.ts has the rest).
 */
import { test } from '@playwright/test';
import { expectCardBeforeTheApp } from './workout-prepaint-support';

test.describe('the current exercise before the app starts, on a desktop', () => {
	// Scripts and the sync are held with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a reload paints the card in the main column before any script, and the app replaces it in place', async ({
		page
	}) => {
		await expectCardBeforeTheApp(page);
	});
});
