/**
 * The season on Train's plan sheet (m7/39 periodisation-timeline), seeded with the
 * periodisation-road fixtures (src/lib/server/test-support/analytics-fixtures/periodisation-road.ts):
 * - multiGoal, M7-built: Plan lists the blocks Postgres holds, from the fight camp through the
 *   marathon's road; the camp's lanes read 'Muay Thai fight · leads', 'Marathon · secondary' and
 *   'Build muscle · maintenance'; the fight and the race are pinned on their weeks; the deload,
 *   taper and recovery weeks carry their word; this week is ringed; outline blocks are no links;
 *   a long run of outline weeks is one counted row, legible at 320 px. By keyboard every planned
 *   week is reached with a visible focus ring, and the region, links and lanes have their names.
 * - While the season streams (the test route's 'slow' fault holds the read), the sheet opens on
 *   M3's timeline, aria-busy, saying 'Loading your season' politely; released, the season lands
 *   with no layout shift (Chromium's layout-shift entries, and every block's and week's box on
 *   any engine).
 * - A road read that fails ('fail') leaves M3's timeline with no error shown, and is recorded; a
 *   sheet whose code fails still offers M3's Retry.
 * - offSeason: maintenance blocks with every goal held and no pin. M3's hybrid with no mode
 *   decisions: its roles are 'worked out from your goals'.
 * - From 1024 px a segmented track runs above the list with the events and today; week links have
 *   hover and focus states.
 * Axe is clean in both themes with the sheet open, loading and loaded; screens are captured at 320,
 * 393 × 659 and 1440 × 900.
 *
 * Serial: the program and the road fault are the one owner's and the one server's.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { ANALYTICS_TZ, auditBothThemes, resetAnalytics, seedAnalytics } from './analytics-support';
import { DESKTOP, expectNoShift, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, query, SAME_ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Your plan' });
const season = (page: Page) => sheet(page).getByRole('region', { name: 'Your season' });
const blocks = (page: Page) => sheet(page).getByTestId('plan-block');
const blockNamed = (page: Page, name: string) =>
	blocks(page).filter({ has: page.getByRole('heading', { name, exact: true }) });
const lanes = (block: Locator) => block.locator('.lanes li');

/** Hold, fail or clear Train's road read (PUT /api/test-support/analytics). */
async function roadFault(request: APIRequestContext, roadFault: 'none' | 'slow' | 'fail') {
	const response = await request.put('/api/test-support/analytics', {
		headers: SAME_ORIGIN,
		data: { roadFault }
	});
	expect(response.status(), `road fault '${roadFault}'`).toBe(200);
}

/** The active program's blocks as Postgres holds them, in order. */
async function storedBlocks() {
	return query<{ name: string; outline: boolean }>(
		`select b.name, b.outline from program_blocks b join programs p on p.id = b.program_id
		  where p.status = 'active' order by b.position`
	);
}

async function openPlan(page: Page) {
	await page.getByTestId('open-plan').click();
	await expect(sheet(page)).toBeVisible();
}

/** Plan opened on Train, the season landed. */
async function openSeason(page: Page) {
	await gotoHydrated(page, '/train');
	await openPlan(page);
	await expect(season(page)).toHaveAttribute('aria-busy', 'false');
	await expect(sheet(page).locator('.lanes li').first()).toBeVisible();
}

/** A screen while a read is held: fonts.status, never fonts.ready (WebKit resolves it late). */
async function captureHeld(page: Page, name: string) {
	await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
	await page.waitForTimeout(400); // the sheet's entrance settles
	await page.screenshot({
		path: `test-results/screens/${test.info().project.name}/${name}.png`,
		animations: 'disabled'
	});
}

