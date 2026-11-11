/**
 * The next block from a cycle review (src/routes/(app)/progress/reviews/[[key]], NextCycleCard):
 * preview it with every significant change explained, choose when it starts, adjust it, and
 * start it as a new program version.
 *
 * - block-end (the block ends this Sunday, so only 'Next Monday' is on offer): the preview's
 *   starting loads read as estimated; Start lands on the plan overview with the toast, the plan
 *   lists the new block's weeks as planned and Train opens on its week 1; the old version and its
 *   outline stay in History; a rotated exercise kept is planned; a second tap while the first is
 *   on its way posts nothing (one version); a profile changed since the preview refreshes it, and
 *   Retry starts the fresh one
 * - block-end-late (ended weeks ago): 'This week' says it starts today, the lived-through weeks
 *   read as an unplanned bridge and the next block's dates follow it; starting this week plans
 *   the bridge and the block from this Monday
 * - axe in both themes, and the screens at 393 × 659 and 1440 × 900
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays, daysBetween, mondayOf, weekdayOf } from '../src/lib/domain/calendar';
import { WEEKDAY_INFO } from '../src/lib/domain/weekdays';
import { shortDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { cycleReviews, programVersions } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated, toastWith } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
const PLAN = '/train?tool=plan';

const card = (page: Page) => page.getByTestId('next-cycle');
const start = (page: Page) => page.getByTestId('next-cycle-start-block');
/** The preview on screen: the chosen start's. */
const preview = (page: Page) => page.locator('[data-testid="next-cycle-preview"]:visible');
const isStart = (url: URL) => url.pathname.startsWith(LIST) && url.search === '?/startCycle';

/** Create the seeded block's review from the list, and open it. */
async function createReview(page: Page) {
	await gotoHydrated(page, LIST);
	await page
		.locator('[data-testid="review-create"]:has(input[name="blockLineage"])')
		.getByRole('button')
		.click();
	await expect(page.getByTestId('cycle-review')).toBeVisible();
	await expect(card(page)).toHaveAttribute('data-state', 'open');
}

const lineageOf = (seeded: SeededReview) =>
	seeded.review.kind === 'cycle' ? seeded.review.blockLineageId : '';

