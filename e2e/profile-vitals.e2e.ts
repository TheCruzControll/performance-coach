/**
 * Profile → About this app → Speed says how opening the app, answering a tap and staying put felt
 * over the last 7 days, from the p75 web vitals (opening the app on the start route, the
 * manifest's start_url, /today), and how many launches that is. The desktop window:
 * profile-vitals.desktop.e2e.ts.
 */
import { test } from '@playwright/test';
import { gotoHydrated } from './support';
import { expectStartVitals, expectStartVitalsAxeClean, postStartVitals } from './vitals-support';

test('Speed answers its three questions from the p75 vitals, launches counted', async ({
	page
}) => {
	await postStartVitals(page);
	await gotoHydrated(page, '/profile/about/speed');
	await expectStartVitals(page);
	await expectStartVitalsAxeClean(page);
});
