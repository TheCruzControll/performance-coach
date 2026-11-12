/**
 * Train's week findings (m7/04 train-week-findings), seeded with the periodisation-week fixture:
 * next week the owner moved Lower A from Friday to Monday, the day before Tuesday's hard Muay
 * Thai. Each card that finding names carries one calm line ('Heads-up · …') whose why opens
 * from it, even without JavaScript, and the header counts what is still ahead. The week after
 * reads 'No clashes this week'; this week's clash has passed, so it shows nothing and reads 'No
 * clashes ahead this week'; a past week, an outline week, a bridge week and 'First block
 * complete' show no week line at all. The findings match domain evaluateWeek over the week as
 * Postgres holds it (periodisation-support.ts). The cards keep their place while the page
 * hydrates; axe is clean in both themes, at 393 × 659 and in a 1440 × 900 window.
 *
 * Serial: the program is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, expectNoShift, expectNoSideScroll } from './desktop';
import { weekEvaluation } from './periodisation-support';
import { seedReview } from './review-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** The fixture's weeks by number in the program (periodisation-week.ts FIXTURE_WEEKS). */
const WEEK = { past: 1, current: 2, moved: 3, clean: 4, outline: 5 } as const;

type Seeded = SeededAnalytics & { mondays: Record<keyof typeof WEEK, string> };

const HEADLINE = 'Heavy lower body the day before hard Muay Thai';
const MOVED_NOTE = `Heads-up · ${HEADLINE} · You moved this here`;
const TUESDAY_NOTE = `Heads-up · ${HEADLINE} · After Lower A the day before`;

const line = (page: Page) => page.getByTestId('week-line');
const notes = (page: Page) => page.locator('details.note');
/** The note right under the card titled `title`, among the day's cards. */
const noteOf = (page: Page, title: string) =>
	page
		.getByTestId('session-card')
		.filter({ hasText: title })
		.locator('xpath=following-sibling::*[1][self::details]');
const day = (page: Page, n: number) => page.getByTestId('week-strip').getByRole('radio').nth(n);

let seeded: Seeded;

