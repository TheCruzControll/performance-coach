/**
 * Every way a coach turn can fail has its designed state (src/routes/(app)/coach/[[thread]]/
 * Thread.svelte, +page.svelte, src/lib/client/coach/turn.svelte.ts): a failure on the coach's
 * side, busy, a timeout and no connection end on a notice whose Retry asks the same question
 * again under the same id, so the conversation keeps one copy of it; a rate limit counts down; a
 * spent budget and an unavailable coach link to Today and Train, which keep working, and a
 * misconfigured coach still answers today's workout; a refusal says so. The stream client failing
 * to load is the chunk-failed notice with Retry; failing again reloads the page with the question
 * kept, and the composer works.
 *
 * Serial: the coach rows and the faults are the one owner's and the one server's
 * (e2e/coach-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
	coachCounts,
	COACH_TZ,
	lastRun,
	openThread,
	ownerMessages,
	postTurn,
	resetCoach,
	seedCoach,
	setCoachFault,
	type CoachFault,
	type SeededCoach
} from './coach-support';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: COACH_TZ });
// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');
const STREAM_SOURCE = 'src/lib/client/coach/turn.svelte.ts';
const BENCH = 'How has my bench progressed this month?';

/** The stream client's chunk in the build under test, from Vite's manifest. */
function streamChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[STREAM_SOURCE];
	if (!chunk) throw new Error(`${STREAM_SOURCE} is not in the build under test`);
	return chunk.file;
}

let seeded: SeededCoach;
test.beforeEach(async ({ request }) => {
	seeded = await seedCoach(request, 'bench-month');
});

test.afterEach(async ({ page, request }) => {
	await page.context().setOffline(false);
	await resetCoach(request);
});

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });
const notice = (page: Page) => page.getByTestId('turn-notice');
const retry = (page: Page) => notice(page).getByRole('button', { name: 'Retry' });
const asked = (page: Page, text: string) =>
	page.getByTestId('owner-message').filter({ hasText: text });

async function ask(page: Page, text: string) {
	await message(page).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
}

/** The turn has ended: Send is back. */
async function ended(page: Page) {
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 20_000
	});
}

/** axe on the page as it is, in the dark and the light theme. */
async function auditThemes(page: Page, state: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400); // transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${state}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** The state is on screen, one copy of the question with it, captured and audited. */
async function shows(
	page: Page,
	state: string,
	title: string,
	testInfo: Parameters<typeof captureScreen>[1]
) {
	await expect(notice(page)).toContainText(title);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, `coach-state-${state}`);
	await auditThemes(page, state);
}

for (const fault of ['error', 'overloaded'] as const satisfies readonly CoachFault[]) {
	test(`${fault}: the coach-side failure with Retry, which asks again leaving exactly one owner message`, async ({
		page,
		request
	}, testInfo) => {
		await setCoachFault(request, fault);
		await openThread(page, seeded.threads.bench!);
		const before = await ownerMessages(seeded.threads.bench!);
		await ask(page, BENCH);
		await ended(page);
		await shows(page, `provider-${fault}`, 'The coach service had a problem', testInfo);
		await expect(asked(page, BENCH)).toHaveCount(1);
		await expect.poll(async () => (await lastRun())?.status).toBe('failed');

		await setCoachFault(request, 'none');
		await retry(page).click();
		await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
		await ended(page);
		await expect(notice(page)).toHaveCount(0);
		await expect(asked(page, BENCH)).toHaveCount(1);
		const after = await ownerMessages(seeded.threads.bench!);
		expect(after, 'Retry stores the question once').toHaveLength(before.length + 1);
		expect(after.filter((m) => m.text === BENCH)).toHaveLength(1);

		await page.reload();
		await expect(asked(page, BENCH)).toHaveCount(1);
	});
}

test('rate limited: the question once, with a countdown to when it can be asked again, and no Retry yet', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'rate_limited');
	await gotoHydrated(page, '/coach');
	const stored = await coachCounts();
	await ask(page, BENCH);
	await shows(page, 'rate-limited', 'Too many questions in a short time', testInfo);
	await expect(page.getByTestId('turn-wait')).toContainText('You can ask again in');
	await expect(retry(page)).toHaveCount(0);
	await expect(asked(page, BENCH)).toHaveCount(1);
	// Nothing was stored, and the screen stays on /coach.
	await expect(page).toHaveURL(/\/coach$/);
	expect(await coachCounts()).toEqual(stored);
});