/** The current version's blocks, in order, read in SQL. */
async function blocksOf(programId: string, number: number) {
	return query<{ phase: string; name: string; startsOn: string; endsOn: string; outline: boolean }>(
		`select b.phase, b.name, to_char(b.starts_on, 'YYYY-MM-DD') as "startsOn",
			to_char(b.ends_on, 'YYYY-MM-DD') as "endsOn", b.outline
		from program_versions v
		join program_version_blocks vb on vb.version_id = v.id
		join program_blocks b on b.id = vb.block_id
		where v.program_id = $1::uuid and v.number = $2 order by b.position`,
		[programId, number]
	);
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test.describe('block-end', () => {
	let seeded: SeededReview;

	test.beforeEach(async ({ request }) => {
		seeded = await seedReview(request, 'block-end');
		// Bench at one load all block: stalled, so the rules rotate it.
		await query(`update set_records set weight = 80 where exercise_id = $1::uuid`, [
			seeded.exercises.bench_press
		]);
	});

	test('start: the plan overview lists the planned weeks, Train opens on week 1, History keeps the old version', async ({
		page
	}) => {
		await createReview(page);
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText('Your next block');
		// One start on offer: no choice, and it says when.
		await expect(page.getByTestId('next-cycle-start')).toHaveCount(0);
		await expect(preview(page)).toHaveCount(1);
		const end = seeded.review.kind === 'cycle' ? seeded.review.blockEndsOn : '';
		await expect(preview(page)).toContainText(`Starts ${shortDate(addDays(end, 1))}`);
		// Loads from the block's e1RMs read as estimated, and every group explains itself.
		await expect(preview(page).getByTestId('next-cycle-loads')).toContainText('Estimated');
		await expect(
			preview(page).getByTestId('next-cycle-changes').locator('li').first()
		).not.toBeEmpty();

		await start(page).click();
		await expect(page).toHaveURL(new RegExp(`${PLAN.replace('?', '\\?')}$`));
		await expect(toastWith(page, 'Next block planned · version 2')).toBeVisible();
		const versions = await programVersions(seeded.programId!);
		expect(versions.map((v) => [v.number, v.current, v.generator])).toEqual([
			[1, false, versions[0]!.generator],
			[2, true, 'next-block/1+perfo-programming/6']
		]);
		expect((await cycleReviews(lineageOf(seeded)))[0]!.nextVersionNumber).toBe(2);

		// The plan overview: the new block planned, none of its weeks waiting on an outline.
		const sheet = page.getByRole('dialog', { name: 'Your plan' });
		await expect(sheet).toBeVisible();
		const next = sheet.getByTestId('plan-block').nth(1);
		await expect(next).not.toHaveAttribute('data-outline', '');
		await expect(next).not.toContainText('Not planned yet');
		await next.locator('a[data-testid="plan-week"]').first().click();
		// Train on the new block's week 1, its days holding sessions.
		await expect(page).toHaveURL(/\/train\?week=\d+$/);
		await expect(
			page
				.getByTestId('week-strip')
				.getByRole('radio', { name: /\d+ sessions?/ })
				.first()
		).toBeVisible();

		// History: version 1 read-only, with its outline block; the review links to version 2.
		await gotoHydrated(page, '/train/history/1');
		await expect(page.getByTestId('older-version')).toBeVisible();
		const [, outline] = await blocksOf(seeded.programId!, 1);
		expect(outline).toMatchObject({ outline: true });
		await gotoHydrated(page, `${LIST}/c-${(await cycleReviews(lineageOf(seeded)))[0]!.id}`);
		await expect(card(page)).toHaveAttribute('data-state', 'applied');
		await expect(page.getByTestId('review-history')).toHaveText('See version 2 in History');
	});

	test('a rotated exercise kept is planned', async ({ page }) => {
		await createReview(page);
		const keep = page
			.getByTestId('next-cycle-keep')
			.getByRole('checkbox', { name: /Keep Bench press/ });
		await keep.check();
		await start(page).click();
		await expect(page).toHaveURL(/\/train\?tool=plan$/);
		const [row] = await query<{ dislikes: string[]; createdBy: string }>(
			`select input_snapshot->'dislikes' as dislikes, created_by as "createdBy"
			from program_versions where program_id = $1::uuid and number = 2`,
			[seeded.programId]
		);
		expect(row!.createdBy).toBe('owner');
		expect(row!.dislikes).not.toContain('bench_press');
	});

	test('a profile changed since the preview refreshes it, and Retry starts the fresh one', async ({
		page
	}) => {
		await createReview(page);
		const fingerprint = page.locator('input[name^="fingerprint:"]');
		const before = await fingerprint.inputValue();
		await query(
			`update schedules set days_per_week = 5, available_days = '{mon,tue,wed,thu,sat}',
				session_minutes = 75`
		);
		await start(page).click();
		await expect(page.getByTestId('next-cycle-failure')).toContainText('has been refreshed');
		await expect(fingerprint).not.toHaveValue(before);
		expect(await programVersions(seeded.programId!)).toHaveLength(1);
		await expect(start(page)).toHaveText('Retry');
		await start(page).click();
		await expect(page).toHaveURL(/\/train\?tool=plan$/);
		expect(await programVersions(seeded.programId!)).toHaveLength(2);
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('pending: aria-busy, and a second tap posts nothing (one version)', async ({ page }) => {
			await createReview(page);
			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(isStart, async (route) => {
				posts += 1;
				await held;
				await route.continue();
			});
			await start(page).click();
			await expect(start(page)).toHaveAttribute('aria-busy', 'true');
			await expect(card(page).locator('form[aria-busy="true"]')).toHaveCount(1);
			await start(page).dispatchEvent('click');
			await card(page)
				.locator('form[action="?/startCycle"]')
				.evaluate((form: HTMLFormElement) => form.requestSubmit());
			release();
			await expect(page).toHaveURL(/\/train\?tool=plan$/);
			expect(posts).toBe(1);
			expect(await programVersions(seeded.programId!)).toHaveLength(2);
		});
	});

	test('on a phone: axe is clean on the card, and the screen is captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await createReview(page);
		await card(page).scrollIntoViewIfNeeded();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Next block card');
		await captureScreen(page, testInfo, 'next-cycle-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the card in the review column, nothing scrolls sideways', async ({ page }, testInfo) => {
			await createReview(page);
			await expect(card(page)).toBeVisible();
			await expectNoSideScroll(page);
			await start(page).hover();
			await auditBothThemes(page, 'Next block card, desktop');
			await captureScreen(page, testInfo, 'next-cycle-desktop');
		});
	});
});

test.describe('block-end-late', () => {
	test('this week: starts today after an unplanned bridge, and starting creates both', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedReview(request, 'block-end-late');
		if (seeded.review.kind !== 'cycle') throw new Error('a cycle review');
		const { blockStartsOn, blockEndsOn } = seeded.review;
		const thisMonday = mondayOf(seeded.today);
		const next = addDays(blockEndsOn, 1);
		const k = daysBetween(next, thisMonday) / 7;
		const from = daysBetween(blockStartsOn, next) / 7 + 1;

		await createReview(page);
		const choice = page.getByTestId('next-cycle-start');
		await expect(choice.getByRole('radio', { name: /This week/ })).toBeChecked();
		await expect(choice).toContainText(
			`Starts today, ${WEEKDAY_INFO[weekdayOf(seeded.today)].label}`
		);
		await expect(preview(page)).toHaveCount(1);
		await expect(preview(page).getByTestId('next-cycle-bridge')).toHaveText(
			k === 1 ? `Week ${from} stays unplanned` : `Weeks ${from}–${from + k - 1} stay unplanned`
		);
		await expect(preview(page)).toContainText(`${shortDate(thisMonday)} – `);

		// Next Monday's preview: one more unplanned week, and the block a week later.
		await choice.getByText('Next Monday').click();
		await expect(preview(page)).toHaveCount(1);
		await expect(preview(page).getByTestId('next-cycle-bridge')).toHaveText(
			`Weeks ${from}–${from + k} stay unplanned`
		);
		await expect(preview(page)).toContainText(`${shortDate(addDays(thisMonday, 7))} – `);
		await auditBothThemes(page, 'Next block card, a late start');
		await captureScreen(page, testInfo, 'next-cycle-late');

		await choice.getByText('This week').click();
		await start(page).click();
		await expect(page).toHaveURL(/\/train\?tool=plan$/);
		const blocks = await blocksOf(seeded.programId!, 2);
		expect(blocks.slice(1, 3)).toMatchObject([
			{ phase: 'transition', startsOn: next, endsOn: addDays(thisMonday, -1) },
			{ outline: false, startsOn: thisMonday }
		]);
	});
});