test.describe('the periodisation week', () => {
	test.beforeAll(async ({ request }) => {
		seeded = (await seedAnalytics(request, 'periodisation-week')) as Seeded;
	});

	test('the moved card and Tuesday’s each carry the heads-up, matching the evaluation in SQL', async ({
		page
	}, testInfo) => {
		const evaluation = await weekEvaluation(seeded.mondays.moved, seeded.today);
		expect(
			evaluation.findings.map((f) => ({
				rule: f.rule,
				severity: f.severity,
				resolution: f.resolution?.kind,
				lineages: f.sessions.map((s) => s.lineage)
			}))
		).toEqual([
			{
				rule: 'placement.heavy_lower_before_hard',
				severity: 'avoid',
				resolution: 'owner_moved',
				lineages: [seeded.lineages.moved, seeded.lineages.hardMuayThai]
			}
		]);

		await gotoHydrated(page, `/train?week=${WEEK.moved}`);
		await expect(line(page)).toHaveText('1 heads-up this week');
		// Monday, the first day with a session, holds the moved Lower A.
		await expect(noteOf(page, 'Lower A').locator('summary')).toHaveText(MOVED_NOTE);
		await expect(noteOf(page, 'Lower A')).toHaveAttribute('data-tone', 'caution');
		const why = noteOf(page, 'Lower A').getByText(evaluation.findings[0]!.why, { exact: false });
		await expect(why).toBeHidden();
		await noteOf(page, 'Lower A').locator('summary').click();
		await expect(why).toBeVisible();
		await expect(noteOf(page, 'Lower A')).toContainText('You moved Lower A here from Friday.');
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Train findings, the owner-move week');
		await captureScreen(page, testInfo, 'train-findings-phone');

		await day(page, 1).click();
		await expect(noteOf(page, 'Muay Thai class').locator('summary')).toHaveText(TUESDAY_NOTE);
		await expect(notes(page)).toHaveCount(1);
		// Wednesday's Upper A is in no finding.
		await day(page, 2).click();
		await expect(page.getByTestId('session-card')).toContainText('Upper A');
		await expect(notes(page)).toHaveCount(0);
	});

	test('the week after reads ‘No clashes this week’ and shows no note', async ({ page }) => {
		expect((await weekEvaluation(seeded.mondays.clean, seeded.today)).findings).toEqual([]);
		await gotoHydrated(page, `/train?week=${WEEK.clean}`);
		await expect(line(page)).toHaveText('No clashes this week');
		for (let n = 0; n < 7; n++) {
			await day(page, n).click();
			await expect(notes(page)).toHaveCount(0);
		}
	});

	test('a clash whose day has passed is not shown: this week reads ‘No clashes ahead this week’', async ({
		page
	}) => {
		const { findings } = await weekEvaluation(seeded.mondays.current, seeded.today);
		// On a Monday nothing of this week has passed: the fixture plans no clash then.
		expect(findings.map((f) => f.actionable)).toEqual(seeded.lineages.passed ? [false] : []);
		await gotoHydrated(page, '/train');
		await expect(line(page)).toHaveText('No clashes ahead this week');
		await expect(notes(page)).toHaveCount(0);
		if (seeded.lineages.passed) {
			const yesterday = addDays(seeded.today, -1);
			await day(page, weekdayIndex(yesterday)).click();
			await expect(page.getByTestId('session-card').filter({ hasText: 'Lower B' })).toBeVisible();
			await expect(notes(page)).toHaveCount(0);
		}
	});

	test('a past week and an outline week show no week line', async ({ page }) => {
		await gotoHydrated(page, `/train?week=${WEEK.past}`);
		await expect(page.getByTestId('week-strip')).toBeVisible();
		await expect(line(page)).toBeHidden();
		await expect(notes(page)).toHaveCount(0);
		await gotoHydrated(page, `/train?week=${WEEK.outline}`);
		await expect(page.getByTestId('train-not-planned')).toContainText('Not planned yet');
		await expect(line(page)).toBeHidden();
	});

	test('the cards and the week line keep their place while the page hydrates', async ({ page }) => {
		await page.goto(`/train?week=${WEEK.moved}`, { waitUntil: 'domcontentloaded' });
		await expectNoShift(page, {
			action: () => page.waitForLoadState('networkidle'),
			boxes: [line(page), page.getByTestId('session-card').first(), noteOf(page, 'Lower A')]
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the note, and its why opens', async ({ page }) => {
			await page.goto(`/train?week=${WEEK.moved}`);
			await expect(line(page)).toHaveText('1 heads-up this week');
			const note = noteOf(page, 'Lower A');
			await expect(note.locator('summary')).toHaveText(MOVED_NOTE);
			await note.locator('summary').click();
			await expect(note).toHaveAttribute('open', '');
			await expect(note).toContainText('You moved Lower A here from Friday.');
		});
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the note sits under its card in the day’s column, with hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, `/train?week=${WEEK.moved}`);
			await expect(line(page)).toHaveText('1 heads-up this week');
			const note = noteOf(page, 'Lower A');
			const card = (await page.getByTestId('session-card').first().boundingBox())!;
			const box = (await note.boundingBox())!;
			expect(Math.abs(box.x - card.x)).toBeLessThan(1);
			expect(Math.abs(box.width - card.width)).toBeLessThan(1);
			expect(box.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
			await expectNoSideScroll(page);
			const summary = note.locator('summary');
			const colour = () => summary.evaluate((el) => getComputedStyle(el).color);
			const quiet = await colour();
			await summary.hover();
			await expect.poll(colour).not.toBe(quiet);
			await summary.focus();
			await page.keyboard.press('Enter');
			await expect(note).toHaveAttribute('open', '');
			await auditBothThemes(page, 'Train findings, desktop');
			await captureScreen(page, testInfo, 'train-findings-desktop');
		});
	});
});

test.describe('weeks where a clean line would mislead', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('a bridge week shows no week line', async ({ page, request }) => {
		await seedAnalytics(request, 'bridge-week');
		await gotoHydrated(page, '/train');
		await expect(page.getByTestId('train-bridge')).toBeVisible();
		await expect(page.getByTestId('program-position')).toContainText('Between blocks');
		await expect(line(page)).toBeHidden();
	});

	test('‘First block complete’ shows no week line', async ({ page, request }) => {
		await seedReview(request, 'block-end-late');
		await gotoHydrated(page, '/train');
		await expect(page.getByTestId('train-block-complete')).toBeVisible();
		await expect(line(page)).toBeHidden();
	});
});

/** A date's place in its Monday-first week. */
function weekdayIndex(date: string): number {
	return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}
