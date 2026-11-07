/**
 * The coach's states for the axe audit (e2e/a11y.e2e.ts, both themes, every browser project):
 * each case opens one designed state and leaves it on screen. Coach slices add their states here,
 * one entry each, so a11y.e2e.ts keeps a single import (M5 plan).
 */
import { expect, type Page } from '@playwright/test';
import { gotoHydrated } from './support';

export interface CoachA11yCase {
	name: string;
	/** Open the state; the audit runs on whatever is then on screen. */
	open: (page: Page) => Promise<void>;
}

/** /design → Coach, its code loaded (the tabs only switch once the page has hydrated). */
export async function openCoachPanel(page: Page): Promise<void> {
	await gotoHydrated(page, '/design');
	await page.getByRole('tab', { name: 'Coach' }).click();
	await expect(page.getByRole('heading', { name: 'Untrusted text' })).toBeVisible();
}

export const COACH_A11Y: readonly CoachA11yCase[] = [
	{ name: '/design → Coach, every answer state', open: openCoachPanel },
	{
		name: '/design → Coach with a method open, every block shown and an answer streamed',
		open: async (page) => {
			await openCoachPanel(page);
			await page.getByText('How it’s calculated').first().click();
			await page.getByTestId('show-all-blocks').click();
			const next = page.getByTestId('stream-next');
			while ((await next.textContent())?.trim() !== 'Start again') await next.click();
			await expect(page.getByTestId('answer-streaming').getByTestId('answer-block')).toHaveCount(6);
		}
	}
];
