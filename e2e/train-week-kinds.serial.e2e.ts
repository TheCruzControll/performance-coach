/**
 * Week kinds on Train and Today (m7/38 week-kind-indicators), seeded with two fixtures:
 * - periodisation-week-kinds, M7-built: this week is a deload, the week after next a taper before
 *   a 10K race. Train's header names the deload ('Deload week') with its decision's summary and
 *   the race's countdown; the taper week's pill reads 'Taper' and its line counts down; a normal
 *   week has no line; Today's panel names the deload; History's older version is read-only and
 *   has no line.
 * - periodisation-m3-weeks, M3-built: the first block's deload week reads block_structure's
 *   summary, the taper and race weeks event_taper's, and the second block's deload, which no
 *   decision names, WEEK_KIND_WHY's reason; on Train and on Today.
 * The kind's badge never wraps at 320 px. Every line is compared with the decision Postgres
 * holds. Train's response carries Server-Timing 'periodisation'; Today's cannot, as its plan
 * streams after the headers, so its page data is gated in week-line.test.ts instead. Axe is clean in both themes at
 * 393 × 659 and in a 1440 × 900 window, where each screen is captured and the pills have hover
 * and focus states.
 *
 * Serial: the program is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { WEEK_KIND_WHY } from '../src/lib/domain/programming/periodisation/kinds';
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

/** The fixtures' weeks by number (periodisation-week-kinds.ts, periodisation-m3-weeks.ts). */
const M7 = { deload: 2, next: 3, taper: 4, race: 5 } as const;
const M3 = { deload: 5, taper: 7, race: 8, lateDeload: 9 } as const;

type Seeded = SeededAnalytics & { raceOn: string };

/** The newest stored summary of a decision of `kind` in the active program. */
async function summaryOf(kind: string) {
	const [row] = await query<{ summary: string }>(
		`select d.summary from programming_decisions d join programs p on p.id = d.program_id
		  where p.status = 'active' and d.kind = $1 order by d.created_at desc, d.id desc limit 1`,
		[kind]
	);
	return row!.summary;
}

/** '10K race in 24 days', from the server's today and the race's day. */
function countdown(seeded: Seeded, title: string) {
	const days = (Date.parse(seeded.raceOn) - Date.parse(seeded.today)) / 86_400_000;
	return `${title} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`;
}

const kindLine = (page: Page) => page.getByTestId('week-kind');
/** A pill's word, drawn after its number from data-mark: '"Deload"', or 'none'. */
const wordOf = (link: Locator) => link.evaluate((el) => getComputedStyle(el, '::before').content);
const pill = (page: Page, n: number) =>
	page
		.getByRole('navigation', { name: 'Weeks' })
		.getByRole('link', { name: new RegExp(`^Week ${n}\\b`) });

/** Train's kind line: its tag, drawn from data-tag, and its why. */
async function expectLine(page: Page, label: string, why: string) {
	await expect(kindLine(page)).toHaveAttribute('data-tag', label);
	await expect(kindLine(page)).toContainText(why);
}

