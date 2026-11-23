/**
 * A bridge week between blocks (M6 bridge-week-states), seeded with the bridge-week fixture: a
 * late cycle review left three unplanned weeks after Base, this week the last, and Build starts
 * next Monday. Train shows 'Free week', between blocks, with the next block's start and no rest
 * days, and lists the run logged this week as a line of its own; its next step and the next
 * week's arrow open Build's first week; the whole plan names the bridge with its length, as its
 * current phase; History's change that made it says the week was not planned before it;
 * Today's panel names the next block's start with 'Log something else'. Axe is clean in both themes on a phone (393 × 659) and in a desktop window
 * (1440 × 900), where each screen is captured.
 *
 * Serial: the program is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { longDate, shortDate } from '../src/lib/ui/program/words';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { openMore } from './program-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** The fixture's result: Build's first day, and its first week's number in the program. */
type Seeded = SeededAnalytics & { nextBlock: { startsOn: string; week: number } };

let seeded: Seeded;
test.beforeAll(async ({ request }) => {
	seeded = (await seedAnalytics(request, 'bridge-week')) as Seeded;
	// Today shows the plan only once onboarding is complete.
	await query('update athlete_profiles set onboarding_completed_at = now()');
});
test.afterAll(async () => {
	await resetAnalytics();
});

const startsLine = () => `Your next block starts ${shortDate(seeded.nextBlock.startsOn)}`;
/** Train's sentence: the next block by name, and its first day. */
const trainStarts = () => `Build starts ${longDate(seeded.nextBlock.startsOn)}`;
const bridgeCard = (page: Page) => page.getByTestId('train-bridge');

/** Train's bridge week: the card, the next block's start, the off-plan run, no week of rest. */
async function expectTrainBridge(page: Page) {
	await expect(bridgeCard(page)).toContainText('Free week');
	await expect(bridgeCard(page)).toContainText(trainStarts());
	await expect(page.getByTestId('rest-day')).toHaveCount(0);
	await expect(page.getByTestId('session-card')).toHaveCount(0);
	// The run logged this week, as a line that links nowhere: its day, title and length.
	const run = page.getByTestId('train-week').getByTestId('off-plan-workout');
	await expect(run).toHaveCount(1);
	await expect(run).toContainText('Easy run');
	await expect(run).toHaveAttribute(
		'aria-label',
		new RegExp(`^${longDate(seeded.today)}, Easy run, \\d+ min$`)
	);
	await expect(run).toHaveAttribute('data-date', seeded.today);
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

test('the next step and the next week’s arrow open the new block’s first week', async ({
	page
}) => {
	const { week } = seeded.nextBlock;
	const position = new RegExp(`^Week ${week} of \\d+ · Build$`);
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('train-next')).toHaveText('See the next block');
	await page.getByTestId('train-next').click();
	await expect(page).toHaveURL(new RegExp(`/train\\?week=${week}$`));
	await expect(page.getByTestId('program-position')).toHaveText(position);
	await expect(page.getByTestId('session-card').first()).toContainText('Strength A');
	await expect(page.getByTestId('off-plan-workout')).toHaveCount(0);

	await gotoHydrated(page, '/train');
	await page.getByRole('navigation', { name: 'Weeks' }).getByTestId('next-week').click();
	await expect(page).toHaveURL(new RegExp(`/train\\?week=${week}$`));
	await expect(page.getByTestId('program-position')).toHaveText(position);
	await expect(page.getByTestId('week-lines')).toBeVisible();
});

test('the whole plan names the bridge with its length, as the phase now', async ({ page }) => {
	await gotoHydrated(page, '/train');
	await openMore(page);
	await page.getByTestId('open-plan').click();
	await expect(page).toHaveURL(/\/train\/plan$/);
	const phases = page.getByTestId('plan-phases').getByRole('listitem');
	// Base, Mon 5 Oct to Sun 1 Nov in the fixture's weeks, then the bridge's three, then Build.
	const bridgeFrom = seeded.nextBlock.week - 3;
	await expect(phases).toHaveText([
		/^Base\s*Weeks 1 to 4/,
		new RegExp(`^Between blocks · 3 weeks, now\\s*Weeks ${bridgeFrom} to ${bridgeFrom + 2}`),
		new RegExp(`^Build\\s*Weeks ${seeded.nextBlock.week} to ${seeded.nextBlock.week + 3}`)
	]);
	await expect(phases.nth(0)).toHaveAttribute('data-state', 'done');
	await expect(phases.nth(1)).toHaveAttribute('data-state', 'now');
	await auditBothThemes(page, 'the plan, a bridge');
});

// The bridge came with version 2 (the late review's next block), which names no dated session: the
// week it touched is this one, where version 1 had nothing planned (Base ended three weeks ago).
// The week before that change says so, and never draws Base's week 1.
test('History’s change that made the bridge says the week was not planned before it', async ({
	page
}) => {
	await gotoHydrated(page, '/train/history/2');
	await page.getByTestId('see-week').click();
	await expect(page).toHaveURL(/\/train\/history\/2\?week=?$/);
	await expect(page.getByTestId('version-week-label')).toHaveText(
		`Week of ${shortDate(seeded.weekStart)} · before this change`
	);
	const week = page.getByTestId('version-week');
	await expect(week.getByTestId('history-not-planned')).toHaveText(
		/^Not planned before this change\s*Your plan ended before this week then/
	);
	await expect(week.getByTestId('week-lines')).toHaveCount(0);
	await expect(week.getByTestId('history-bridge')).toHaveCount(0);
	// The change itself is one step back.
	await page.getByTestId('back-to-change').click();
	await expect(page).toHaveURL(/\/train\/history\/2$/);
	await expect(page.getByTestId('version-changes')).toBeVisible();
	await gotoHydrated(page, '/train/history/2?week');
	await auditBothThemes(page, 'History, the week before a bridge');
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
		// One readable column: the statement, the run's line, the next step and More, one under
		// the other on the same left edge.
		const parts = [
			bridgeCard(page),
			page.getByTestId('off-plan-workout'),
			page.getByTestId('train-next'),
			page.getByTestId('open-more')
		];
		const boxes = await Promise.all(parts.map(async (part) => (await part.boundingBox())!));
		for (const [i, box] of boxes.entries()) {
			expect(Math.abs(box.x - boxes[0]!.x), `${parts[i]} on the column's edge`).toBeLessThanOrEqual(
				1
			);
			if (i > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y);
		}
		await auditBothThemes(page, 'Train, a bridge week, desktop');
		await captureScreen(page, testInfo, 'bridge-week-train-desktop');

		await gotoHydrated(page, '/train/history/2?week');
		await expect(page.getByTestId('history-not-planned')).toBeVisible();
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'bridge-week-history-desktop');

		await gotoHydrated(page, '/today');
		await expect(page.getByTestId('today-bridge')).toContainText(startsLine());
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Today, a bridge week, desktop');
		await captureScreen(page, testInfo, 'bridge-week-today-desktop');
	});
});
