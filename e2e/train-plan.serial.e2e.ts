/**
 * Train's plan overview (src/lib/ui/program/PlanOverviewSheet.svelte, BlockTimeline.svelte):
 * Plan, in the program header's actions row, opens a sheet code-split out of Train that lists
 * every block with its phase, dates and weeks. This week is marked, an outline block's weeks are
 * not planned yet and never links, and a dated goal sits in its week. A planned week opens on
 * Train through the week change's pending state; Close and Escape give the focus back to Plan;
 * and a sheet whose code fails to load offers Retry beside Plan, which opens it. Serial: the
 * program and the goals are the one owner's (e2e/program-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { FIXTURE_GOAL } from '../src/lib/server/test-support/program-fixtures';
import { shortDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const SHEET = 'src/lib/ui/program/PlanOverviewSheet.svelte';
const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');

/** The URL pattern of a module's chunk in the build under test, from Vite's manifest. */
function chunkOf(source: string): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[source];
	if (!chunk) throw new Error(`${source} is not in the build under test`);
	return `**/${chunk.file}`;
}

async function audit(page: Page): Promise<string[]> {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(500); // the sheet's entrance settles: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

const plan = (page: Page) => page.getByTestId('open-plan');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Your plan' });
const blocks = (page: Page) => sheet(page).getByTestId('plan-block');
const position = (page: Page) => page.getByTestId('program-position');
/** 'Mon 9 Nov – Sun 15 Nov': `from` and the day `days` after it, in words. */
const range = (from: string, days: number) =>
	`${shortDate(from)} – ${shortDate(addDays(from, days))}`;

async function openPlan(page: Page) {
	await plan(page).click();
	await expect(sheet(page)).toBeVisible();
}

test.describe('a program this week', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
	});

	test('Plan lists every block with its phase, dates and weeks, this week marked', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/train');
		await openPlan(page);
		await expect(sheet(page)).toContainText('Strength, running and Muay Thai');

		await expect(blocks(page).getByRole('heading', { level: 3 })).toHaveText([
			'Baseline week',
			'Accumulation'
		]);
		await expect(blocks(page).getByTestId('plan-block-span')).toHaveText([
			`${range(seeded.weekStart, 6)} · 1 week`,
			`${range(addDays(seeded.weekStart, 7), 27)} · 4 weeks`
		]);
		await expect(blocks(page).first()).toHaveAttribute('data-current', '');
		await expect(blocks(page).last()).not.toHaveAttribute('data-current');

		// Every planned week links to itself on Train, with its dates; this week says so.
		const links = sheet(page).getByRole('link');
		await expect(links).toHaveCount(5);
		for (const n of [1, 2, 3, 4, 5]) {
			const link = links.nth(n - 1);
			await expect(link).toHaveAttribute('href', `/train?week=${n}`);
			await expect(link).toContainText(`Week ${n}`);
			await expect(link).toContainText(range(addDays(seeded.weekStart, 7 * (n - 1)), 6));
		}
		const current = sheet(page).locator('[aria-current="date"]');
		await expect(current).toHaveCount(1);
		await expect(current).toContainText('Week 1');
		await expect(current).toContainText('This week');
		await expect(sheet(page).getByText('Not planned yet')).toHaveCount(0);
		await captureScreen(page, testInfo, 'train-plan');
		expect(errors).toEqual([]);
	});

	test('a week tapped in the plan shows on Train, through the week change’s pending state', async ({
		page
	}) => {
		await gotoHydrated(page, '/train');
		await openPlan(page);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/__data.json*', async (route) => {
			await held;
			await route.continue();
		});

		await sheet(page)
			.getByRole('link', { name: /^Week 3\b/ })
			.click();
		await expect(sheet(page)).toBeHidden();
		await expect(page.getByTestId('train-week')).toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('link', { name: /^Week 3$/ })).toHaveAttribute('aria-busy', 'true');
		await expect(position(page)).toHaveText('Baseline week · Week 1 of 5');

		release();
		await expect(page).toHaveURL(/\/train\?week=3$/);
		await expect(position(page)).toHaveText('Accumulation · Week 3 of 5');
		await expect(page.getByTestId('train-week')).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('link', { name: /^Week 3$/ })).toHaveAttribute(
			'aria-current',
			'page'
		);
	});

	test('Close and Escape give the focus back to Plan', async ({ page }) => {
		await gotoHydrated(page, '/train');
		// From the keyboard: WebKit focuses no button on a click.
		await plan(page).focus();
		await page.keyboard.press('Enter');
		await expect(sheet(page)).toBeVisible();
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(plan(page)).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(sheet(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(plan(page)).toBeFocused();
	});

	test('the open sheet passes axe in dark and light', async ({ page }) => {
		await gotoHydrated(page, '/train');
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/train');
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			await openPlan(page);
			expect(await audit(page), `axe, ${theme}`).toEqual([]);
		}
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('Plan has its hover and focus states, and the sheet keeps to the window', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			const border = () => plan(page).evaluate((el) => getComputedStyle(el).borderColor);
			const rest = await border();
			await plan(page).hover();
			await expect.poll(border, { message: 'a hover state' }).not.toBe(rest);

			await openPlan(page);
			// From the sheet: Close, then the first week, which shows its focus ring.
			await page.keyboard.press('Tab');
			await page.keyboard.press('Tab');
			const week = sheet(page).getByRole('link', { name: /^Week 1\b/ });
			await expect(week).toBeFocused();
			expect(
				await week.evaluate((el) => getComputedStyle(el).outlineStyle),
				'a focus ring'
			).not.toBe('none');
			await expectNoSideScroll(page);
			const box = await sheet(page).getByTestId('block-timeline').boundingBox();
			expect(box!.width, 'the timeline keeps a readable width').toBeLessThanOrEqual(34 * 16);
			await captureScreen(page, testInfo, 'train-plan-desktop');
		});
	});
});