test.describe('an M7-built program', () => {
	let seeded: Seeded;
	test.beforeAll(async ({ request }) => {
		seeded = (await seedAnalytics(request, 'periodisation-week-kinds')) as Seeded;
	});
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('this week’s deload is named with its decision’s why and the race’s countdown', async ({
		page
	}, testInfo) => {
		const response = await page.goto('/train');
		expect(response!.headers()['server-timing']).toMatch(/periodisation;dur=[\d.]+/);
		await gotoHydrated(page, '/train');
		await expectLine(page, 'Deload week', await summaryOf('deload_scheduled'));
		await expect(kindLine(page)).toContainText(countdown(seeded, '10K race'));
		await expect(pill(page, M7.deload)).toHaveAccessibleName('Week 2, Deload, this week');
		expect(await wordOf(pill(page, M7.deload))).toBe('"Deload"');
		await expect(pill(page, M7.next)).toHaveAccessibleName('Week 3');
		expect(await wordOf(pill(page, M7.next))).toBe('none');
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Train, a deload week');
		await captureScreen(page, testInfo, 'train-week-kind-deload-phone');
	});

	test('the taper week’s pill reads Taper, and its line counts down to the race', async ({
		page
	}) => {
		await gotoHydrated(page, `/train?week=${M7.taper}`);
		await expect(pill(page, M7.taper)).toHaveAccessibleName('Week 4, Taper');
		expect(await wordOf(pill(page, M7.taper))).toBe('"Taper"');
		expect(await wordOf(pill(page, M7.race))).toBe('"Event"');
		await expectLine(page, 'Taper', await summaryOf('taper_planned'));
		await expect(kindLine(page)).toContainText(countdown(seeded, '10K race'));
	});

	test('a normal week has no line', async ({ page }) => {
		await gotoHydrated(page, `/train?week=${M7.next}`);
		await expect(page.getByTestId('program-position')).toBeVisible();
		await expect(kindLine(page)).toBeHidden();
		await expect(kindLine(page)).toHaveText('');
	});

	test('the kind’s badge stays on one line at 320 px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/train');
		// The tag is the line's ::before: it never wraps, and the why wraps under it instead.
		const tag = await kindLine(page).evaluate((el) => {
			const { content, whiteSpace } = getComputedStyle(el, '::before');
			return { content, whiteSpace };
		});
		expect(tag.content).toBe('"Deload week"');
		expect(tag.whiteSpace).toBe('nowrap');
		const pillWord = pill(page, M7.deload);
		expect(await pillWord.evaluate((el) => getComputedStyle(el, '::before').whiteSpace)).toBe(
			'nowrap'
		);
		expect((await pill(page, M7.deload).boundingBox())!.height).toBe(44);
		await expectNoSideScroll(page);
	});

	test('Today’s panel names the deload', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/today');
		const line = page.getByTestId('today-plan').getByTestId('today-week-kind');
		await expect(line.getByTestId('week-kind-label')).toHaveText('Deload week');
		await expect(line).toContainText(await summaryOf('deload_scheduled'));
		await expect(line).toContainText(countdown(seeded, '10K race'));
		await auditBothThemes(page, 'Today, a deload week');
		await captureScreen(page, testInfo, 'today-week-kind-deload-phone');
	});

	test('History’s older version is read-only, with no line', async ({ page }) => {
		await gotoHydrated(page, '/train/history/1');
		await expect(page.getByTestId('older-version')).toContainText('Older version · read-only');
		await expect(kindLine(page)).toHaveCount(0);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the line sits under the titles, and the pills have hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, `/train?week=${M7.taper}`);
			const position = (await page.getByTestId('program-position').boundingBox())!;
			const line = (await kindLine(page).boundingBox())!;
			expect(line.y).toBeGreaterThanOrEqual(position.y + position.height - 1);
			expect(Math.abs(line.x - position.x)).toBeLessThan(1);
			const taper = pill(page, M7.taper);
			const quiet = await pill(page, M7.race).evaluate((el) => getComputedStyle(el).borderColor);
			await pill(page, M7.race).hover();
			await expect
				.poll(() => pill(page, M7.race).evaluate((el) => getComputedStyle(el).borderColor))
				.not.toBe(quiet);
			await taper.focus();
			expect(await taper.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await taper.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Train, a taper week, desktop');
			await captureScreen(page, testInfo, 'train-week-kind-taper-desktop');
		});

		test('Today names the deload beside its side column', async ({ page }, testInfo) => {
			await gotoHydrated(page, '/today');
			await expect(page.getByTestId('today-week-kind')).toContainText('Deload week');
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Today, a deload week, desktop');
			await captureScreen(page, testInfo, 'today-week-kind-deload-desktop');
		});
	});
});

test.describe('an M3-built program', () => {
	let seeded: Seeded;
	test.beforeAll(async ({ request }) => {
		seeded = (await seedAnalytics(request, 'periodisation-m3-weeks')) as Seeded;
	});
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('its deload, taper and race weeks say why, from M3’s decisions or the default', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/train');
		await expectLine(page, 'Deload week', await summaryOf('block_structure'));
		await expect(kindLine(page)).toContainText(countdown(seeded, '5K race'));
		await captureScreen(page, testInfo, 'train-week-kind-m3-phone');

		const taper = await summaryOf('event_taper');
		await gotoHydrated(page, `/train?week=${M3.taper}`);
		await expectLine(page, 'Taper', taper);
		await gotoHydrated(page, `/train?week=${M3.race}`);
		await expectLine(page, 'Event week', taper);
		await gotoHydrated(page, `/train?week=${M3.lateDeload}`);
		await expectLine(page, 'Deload week', WEEK_KIND_WHY.deload);
		await auditBothThemes(page, 'Train, an M3-built deload week');
	});

	test('Today names the first block’s deload with block_structure’s summary', async ({ page }) => {
		await gotoHydrated(page, '/today');
		const line = page.getByTestId('today-week-kind');
		await expect(line.getByTestId('week-kind-label')).toHaveText('Deload week');
		await expect(line).toContainText(await summaryOf('block_structure'));
	});
});
