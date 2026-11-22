/**
 * 'Why this day?' on Train (m7/14 placement-why), seeded with the periodisation-week fixture:
 * next week the owner moved Lower A from Friday to Monday. Under its card a native disclosure,
 * closed by default, titled 'Why Monday?', lists the owner's move first and then version 1's
 * placement, which names the rule that kept the heavy legs off the day before hard Muay Thai.
 * It opens by tap (a click without a touch screen), Enter and Space, and without JavaScript. Its
 * lines match the decisions Postgres holds for the session. Sessions no decision names (this
 * week's, and the long run on the day it prefers) have none. axe is clean in both themes with one open, at 393 × 659 and in a
 * 1440 × 900 window, where the summary has hover and focus states.
 *
 * Serial: the program is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, query } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** The fixture's weeks by number in the program (periodisation-week.ts FIXTURE_WEEKS). */
const WEEK = { current: 2, moved: 3 } as const;
const RULE = 'Heavy lower body the day before hard Muay Thai';

/** The why right after the card titled `title` and its finding's note, if any. */
const whyOf = (page: Page, title: string) =>
	page
		.getByTestId('session-card')
		.filter({ hasText: title })
		.locator('xpath=following-sibling::details[contains(@class, "why")][1]');
const day = (page: Page, n: number) => page.getByTestId('week-strip').getByRole('radio').nth(n);

/** The decisions that name `lineage`, newest first, as the store holds them. */
async function decisionsFor(lineage: string) {
	return query<{ kind: string; why: string; decided_by: string; number: number }>(
		`select d.kind, d.why, d.decided_by, v.number
		   from programming_decisions d join program_versions v on v.id = d.version_id
		  where d.affected ? $1
		    and d.kind in ('session_moved', 'schedule_repaired', 'priority_tradeoff',
		                   'interference_resolved', 'maintenance_dose', 'session_placed',
		                   'commitment_placed')
		  order by d.created_at desc, d.id desc`,
		[lineage]
	);
}

async function expectClosed(why: Locator) {
	await expect(why).not.toHaveAttribute('open');
	await expect(why.locator('li').first()).toBeHidden();
}

let seeded: SeededAnalytics;

test.beforeAll(async ({ request }) => {
	seeded = await seedAnalytics(request, 'periodisation-week');
});

test.afterAll(async () => {
	await resetAnalytics();
});

test('the moved Lower A says why it is on Monday: your move first, then the rule', async ({
	page
}, testInfo) => {
	const stored = await decisionsFor(seeded.lineages.moved!);
	expect(stored.map((d) => [d.kind, d.decided_by, d.number])).toEqual([
		['session_moved', 'owner', 2],
		['interference_resolved', 'rules', 1]
	]);
	expect(stored[1]!.why).toContain(RULE);

	await gotoHydrated(page, `/train?week=${WEEK.moved}`);
	const why = whyOf(page, 'Lower A');
	await expect(why.locator('summary')).toHaveText('Why Monday?');
	await expectClosed(why);
	const summary = why.locator('summary');
	expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);

	// A tap on the phone; a click where there is no touch screen.
	if (testInfo.project.use.hasTouch) await summary.tap();
	else await summary.click();
	await expect(why).toHaveAttribute('open', '');
	await expect(why.locator('li')).toHaveText([
		`Session moved (You, version 2): ${stored[0]!.why}`,
		`Interference avoided (Programming rules, version 1): ${stored[1]!.why}`
	]);
	await expect(why.locator('li').nth(1)).toContainText(RULE);
	await expectNoSideScroll(page);
	await auditBothThemes(page, 'Train, why this day, open');
	await captureScreen(page, testInfo, 'train-why-phone');

	// The keyboard: Enter closes it, Space opens it again.
	await summary.focus();
	await page.keyboard.press('Enter');
	await expectClosed(why);
	await page.keyboard.press('Space');
	await expect(why).toHaveAttribute('open', '');
	await expect(why.locator('li').first()).toBeVisible();
});

test('a session a decision names says why, Tuesday’s class by its commitment', async ({ page }) => {
	await gotoHydrated(page, `/train?week=${WEEK.moved}`);
	await day(page, 1).click();
	const why = whyOf(page, 'Muay Thai class');
	await expect(why.locator('summary')).toHaveText('Why Tuesday?');
	await why.locator('summary').click();
	await expect(why.locator('li')).toHaveText([
		/^Commitment placed \(Programming rules, version 1\): /
	]);
	// No generator stage writes session_placed: the long run on its preferred day has none.
	await day(page, 6).click();
	await expect(page.getByTestId('session-card').filter({ hasText: 'Long run' })).toBeVisible();
	await expect(page.locator('details.why')).toHaveCount(0);
});

test('this week’s sessions, which no decision names, have no disclosure', async ({ page }) => {
	// Yesterday's Lower B (none on a Monday) is in no decision, as the store holds them.
	if (seeded.lineages.passed) expect(await decisionsFor(seeded.lineages.passed)).toEqual([]);
	await gotoHydrated(page, `/train?week=${WEEK.current}`);
	for (let n = 0; n < 7; n++) {
		await day(page, n).click();
		await expect(page.getByTestId('day-sessions')).toBeVisible();
		await expect(page.locator('details.why')).toHaveCount(0);
	}
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the server renders it closed, and it opens', async ({ page }) => {
		await page.goto(`/train?week=${WEEK.moved}`);
		const why = whyOf(page, 'Lower A');
		await expect(why.locator('summary')).toHaveText('Why Monday?');
		await expectClosed(why);
		await why.locator('summary').click();
		await expect(why).toHaveAttribute('open', '');
		await expect(why.locator('li').nth(1)).toContainText(RULE);
	});
});

test.describe('in a desktop window', () => {
	test.use({ ...DESKTOP });

	test('it sits under its card in the day’s column, with hover and focus states', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, `/train?week=${WEEK.moved}`);
		const why = whyOf(page, 'Lower A');
		const card = (await page
			.getByTestId('session-card')
			.filter({ hasText: 'Lower A' })
			.boundingBox())!;
		const box = (await why.boundingBox())!;
		expect(Math.abs(box.x - card.x)).toBeLessThan(1);
		expect(Math.abs(box.width - card.width)).toBeLessThan(1);
		expect(box.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
		const summary = why.locator('summary');
		const colour = () => summary.evaluate((el) => getComputedStyle(el).color);
		const quiet = await colour();
		await summary.hover();
		await expect.poll(colour).not.toBe(quiet);
		await summary.focus();
		expect(await summary.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		await page.keyboard.press('Space');
		await expect(why).toHaveAttribute('open', '');
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Train, why this day, desktop');
		await captureScreen(page, testInfo, 'train-why-desktop');
	});
});