test('an outline leads to the event date: its weeks are not planned yet, and never links', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'one-week', start: 'this_week' });
	// The goal the fixture's blocks serve, its fight on the Saturday of week 4: the outline's last.
	const fight = addDays(seeded.weekStart, 26);
	await query(
		`insert into training_goals (id, owner_id, kind, title, disciplines, priority, event_type, event_date)
		select $1, id, 'event', 'Fight night', '{muay_thai}', 1, 'Muay Thai fight', $2 from owners`,
		[FIXTURE_GOAL, fight]
	);
	await gotoHydrated(page, '/train');
	await openPlan(page);

	await expect(blocks(page).getByRole('heading', { level: 3 })).toHaveText([
		'Baseline week',
		'Accumulation'
	]);
	const outline = blocks(page).last();
	await expect(outline).toHaveAttribute('data-outline', '');
	await expect(outline).toContainText('Outline');
	await expect(outline.getByTestId('plan-block-span')).toHaveText(
		`${range(addDays(seeded.weekStart, 7), 20)} · 3 weeks`
	);

	// Only week 1 is planned: each outline week says so, and none is a link.
	await expect(sheet(page).getByRole('link')).toHaveCount(1);
	await expect(outline.getByRole('link')).toHaveCount(0);
	const weeks = outline.getByTestId('plan-week');
	await expect(weeks).toHaveCount(3);
	for (const [i, n] of [2, 3, 4].entries()) {
		await expect(weeks.nth(i)).toContainText(`Week ${n}`);
		await expect(weeks.nth(i)).toContainText('Not planned yet');
	}

	// The phases reach the fight, which sits in the outline's last week.
	const event = sheet(page).getByTestId('plan-event');
	await expect(event).toHaveCount(1);
	await expect(event).toContainText('Event');
	await expect(event).toContainText('Fight night');
	await expect(event).toContainText(shortDate(fight));
	await expect(outline.getByRole('listitem').last()).toContainText('Week 4');
	await expect(outline.getByRole('listitem').last()).toContainText('Fight night');
	await captureScreen(page, testInfo, 'train-plan-outline');
	expect(await audit(page)).toEqual([]);
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request the service worker answers, and it precaches every chunk.
	test.use({ serviceWorkers: 'block' });

	test.afterEach(async ({ page }) => {
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('the sheet is not part of Train’s load; a tap made before its code arrives opens it', async ({
		page,
		request
	}, testInfo) => {
		await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
		const chunk = chunkOf(SHEET);
		const requested: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(chunk, async (route) => {
			requested.push(route.request().url());
			await held;
			await route.continue();
		});
		await gotoHydrated(page, '/train');
		expect(requested, 'not fetched with Train').toEqual([]);

		await plan(page).click();
		await expect.poll(() => requested.length, { message: 'fetched on the tap' }).toBe(1);
		await expect(plan(page)).toHaveAttribute('aria-busy', 'true');
		await page.waitForTimeout(400); // past the beat before the spinner shows
		await captureScreen(page, testInfo, 'train-plan-pending');

		release();
		await expect(sheet(page)).toBeVisible();
		await expect(plan(page)).toHaveAttribute('aria-busy', 'false');
		expect(requested).toHaveLength(1);
	});

	test('a sheet whose code fails to load offers Retry beside Plan, which opens it', async ({
		page,
		request
	}, testInfo) => {
		await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
		const pageErrors: string[] = [];
		page.on('pageerror', (err) => pageErrors.push(err.message));
		const chunk = chunkOf(SHEET);
		await page.route(chunk, (route) => route.abort('internetdisconnected'));
		await gotoHydrated(page, '/train');

		await plan(page).click();
		const notice = page.getByRole('alert').filter({ hasText: 'Couldn’t open your plan' });
		await expect(notice).toBeVisible();
		await expect(page.getByTestId('plan-sheet')).toHaveCount(0);
		await expect(plan(page)).toHaveAttribute('aria-busy', 'false');
		const retry = notice.getByRole('button', { name: 'Retry' });
		const target = await retry.boundingBox();
		expect(target?.width, 'Retry is at least 44 px wide').toBeGreaterThanOrEqual(44);
		expect(target?.height, 'Retry is at least 44 px tall').toBeGreaterThanOrEqual(44);
		await captureScreen(page, testInfo, 'train-plan-retry');

		// Back online, Retry opens the sheet: in place where the browser fetches a failed module
		// again, or by reloading Train with ?tool=plan where it does not (Chromium).
		await page.unroute(chunk);
		await retry.click();
		await expect(sheet(page)).toBeVisible();
		await expect(blocks(page)).toHaveCount(2);
		await expect(notice).toHaveCount(0);
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(page).toHaveURL(/\/train$/);
		expect(pageErrors).toEqual([]);
	});
});