test('budget: today’s budget is used up, and its links open Today and Train, which work', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'budget');
	await openThread(page, seeded.threads.bench!);
	await ask(page, BENCH);
	await ended(page);
	await shows(page, 'budget', 'Today’s coach budget is used up', testInfo);
	await expect(retry(page)).toHaveCount(0);

	await notice(page).getByRole('link', { name: 'Today’s workout' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
	await page.goBack();
	await expect(page.getByTestId('thread')).toBeVisible();
	const nav = page.getByRole('navigation', { name: 'Primary' });
	await nav.getByRole('link', { name: 'Train' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
});

test('unavailable: today’s workout is still answered; anything else is the unavailable notice with links to Today and Train', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'unavailable');
	await openThread(page, seeded.threads.bench!);
	await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is unavailable');
	await expect(message(page)).toBeEnabled();

	const answers = page.getByTestId('coach-message').or(page.getByTestId('live-answer'));
	const before = await answers.count();
	await ask(page, 'What’s today’s workout?');
	await ended(page);
	await expect(answers).toHaveCount(before + 1);
	await expect(notice(page)).toHaveCount(0);

	await ask(page, BENCH);
	await ended(page);
	await shows(page, 'unavailable', 'The coach is unavailable', testInfo);
	await expect(retry(page)).toHaveCount(0);
	await notice(page).getByRole('link', { name: 'Train' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
	await page.goBack();
	await notice(page).getByRole('link', { name: 'Today’s workout' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
});

test('refused: the coach says it can’t help, with no Retry', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'refusal');
	await openThread(page, seeded.threads.bench!);
	await ask(page, BENCH);
	await ended(page);
	await shows(page, 'refused', 'The coach can’t help with that', testInfo);
	await expect(retry(page)).toHaveCount(0);
});

test('timeout: the partial it stored, why it ended, and one Retry', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'slow', { turnMs: 1_000 });
	await openThread(page, seeded.threads.bench!);
	await ask(page, BENCH);
	await ended(page);
	await expect(page.getByTestId('coach-message').last().getByTestId('answer-ended')).toHaveText(
		'Failed'
	);
	await shows(page, 'timeout', 'The answer took too long', testInfo);
	await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(1);

	await setCoachFault(request, 'none');
	await retry(page).click();
	await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
	await expect(asked(page, BENCH)).toHaveCount(1);
});

test('busy: another answer still running in the conversation, with Retry once it has finished', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'slow');
	await openThread(page, seeded.threads.bench!);
	// Another device's answer, still streaming in the same conversation.
	const other = postTurn(request, 'Is my week on track?', seeded.threads.bench!);
	await expect.poll(async () => (await lastRun())?.status).toBe('running');

	await ask(page, BENCH);
	await ended(page);
	await shows(page, 'busy', 'Another answer is still running', testInfo);
	await expect(asked(page, BENCH)).toHaveCount(1);

	await other;
	await setCoachFault(request, 'none');
	await retry(page).click();
	await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
	await expect(asked(page, BENCH)).toHaveCount(1);
	expect((await ownerMessages(seeded.threads.bench!)).filter((m) => m.text === BENCH)).toHaveLength(
		1
	);
});

