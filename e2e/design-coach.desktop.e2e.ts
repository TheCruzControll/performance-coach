/**
 * The coach's answer components on /design → Coach in a desktop window (1440 × 900): the panel
 * keeps the Components column, about a phone column wide and never wider than the readable
 * column, so no answer stretches; Tab walks its sources and disclosures in reading order with a
 * visible ring; Enter works the exercise button and the method; sources and the method take a
 * hover tint for the mouse. The composer, Thinking, loading rows and every notice keep the same
 * column; the keyboard sends with Enter, adds a line with Shift+Enter and shows a ring on the
 * composer; the composer, Stop and Retry answer the mouse. Screenshots in both themes.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openCoachPanel } from './coach-a11y';
import { boxOf, DESKTOP, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, trackConsoleErrors } from './support';

test.use(DESKTOP);

const answer = (page: Page) => page.getByTestId('answer-full');

/** The focused element's accessible name, as the sources and the summary carry it. */
const focusedName = (page: Page) =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
	});

const background = (target: Locator) =>
	target.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('/design → Coach on a desktop', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the panel keeps a readable column beside the gallery (${theme})`, async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await openCoachPanel(page);
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			const panel = await boxOf(page.getByRole('tabpanel'));
			const tabs = await boxOf(page.getByRole('tablist', { name: 'Component group' }));
			expect(Math.abs(panel.x - tabs.x), 'under its tabs').toBeLessThanOrEqual(1);
			expect(panel.width, 'about a phone column').toBeGreaterThanOrEqual(
				(await tokenPx(page, '--content-max')) - 40
			);
			expect(panel.width, 'never wider than the readable column').toBeLessThanOrEqual(
				await tokenPx(page, '--content-readable')
			);
			// The Cards & tones column sits beside it, so the page is not one stretched column.
			const cards = await boxOf(page.getByRole('heading', { name: 'Cards & tones' }));
			expect(cards.x, 'the next group is beside the panel').toBeGreaterThan(panel.x + panel.width);
			for (const block of await answer(page).getByTestId('answer-block').all()) {
				const box = await boxOf(block);
				expect(box.width).toBeLessThanOrEqual(panel.width + 1);
			}
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, `design-coach-${theme}-desktop`);
			expect(errors).toEqual([]);
		});
	}

	test('Tab walks the sources and the method in reading order, each with a visible ring', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		await page.getByRole('tab', { name: 'Coach' }).focus();
		await page.keyboard.press('Tab'); // the tab panel itself
		const expected = [
			'Lower body strength, Workout, Mon 2 Nov 2026',
			'Back squat top set, Set, Mon 2 Nov 2026',
			'How it’s calculated',
			'Back squat top set, Set, Mon 2 Nov 2026',
			'Set, Mon 26 Oct 2026',
			'Back squat, Exercise',
			'Lower body strength, Planned session, Fri 6 Nov 2026',
			'Left knee, 2 out of 10, Pain report, Wed 28 Oct 2026'
		];
		for (const name of expected) {
			await page.keyboard.press('Tab');
			expect(await focusedName(page)).toBe(name);
			const ring = await page.evaluate(() => {
				const style = getComputedStyle(document.activeElement!);
				return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
			});
			expect(ring.style, `${name} shows a ring`).not.toBe('none');
			expect(ring.width, `${name}'s ring`).toBeGreaterThanOrEqual(2);
			if (name === 'Back squat, Exercise')
				await captureScreen(page, testInfo, 'design-coach-focus-desktop');
		}

		// Enter works the exercise button and the method, without a mouse.
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Shift+Tab');
		expect(await focusedName(page)).toBe('Back squat, Exercise');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('open-exercise')).toHaveText('open-exercise: back_squat');
		const metric = answer(page).getByTestId('answer-block').nth(2);
		await metric.locator('summary').focus();
		await page.keyboard.press('Enter');
		await expect(metric.locator('details')).toHaveAttribute('open', '');
	});

	test('every answer state, scrolled into view, at 1440 × 900', async ({ page }, testInfo) => {
		await openCoachPanel(page);
		const shoot = async (target: Locator, name: string) => {
			await target.scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `design-coach-${name}-desktop`);
		};
		const metric = answer(page).getByTestId('answer-block').nth(2);
		await metric.locator('summary').click();
		await expect(metric.locator('details')).toHaveAttribute('open', '');
		await shoot(metric, 'method');
		await shoot(page.getByTestId('answer-unchecked'), 'unchecked');
		const long = page.getByTestId('answer-long');
		await shoot(long.getByRole('button', { name: 'Show all 15 parts' }), 'long');
		await long.getByRole('button', { name: 'Show all 15 parts' }).click();
		await expect(long.getByTestId('answer-block')).toHaveCount(15);
		await shoot(long.getByTestId('answer-block').nth(14), 'long-all');
		await shoot(page.getByTestId('answer-hostile'), 'untrusted');
		await shoot(page.getByTestId('activity-states'), 'activity');
		const next = page.getByTestId('stream-next');
		while ((await next.textContent())?.trim() !== 'Start again') await next.click();
		const streamed = page.getByTestId('answer-streaming');
		await expect(streamed.getByTestId('answer-block')).toHaveCount(6);
		await shoot(streamed, 'streamed');
		await expectNoSideScroll(page);
	});

	test('sources and the method take a hover tint for the mouse', async ({ page }) => {
		await openCoachPanel(page);
		const blocks = answer(page).getByTestId('answer-block');
		const targets = [
			blocks.nth(1).getByRole('link').first(),
			blocks.nth(3).getByRole('button', { name: 'Back squat, Exercise' }),
			blocks.nth(2).locator('summary')
		];
		for (const target of targets) {
			const before = await background(target);
			await target.hover();
			await expect.poll(() => background(target)).not.toBe(before);
			expect(await target.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
		}
		// A source with no screen of its own takes none: it is not a control.
		const plain = blocks.nth(5).locator('.source').first();
		const before = await background(plain);
		await plain.hover();
		await page.waitForTimeout(250);
		expect(await background(plain)).toBe(before);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`the composer, Thinking and every notice stay in the panel's column (${theme})`, async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await openCoachPanel(page);
			const panel = await boxOf(page.getByRole('tabpanel'));
			const parts = [
				...(await page.getByRole('form', { name: 'Message your coach' }).all()),
				page.getByTestId('thinking'),
				page.getByTestId('loading-rows'),
				...(await page
					.locator('[data-testid^="notice-"]:not([data-testid="notice-readout"])')
					.all())
			];
			expect(parts.length).toBe(4 + 2 + 20);
			for (const part of parts) {
				const box = await boxOf(part);
				expect(box.x, `${part} starts in the panel`).toBeGreaterThanOrEqual(panel.x - 1);
				expect(box.x + box.width, `${part} ends in the panel`).toBeLessThanOrEqual(
					panel.x + panel.width + 1
				);
			}
			await expectNoSideScroll(page);
			for (const area of ['composer-running', 'thinking', 'notice-unavailable', 'notice-empty']) {
				await page.getByTestId(area).scrollIntoViewIfNeeded();
				await captureScreen(page, testInfo, `design-coach-${area}-${theme}-desktop`);
			}
			expect(errors).toEqual([]);
		});
	}

	test('the keyboard sends with Enter, adds a line with Shift+Enter, and rings the composer', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const ready = page.getByTestId('composer-ready');
		const input = ready.getByRole('textbox', { name: 'Message' });
		const shadow = () => ready.evaluate((el) => getComputedStyle(el).boxShadow);
		const resting = await shadow();
		await input.focus();
		await expect.poll(shadow, { message: 'the composer takes the focus ring' }).not.toBe(resting);
		await page.keyboard.type('Bench');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('and squat');
		await expect(input).toHaveValue('Bench\nand squat');
		await captureScreen(page, testInfo, 'design-coach-composer-focus-desktop');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('composer-readout')).toContainText('composer: sent: Bench');
		await expect(input).toHaveValue('');

		// Tab leaves the message for Send, then the running composer's message and Stop: each rings.
		await page.keyboard.type('Next');
		await page.keyboard.press('Tab');
		await expect(ready.getByRole('button', { name: 'Send' })).toBeFocused();
		const stop = page.getByTestId('composer-running').getByRole('button', { name: 'Stop' });
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await expect(stop).toBeFocused();
		const ring = await stop.evaluate((el) => getComputedStyle(el).outlineStyle);
		expect(ring).not.toBe('none');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('composer-readout')).toHaveText('composer: stopped');
	});

	test('the composer, Stop and Retry answer the mouse', async ({ page }) => {
		await openCoachPanel(page);
		const ready = page.getByTestId('composer-ready');
		const border = () => ready.evaluate((el) => getComputedStyle(el).borderColor);
		const before = await border();
		await ready.hover();
		await expect.poll(border).not.toBe(before);

		const targets = [
			page.getByTestId('composer-running').getByRole('button', { name: 'Stop' }),
			page.getByTestId('notice-provider').getByRole('button', { name: 'Try again' })
		];
		for (const target of targets) {
			await target.scrollIntoViewIfNeeded();
			const tint = await background(target);
			await target.hover();
			await expect.poll(() => background(target)).not.toBe(tint);
			expect(await target.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
		}
		// The disabled composer takes none: nothing there can be sent.
		const disabled = page.getByTestId('composer-disabled');
		const still = await disabled.evaluate((el) => getComputedStyle(el).borderColor);
		await disabled.hover();
		await page.waitForTimeout(250);
		expect(await disabled.evaluate((el) => getComputedStyle(el).borderColor)).toBe(still);
	});
});
