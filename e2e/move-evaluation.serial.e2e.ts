/**
 * The Move sheet judged with M7's rules (m7/23 move-evaluation), seeded with the
 * periodisation-week fixture: next week the owner moved Lower A from Friday to Monday, the day
 * before Tuesday's hard Muay Thai. Opening Move on Lower A lists, under the days, each day a move
 * would bring a clash to as one calm line whose reason opens in a native <details>, and Friday,
 * the day the scheduler would move it back to, reads 'Clears this week’s clash'. A move onto a
 * warned day still saves, and Train then shows its heads-up. axe is clean in both themes with the
 * sheet open, at 393 × 659 and in a 1440 × 900 window.
 *
 * Serial: the program is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { shortDate } from '../src/lib/ui/program/words';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, toastWith } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

type Seeded = SeededAnalytics & { mondays: { moved: string } };

/** The fixture's owner-move week, by its number in the program. */
const MOVED_WEEK = 3;
const WEDNESDAY_LINE = 'Wed · Heavy lower body the day before hard Muay Thai';
const CLEARS = 'Clears this week’s clash';

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Move session' });
const day = (page: Page, date: string) =>
	sheet(page).getByRole('radio', { name: new RegExp(`^${shortDate(date)}\\b`) });
const headsUps = (page: Page) => sheet(page).getByTestId('move-day-warnings');
const wednesdayLine = (page: Page) =>
	headsUps(page).locator('details').filter({ hasText: WEDNESDAY_LINE });

let seeded: Seeded;

/** Lower A's session screen, with its Move sheet open on the days it can reach. */
async function openMove(page: Page) {
	await gotoHydrated(page, `/train/session/${seeded.lineages.moved}`);
	await page.getByTestId('move-session').click();
	await expect(sheet(page).getByRole('radio').first()).toBeVisible();
}

test.describe('moving the owner’s Lower A', () => {
	test.beforeAll(async ({ request }) => {
		seeded = (await seedAnalytics(request, 'periodisation-week')) as Seeded;
	});

	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('each day says what a move there would clash with, and Friday clears the week’s clash', async ({
		page
	}, testInfo) => {
		await openMove(page);
		const monday = seeded.mondays.moved;
		await expect(wednesdayLine(page).locator('summary')).toHaveText(WEDNESDAY_LINE);
		// Friday, where the scheduler would put it back, reads the clash it clears.
		await expect(day(page, addDays(monday, 4)).locator('xpath=..')).toContainText(CLEARS);
		await expect(day(page, addDays(monday, 2)).locator('xpath=..')).not.toContainText(CLEARS);

		const why = wednesdayLine(page).getByText('tire the legs for a day or more', { exact: false });
		await expect(why).toBeHidden();
		await wednesdayLine(page).locator('summary').click();
		await expect(why).toBeVisible();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Move sheet with each day’s heads-up');
		await captureScreen(page, testInfo, 'move-evaluation-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the heads-ups open with the keyboard, with hover and focus states', async ({
			page
		}, testInfo) => {
			await openMove(page);
			const summary = wednesdayLine(page).locator('summary');
			await expect(summary).toHaveText(WEDNESDAY_LINE);
			const colour = () => summary.evaluate((el) => getComputedStyle(el).color);
			const quiet = await colour();
			await summary.hover();
			await expect.poll(colour).not.toBe(quiet);
			await summary.focus();
			await page.keyboard.press('Enter');
			await expect(wednesdayLine(page)).toHaveAttribute('open', '');
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Move sheet with each day’s heads-up, desktop');
			await captureScreen(page, testInfo, 'move-evaluation-desktop');
		});
	});

	test('a move onto a warned day still saves, and Train then shows its heads-up', async ({
		page
	}) => {
		await openMove(page);
		const wednesday = addDays(seeded.mondays.moved, 2);
		await day(page, wednesday).check();
		await expect(sheet(page).getByTestId('move-warnings')).toContainText(
			'Heavy lower body the day before hard Muay Thai'
		);
		await sheet(page).getByTestId('edit-save').click();
		await expect(toastWith(page, /^Moved to Wednesday · version \d+$/)).toBeVisible();

		await gotoHydrated(page, `/train?week=${MOVED_WEEK}`);
		await page.getByTestId('week-strip').getByRole('radio').nth(2).click();
		const note = page
			.getByTestId('session-card')
			.filter({ hasText: 'Lower A' })
			.locator('xpath=following-sibling::*[1][self::details]');
		await expect(note.locator('summary')).toHaveText(
			'Heads-up · Heavy lower body the day before hard Muay Thai · You moved this here'
		);
	});
});
