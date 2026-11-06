/**
 * The program display components on /design → Plan, on one fixture week (Wednesday 4
 * November 2026 is today). WeekStrip: seven named days Monday first, the server's today, dots
 * hidden behind each day's name, selection by tap and by arrow keys. SessionCard: every state in
 * words (baseline, pending, done, skipped, moved, read-only). PrescriptionLines: describe.ts's
 * words, with no load it cannot compute. Every target is ≥ 44 px and nothing scrolls sideways at
 * 393 px; at 1440 × 900 the panel keeps a readable width, with hover and focus states.
 * Runs on Chromium and WebKit; axe for the same panel lives in a11y.e2e.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { captureScreen, trackConsoleErrors } from './support';

async function openProgram(page: Page) {
	await page.goto('/design');
	// The tabs only switch once the page has hydrated; network idle stands in for that.
	await page.waitForLoadState('networkidle');
	await page.getByRole('tab', { name: 'Plan' }).click();
	await expect(page.getByRole('heading', { name: 'Session card' })).toBeVisible();
	return page.getByRole('radiogroup', { name: 'Week 1' });
}

/** A colour token as the browser computes it, to compare with a computed background. */
function tokenColor(page: Page, token: string) {
	return page.evaluate((t) => {
		const probe = document.createElement('span');
		probe.style.color = `var(${t})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, token);
}

const DAYS = [
	'Monday 2 November, 1 session, 1 done',
	'Tuesday 3 November, 2 sessions, 1 done, 1 skipped',
	'Wednesday 4 November, today, 2 sessions',
	'Thursday 5 November, 2 sessions',
	'Friday 6 November, no sessions',
	'Saturday 7 November, 1 session',
	'Sunday 8 November, no sessions'
];

test.describe('/design → Plan', () => {
	test("the week strip names seven days Monday first, rings the server's today and hides its dots", async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const strip = await openProgram(page);
		const days = strip.getByRole('radio');
		await expect(days).toHaveCount(7);
		for (const [i, name] of DAYS.entries()) await expect(days.nth(i)).toHaveAccessibleName(name);

		// Today (the fixture's server date) is marked, starts selected and is the one tab stop.
		const wednesday = days.nth(2);
		await expect(wednesday).toHaveAttribute('aria-current', 'date');
		await expect(strip.locator('[aria-current]')).toHaveCount(1);
		await expect(wednesday).toBeChecked();
		await expect(strip.getByRole('radio', { checked: true })).toHaveCount(1);
		await expect(strip.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(wednesday).toHaveAttribute('tabindex', '0');

		// A dot per session in its discipline's colour, a skipped one as a ring; none on a rest day.
		await expect(strip.locator('.dots[aria-hidden="true"]')).toHaveCount(7);
		const tuesday = days.nth(1).locator('.dot');
		await expect(tuesday).toHaveCount(2);
		await expect(tuesday.nth(0)).toHaveClass(/\bring\b/);
		await expect(tuesday.nth(1)).not.toHaveClass(/\bring\b/);
		const background = (dot: typeof tuesday) =>
			dot.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(await background(tuesday.nth(1))).toBe(await tokenColor(page, '--color-combat'));
		expect(await background(days.nth(0).locator('.dot'))).toBe(
			await tokenColor(page, '--color-strength')
		);
		await expect(days.nth(4).locator('.dot')).toHaveCount(0);

		await strip.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-program-week');
		expect(errors).toEqual([]);
	});

	test('the week strip selects one day at a time, by tap and by arrow keys, Home and End', async ({
		page
	}, testInfo) => {
		const strip = await openProgram(page);
		const days = strip.getByRole('radio');
		const value = page.getByTestId('week-value');
		await expect(value).toHaveText('selected: 2026-11-04');

		// A tap on the phone; a click where there is no touch screen.
		if (testInfo.project.use.hasTouch) await days.nth(4).tap();
		else await days.nth(4).click();
		await expect(days.nth(4)).toBeChecked();
		await expect(days.nth(2)).not.toBeChecked();
		await expect(value).toHaveText('selected: 2026-11-06');
		// Today keeps its mark, and the tab stop follows the selection.
		await expect(days.nth(2)).toHaveAttribute('aria-current', 'date');
		await expect(days.nth(4)).toHaveAttribute('tabindex', '0');
		await expect(strip.locator('[tabindex="0"]')).toHaveCount(1);

		await days.nth(4).focus();
		await page.keyboard.press('ArrowRight');
		await expect(days.nth(5)).toBeFocused();
		await expect(days.nth(5)).toBeChecked();
		await expect(value).toHaveText('selected: 2026-11-07');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await expect(days.nth(3)).toBeFocused();
		await expect(value).toHaveText('selected: 2026-11-05');
		await page.keyboard.press('Home');
		await expect(days.nth(0)).toBeChecked();
		// The ends wrap, as in every radio group.
		await page.keyboard.press('ArrowLeft');
		await expect(days.nth(6)).toBeFocused();
		await expect(days.nth(6)).toBeChecked();
		await page.keyboard.press('ArrowRight');
		await expect(days.nth(0)).toBeChecked();
		await page.keyboard.press('End');
		await expect(days.nth(6)).toBeFocused();
		await expect(value).toHaveText('selected: 2026-11-08');
		await expect(strip.getByRole('radio', { checked: true })).toHaveCount(1);
	});

	test('session cards say every state in words, the pending one busy', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openProgram(page);
		const panel = page.getByRole('tabpanel');
		/** A card link: named by everything it shows, title first (label in name). */
		const card = (title: string) => panel.getByRole('link', { name: new RegExp(`^${title} `) });

		const cards = [
			'Upper body strength Strength · 55 min · Moderate · Morning Baseline',
			'Easy run Easy run · 30 min · Easy · Morning',
			'Lower body strength Strength · 60 min · Hard · Morning Done',
			'Intervals Intervals · 45 min · Hard · Morning Skipped',
			'Mobility Mobility · 20 min · Easy Moved from Mon'
		];
		await expect(panel.getByRole('link')).toHaveCount(cards.length);
		for (const [i, name] of cards.entries()) {
			await expect(panel.getByRole('link').nth(i)).toHaveAccessibleName(name);
		}

		// Pending: busy while its link navigates, with the progress line; no other card is.
		await expect(card('Easy run')).toHaveAttribute('aria-busy', 'true');
		await expect(card('Easy run').locator('.progress')).toBeVisible();
		await expect(panel.locator('[aria-busy="true"]')).toHaveCount(1);
		await expect(panel.locator('.progress')).toHaveCount(1);

		// Status words, with the discipline dot a ring once skipped.
		await expect(card('Intervals').locator('.dot')).toHaveClass(/\bring\b/);
		await expect(card('Lower body strength').locator('.dot')).not.toHaveClass(/\bring\b/);
		await expect(card('Upper body strength').getByText('Baseline')).toBeVisible();
		await expect(card('Mobility').getByText('Moved from Mon')).toBeVisible();

		// Read-only (an older version): the same card without a link, a chevron or a badge.
		const readOnly = page.getByTestId('card-read-only');
		await expect(readOnly).toHaveText(
			/^\s*Muay Thai class\s*Muay Thai · 90 min · Hard · Evening\s*$/
		);
		await expect(readOnly.getByRole('link')).toHaveCount(0);
		await expect(readOnly.locator('svg')).toHaveCount(0);

		await card('Upper body strength').evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await captureScreen(page, testInfo, 'design-program-cards');
		expect(errors).toEqual([]);
	});

	test("prescription lines read describe.ts's words and show no load they cannot compute", async ({
		page
	}, testInfo) => {
		await openProgram(page);
		const items = (name: string) => page.getByRole('list', { name }).locator(':scope > li');

		const squat = items('Back squat');
		await expect(squat).toHaveCount(2);
		await expect(squat.nth(0)).toHaveText(
			/^Work up to a set of 5 @ RPE 7\s*Record the weight, reps and RPE you reach, so your 1RM can be estimated\.\s*Rest 3:00$/
		);
		// Back-off sets from an estimate the baseline has not given yet: a fraction, no number.
		await expect(squat.nth(1)).toHaveText(/^3 × 5\s*75 % of your week-1 estimate · Rest 2:00$/);
		await expect(page.getByRole('list', { name: 'Back squat' })).not.toContainText('kg');

		const bench = items('Bench press');
		await expect(bench.nth(0)).toHaveText(
			/^3 × 5 @ RPE 7\s*70 kg\s*70 % of your measured 1RM · Rest 2:00$/
		);
		await expect(bench.nth(1)).toHaveText(/^3 × 8–12 @ RPE 8\s*Rest 1:30 · Tempo 3010$/);

		const run = items('Intervals');
		await expect(run).toHaveCount(3);
		await expect(run.nth(0)).toHaveText(/^Warm-up 10:00\s*HR zone 2$/);
		await expect(run.nth(1).locator('p')).toHaveText('6 × (Interval 400 m + Recovery 1:30)');
		await expect(run.nth(1).getByRole('listitem')).toHaveText([
			'Interval 400 m · 3:45–4:00 /km · RPE 8',
			'Recovery 1:30 · RPE 3'
		]);
		await expect(run.nth(2)).toHaveText(/^Cool-down 10:00\s*HR zone 1$/);

		await page.getByRole('list', { name: 'Bench press' }).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-program-lines');
	});

	test('every target is at least 44 × 44 px', async ({ page }) => {
		await openProgram(page);
		const targets = page.getByRole('tabpanel').locator('a, button');
		// Seven days and five card links.
		await expect(targets).toHaveCount(12);
		for (const target of await targets.all()) {
			const box = (await target.boundingBox())!;
			const name = await target.getAttribute('aria-label');
			expect(box.width, name ?? undefined).toBeGreaterThanOrEqual(44);
			expect(box.height, name ?? undefined).toBeGreaterThanOrEqual(44);
		}
	});

	test('nothing scrolls sideways at 393 px', async ({ page }) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await openProgram(page);
		await page.evaluate(() => document.fonts.ready);
		// At rest: the tab indicator's spring overshoots the last tab for a few frames.
		await expect
			.poll(() =>
				page.evaluate(() =>
					document
						.getAnimations()
						.every(
							(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
						)
				)
			)
			.toBe(true);
		const { scrollWidth, innerWidth } = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth
		}));
		expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
		expect(innerWidth, 'the layout viewport was not widened').toBe(393);
		// The strip, every card and every list stay inside the panel, within the page's gutters.
		const panel = (await page.getByRole('tabpanel').boundingBox())!;
		const parts = page.getByRole('tabpanel').locator('[role="radiogroup"], .card, ol');
		await expect(parts).toHaveCount(1 + 6 + 3);
		for (const part of await parts.all()) {
			const box = (await part.boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(panel.x - 0.5);
			expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
		}
	});
});

test.describe('/design → Plan at 1440 × 900', () => {
	test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

	test('the panel keeps its readable width, names days in three letters and shows hover and focus', async ({
		page
	}, testInfo) => {
		const strip = await openProgram(page);
		// The reference page's column, not a phone layout stretched to the window.
		const panel = (await page.getByRole('tabpanel').boundingBox())!;
		expect(panel.width).toBeLessThanOrEqual(34 * 16);
		expect(panel.x).toBeGreaterThan((1440 - 34 * 16) / 2 - 1);
		await expect(strip.getByText('Wed', { exact: true })).toBeVisible();
		await expect(strip.getByText('W', { exact: true })).toBeHidden();

		const card = page.getByRole('link', { name: /^Upper body strength / });
		const border = () => card.evaluate((el) => getComputedStyle(el).borderTopColor);
		const resting = await border();
		await card.hover();
		await expect.poll(border).not.toBe(resting);

		// Keyboard focus: the day's face takes the ring, and so does a card.
		await strip.getByRole('radio', { checked: true }).focus();
		await page.keyboard.press('ArrowRight');
		const thursday = strip.getByRole('radio', { name: /^Thursday/ });
		await expect(thursday).toBeFocused();
		expect(await thursday.evaluate((el) => getComputedStyle(el, '::before').outlineStyle)).toBe(
			'solid'
		);
		await card.focus();
		expect(await card.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

		await captureScreen(page, testInfo, 'design-program-desktop');
	});
});
