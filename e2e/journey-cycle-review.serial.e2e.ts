/**
 * The cycle loop end to end (M6 journey-cycle-review), on an iPhone and in a desktop window, with
 * a screenshot of every step. Each step's own screen has its own spec (review-entry,
 * cycle-review, next-cycle, train-review-notice, bridge-week, program-history,
 * review-proposal-origin); this one walks them in order, as the owner does, on one history.
 *
 * - On time (block-end: the block's last week is fully logged and it ends this Sunday): Train is
 *   on the block's last week with nothing left to do and Today offers the cycle review; the review
 *   shows goal progress and what changes and why; the next block starts from its preview (Next
 *   Monday, the only start on offer); Train opens its week 1, whose loads read as a share of the
 *   estimated 1RM; History lists version 2 and the previous version 1, read-only; M5's inbox lists
 *   the next_cycle as applied, labelled 'Cycle review'.
 * - Late (block-end-late: the block ended weeks ago, nothing planned since): Train reads 'First
 *   block complete' and leads to the review; the preview names the unplanned weeks; starting this
 *   week creates them and the block from this Monday; Train's previous week reads 'Unplanned week
 *   · between blocks'; the plan timeline labels the bridge with its length.
 *
 * Steps that depend on the weekday read the dates seedReview returns, never the clock. Nothing
 * here holds a request, so the service worker stays on (WebKit's page.route trap does not apply).
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { addDays, daysBetween, mondayOf } from '../src/lib/domain/calendar';
import { DESKTOP, expectNoSideScroll, isDesktopPage } from './desktop';
import { cycleReviews, programVersions } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type ReviewScenario,
	type ReviewTarget,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated, toastWith } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
const INBOX = '/coach/proposals';

type Cycle = Extract<ReviewTarget, { kind: 'cycle' }>;

const cycleOf = (seeded: SeededReview): Cycle => {
	if (seeded.review.kind !== 'cycle') throw new Error('a cycle scenario');
	return seeded.review;
};
/** The program's week (1-based, from the reviewed block's first Monday) that starts on `monday`. */
const weekNumber = (cycle: Cycle, monday: string) =>
	daysBetween(cycle.blockStartsOn, monday) / 7 + 1;

/**
 * Seed `scenario` (seedReview), with onboarding complete: Today shows the plan, and so the review
 * prompt, only once it is.
 */
