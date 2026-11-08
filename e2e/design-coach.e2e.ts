/**
 * The coach's answer components on /design → Coach, at the iPhone size (393 × 659): every block
 * kind labelled in words, sources with dated accessible names, a metric in tabular figures with
 * its method behind a disclosure, the 'Not checked' badge, 'Show all' over 12 blocks, untrusted
 * text that stays literal, an exercise source that is a button for the page, activity chips in
 * their three states, and the live region reading each block and 'Answer complete'. Runs on
 * Chromium and WebKit; axe for both themes lives in a11y.e2e.ts (e2e/coach-a11y.ts), the desktop
 * window in design-coach.desktop.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openCoachPanel } from './coach-a11y';
import { boxOf, expectNoSideScroll } from './desktop';
import { captureScreen, trackConsoleErrors } from './support';

const answer = (page: Page) => page.getByTestId('answer-full');
const blocksOf = (area: Locator) => area.getByTestId('answer-block');

/** Every box at least 44 × 44 px (an inline link inside a sentence is exempt, as in WCAG). */
async function expectTargets(targets: Locator) {
	for (const target of await targets.all()) {
		const box = await boxOf(target);
		const name = (await target.getAttribute('aria-label')) ?? (await target.textContent());
		expect(box.height, `${name} is tall enough`).toBeGreaterThanOrEqual(44);
		expect(box.width, `${name} is wide enough`).toBeGreaterThanOrEqual(44);
	}
}

