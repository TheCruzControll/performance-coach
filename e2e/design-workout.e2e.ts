/**
 * /design → Workout at the iPhone size (393 × 659): every src/lib/ui/workout component in each of
 * its states, each said in words and screenshotted on its own; every control at least 44 × 44 px;
 * nothing scrolls sideways; and at 200 % text every control can still be reached and is not cut
 * off. Runs on Chromium and WebKit; axe for both themes lives in a11y-suite.ts, the desktop window
 * in design-workout.desktop.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { answerHistory, openWorkoutPanel, pick } from './design-workout';
import { expectNoSideScroll } from './desktop';
import { captureScreen, trackConsoleErrors } from './support';

/** Scrolls a state into view and saves its screenshot. */
async function shoot(page: Page, target: Locator, name: string) {
	await target.scrollIntoViewIfNeeded();
	await captureScreen(page, test.info(), `design-workout-${name}`);
}

/**
 * Every control's hit area at least 44 × 44 px: how far around its middle a tap still lands on it,
 * so a compact button's ::after extension counts (as in design-coach.e2e.ts).
 */
async function expectHitAreas(targets: Locator) {
	for (const target of await targets.all()) {
		if (!(await target.isVisible())) continue;
		const name = (await target.getAttribute('aria-label')) ?? (await target.textContent());
		const area = await target.evaluate((el) => {
			el.scrollIntoView({ block: 'center', inline: 'center' });
			const r = el.getBoundingClientRect();
			const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
			const on = (x: number, y: number) => {
				const hit = document.elementFromPoint(x, y);
				return Boolean(hit) && (hit === el || el.contains(hit));
			};
			const reach = (dx: number, dy: number) => {
				let n = 0;
				while (n < 40 && on(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
				return n;
			};
			return on(cx, cy)
				? { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 }
				: { width: 0, height: 0 };
		});
		expect(area.height, `${name} is tall enough to tap`).toBeGreaterThanOrEqual(44);
		expect(area.width, `${name} is wide enough to tap`).toBeGreaterThanOrEqual(44);
	}
}

/** The panel's targets: its buttons and the faces of its radios. */
const targetsOf = (panel: Locator) => panel.locator('button, label:has(input[type="radio"])');

/** Everything it can be operated with: the targets, and the steppers' typed values. */
const controlsOf = (panel: Locator) =>
	panel.locator('button, [role="spinbutton"], label:has(input[type="radio"])');

test.describe('/design → Workout', () => {
	test('every state renders, each said in words', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		const panel = await openWorkoutPanel(page);
		expect(page.viewportSize()?.width).toBe(393);
		await captureScreen(page, test.info(), 'design-workout');

		const rows = panel.getByTestId('set-rows').getByTestId('set');
		await expect(rows).toHaveCount(7);
		const states = ['done', 'missed', 'skipped', 'current', 'todo', 'extra', 'not-saved'];
		for (const [i, state] of states.entries())
			await expect(rows.nth(i)).toHaveAttribute('data-state', state);
		await expect(rows.nth(1)).toContainText('2 missed');
		await expect(rows.nth(3)).toHaveAttribute('aria-current', 'step');
		await expect(rows.nth(6)).toContainText('Not saved on this device');
		await expect(rows.nth(0).getByRole('button', { name: /^Edit set\s1\b/ })).toBeVisible();
		await expect(rows.nth(3).getByRole('button', { name: 'Plates for set 4' })).toBeVisible();
		await shoot(page, panel.getByTestId('set-rows'), 'set-rows');

		for (const phase of ['running', 'paused', 'over'])
			await expect(panel.getByTestId(`rest-${phase}`).getByTestId('rest-timer')).toHaveAttribute(
				'data-phase',
				phase
			);
		await expect(panel.getByTestId('rest-over')).toContainText('Rest over');
		await shoot(page, panel.getByTestId('rest-running'), 'rest');

		const clocks = panel.getByTestId('stopwatches').getByRole('timer');
		await expect(clocks).toHaveCount(2);
		await expect(clocks.nth(1)).toHaveAttribute('aria-label', 'Workout time, paused');
		// The running one pauses, the paused one resumes: the controls work.
		await panel.getByRole('button', { name: 'Pause workout time' }).first().click();
		await expect(clocks.nth(0)).toHaveAttribute('data-paused', '');
		await panel
			.getByRole('button', { name: /paused: resume or reset/ })
			.nth(1)
			.click();
		const sheet = page.getByRole('dialog', { name: 'Workout time paused' });
		await sheet.getByRole('button', { name: 'Resume workout time' }).click();
		await expect(sheet).toBeHidden();
		await expect(clocks.nth(1)).not.toHaveAttribute('data-paused', '');

		const pills = panel.getByTestId('sync-pills').getByRole('status');
		await expect(pills).toHaveText([
			'Saved',
			'Saving…',
			'Offline · 3 pending',
			'Can’t connect · 3 waiting',
			'Retrying in 12 s',
			'2 need attention',
			'Sign in to sync · 4 waiting',
			'Finish adding your passkey'
		]);
		await shoot(page, panel.getByTestId('sync-pills'), 'sync');
		await expectNoSideScroll(page);
		expect(errors).toEqual([]);
	});

	test('the logger takes every measure and load type, its RPE one radio group', async ({
		page
	}) => {
		const panel = await openWorkoutPanel(page);
		const logger = panel.getByTestId('set-logger');
		const kinds: [string, string | null, string][] = [
			['Barbell', 'Weight', 'Reps'],
			['Bodyweight', 'Added weight', 'Reps'],
			['Assisted', 'Assistance', 'Reps'],
			['Unloaded', null, 'Reps'],
			['Time', 'Added weight', 'Time'],
			['Distance', 'Weight', 'Distance']
		];
		for (const [kind, load, amount] of kinds) {
			await pick(panel, 'logger-kind', kind);
			const field = (name: string) => logger.getByRole('spinbutton', { name, exact: true });
			if (load) await expect(field(load)).toBeVisible();
			else await expect(logger.getByTestId('logger-load')).toHaveCount(0);
			await expect(field(amount)).toBeVisible();
			await expect(logger.getByRole('group', { name: 'RPE' }).getByRole('radio')).toHaveCount(10);
			await expect(logger.getByTestId('missed-toggle')).toHaveCount(amount === 'Reps' ? 1 : 0);
			await expectNoSideScroll(page);
			await shoot(page, logger, `logger-${kind.toLowerCase()}`);
		}
		await pick(panel, 'logger-kind', 'Barbell');
		await logger.getByTestId('missed-toggle').click();
		await expect(
			logger.getByRole('spinbutton', { name: 'Missed reps', exact: true })
		).toBeVisible();
		await shoot(page, logger, 'logger-missed');
	});

	test('the exercise card: baseline, A1, swapped, stopped and still checking last time', async ({
		page
	}) => {
		const panel = await openWorkoutPanel(page);
		const card = panel.getByTestId('exercise');
		const cases: [string, string | null, string][] = [
			['Baseline', null, 'Last time · none yet'],
			['A1 / A2', null, 'Last time · 4 days ago'],
			['Swapped', 'Swapped for this session', 'No previous sets on this device'],
			['Stopped', 'Stopped', 'Last time · 7 days ago'],
			['Checking', 'Swapped for this session', 'Last time · checking']
		];
		for (const [kind, state, previous] of cases) {
			await pick(panel, 'card-kind', kind);
			if (state) await expect(card.getByTestId('slot-state')).toContainText(state);
			else await expect(card.getByTestId('slot-state')).toHaveCount(0);
			await expect(card.getByTestId('exercise-previous')).toContainText(previous);
			await expectNoSideScroll(page);
			await shoot(page, card, `card-${kind.split(' ')[0]!.toLowerCase()}`);
		}
		await pick(panel, 'card-kind', 'A1 / A2');
		await expect(card.locator('.badge')).toHaveText('A1');
		await pick(panel, 'card-kind', 'Stopped');
		await expect(card.getByRole('button', { name: 'Exercise options' })).toHaveCount(0);
		await expect(card.locator('[aria-current]')).toHaveCount(0);
	});

	test('Up next: the superset partner, between exercises, and every exercise done', async ({
		page
	}) => {
		const panel = await openWorkoutPanel(page);
		const upNext = panel.getByTestId('up-next');
		await expect(upNext).toContainText('A2');
		await expect(upNext).toContainText('Plank');
		await expect(upNext).toContainText('45 s at RPE 7');
		await shoot(page, upNext, 'up-next-partner');

		await pick(panel, 'up-next-kind', 'Between exercises');
		await expect(upNext.getByRole('button', { name: 'Start Pull-up' })).toBeVisible();
		await shoot(page, upNext, 'up-next-between');

		await pick(panel, 'up-next-kind', 'All done');
		await expect(upNext).toContainText('Every exercise done');
		await expect(upNext.getByTestId('up-next-finish')).toBeVisible();
		await shoot(page, upNext, 'up-next-done');
		await expectNoSideScroll(page);
	});

	test.describe('the exercise history sheet', () => {
		test.use({ serviceWorkers: 'block' });

		test('opens from the card and from its button, answered and offline', async ({
			page,
			context
		}) => {
			await answerHistory(page);
			const panel = await openWorkoutPanel(page);
			await panel.getByTestId('exercise-history-open').click();
			const sheet = page.getByTestId('exercise-history-sheet');
			await expect(sheet.getByTestId('history-best')).toContainText('Estimated 1RM · 123.5 kg');
			await expect(sheet.getByTestId('history-session')).toHaveCount(2);
			await captureScreen(page, test.info(), 'design-workout-history');
			await page.keyboard.press('Escape');
			await expect(sheet).toBeHidden();

			await context.setOffline(true);
			await panel.getByTestId('open-history').click();
			await expect(sheet.getByTestId('exercise-history-offline')).toBeVisible();
			await expect(sheet.getByTestId('history-set')).toHaveCount(2);
			await captureScreen(page, test.info(), 'design-workout-history-offline');
			await context.setOffline(false);
		});
	});

	test('every control is at least 44 × 44 px', async ({ page }) => {
		const panel = await openWorkoutPanel(page);
		await panel.getByTestId('missed-toggle').click();
		await expectHitAreas(targetsOf(panel));
		await pick(panel, 'up-next-kind', 'Between exercises');
		await expectHitAreas(panel.getByTestId('up-next').getByRole('button'));
	});

	test('at 200 % text every control can be reached and is not cut off', async ({ page }) => {
		const panel = await openWorkoutPanel(page);
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		await panel.getByTestId('missed-toggle').click();
		for (const control of await controlsOf(panel).all()) {
			if (!(await control.isVisible())) continue;
			const name = (await control.getAttribute('aria-label')) ?? (await control.textContent());
			const fit = await control.evaluate((el) => {
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
				// Every ancestor that clips its overflow holds the whole control.
				const clippedBy: string[] = [];
				for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
					const style = getComputedStyle(a);
					if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
					const b = a.getBoundingClientRect();
					const inside =
						r.left >= b.left - 1 &&
						r.right <= b.right + 1 &&
						r.top >= b.top - 1 &&
						r.bottom <= b.bottom + 1;
					if (!inside) clippedBy.push(a.className || a.tagName);
				}
				return { reached: Boolean(hit) && (hit === el || el.contains(hit)), clippedBy };
			});
			expect(fit.reached, `${name} can be reached`).toBe(true);
			expect(fit.clippedBy, `${name} is not cut off`).toEqual([]);
		}
		await captureScreen(page, test.info(), 'design-workout-200');
	});
});
