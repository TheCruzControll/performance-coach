/**
 * The Coach screens (src/routes/(app)/coach/[[thread]]): /coach with PRD §12's suggestions under
 * the header, then Recent conversations newest first ('Show older' busy while it loads, with an
 * inline Retry when it fails), or the empty state; /coach/<id> with the stored conversation and
 * an 'All conversations' link. The composer is rendered disabled until coach-thread-stream; an
 * entry point's question waits in it under a context chip. Not launched, switched off and the
 * other unavailable reasons have their notices while the rest of the app works; an unknown
 * conversation is the 404 page with the Coach tab still active; opening a conversation is busy
 * until it renders; a failed read shows the load-failed notice, whose Retry loads it.
 *
 * Serial: the coach rows and the faults are the one owner's and the one server's
 * (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
	DESKTOP,
	expectCentredOver,
	expectMainCentred,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import { COACH_TZ, openThread, query, resetCoach, seedCoach, setCoachFault } from './coach-support';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use({ timezoneId: COACH_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

/** bench-month's stored conversation (coach-fixtures.ts). */
const BENCH_QUESTION = 'How is my bench press going?';

const screen = (page: Page) => page.getByTestId('coach-screen');
const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const threadRows = (page: Page) => page.getByTestId('thread-row');
const coachTab = (page: Page) =>
	page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Coach' });