test('offline: the question once, You’re offline with Retry, which asks it once back online', async ({
	page
}, testInfo) => {
	// The stream client loads on idle: offline only once it has.
	const loaded = page.waitForResponse((response) => response.url().endsWith(`/${streamChunk()}`));
	await openThread(page, seeded.threads.bench!);
	await loaded;
	await page.context().setOffline(true);
	await ask(page, BENCH);
	await shows(page, 'offline', 'You’re offline', testInfo);
	await expect(asked(page, BENCH)).toHaveCount(1);

	// Still offline, Retry keeps the state; back online, it asks the question once.
	await retry(page).click();
	await expect(notice(page)).toContainText('You’re offline');
	await page.context().setOffline(false);
	await retry(page).click();
	await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
	await expect(asked(page, BENCH)).toHaveCount(1);
	expect((await ownerMessages(seeded.threads.bench!)).filter((m) => m.text === BENCH)).toHaveLength(
		1
	);

	// The rest of the app works.
	const nav = page.getByRole('navigation', { name: 'Primary' });
	await nav.getByRole('link', { name: 'Today' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
	await nav.getByRole('link', { name: 'Train' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
});

test('the stream client failing once is the chunk-failed notice, whose Retry sends the question', async ({
	page
}, testInfo) => {
	const chunk = `**/${streamChunk()}`;
	await page.route(chunk, (route) => route.abort());
	await openThread(page, seeded.threads.bench!);
	// Fetched as a module, never as a modulepreload, which WebKit would never fetch again.
	await expect(page.locator(`link[rel="modulepreload"][href$="/${streamChunk()}"]`)).toHaveCount(0);
	await ask(page, BENCH);
	const failed = page.getByTestId('stream-failed');
	await expect(failed).toContainText('Couldn’t load this part of the coach');
	await expect(message(page)).toHaveValue(BENCH);
	await captureScreen(page, testInfo, 'coach-state-stream-failed');
	await auditThemes(page, 'stream failed');

	// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of the
	// conversation that keeps the question in the composer.
	await page.unroute(chunk);
	await failed.getByRole('button', { name: 'Retry' }).click();
	await expect(failed).toHaveCount(0, { timeout: 20_000 });
	if ((await asked(page, BENCH).count()) === 0) {
		await page.waitForLoadState('networkidle');
		await expect(message(page)).toHaveValue(BENCH);
		await composer(page).getByRole('button', { name: 'Send' }).click();
	}
	await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
	await expect(asked(page, BENCH)).toHaveCount(1);
});

test('the stream client failing twice reloads the conversation, the question kept, and the composer works', async ({
	page
}) => {
	const chunk = `**/${streamChunk()}`;
	let reloaded = false;
	let armed = false;
	page.on('framenavigated', (frame) => {
		if (armed && frame === page.mainFrame()) reloaded = true;
	});
	// Every fetch fails until the page reloads.
	await page.route(chunk, (route) => (reloaded ? route.continue() : route.abort()));
	await openThread(page, seeded.threads.bench!);
	await ask(page, BENCH);
	const failed = page.getByTestId('stream-failed');
	await expect(failed).toBeVisible();

	armed = true;
	await failed.getByRole('button', { name: 'Retry' }).click();
	await expect.poll(() => reloaded, { message: 'the second failure reloads' }).toBe(true);
	await page.waitForLoadState('networkidle');
	await expect(page).toHaveURL(new RegExp(`/coach/${seeded.threads.bench}$`));
	await expect(failed).toHaveCount(0);
	await expect(message(page)).toHaveValue(BENCH);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(page.getByTestId('live-answer')).toContainText('top set', { timeout: 20_000 });
	await expect(asked(page, BENCH)).toHaveCount(1);
});

/** Reaches a state from the thread, and returns what to wait for before the test ends. */
type Reach = (page: Page, request: APIRequestContext) => Promise<(() => Promise<unknown>) | void>;

/** Sets `fault`, opens the bench conversation and asks. */
const faulted =
	(fault: CoachFault, controls?: Parameters<typeof setCoachFault>[2]): Reach =>
	async (page, request) => {
		await setCoachFault(request, fault, controls);
		await openThread(page, seeded.threads.bench!);
		await ask(page, BENCH);
	};

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	const states: [state: string, title: string, reach: Reach, testId?: string][] = [
		['error', 'The coach service had a problem', faulted('error')],
		['overloaded', 'The coach service had a problem', faulted('overloaded')],
		['rate_limited', 'Too many questions in a short time', faulted('rate_limited')],
		['budget', 'Today’s coach budget is used up', faulted('budget')],
		['unavailable', 'The coach is unavailable', faulted('unavailable')],
		['refusal', 'The coach can’t help with that', faulted('refusal')],
		['timeout', 'The answer took too long', faulted('slow', { turnMs: 1_000 })],
		[
			'busy',
			'Another answer is still running',
			async (page, request) => {
				await setCoachFault(request, 'slow');
				await openThread(page, seeded.threads.bench!);
				const other = postTurn(request, 'Is my week on track?', seeded.threads.bench!);
				await expect.poll(async () => (await lastRun())?.status).toBe('running');
				await ask(page, BENCH);
				return () => other;
			}
		],
		[
			'offline',
			'You’re offline',
			async (page) => {
				const loaded = page.waitForResponse((r) => r.url().endsWith(`/${streamChunk()}`));
				await openThread(page, seeded.threads.bench!);
				await loaded;
				await page.context().setOffline(true);
				await ask(page, BENCH);
			}
		],
		[
			'stream-failed',
			'Couldn’t load this part of the coach',
			async (page) => {
				await page.route(`**/${streamChunk()}`, (route) => route.abort());
				await openThread(page, seeded.threads.bench!);
				await ask(page, BENCH);
			},
			'stream-failed'
		]
	];

	for (const [state, title, reach, testId = 'turn-notice'] of states) {
		test(`${state}: its notice keeps the readable column, with hover and focus on its actions`, async ({
			page,
			request
		}, testInfo) => {
			const pending = await reach(page, request);
			const shown = page.getByTestId(testId);
			await expect(shown).toContainText(title, { timeout: 20_000 });
			await ended(page);
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);

			const action = shown.getByRole('button').or(shown.getByRole('link')).first();
			if ((await action.count()) > 0) {
				await action.focus();
				await expect
					.poll(() => action.evaluate((el) => getComputedStyle(el).outlineStyle))
					.not.toBe('none');
			}
			await captureScreen(page, testInfo, `coach-state-${state}-desktop`);
			await auditThemes(page, `${state} desktop`);
			await pending?.();
		});
	}
});
