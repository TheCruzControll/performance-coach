/**
 * A bridge week between blocks (M6 bridge-week-states), seeded with the bridge-week fixture: a
 * late cycle review left three unplanned weeks after Base, this week the last, and Build starts
 * next Monday. Train shows 'Unplanned week · between blocks' with the next block's start and no
 * rest-day cards, and lists the run logged this week as off-plan; its next step and the next
 * week's pill open Build's first week; the plan timeline labels the bridge with its length;
 * History's version shows the same state; Today's panel names the next block's start with 'Log
 * something else'. Axe is clean in both themes on a phone (393 × 659) and in a desktop window
 * (1440 × 900), where each screen is captured.
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
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** The fixture's result: Build's first day, and its first week's number in the program. */
type Seeded = SeededAnalytics & { nextBlock: { startsOn: string; week: number } };

let seeded: Seeded;
test.beforeAll(async ({ request }) => {
	seeded = (await seedAnalytics(request, 'bridge-week')) as Seeded;
});
test.afterAll(async () => {
	await resetAnalytics();
});

const startsLine = () => `Your next block starts ${shortDate(seeded.nextBlock.startsOn)}`;
const bridgeCard = (page: Page) => page.getByTestId('train-bridge');

/** Train's bridge week: the card, the next block's start, the off-plan run, no week of rest. */
async function expectTrainBridge(page: Page) {
	await expect(bridgeCard(page)).toContainText('Unplanned week · between blocks');
	await expect(bridgeCard(page)).toContainText(startsLine());
	await expect(page.getByTestId('rest-day')).toHaveCount(0);
	await expect(page.getByTestId('week-strip')).toHaveCount(0);
	await expect(page.getByTestId('session-card')).toHaveCount(0);
	const run = page.getByTestId('train-week').getByTestId('off-plan-workout');
	await expect(run).toHaveCount(1);
	await expect(run).toContainText('Easy run');
	await expect(run).toContainText(shortDate(seeded.today));
	await expect(run).toContainText('Off-plan');
}

test('Train shows the bridge week with the next block’s start, its run off-plan', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/train');
	await expectTrainBridge(page);
	await expect(page.getByTestId('program-position')).toContainText('Between blocks');
	await auditBothThemes(page, 'Train, a bridge week');
	await captureScreen(page, testInfo, 'bridge-week-train');
});

test('the next step and the next week’s pill open the new block’s first week', async ({ page }) => {
	const { week } = seeded.nextBlock;
	await gotoHydrated(page, '/train');
	await page.getByTestId('train-next').click();
	await expect(page).toHaveURL(new RegExp(`/train\\?week=${week}$`));
	await expect(page.getByTestId('program-position')).toContainText(`Build · Week ${week}`);
	await expect(page.getByTestId('session-card').first()).toContainText('Strength A');
	await expect(page.getByTestId('off-plan-workout')).toHaveCount(0);

	await gotoHydrated(page, '/train');
	const pill = page.getByRole('navigation', { name: 'Weeks' }).getByRole('link', {
		name: `Week ${week}`,
		exact: true
	});
	await pill.click();
	await expect(pill).toHaveAttribute('aria-current', 'page');
	await expect(page.getByTestId('program-position')).toContainText(`Build · Week ${week}`);
	await expect(page.getByTestId('week-strip')).toBeVisible();
});

test('the plan timeline labels the bridge with its length, hatched', async ({ page }) => {
	await gotoHydrated(page, '/train');
	await page.getByTestId('open-plan').click();
	const sheet = page.getByRole('dialog', { name: 'Your plan' });
	await expect(sheet).toBeVisible();
	const blocks = sheet.getByTestId('plan-block');
	await expect(blocks.getByRole('heading', { level: 3 })).toHaveText([
		'Base',
		'Between blocks · 3 weeks',
		'Build'
	]);
	const bridge = blocks.nth(1);
	await expect(bridge).toHaveAttribute('data-bridge', '');
	await expect(bridge).toHaveAttribute('data-current', '');
	const from = addDays(seeded.weekStart, -14);
	await expect(bridge.getByTestId('plan-block-span')).toHaveText(
		`${shortDate(from)} – ${shortDate(addDays(seeded.weekStart, 6))} · Nothing planned`
	);
	await expect(bridge.getByTestId('plan-week')).toHaveCount(3);
	await expect(bridge.getByText('Unplanned', { exact: true })).toHaveCount(3);
	await auditBothThemes(page, 'the plan, a bridge');
});

test('History’s version shows the same state for the bridge week', async ({ page }) => {
	await gotoHydrated(page, '/train/history/2');
	const week = page.getByTestId('version-week');
	await expect(week.getByTestId('history-bridge')).toContainText('Unplanned week · between blocks');
	await expect(week.getByTestId('history-bridge')).toContainText(
		`The next block starts ${shortDate(seeded.nextBlock.startsOn)}`
	);
	await expect(week.getByTestId('rest-day')).toHaveCount(0);
	await expect(week.getByTestId('week-strip')).toHaveCount(0);
	await auditBothThemes(page, 'History, a bridge week');
});

test('Today’s panel names the next block’s start, with Log something else', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/today');
	const bridge = page.getByTestId('today-plan').getByTestId('today-bridge');
	await expect(bridge).toContainText('Between blocks');
	await expect(bridge).toContainText(startsLine());
	await expect(bridge.getByTestId('log-something-else')).toHaveAttribute('href', '/workout');
	await expect(page.getByTestId('today-rest')).toHaveCount(0);
	await expect(page.getByTestId('today-up-next').getByTestId('up-next-card').first()).toContainText(
		'Strength A'
	);
	await auditBothThemes(page, 'Today, a bridge week');
	await captureScreen(page, testInfo, 'bridge-week-today');
});

test.describe('in a desktop window', () => {
	test.use({ ...DESKTOP });

	test('Train, History and Today lay the bridge out at 1440 × 900', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train');
		await expectTrainBridge(page);
		await expectNoSideScroll(page);
		const card = await bridgeCard(page).boundingBox();
		const tools = await page.getByRole('region', { name: 'Tools' }).boundingBox();
		// The tools sit beside the card, never under a stretched phone column.
		expect(tools!.x).toBeGreaterThan(card!.x + card!.width);
		await auditBothThemes(page, 'Train, a bridge week, desktop');
		await captureScreen(page, testInfo, 'bridge-week-train-desktop');

		await gotoHydrated(page, '/train/history/2');
		await expect(page.getByTestId('history-bridge')).toBeVisible();
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'bridge-week-history-desktop');

		await gotoHydrated(page, '/today');
		await expect(page.getByTestId('today-bridge')).toContainText(startsLine());
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Today, a bridge week, desktop');
		await captureScreen(page, testInfo, 'bridge-week-today-desktop');
	});
});
