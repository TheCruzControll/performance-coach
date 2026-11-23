/**
 * Train's notice for a week a weekly review changed (src/routes/(app)/train, week-changes.ts),
 * and 'First block complete' leading to the cycle review.
 *
 * - review-ahead: generating next week from the review lands on Train's next week, whose one
 *   line under the week opens the notice, 'Updated from your weekly review', with every applied
 *   decision's why (the version's decisions, read in SQL); its links open the version in History
 *   and the review; the week before shows none. After a modified decision (one change at its half step, the rest left
 *   out), it lists only that change.
 * - block-end-late: the block is over and nothing is planned since, so Train's 'First block
 *   complete' leads to the reviews list, which creates the cycle review; then straight to it.
 * - axe in both themes; the notice at 393 × 659 and, under the week in its column, at 1440 × 900.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seedAnalytics } from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { cycleReviews, programVersions } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetReviews,
	seedReview,
	type ReviewTarget
} from './review-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';

interface Seeded {
	programId: string;
	review: Extract<ReviewTarget, { kind: 'weekly' }>;
}

async function seedAhead(request: APIRequestContext) {
	await resetReviews(request);
	return (await seedAnalytics(request, 'review-ahead')) as unknown as Seeded;
}

const notice = (page: Page) => page.getByTestId('review-notice');

/** Open the week's note from its one line (a finding's count, if any, names the line first). */
async function openNote(page: Page) {
	const line = page.getByTestId('week-line');
	await expect(line).toHaveText(/Updated from your weekly review|heads-up|trade-off/);
	await line.click();
	await expect(notice(page)).toBeVisible();
	await expect(page.locator('details.note')).toContainText('Updated from your weekly review');
}
const items = (page: Page) => page.getByTestId('review-next-item');
const reviewPage = (s: Seeded) => `${LIST}/w-${s.review.weekStartsOn}`;

/** Generate next week from the review's card, landing on Train's next week. */
async function generate(page: Page, s: Seeded, choose?: (page: Page) => Promise<void>) {
	await gotoHydrated(page, reviewPage(s));
	await expect(page.getByTestId('review-next-week')).toHaveAttribute('data-state', 'open');
	await choose?.(page);
	await page.getByTestId('review-next-generate').click();
	await expect(page).toHaveURL(/\/train\?week=\d+$/);
	return Number(new URL(page.url()).searchParams.get('week'));
}

/** Version 2's decisions, read in SQL: the changes and the review_applied decision. */
async function applied(s: Seeded) {
	const versions = await programVersions(s.programId);
	expect(versions.map((v) => v.number)).toEqual([1, 2]);
	const decisions = versions[1]!.decisions;
	return {
		changes: decisions.filter((d) => d.kind !== 'review_applied'),
		review: decisions.find((d) => d.kind === 'review_applied')!
	};
}

test.describe('review-ahead: next week generated from the review', () => {
	let seeded: Seeded;

	test.beforeEach(async ({ request }) => {
		seeded = await seedAhead(request);
	});

	test('Train shows the notice with every why, its links open History and the review, other weeks show none', async ({
		page
	}, testInfo) => {
		const week = await generate(page, seeded);
		const { changes, review } = await applied(seeded);
		expect(changes.length).toBeGreaterThan(1);

		await expect(notice(page)).toBeHidden();
		await openNote(page);
		await expect(notice(page)).toContainText(review.why);
		await expect(notice(page).getByRole('listitem')).toHaveCount(changes.length);
		for (const change of changes) {
			await expect(notice(page)).toContainText(change.why);
		}
		await notice(page).scrollIntoViewIfNeeded();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Train review notice');
		await captureScreen(page, testInfo, 'train-review-notice-phone');

		await notice(page).getByTestId('review-notice-version').click();
		await expect(page).toHaveURL(/\/train\/history\/2$/);
		await expect(
			page.getByTestId('version-changes').getByTestId('decision').filter({ hasText: review.why })
		).toBeVisible();

		await gotoHydrated(page, `/train?week=${week}`);
		await openNote(page);
		await notice(page).getByTestId('review-notice-review').click();
		await expect(page).toHaveURL(new RegExp(`${reviewPage(seeded)}$`));
		await expect(page.getByTestId('review-next-week')).toHaveAttribute('data-state', 'applied');

		await gotoHydrated(page, `/train?week=${week - 1}`);
		await expect(page.getByTestId('week-lines')).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await expect(
			page.getByTestId('week-line').filter({ hasText: 'Updated from your weekly review' })
		).toHaveCount(0);
	});

	test('after a modified decision, it lists only the change applied', async ({ page }) => {
		await generate(page, seeded, async (page) => {
			const halved = items(page).filter({ hasText: 'Half step · 86.25 kg' }).first();
			await halved.getByLabel('Half step · 86.25 kg').check();
			const keep = await halved.locator('input[name="item"]').getAttribute('value');
			for (const item of await items(page).all()) {
				const box = item.locator('input[name="item"]');
				if ((await box.getAttribute('value')) !== keep) await box.uncheck();
			}
		});
		const { changes, review } = await applied(seeded);
		expect(changes).toHaveLength(1);
		await openNote(page);
		await expect(notice(page).getByRole('listitem')).toHaveCount(1);
		await expect(notice(page)).toContainText(changes[0]!.why);
		await expect(notice(page)).toContainText(review.why);
		expect(review.why).toMatch(/^You applied 1 change/);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the notice opens under the week, in its column, nothing scrolls sideways', async ({
			page
		}, testInfo) => {
			await generate(page, seeded);
			await openNote(page);
			const week = (await page.getByTestId('week-lines').boundingBox())!;
			const main = (await page.locator('main#main').boundingBox())!;
			const box = (await notice(page).boundingBox())!;
			expect(Math.abs(box.x - week.x)).toBeLessThanOrEqual(1);
			expect(box.y).toBeGreaterThanOrEqual(week.y + week.height - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
			await expectNoSideScroll(page);
			await notice(page).getByTestId('review-notice-version').hover();
			await captureScreen(page, testInfo, 'train-review-notice-desktop');
		});
	});
});

test.describe('block-end-late: the block is over', () => {
	test('First block complete leads to the reviews list, then to the cycle review', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedReview(request, 'block-end-late');
		const lineage = seeded.review.kind === 'cycle' ? seeded.review.blockLineageId : '';

		await gotoHydrated(page, '/train');
		await expect(page.getByTestId('train-block-complete')).toBeVisible();
		const next = page.getByTestId('train-next');
		await expect(next).toHaveText('Review the block');
		await auditBothThemes(page, 'Train block complete');
		await captureScreen(page, testInfo, 'train-block-complete-review');
		await next.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));

		const create = page.locator('[data-testid="review-create"]:has(input[name="blockLineage"])');
		await create.getByRole('button').click();
		await expect(page.getByTestId('cycle-review')).toBeVisible();
		const [stored] = await cycleReviews(lineage);
		expect(stored).toBeDefined();

		await gotoHydrated(page, '/train');
		await expect(next).toHaveText('Open the review');
		await next.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-${stored!.id}$`));
		await expect(page.getByTestId('cycle-review')).toBeVisible();
	});
});
