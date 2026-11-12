/**
 * Profile's start-route vitals in a desktop window (1440 × 900): inside the real-user
 * performance card of the centred two-column layout, the three tiles on one row.
 */
import { expect, test } from '@playwright/test';
import { expectMainCentred, expectNoSideScroll } from './desktop';
import { gotoHydrated } from './support';
import { expectStartVitals, expectStartVitalsAxeClean, postStartVitals } from './vitals-support';

test('profile shows the start-route vitals on one row in the centred layout', async ({ page }) => {
	await postStartVitals(page);
	await gotoHydrated(page, '/profile');
	const start = await expectStartVitals(page);
	await expectMainCentred(page);
	await expectNoSideScroll(page);
	const tops = await start
		.getByRole('listitem')
		.evaluateAll((items) => items.map((i) => Math.round(i.getBoundingClientRect().top)));
	expect(tops).toHaveLength(3);
	expect(new Set(tops).size).toBe(1);
	await expectStartVitalsAxeClean(page);
});