async function seedOnboarded(request: APIRequestContext, scenario: ReviewScenario) {
	const seeded = await seedReview(request, scenario);
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

const card = (page: Page) => page.getByTestId('next-cycle');
const preview = (page: Page) => page.locator('[data-testid="next-cycle-preview"]:visible');
const position = (page: Page) => page.getByTestId('program-position');
const planSheet = (page: Page) => page.getByRole('dialog', { name: 'Your plan' });

/** One step's evidence: nothing scrolls sideways, and the screen is captured. */
async function capture(page: Page, testInfo: TestInfo, step: string) {
	await expectNoSideScroll(page);
	const viewport = isDesktopPage(page) ? 'desktop' : 'phone';
	await captureScreen(page, testInfo, `journey-cycle-${step}-${viewport}`);
}

/** Create the block's review from the reviews list's cycle row, which lands on the review. */
async function createFromList(page: Page) {
	await expect(page).toHaveURL(new RegExp(`${LIST}$`));
	await page
		.locator('[data-testid="review-create"]:has(input[name="blockLineage"])')
		.getByRole('button')
		.click();
	await expect(page.getByTestId('cycle-review')).toBeVisible();
	await expect(card(page)).toHaveAttribute('data-state', 'open');
}

/** Version `number`'s first strength session in the week starting `monday`, read in SQL. */
async function firstStrength(programId: string, number: number, monday: string) {
	const [row] = await query<{ lineage: string; date: string }>(
		`select s.lineage_id::text as lineage, to_char(s.scheduled_on, 'YYYY-MM-DD') as date
		from program_versions v
		join program_version_weeks vw on vw.version_id = v.id
		join program_weeks w on w.id = vw.week_id
		join planned_sessions s on s.week_id = w.id
		where v.program_id = $1::uuid and v.number = $2 and w.starts_on = $3::date
			and s.discipline = 'strength'
		order by s.scheduled_on, s.order_in_day limit 1`,
		[programId, number, monday]
	);
	expect(row, 'week 1 holds a strength session').toBeDefined();
	return row!;
}

/** The on-time journey, from the block's last week to the inbox. */
async function onTime(page: Page, seeded: SeededReview, testInfo: TestInfo) {
	const cycle = cycleOf(seeded);
	const blockWeeks = (daysBetween(cycle.blockStartsOn, cycle.blockEndsOn) + 1) / 7;
	const next = addDays(cycle.blockEndsOn, 1);

	// 1. Train: the block's last week, every session in it logged; Today offers the review.
	await gotoHydrated(page, '/train');
	await expect(position(page)).toContainText(`Week ${blockWeeks} of`);
	await expect(page.locator('[data-testid="session-card"][data-status="planned"]')).toHaveCount(0);
	await capture(page, testInfo, '1-train-last-week');
	await gotoHydrated(page, '/today');
	const prompt = page.getByTestId('review-prompt');
	await expect(prompt).toHaveAttribute('data-kind', 'cycle');
	await expect(prompt).toContainText('Block complete — review it and plan the next');
	await capture(page, testInfo, '1-today-prompt');
	await prompt.getByRole('button').click();
	await expect(page).toHaveURL(new RegExp(`${LIST}/c-[0-9a-f-]{36}$`));
	const [review] = await cycleReviews(cycle.blockLineageId);
	expect(review, 'one cycle review stored').toBeDefined();

	// 2. The review: goal progress, then the next block with what changes and why.
	await expect(page.getByTestId('cycle-review')).toBeVisible();
	const goals = page.locator('[data-testid="review-section"][data-section="goals"]');
	await expect(goals.getByTestId('section-verdict')).not.toBeEmpty();
	await capture(page, testInfo, '2-review-goals');
	await expect(card(page)).toHaveAttribute('data-state', 'open');
	const change = preview(page).getByTestId('next-cycle-changes').locator('li').first();
	await expect(change.locator('.label')).not.toBeEmpty();
	await expect(change.locator('.muted')).not.toBeEmpty();
	await card(page).scrollIntoViewIfNeeded();
	await capture(page, testInfo, '2-review-next-block');

	// 3. Start it: the block ends this Sunday, so it starts Monday, the only start on offer.
	await expect(page.getByTestId('next-cycle-start')).toHaveCount(0);
	await page.getByTestId('next-cycle-start-block').click();
	await expect(page).toHaveURL(/\/train\?tool=plan$/);
	await expect(toastWith(page, 'Next block planned · version 2')).toBeVisible();
	await expect(planSheet(page)).toBeVisible();
	await capture(page, testInfo, '3-plan-after-start');

	// 4. Train on the new block's week 1; its loads read as a share of the estimated 1RM.
	const newBlock = planSheet(page).getByTestId('plan-block').nth(1);
	await newBlock.locator('a[data-testid="plan-week"]').first().click();
	await expect(page).toHaveURL(new RegExp(`/train\\?week=${weekNumber(cycle, next)}$`));
	const strength = await firstStrength(seeded.programId!, 2, next);
	await page
		.getByTestId('week-strip')
		.getByRole('radio')
		.nth(daysBetween(next, strength.date))
		.click();
	await expect(page.locator(`a[href="/train/session/${strength.lineage}"]`)).toBeVisible();
	await capture(page, testInfo, '4-train-week-1');
	await page.locator(`a[href="/train/session/${strength.lineage}"]`).click();
	await expect(page).toHaveURL(new RegExp(`/train/session/${strength.lineage}$`));
	await expect(page.getByTestId('exercises')).toContainText('of your estimated 1RM');
	await capture(page, testInfo, '4-session-estimated');

	// 5. History: version 2 and the previous version 1, which opens read-only.
	await gotoHydrated(page, '/train/history');
	const links = page.getByTestId('version-link');
	await expect(links.filter({ hasText: /^\s*Version 2\b/ })).toHaveCount(1);
	await expect(links.filter({ hasText: /^\s*Version 1\b/ })).toHaveCount(1);
	await capture(page, testInfo, '5-history');
	await links.filter({ hasText: /^\s*Version 1\b/ }).click();
	await expect(page).toHaveURL(/\/train\/history\/1$/);
	await expect(page.getByTestId('older-version')).toContainText('Older version · read-only');
	await expect(page.getByTestId('move-session')).toHaveCount(0);
	await capture(page, testInfo, '5-history-version-1');
	expect((await programVersions(seeded.programId!)).map((v) => [v.number, v.current])).toEqual([
		[1, false],
		[2, true]
	]);

	// 6. M5's inbox: the review's next_cycle applied as version 2, labelled 'Cycle review'.
	const [applied] = await query<{ id: string }>(
		`select id::text from coach_proposals where kind = 'next_cycle' and status = 'applied'`
	);
	expect(applied, 'the next_cycle is applied').toBeDefined();
	await gotoHydrated(page, INBOX);
	const row = page.locator(`[data-testid="inbox-row"][href^="${INBOX}/${applied!.id}"]`);
	await expect(row.getByTestId('inbox-origin')).toHaveText('Cycle review');
	await expect(row).toContainText('Applied as version 2');
	await row.click();
	const proposal = page.getByTestId('inbox-detail').getByTestId('proposal-card');
	await expect(proposal.getByTestId('proposal-origin')).toHaveText('From your cycle review');
	await expect(proposal).toContainText('Applied as version 2');
	await auditBothThemes(page, 'the inbox, a cycle review’s next block applied');
	await capture(page, testInfo, '6-inbox-applied');
}

/** The late journey: the bridge weeks shown, created and labelled. */
async function late(page: Page, seeded: SeededReview, testInfo: TestInfo) {
	const cycle = cycleOf(seeded);
	const thisMonday = mondayOf(seeded.today);
	const next = addDays(cycle.blockEndsOn, 1);
	const k = daysBetween(next, thisMonday) / 7;
	const from = weekNumber(cycle, next);
	const weeks = `${k} ${k === 1 ? 'week' : 'weeks'}`;

	// Train: the block is complete, and it leads to the review.
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('train-block-complete')).toBeVisible();
	await capture(page, testInfo, 'late-1-train-complete');
	await page.getByTestId('train-next').click();
	await createFromList(page);

	// The preview, starting this week: the weeks lived through stay unplanned.
	await expect(
		page.getByTestId('next-cycle-start').getByRole('radio', { name: /This week/ })
	).toBeChecked();
	await expect(preview(page).getByTestId('next-cycle-bridge')).toHaveText(
		k === 1 ? `Week ${from} stays unplanned` : `Weeks ${from}–${from + k - 1} stay unplanned`
	);
	await card(page).scrollIntoViewIfNeeded();
	await capture(page, testInfo, 'late-2-preview-bridge');

	// Starting this week creates the bridge, then the block from this Monday.
	await page.getByTestId('next-cycle-start-block').click();
	await expect(page).toHaveURL(/\/train\?tool=plan$/);
	const sheet = planSheet(page);
	await expect(sheet).toBeVisible();
	const bridge = sheet.locator('[data-testid="plan-block"][data-bridge]');
	await expect(bridge).toHaveCount(1);
	await expect(bridge.getByRole('heading', { level: 3 })).toHaveText(`Between blocks · ${weeks}`);
	await expect(bridge.getByTestId('plan-week')).toHaveCount(k);
	await expect(bridge.getByText('Unplanned', { exact: true })).toHaveCount(k);
	await capture(page, testInfo, 'late-3-plan-bridge');
	const blocks = await query<{ phase: string; startsOn: string; outline: boolean }>(
		`select b.phase, to_char(b.starts_on, 'YYYY-MM-DD') as "startsOn", b.outline
		from program_versions v
		join program_version_blocks vb on vb.version_id = v.id
		join program_blocks b on b.id = vb.block_id
		where v.program_id = $1::uuid and v.number = 2 order by b.position`,
		[seeded.programId]
	);
	expect(blocks.slice(1, 3)).toMatchObject([
		{ phase: 'transition', startsOn: next },
		{ outline: false, startsOn: thisMonday }
	]);

	// Train's previous week: a bridge week, never seven rest days.
	await gotoHydrated(page, `/train?week=${weekNumber(cycle, thisMonday) - 1}`);
	await expect(page.getByTestId('train-bridge')).toContainText('Unplanned week · between blocks');
	await expect(page.getByTestId('rest-day')).toHaveCount(0);
	await capture(page, testInfo, 'late-4-train-bridge-week');
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test.describe('block-end: on time', () => {
	test('end of block → cycle review → next block → Train week 1 → History → inbox, on an iPhone', async ({
		page,
		request
	}, testInfo) => {
		await onTime(page, await seedOnboarded(request, 'block-end'), testInfo);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the same journey at 1440 × 900', async ({ page, request }, testInfo) => {
			await onTime(page, await seedOnboarded(request, 'block-end'), testInfo);
		});
	});
});

test.describe('block-end-late: a late start', () => {
	test('the unplanned weeks previewed, created, on Train and in the plan, on an iPhone', async ({
		page,
		request
	}, testInfo) => {
		await late(page, await seedOnboarded(request, 'block-end-late'), testInfo);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the same late start at 1440 × 900', async ({ page, request }, testInfo) => {
			await late(page, await seedOnboarded(request, 'block-end-late'), testInfo);
		});
	});
});