test.describe('an M7-built multiGoal season', () => {
	test.beforeAll(async ({ request }) => {
		await roadFault(request, 'none');
		await seedAnalytics(request, 'periodisation-road');
	});
	test.afterEach(async ({ request }) => {
		await roadFault(request, 'none');
	});
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('Plan shows the phases to both events, each goal’s role, the ticks and this week', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await openSeason(page);
		const stored = await storedBlocks();
		await expect(blocks(page).getByRole('heading', { level: 3 })).toHaveText(
			stored.map((b) => b.name)
		);
		expect(stored.slice(0, 2).map((b) => b.name)).toEqual(['Fight camp', 'Recovery']);
		expect(stored.map((b) => b.name)).toContain('Marathon taper');

		const camp = blockNamed(page, 'Fight camp');
		await expect(lanes(camp)).toHaveText([
			'Muay Thai fight · leads',
			'Marathon · secondary',
			'Build muscle · maintenance',
			'Keep strength · maintenance'
		]);
		await expect(camp).toHaveAttribute('data-tone', 'build');
		// Pinned on their weeks: the fight in the camp, the race in the taper.
		await expect(camp.getByTestId('plan-event')).toContainText('Muay Thai fight');
		const taper = blockNamed(page, 'Marathon taper');
		await expect(taper.getByTestId('plan-event')).toContainText('Marathon');
		await expect(taper).toHaveAttribute('data-tone', 'taper');
		// The words on the weeks: the camp's deload, the taper's start, each recovery.
		await expect(camp.locator('.tick')).toHaveText(['Deload']);
		await expect(taper.locator('.tick')).toHaveText(['Taper']);
		await expect(blockNamed(page, 'Recovery').first().locator('.tick')).toHaveText(['Recovery']);
		// This week: ringed, and named.
		const current = sheet(page).locator('[aria-current="date"]');
		await expect(current).toHaveCount(1);
		await expect(current).toContainText('This week');
		expect(await current.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
		// Outline blocks are no links; the marathon build's six outline weeks are one counted row.
		for (const [i, block] of stored.entries()) {
			if (block.outline) await expect(blocks(page).nth(i).getByRole('link')).toHaveCount(0);
		}
		const build = blockNamed(page, 'Marathon build');
		await expect(build.getByTestId('plan-weeks')).toContainText('6 weeks · Not planned yet');
		await expect(build.getByTestId('plan-week')).toHaveCount(0);

		await auditBothThemes(page, 'Train’s plan, the season');
		await captureScreen(page, testInfo, 'train-road-phone');
	});

	test('by keyboard every planned week is reached with a visible ring; the names are spoken', async ({
		page
	}) => {
		await openSeason(page);
		await expect(season(page)).toBeVisible();
		const first = sheet(page).getByRole('link', { name: /^Week 1\b/ });
		await expect(first).toHaveAccessibleName(/This week/);
		for (let i = 0; i < 12 && !(await first.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(first).toBeFocused();
		expect(await first.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		await page.keyboard.press('Tab');
		await expect(sheet(page).getByRole('link', { name: /^Week 2\b/ })).toBeFocused();
		// The camp's lanes are a list of plain sentences.
		const list = blockNamed(page, 'Fight camp').getByRole('list').first();
		await expect(list.getByRole('listitem').first()).toHaveText('Muay Thai fight · leads');
	});

	test('at 320 px the long road stays legible: no side scroll, the outline counted', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await openSeason(page);
		await expectNoSideScroll(page);
		const width = (await sheet(page).locator('.sheet').boundingBox())!.width;
		for (const lane of await sheet(page).locator('.lanes li').all()) {
			expect((await lane.boundingBox())!.width).toBeLessThanOrEqual(width);
		}
		// Every outline week either listed (an event's) or counted: fewer rows than weeks.
		const rows = await sheet(page)
			.locator('[data-testid="plan-week"], [data-testid="plan-weeks"]')
			.count();
		const weeks = await query<{ weeks: number }>(
			`select ((max(b.ends_on) - min(b.starts_on) + 1) / 7)::int as weeks from program_blocks b
			   join programs p on p.id = b.program_id where p.status = 'active'`
		);
		expect(rows).toBeLessThan(weeks[0]!.weeks);
		await captureScreen(page, testInfo, 'train-road-320');
	});

	test('while the season streams: M3’s timeline, aria-busy, then the season with no shift', async ({
		page,
		request
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await roadFault(request, 'slow');
		// A client navigation streams Train's data: the week first, the held season after it.
		await gotoHydrated(page, '/today');
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Train' })
			.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		await openPlan(page);
		await expect(season(page)).toHaveAttribute('aria-busy', 'true');
		await expect(sheet(page)).toContainText('Loading your season');
		await expect(blocks(page).first()).toBeVisible();
		await expect(sheet(page).locator('.lanes li')).toHaveCount(0);
		await auditBothThemes(page, 'Train’s plan, the season loading');
		await captureHeld(page, 'train-road-loading');

		const boxes = [
			...(await blocks(page).all()),
			...(await sheet(page).getByTestId('plan-week').all())
		];
		await expectNoShift(page, {
			boxes,
			action: async () => {
				await roadFault(request, 'none');
				await expect(season(page)).toHaveAttribute('aria-busy', 'false');
				await expect(lanes(blockNamed(page, 'Fight camp'))).toHaveCount(4);
			}
		});
		await expect(sheet(page)).not.toContainText('Loading your season');
		await auditBothThemes(page, 'Train’s plan, the season loaded');
		await captureScreen(page, testInfo, 'train-road-loaded');
	});

	test('a road read that fails leaves M3’s timeline, with no error shown, and is recorded', async ({
		page,
		request
	}) => {
		await roadFault(request, 'fail');
		await gotoHydrated(page, '/train');
		await openPlan(page);
		await expect(season(page)).toHaveAttribute('aria-busy', 'false');
		await expect(blocks(page).first()).toBeVisible();
		await expect(sheet(page).locator('.lanes li')).toHaveCount(0);
		// M3's timeline exactly: no track (a blank band from 1024 px) and every outline week listed.
		await expect(sheet(page).locator('.track')).toHaveCount(0);
		await expect(sheet(page).getByTestId('plan-weeks')).toHaveCount(0);
		await expect(sheet(page).getByRole('alert')).toHaveCount(0);
		const recorded = await query<{ n: number }>(
			`select count(*)::int as n from app_errors
			  where context->>'part' = 'road' and occurred_at > now() - interval '2 minutes'`
		);
		expect(recorded[0]!.n).toBeGreaterThan(0);
	});

	test.describe('with the service worker blocked', () => {
		// page.route sees a request from a page the service worker controls only without it (WebKit).
		test.use({ serviceWorkers: 'block' });

		test('a sheet whose code fails still offers M3’s Retry, which opens the season', async ({
			page
		}) => {
			const manifest = JSON.parse(
				readFileSync(
					path.resolve(import.meta.dirname, '../.svelte-kit/output/client/.vite/manifest.json'),
					'utf8'
				)
			) as Record<string, { file: string } | undefined>;
			const file = manifest['src/lib/ui/program/PlanOverviewSheet.svelte']?.file;
			expect(file, 'the plan sheet is in the build under test').toBeTruthy();
			const chunk = `**/${file}`;
			await page.route(chunk, (route) => route.abort('internetdisconnected'));
			await gotoHydrated(page, '/train');
			await page.getByTestId('open-plan').click();
			const notice = page.getByRole('alert').filter({ hasText: 'Couldn’t open your plan' });
			await expect(notice).toBeVisible();
			await page.unroute(chunk);
			await notice.getByRole('button', { name: 'Try again' }).click();
			await expect(sheet(page)).toBeVisible();
			await expect(lanes(blockNamed(page, 'Fight camp'))).toHaveCount(4);
		});
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the track runs above the list with the events and today; weeks have hover and focus', async ({
			page
		}, testInfo) => {
			await openSeason(page);
			const track = sheet(page).locator('.track');
			await expect(track).toBeVisible();
			await expect(track).toHaveAttribute('aria-hidden', 'true');
			await expect(track.locator('.segment')).toHaveCount((await storedBlocks()).length);
			await expect(track.locator('.mark[data-kind="pin"]')).toHaveCount(2);
			await expect(track.locator('.mark[data-kind="now"]')).toHaveCount(1);
			await expect(track.locator('.legend')).toContainText('Muay Thai fight');
			await expect(track.locator('.legend')).toContainText('Marathon');
			const list = (await blocks(page).first().boundingBox())!;
			expect((await track.boundingBox())!.y).toBeLessThan(list.y);

			const week = sheet(page).getByRole('link', { name: /^Week 2\b/ });
			const quiet = await week.evaluate((el) => getComputedStyle(el).backgroundColor);
			await week.hover();
			await expect
				.poll(() => week.evaluate((el) => getComputedStyle(el).backgroundColor))
				.not.toBe(quiet);
			await week.focus();
			expect(await week.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Train’s plan, the season, desktop');
			await captureScreen(page, testInfo, 'train-road-desktop');
		});
	});
});

test.describe('an off-season', () => {
	test.beforeAll(async ({ request }) => {
		await seedAnalytics(request, 'periodisation-road-off-season');
	});
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('maintenance blocks hold every goal, with no pin', async ({ page }) => {
		await openSeason(page);
		await expect(lanes(blocks(page).first())).toHaveText([
			'Keep strength · maintenance',
			'Keep running fitness · maintenance'
		]);
		await expect(blocks(page).first()).toHaveAttribute('data-tone', 'maintenance');
		await expect(sheet(page).getByTestId('plan-event')).toHaveCount(0);
		await expect(sheet(page).locator('.mark[data-kind="pin"]')).toHaveCount(0);
	});
});

test.describe('a program built before M7', () => {
	test.beforeAll(async ({ request }) => {
		await seedAnalytics(request, 'periodisation-road-m3');
	});
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('its roles are worked out from its goals, and say so', async ({ page }) => {
		await openSeason(page);
		const first = blocks(page).first();
		await expect(first.getByText('Goal roles · worked out from your goals')).toBeVisible();
		await expect(lanes(first).first()).toHaveText('Marathon · leads');
	});
});
