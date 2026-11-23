/**
 * Train's week findings (m7/04 train-week-findings), seeded with the periodisation-week fixture:
 * next week the owner moved Lower A from Friday to Monday, the day before Tuesday's hard Muay
 * Thai. The week's one line under its lines counts what is still ahead ('1 heads-up this week')
 * and opens, in place and even without JavaScript, the finding once, as its label and headline
 * ('Heads-up · …'), with its why. The week after reads 'No clashes this week'; this week's clash
 * has passed, so it shows nothing and reads 'No clashes ahead this week'; a past week and an
 * outline week show no findings line, a bridge week and 'First block complete' no line at all.
 * The findings match domain evaluateWeek over the week as Postgres holds it
 * (periodisation-support.ts). The lines keep their place while the page hydrates; axe is clean in
 * both themes, at 393 × 659 and in a 1440 × 900 window.
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
import { sessionLine } from './program-support';
import { seedReview } from './review-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** The fixture's weeks by number in the program (periodisation-week.ts FIXTURE_WEEKS). */
const WEEK = { past: 1, current: 2, moved: 3, clean: 4, outline: 5 } as const;

type Seeded = SeededAnalytics & { mondays: Record<keyof typeof WEEK, string> };

const HEADLINE = 'Heavy lower body the day before hard Muay Thai';
/** The finding on the moved session and Tuesday's class, listed once in the week's note. */
const NOTE = `Heads-up · ${HEADLINE}`;

const line = (page: Page) => page.getByTestId('week-line');
const findings = (page: Page) => page.getByTestId('week-findings');
/** A line about findings: the count, or that there are no clashes. */
const findingsLine = (page: Page) => line(page).filter({ hasText: /clash|heads-up|trade-off/ });

let seeded: Seeded;

test.describe('the periodisation week', () => {
	test.beforeAll(async ({ request }) => {
		seeded = (await seedAnalytics(request, 'periodisation-week')) as Seeded;
	});

	test('the week’s line opens the one heads-up on the moved session and Tuesday’s, matching the evaluation in SQL', async ({
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
		await expect(findings(page)).toBeHidden();
		await line(page).click();
		// The finding once, though it names Monday's moved Lower A and Tuesday's class, with no
		// words that place it on either. Wednesday's Upper A is in no finding.
		const notes = findings(page).locator('.finding');
		await expect(notes).toHaveText([NOTE]);
		await expect(notes.first()).toHaveAttribute('data-tone', 'caution');
		await expect(findings(page)).not.toContainText('Upper A');
		await expect(findings(page)).toContainText(evaluation.findings[0]!.why);
		await expect(findings(page)).toContainText('Why: ');
		await expect(findings(page)).toContainText('You moved Lower A here from Friday.');
		// The scheduler's dry-run fix (m7/22) may move the owner's own session back.
		await expect(findings(page)).toContainText('Moving Lower A to Friday clears this.');
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Train findings, the owner-move week');
		await captureScreen(page, testInfo, 'train-findings-phone');
	});

	test('the week after reads ‘No clashes this week’ and holds no heads-up', async ({ page }) => {
		expect((await weekEvaluation(seeded.mondays.clean, seeded.today)).findings).toEqual([]);
		await gotoHydrated(page, `/train?week=${WEEK.clean}`);
		await expect(line(page)).toHaveText('No clashes this week');
		await expect(findings(page)).toHaveCount(0);
	});

	test('a clash whose day has passed is not shown: this week reads ‘No clashes ahead this week’', async ({
		page
	}) => {
		const { findings: found } = await weekEvaluation(seeded.mondays.current, seeded.today);
		// On a Monday nothing of this week has passed: the fixture plans no clash then.
		expect(found.map((f) => f.actionable)).toEqual(seeded.lineages.passed ? [false] : []);
		await gotoHydrated(page, '/train');
		await expect(line(page)).toHaveText('No clashes ahead this week');
		await expect(findings(page)).toHaveCount(0);
		if (seeded.lineages.passed) {
			const yesterday = addDays(seeded.today, -1);
			await expect(sessionLine(page, 'Lower B', yesterday)).toBeVisible();
		}
	});

	test('a past week and an outline week show no findings line', async ({ page }) => {
		await gotoHydrated(page, `/train?week=${WEEK.past}`);
		await expect(page.getByTestId('week-lines')).toBeVisible();
		// A past week's line, if it has one, is only why each day holds its session.
		await expect(findingsLine(page)).toHaveCount(0);
		await expect(findings(page)).toHaveCount(0);
		await gotoHydrated(page, `/train?week=${WEEK.outline}`);
		await expect(page.getByTestId('train-not-planned')).toContainText('Not planned yet');
		await expect(line(page)).toBeHidden();
	});

	test('the lines and the week line keep their place while the page hydrates', async ({ page }) => {
		await page.goto(`/train?week=${WEEK.moved}`, { waitUntil: 'domcontentloaded' });
		await expectNoShift(page, {
			action: () => page.waitForLoadState('networkidle'),
			boxes: [line(page), page.getByTestId('session-card').first(), page.getByTestId('week-lines')]
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		// v2/07a1 opens the week's note in place, a native disclosure, so it opens without
		// JavaScript too (a sheet, from v2/07a2, will need it).
		test('the server renders the week line, and the heads-up opens from it', async ({ page }) => {
			await page.goto(`/train?week=${WEEK.moved}`);
			await expect(line(page)).toHaveText('1 heads-up this week');
			await line(page).click();
			await expect(findings(page).locator('.finding')).toHaveText([NOTE]);
			await expect(findings(page)).toContainText('You moved Lower A here from Friday.');
		});
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the week line sits under the lines in the column, with hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, `/train?week=${WEEK.moved}`);
			await expect(line(page)).toHaveText('1 heads-up this week');
			const week = (await page.getByTestId('week-lines').boundingBox())!;
			const box = (await line(page).boundingBox())!;
			expect(Math.abs(box.x - week.x)).toBeLessThan(1);
			expect(Math.abs(box.width - week.width)).toBeLessThan(1);
			expect(box.y).toBeGreaterThanOrEqual(week.y + week.height - 1);
			await expectNoSideScroll(page);
			const colour = () => line(page).evaluate((el) => getComputedStyle(el).color);
			const quiet = await colour();
			await line(page).hover();
			await expect.poll(colour).not.toBe(quiet);
			await line(page).focus();
			await page.keyboard.press('Enter');
			await expect(findings(page)).toBeVisible();
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
