/**
 * The coach's answer components on /design → Coach, at the iPhone size (393 × 659): every block
 * kind labelled in words, sources with dated accessible names, a metric in tabular figures with
 * its method behind a disclosure, the 'Not checked' badge, 'Show all' over 12 blocks, untrusted
 * text that stays literal, an exercise source that is a button for the page, activity chips in
 * their three states, and the live region reading each block and 'Answer complete'. Then the
 * composer (Enter on a mouse, Return on a finger, Send, Stop, the count near its limit and the
 * disabled state), 'Thinking…' and reduced motion, loading rows, and every notice with its words
 * and Retry. Runs on
 * Chromium and WebKit; axe for both themes lives in a11y.e2e.ts (e2e/coach-a11y.ts), the desktop
 * window in design-coach.desktop.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { COACH_NOTICES, type CoachNoticeKind } from '../src/lib/ui/coach/coach-notices';
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

/**
 * Every control's hit area at least 44 × 44 px: how far around its middle a tap still lands on it,
 * so a compact button's ::after extension counts (as in primitives.desktop.e2e.ts).
 */
async function expectHitAreas(targets: Locator) {
	for (const target of await targets.all()) {
		const name = await target.textContent();
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

	test('every notice says its state in words, with Retry only where trying again can work', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openCoachPanel(page);
		for (const kind of Object.keys(COACH_NOTICES) as CoachNoticeKind[]) {
			const copy = COACH_NOTICES[kind];
			const notice = page.getByTestId(`notice-${kind}`);
			await expect(notice, kind).toContainText(copy.title);
			await expect(notice, kind).toContainText(copy.body);
			await expect(notice.getByRole('button', { name: 'Retry' }), kind).toHaveCount(
				copy.retry ? 1 : 0
			);
		}
		await expect(page.getByTestId('notice-not_launched')).toContainText(
			'Your coach is getting ready'
		);
		await expect(page.getByTestId('notice-disabled')).toContainText('The coach is switched off');
		// A failure to act on is announced at once; an outage or a limit is read politely.
		await expect(page.getByTestId('notice-provider')).toHaveAttribute('role', 'alert');
		await expect(page.getByTestId('notice-chunk_failed')).toHaveAttribute('role', 'alert');
		await expect(page.getByTestId('notice-rate_limited')).toHaveAttribute('role', 'status');
		await expect(page.getByTestId('notice-not_launched')).toHaveAttribute('role', 'status');
		// Each notice has its own mark beside its words.
		await expect(page.getByTestId('notice-offline').locator('.glyph use')).toHaveAttribute(
			'href',
			/#wifi-off$/
		);
		await expect(page.getByTestId('notice-empty').getByRole('heading')).toHaveText(
			'No conversations yet'
		);

		const readout = page.getByTestId('notice-readout');
		await expect(readout).toHaveText('retry: none');
		for (const kind of ['offline', 'provider', 'chunk_failed', 'load_failed'] as const) {
			await page.getByTestId(`notice-${kind}`).getByRole('button', { name: 'Retry' }).click();
			await expect(readout).toHaveText(`retry: ${kind}`);
		}
		// A Retry under way is busy and takes no second press.
		const busy = page.getByTestId('notice-action_failed').getByRole('button', { name: 'Retry' });
		await expect(busy).toHaveAttribute('aria-busy', 'true');
		await expect(busy).toBeDisabled();
		// Retry is a compact button: its 44 px is the hit area, not the 36 px border box.
		await expectHitAreas(page.getByRole('button', { name: 'Retry' }));

		await expect(page.getByTestId('mock-badge')).toContainText('Practice coach');
		await expectNoSideScroll(page);
		for (const area of ['notice-no_key', 'notice-unavailable', 'notice-chunk_failed']) {
			await page.getByTestId(area).scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `design-coach-${area}`);
		}
		await page.getByTestId('notice-empty').scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-empty');
		expect(errors).toEqual([]);
	});

	test('the composer: Enter sends on a mouse, Return adds a newline on a finger', async ({
		page
	}) => {
		await openCoachPanel(page);
		await expect(page.getByRole('form', { name: 'Message your coach' })).toHaveCount(4);
		const ready = page.getByTestId('composer-ready');
		const input = ready.getByRole('textbox', { name: 'Message' });
		const send = ready.getByRole('button', { name: 'Send' });
		const readout = page.getByTestId('composer-readout');
		await expect(input).toHaveAttribute('maxlength', '4000');
		await expect(send).toBeDisabled();

		// A mouse: Shift+Enter adds a line, Enter sends, and the composer empties.
		await input.click();
		await input.press('Enter');
		await expect(readout).toHaveText('composer: none');
		await input.fill('First line');
		await input.press('Shift+Enter');
		await input.pressSequentially('second line');
		await expect(input).toHaveValue('First line\nsecond line');
		await expect(send).toBeEnabled();
		await input.press('Enter');
		await expect(readout).toContainText('composer: sent: First line');
		await expect(readout).toContainText('second line');
		await expect(input).toHaveValue('');
		await expect(send).toBeDisabled();

		// A finger: the phone's Return adds a line, and only Send sends.
		await input.tap();
		await input.fill('Tapped');
		await input.press('Enter');
		await expect(input).toHaveValue('Tapped\n');
		await expect(readout).toContainText('First line');
		await send.tap();
		await expect(readout).toHaveText('composer: sent: Tapped');
		await expect(input).toHaveValue('');
	});

	test('the composer keeps 44 px targets, turns Send into Stop, counts near its limit and can be disabled', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const ready = page.getByTestId('composer-ready');
		await expectTargets(ready.getByRole('button', { name: 'Send' }));
		expect((await boxOf(ready.getByRole('textbox'))).height).toBeGreaterThanOrEqual(44);

		const running = page.getByTestId('composer-running');
		await expect(running.getByRole('button', { name: 'Send' })).toHaveCount(0);
		const stop = running.getByRole('button', { name: 'Stop' });
		await expectTargets(stop);
		await stop.click();
		await expect(page.getByTestId('composer-readout')).toHaveText('composer: stopped');

		// Near the limit the count shows, tied to the message; the message scrolls past 8 lines.
		const long = page.getByTestId('composer-long');
		const count = long.getByTestId('composer-count');
		await expect(count).toHaveText(/3,870 \/ 4,000$/);
		const countId = await count.getAttribute('id');
		await expect(long.getByRole('textbox')).toHaveAttribute('aria-describedby', countId!);
		await expect(page.getByTestId('composer-ready').getByTestId('composer-count')).toHaveCount(0);
		const tall = await boxOf(long);
		expect(tall.height, 'eight lines at most').toBeLessThanOrEqual(220);

		const disabled = page.getByTestId('composer-disabled');
		const field = disabled.getByRole('textbox', { name: 'Message' });
		await expect(field).toBeDisabled();
		await expect(field).toHaveAttribute('placeholder', 'Ask your coach · coming soon');
		await expect(disabled.getByRole('button', { name: 'Send' })).toBeDisabled();
		await expectNoSideScroll(page);
		await running.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-composer');
		await disabled.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-composer-disabled');
	});

	test('Thinking pulses beside its words, and holds still under reduced motion', async ({
		page
	}, testInfo) => {
		await openCoachPanel(page);
		const thinking = page.getByTestId('thinking');
		await expect(thinking).toHaveText('Thinking…');
		await expect(thinking).toHaveAttribute('role', 'status');
		const dots = thinking.locator('.dots span');
		await expect(dots).toHaveCount(3);
		const animation = () => dots.first().evaluate((el) => getComputedStyle(el).animationName);
		expect(await animation()).not.toBe('none');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect.poll(animation).toBe('none');

		const loading = page.getByTestId('loading-rows');
		await expect(loading).toHaveAttribute('aria-busy', 'true');
		await expect(loading).toHaveAttribute('role', 'status');
		await expect(loading).toContainText('Loading your conversations…');
		await expect(loading.locator('.row')).toHaveCount(3);
		await thinking.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-coach-waiting');
	});
});