/** axe on `path` in the dark and the light theme. */
async function auditThemes(page: Page, path: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, path);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe on ${path}, ${theme}`).toEqual([]);
	}
}

/** Hold every request `matches` names until `release` is called. */
async function hold(page: Page, matches: string | ((url: URL) => boolean)) {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(matches, async (route) => {
		await held;
		await route.continue();
	});
	return release;
}

/** `count` open conversations, a minute apart, newest 'Question 1'. */
async function manyThreads(count: number) {
	await query(
		`insert into coach_threads (owner_id, title, title_source, segment_prompt_version, last_message_at)
		select o.id, 'Question ' || n, 'first_message', 'pv-e2e', now() - n * interval '1 minute'
		from owners o, generate_series(1, $1::int) n`,
		[count]
	);
}

test('with no conversation, the suggestions sit under the header over the empty state', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/coach');
	await expect(page.getByRole('heading', { level: 1, name: 'Coach' })).toBeVisible();
	await expect(page.locator('.prompt')).toHaveCount(4);
	await expect(page.locator('.prompt').first()).toHaveText(
		'How has my bench progressed this month?'
	);
	await expect(page.getByTestId('coach-empty')).toContainText('No conversations yet');
	await expect(page.getByTestId('mock-badge')).toContainText('Practice coach');
	await expect(page.getByTestId('coach-unavailable')).toHaveCount(0);
	await expect(page.getByTestId('context-chip')).toHaveCount(0);
	await expect(coachTab(page)).toHaveAttribute('aria-current', 'page');

	// The suggestions come first in the column, and every one ends above the composer.
	const bar = (await composer(page).boundingBox())!;
	for (const prompt of await page.locator('.prompt').all()) {
		const box = (await prompt.boundingBox())!;
		expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
	}
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-empty');
	expect(errors).toEqual([]);
});

test('the composer is disabled until the coach can stream, and the suggestions are words', async ({
	page
}) => {
	await gotoHydrated(page, '/coach');
	await expect(composer(page).getByRole('textbox', { name: 'Message' })).toBeDisabled();
	await expect(composer(page).getByRole('textbox', { name: 'Message' })).toHaveAttribute(
		'placeholder',
		'Ask your coach'
	);
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeDisabled();
	await expect(page.locator('.prompt').getByRole('button')).toHaveCount(0);
	await expect(page.locator('.prompt').getByRole('link')).toHaveCount(0);
});

test('an entry point’s question waits in the composer under its context chip', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/coach?ask=How%20did%20my%20workout%20go%3F&from=workout');
	await expect(page.getByTestId('context-chip')).toHaveText(/From your workout/);
	await expect(composer(page).getByRole('textbox', { name: 'Message' })).toHaveValue(
		'How did my workout go?'
	);
	await expect(page.locator('.prompt')).toHaveCount(4);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-prefill');

	// An entry the screen does not know prefills its question with no chip.
	await gotoHydrated(page, '/coach?ask=Hello&from=somewhere');
	await expect(page.getByTestId('context-chip')).toHaveCount(0);
	await expect(composer(page).getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
});

test('a stored conversation opens from Recent conversations and survives a reload', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedCoach(request, 'bench-month');
	await gotoHydrated(page, '/coach');
	await expect(threadRows(page)).toHaveCount(1);
	await expect(threadRows(page).first()).toContainText(BENCH_QUESTION);
	await expect(threadRows(page).first()).toContainText(/Today · \d\d:\d\d/);
	await expect(page.getByTestId('coach-empty')).toHaveCount(0);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-recent');

	await threadRows(page).first().click();
	await expect(page).toHaveURL(`/coach/${seeded.threads.bench}`);
	const thread = page.getByTestId('thread');
	await expect(thread.getByRole('heading', { level: 2 })).toHaveText(BENCH_QUESTION);
	await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH_QUESTION));
	await expect(page.getByTestId('coach-message')).toHaveCount(1);
	await expect(page.getByTestId('coach-message')).toContainText('Bench press');
	await expect(page.getByTestId('coach-message').getByTestId('answer-block')).toHaveCount(2);
	await expect(coachTab(page)).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.prompt')).toHaveCount(0);
	await expect(composer(page).getByRole('textbox', { name: 'Message' })).toBeDisabled();
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-thread');

	await page.reload();
	await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH_QUESTION));
	await expect(page.getByTestId('coach-message')).toContainText('Bench press');

	await page.getByTestId('all-conversations').click();
	await expect(page).toHaveURL('/coach');
	await expect(threadRows(page)).toHaveCount(1);
});

test('Coach and a conversation have no WCAG A/AA violations in either theme', async ({
	page,
	request
}) => {
	const seeded = await seedCoach(request, 'bench-month');
	await gotoHydrated(page, '/coach');
	await auditThemes(page, '/coach');
	await auditThemes(page, `/coach/${seeded.threads.bench}`);
});

test.describe('when the coach cannot answer', () => {
	test.afterEach(async ({ request }) => {
		await resetCoach(request);
	});

	test('not launched: the getting-ready notice, a disabled composer, and Today and Train work', async ({
		page,
		request
	}, testInfo) => {
		await setCoachFault(request, 'not_launched');
		await gotoHydrated(page, '/coach');
		const notice = page.getByTestId('coach-unavailable');
		await expect(notice).toContainText('Your coach is getting ready');
		await expect(notice.getByRole('button', { name: 'Retry' })).toHaveCount(0);
		await expect(page.getByTestId('mock-badge')).toHaveCount(0);
		await expect(composer(page).getByRole('textbox', { name: 'Message' })).toBeDisabled();
		await expect(page.locator('.prompt')).toHaveCount(4);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-not-launched');

		const nav = page.getByRole('navigation', { name: 'Primary' });
		await nav.getByRole('link', { name: 'Today' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
		await nav.getByRole('link', { name: 'Train' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
	});

	test('switched off: its own notice', async ({ page, request }) => {
		await setCoachFault(request, 'disabled');
		await gotoHydrated(page, '/coach');
		await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is switched off');
		await expect(composer(page).getByRole('textbox', { name: 'Message' })).toBeDisabled();
	});

	test('unavailable: the unavailable notice, on a conversation too, and Today and Train work', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'bench-month');
		await setCoachFault(request, 'unavailable');
		await gotoHydrated(page, '/coach');
		await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is unavailable');
		await captureScreen(page, testInfo, 'coach-unavailable');

		await openThread(page, seeded.threads.bench!);
		await expect(page.getByTestId('coach-message')).toContainText('Bench press');
		await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is unavailable');

		const nav = page.getByRole('navigation', { name: 'Primary' });
		await nav.getByRole('link', { name: 'Today' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
		await nav.getByRole('link', { name: 'Train' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
	});
});

test('an unknown or malformed conversation is the 404 page, with the Coach tab still active', async ({
	page
}) => {
	for (const path of [`/coach/${crypto.randomUUID()}`, '/coach/not-a-conversation']) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(404);
		await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
		await expect(coachTab(page)).toHaveAttribute('aria-current', 'page');
	}
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('opening a conversation is busy until it renders', async ({ page, request }) => {
		const seeded = await seedCoach(request, 'bench-month');
		await gotoHydrated(page, '/coach');
		const release = await hold(page, `**/coach/${seeded.threads.bench}/__data.json*`);
		await threadRows(page).first().click();
		await expect(screen(page)).toHaveAttribute('aria-busy', 'true');
		await expect(page.getByTestId('coach-loading')).toBeVisible();
		await expect(page.getByTestId('coach-loading')).toContainText('Loading the conversation…');
		release();
		await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH_QUESTION));
		await expect(screen(page)).not.toHaveAttribute('aria-busy');
		await expect(page.getByTestId('coach-loading')).toHaveCount(0);
	});

	test('Show older is busy while it loads; answering 500 it offers Retry, which lists them', async ({
		page
	}) => {
		await manyThreads(21);
		await gotoHydrated(page, '/coach');
		await expect(threadRows(page)).toHaveCount(20);
		await expect(threadRows(page).first()).toContainText('Question 1');

		const isOlder = (url: URL) =>
			url.pathname === '/coach/__data.json' && url.searchParams.has('before');
		await page.route(
			isOlder,
			(route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
			{ times: 1 }
		);
		const older = page.getByTestId('show-older');
		await older.click();
		const failed = page.getByTestId('older-failed');
		await expect(failed).toContainText('Couldn’t load your conversations');
		await expect(threadRows(page)).toHaveCount(20);

		const release = await hold(page, isOlder);
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(older).toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('status').filter({ hasText: 'Loading older' })).toHaveCount(1);
		release();
		await expect(threadRows(page)).toHaveCount(21);
		await expect(threadRows(page).last()).toContainText('Question 21');
		await expect(failed).toHaveCount(0);
		await expect(older).toHaveCount(0);
	});

	// The load's own soft failure, as when the database read fails: a 200 whose page data is
	// { failed: true } (devalue's flattened form, in place of the real page node's).
	test('a conversation whose load fails shows the load-failed notice, and Retry loads it', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'bench-month');
		await gotoHydrated(page, '/coach');
		await page.route(
			`**/coach/${seeded.threads.bench}/__data.json*`,
			async (route) => {
				const response = await route.fetch();
				const body = (await response.json()) as { nodes: { data: unknown }[] };
				body.nodes.at(-1)!.data = [
					{ coach: 1, prefill: 4, failed: 3 },
					{ status: 2, mockBadge: 3 },
					'ready',
					true,
					null
				];
				await route.fulfill({ response, json: body });
			},
			{ times: 1 }
		);
		await threadRows(page).first().click();
		const failed = page.getByTestId('load-failed');
		await expect(failed).toContainText('Couldn’t load your conversations');
		await expect(page.getByTestId('all-conversations')).toBeVisible();
		await expect(coachTab(page)).toHaveAttribute('aria-current', 'page');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-load-failed');

		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH_QUESTION));
		await expect(failed).toHaveCount(0);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test.afterEach(async ({ request }) => {
		await resetCoach(request);
	});

	test('Coach keeps the readable column, its composer centred over it, with hover and focus', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'bench-month');
		await gotoHydrated(page, '/coach');
		await page.evaluate(() => document.fonts.ready);
		const readable = await tokenPx(page, '--content-readable');
		await expectMainCentred(page, readable);
		await expectCentredOver(page, composer(page), page.locator('main#main'));

		// Two columns of suggestions, every one above the composer.
		const prompts = page.locator('.prompt');
		const [a, b] = [(await prompts.nth(0).boundingBox())!, (await prompts.nth(1).boundingBox())!];
		expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
		const bar = (await composer(page).boundingBox())!;
		for (const prompt of await prompts.all()) {
			const box = (await prompt.boundingBox())!;
			expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
		}

		// A conversation row takes a visible focus ring, and its edge strengthens under a fine pointer.
		const row = threadRows(page).first();
		await row.focus();
		await expect
			.poll(() => row.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');
		await row.blur();
		const edge = await row.evaluate((el) => getComputedStyle(el).borderColor);
		await row.hover();
		await expect.poll(() => row.evaluate((el) => getComputedStyle(el).borderColor)).not.toBe(edge);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-desktop');

		await openThread(page, seeded.threads.bench!);
		await expectMainCentred(page, readable);
		await expectCentredOver(page, composer(page), page.locator('main#main'));
		const back = page.getByTestId('all-conversations');
		await back.focus();
		await expect
			.poll(() => back.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');
		await back.blur();
		const colour = await back.evaluate((el) => getComputedStyle(el).color);
		await back.hover();
		await expect.poll(() => back.evaluate((el) => getComputedStyle(el).color)).not.toBe(colour);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-thread-desktop');
	});

	test('the getting-ready notice keeps the readable column', async ({
		page,
		request
	}, testInfo) => {
		await setCoachFault(request, 'not_launched');
		await gotoHydrated(page, '/coach');
		await expect(page.getByTestId('coach-unavailable')).toContainText(
			'Your coach is getting ready'
		);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-not-launched-desktop');
	});

	test('Coach has no WCAG A/AA violations on a desktop window in either theme', async ({
		page,
		request
	}) => {
		const seeded = await seedCoach(request, 'bench-month');
		await gotoHydrated(page, '/coach');
		await auditThemes(page, '/coach');
		await auditThemes(page, `/coach/${seeded.threads.bench}`);
	});
});
