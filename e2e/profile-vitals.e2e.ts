/**
 * Profile's real-user performance card shows what opening the app costs: TTFB, LCP and INP at
 * p75 on the start route (the manifest's start_url, /today), beside the all-screens figures. The
 * desktop window: profile-vitals.desktop.e2e.ts.
 */
import { test } from '@playwright/test';
import { gotoHydrated } from './support';
import { expectStartVitals, expectStartVitalsAxeClean, postStartVitals } from './vitals-support';

test('profile shows TTFB, LCP and INP at p75 for opening the app', async ({ page }) => {
	await postStartVitals(page);
	await gotoHydrated(page, '/profile');
	await expectStartVitals(page);
	await expectStartVitalsAxeClean(page);
});
