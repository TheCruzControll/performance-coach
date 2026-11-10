/**
 * The coach's states for the axe audit (e2e/a11y-suite.ts, run by a11y-dark.e2e.ts and
 * a11y-light.e2e.ts, every browser project): each case opens one designed state and leaves it on
 * screen. Coach slices add their states here, one entry each, so a11y-suite.ts keeps a single
 * import (M5 plan).
 */
import { expect, type Page } from '@playwright/test';
import { openWorkoutPanel } from './design-workout';
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
	},
	{
		name: '/design → Coach with a message typed in the focused composer, Thinking held still',
		open: async (page) => {
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await openCoachPanel(page);
			const ready = page.getByTestId('composer-ready');
			await ready.getByRole('textbox', { name: 'Message' }).fill('How is my bench going?');
			await expect(ready.getByRole('button', { name: 'Send' })).toBeEnabled();
			await expect(page.getByTestId('notice-provider')).toBeVisible();
		}
	},
	{
		name: '/design → Coach, a proposal card accepted, beside its other states',
		open: async (page) => {
			await openCoachPanel(page);
			const card = page.getByTestId('proposal-live');
			await card.getByRole('button', { name: 'Accept' }).click();
			await expect(card.getByTestId('proposal-version')).toBeVisible();
			await expect(page.getByTestId('proposal-superseded')).toContainText('Superseded');
		}
	},
	{
		name: '/design → Coach, a proposal card rejected, beside Couldn’t save, offline and revised',
		open: async (page) => {
			await openCoachPanel(page);
			const card = page.getByTestId('proposal-live');
			await card.getByRole('button', { name: 'Reject' }).click();
			await expect(card.getByTestId('proposal-state')).toContainText('Declined');
			await expect(page.getByTestId('proposal-failure')).toContainText('Couldn’t save');
			await expect(page.getByTestId('proposal-offline')).toBeVisible();
			await expect(page.getByTestId('proposal-revised')).toContainText('revised');
		}
	},
	{
		name: '/design → Workout, the exercise history sheet by exercise id alone, offline',
		open: async (page) => {
			const panel = await openWorkoutPanel(page);
			await page.context().setOffline(true);
			await panel.getByTestId('open-history-by-id').click();
			await expect(page.getByTestId('exercise-history-offline')).toContainText(
				'Exercise history needs a connection'
			);
		}
	},
	{
		name: '/coach/proposals, the Proposals inbox: empty, or the list',
		open: async (page) => {
			await gotoHydrated(page, '/coach/proposals');
			await expect(
				page.getByTestId('inbox-empty').or(page.getByTestId('filter-all'))
			).toBeVisible();
		}
	}
];