test.describe('/design → Coach', () => {
	test('labels every block kind in words, with a mark, never by colour alone', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openCoachPanel(page);
		const blocks = blocksOf(answer(page));
		await expect(blocks).toHaveCount(6);
		const labels = ['Note', 'Fact', 'Calculated', 'Recommendation', 'Safety', 'Note'];
		for (const [i, label] of labels.entries()) {
			const kind = blocks.nth(i).locator('.kind');
			// Uppercase is only the treatment: the words themselves are the label.
			await expect(kind).toHaveText(label);
			await expect(kind.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		}
		// Each kind has its own mark: the label never rests on the edge's colour.
		const marks = await blocks
			.locator('.kind use')
			.evaluateAll((uses) => uses.map((u) => u.getAttribute('href')?.split('#')[1]));
		expect(new Set(marks.slice(0, 5)).size).toBe(5);

		await expect(blocks.nth(1)).toContainText('You squatted 140 kg × 5 at RPE 8 on Monday.');
		await expect(blocks.nth(1).locator('strong')).toHaveText('140 kg × 5');
		await expect(blocks.nth(3).locator('.body').getByRole('listitem')).toHaveText([
			'Keep the top set at RPE 8.',
			'Add one back-off set at 120 kg × 5.'
		]);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'design-coach-answer');
		expect(errors).toEqual([]);
	});

	test('a metric reads in tabular figures, with how it was calculated behind a disclosure', async ({
		page
	}) => {
		await openCoachPanel(page);
		const metric = blocksOf(answer(page)).nth(2);
		const numerals = (target: Locator) =>
			target.evaluate((el) => getComputedStyle(el).fontVariantNumeric);
		expect(await numerals(metric.locator('.body p'))).toContain('tabular-nums');
		// Only a metric: a fact's numbers stay proportional.
		expect(await numerals(blocksOf(answer(page)).nth(1).locator('.body p'))).not.toContain(
			'tabular-nums'
		);

		const method = metric.getByText(
			'Epley: weight × (1 + reps ÷ 30), from your best set each week.'
		);
		await expect(method).toBeHidden();
		const summary = metric.locator('summary');
		await expect(summary).toHaveText('How it’s calculated');
		await summary.click();
		await expect(method).toBeVisible();
		await expect(metric.locator('details')).toHaveAttribute('open', '');
		await summary.click();
		await expect(method).toBeHidden();
		await expectTargets(metric.locator('summary'));
	});

	test('sources are dated rows: links to their screens, the exercise a button for the page', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const blocks = blocksOf(answer(page));

		const fact = blocks.nth(1).getByRole('list', { name: 'Sources' });
		await expect(fact.getByRole('link')).toHaveCount(2);
		const workout = fact.getByRole('link', {
			name: 'Lower body strength, Workout, Mon 2 Nov 2026',
			exact: true
		});
		await expect(workout).toHaveAttribute('href', '/progress/workouts/w-lower-1');
		await expect(workout.locator('time')).toHaveAttribute('datetime', '2026-11-02');
		await expect(workout).toContainText('Mon 2 Nov 2026');
		// A set opens the workout it was logged in; an unlabelled one is named by its kind.
		await expect(
			fact.getByRole('link', { name: 'Back squat top set, Set, Mon 2 Nov 2026', exact: true })
		).toHaveAttribute('href', '/progress/workouts/w-lower-1');
		await expect(
			blocks.nth(2).getByRole('link', { name: 'Set, Mon 26 Oct 2026', exact: true })
		).toHaveAttribute('href', '/progress/workouts/w-lower-0');
		await expect(
			blocks
				.nth(4)
				.getByRole('link', { name: 'Left knee, 2 out of 10, Pain report, Wed 28 Oct 2026' })
		).toHaveAttribute('href', '/progress/workouts/w-lower-0');

		// The exercise is a button, named by its words, and the page decides what it opens.
		const recommendation = blocks.nth(3);
		await expect(
			recommendation.getByRole('link', {
				name: 'Lower body strength, Planned session, Fri 6 Nov 2026'
			})
		).toHaveAttribute('href', '/train/session/lower-a');
		const squat = recommendation.getByRole('button', { name: 'Back squat, Exercise', exact: true });
		await expect(squat).toBeVisible();
		await expect(page.getByTestId('open-exercise')).toHaveText('open-exercise: none');
		await squat.click();
		await expect(page.getByTestId('open-exercise')).toHaveText('open-exercise: back_squat');
		await expect(page).toHaveURL(/\/design$/);

		// Sources with no screen of their own are words, not controls; a raw id never shows.
		const note = blocks.nth(5).getByRole('list', { name: 'Sources' });
		await expect(note.getByRole('link')).toHaveCount(0);
		await expect(note.getByRole('button')).toHaveCount(0);
		await expect(note.getByRole('listitem')).toHaveCount(2);
		await expect(note.getByRole('listitem').nth(0)).toContainText('Easy run after a heavy day');
		await expect(note.getByRole('listitem').nth(1)).toContainText('Thu 5 Nov 2026');
		await expect(answer(page)).not.toContainText('d-easy-1');
		await expect(answer(page)).not.toContainText('s-squat-0');

		await expectTargets(answer(page).locator('a.source, button.source'));
		await recommendation.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-sources');
	});

	test('a block the policy could not check says so in words', async ({ page }, testInfo) => {
		await openCoachPanel(page);
		const unchecked = page.getByTestId('answer-unchecked');
		await expect(unchecked.getByTestId('unchecked')).toHaveText('Not checked against your data');
		await expect(unchecked.getByTestId('unchecked').locator('svg')).toHaveCount(1);
		// Every grounded block goes without it.
		await expect(answer(page).getByTestId('unchecked')).toHaveCount(0);
		await unchecked.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-unchecked');
	});

	test('a long answer shows 12 blocks, then Show all reveals the rest and moves focus there', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const long = page.getByTestId('answer-long');
		await expect(blocksOf(long)).toHaveCount(12);
		await expect(long).not.toContainText('Week 13');
		const more = long.getByRole('button', { name: 'Show all 15 parts' });
		await more.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-long');
		await expectTargets(more);
		await more.click();
		await expect(blocksOf(long)).toHaveCount(15);
		await expect(more).toHaveCount(0);
		await expect(blocksOf(long).nth(12)).toBeFocused();
		await expect(blocksOf(long).nth(12)).toContainText('Week 13');
		await expect(blocksOf(long).nth(14)).toContainText('Week 15');
	});

	test('untrusted text stays literal: no markup, no formatting and no outside link', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const hostile = page.getByTestId('answer-hostile');
		await expect(hostile).toContainText(
			'<img src=x onerror="alert(1)"> and &amp; stay as written.'
		);
		await expect(hostile).toContainText(
			'**not bold**, _not italic_ and [a link](https://example.com) too.'
		);
		await expect(hostile.locator('code')).toHaveText('<script>alert(1)</script>');
		await expect(hostile).toContainText('not a link');
		await expect(hostile).toContainText('nor this');
		await expect(hostile).toContainText('<b>Monday</b>');
		await expect(hostile.locator('.body img, .body script, .body b, .body i')).toHaveCount(0);
		await expect(hostile.locator('.body strong, .body em')).toHaveCount(0);
		// No link in the words at all: neither javascript: nor a protocol-relative path.
		await expect(hostile.locator('.body a')).toHaveCount(0);
		// The source's label is words too, and its link is the app's own.
		const source = hostile.getByRole('link', {
			name: '<i>Lower body</i>, Workout, Mon 2 Nov 2026',
			exact: true
		});
		await expect(source).toHaveAttribute('href', '/progress/workouts/w-lower-1');
		await expect(source.locator('i')).toHaveCount(0);
		await hostile.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-untrusted');
	});

	test('activity chips say running, done and failed in words, each with its own mark', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const chips = page.getByTestId('activity-states').locator('.activity');
		await expect(chips).toHaveCount(3);
		await expect(chips.nth(0)).toHaveAttribute('data-state', 'running');
		await expect(chips.nth(0)).toHaveText(/…$/);
		await expect(chips.nth(0).locator('.spinner')).toHaveCount(1);
		await expect(chips.nth(1)).toHaveAttribute('data-state', 'done');
		await expect(chips.nth(1)).toContainText('6');
		await expect(chips.nth(1).locator('use')).toHaveAttribute('href', /#check$/);
		await expect(chips.nth(2)).toHaveAttribute('data-state', 'failed');
		await expect(chips.nth(2)).toHaveText(/^Couldn’t/);
		await expect(chips.nth(2).locator('use')).toHaveAttribute('href', /#alert$/);
		const texts = await chips.allTextContents();
		expect(new Set(texts.map((t) => t.trim())).size).toBe(3);
		await chips.nth(0).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-activity');
	});

	test('the live region reads each completed block once, then Answer complete', async ({
		page
	}) => {
		await openCoachPanel(page);
		const log = page.getByRole('log', { name: 'Coach answer updates' });
		await expect(log).toHaveAttribute('aria-live', 'polite');
		await expect(log.locator('p')).toHaveCount(0);
		const live = page.getByTestId('activity-live');
		await expect(live).toHaveAttribute('data-state', 'running');

		const next = page.getByTestId('stream-next');
		await next.click();
		await expect(live).toHaveAttribute('data-state', 'done');
		await expect(log.locator('p')).toHaveText([
			'Note: Your squat is moving well. Here is what the last two weeks show.'
		]);
		await next.click();
		await expect(log.locator('p').nth(1)).toHaveText(
			'Fact: You squatted 140 kg × 5 at RPE 8 on Monday.'
		);
		for (let i = 2; i < 6; i++) await next.click();
		await expect(log.locator('p')).toHaveCount(7);
		await expect(log.locator('p').nth(4)).toHaveText(/^Safety: Stop the set/);
		await expect(log.locator('p').last()).toHaveText('Answer complete');
		await expect(next).toHaveText('Start again');
		// Nothing streamed reads twice, and no partial words are ever in the region.
		const lines = await log.locator('p').allTextContents();
		expect(new Set(lines).size).toBe(lines.length);
		await expect(blocksOf(page.getByTestId('answer-streaming'))).toHaveCount(6);
	});

	test('the six group tabs fit the phone: no label runs into its neighbour', async ({ page }) => {
		await openCoachPanel(page);
		const tabs = page.getByRole('tablist', { name: 'Component group' }).getByRole('tab');
		await expect(tabs).toHaveCount(6);
		const words = await tabs.evaluateAll((all) =>
			all.map((tab) => {
				const range = document.createRange();
				range.selectNodeContents(tab);
				const text = range.getBoundingClientRect();
				const box = tab.getBoundingClientRect();
				return { left: text.left, right: text.right, height: box.height, width: box.width };
			})
		);
		for (let i = 1; i < words.length; i++) {
			expect(words[i]!.left - words[i - 1]!.right, `gap before tab ${i + 1}`).toBeGreaterThan(4);
		}
		for (const tab of words) {
			expect(tab.height).toBeGreaterThanOrEqual(44);
			expect(tab.width).toBeGreaterThanOrEqual(44);
		}
		await expectNoSideScroll(page);
	});
});
