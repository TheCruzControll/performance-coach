/**
 * Profile → About this app → Speed in a desktop window (1440 × 900): Profile's columns, centred
 * right of the rail, with About open beside the list, and no side scroll.
 */
import { expect, test } from '@playwright/test';
import { expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { gotoHydrated } from './support';
import { expectStartVitals, expectStartVitalsAxeClean, postStartVitals } from './vitals-support';

test('Speed opens in Profile’s columns, About open beside it', async ({ page }) => {
	await postStartVitals(page);
	await gotoHydrated(page, '/profile/about/speed');
	await expectStartVitals(page);
	await expectMainCentred(page, await tokenPx(page, '--content-profile'));
	await expectNoSideScroll(page);
	const list = page.getByRole('navigation', { name: 'Profile' });
	await expect(list.getByTestId('about-link')).toHaveAttribute('aria-current', 'page');
	await expectStartVitalsAxeClean(page);
});
