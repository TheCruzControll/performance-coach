/**
 * Asking the coach and watching the answer stream (src/routes/(app)/coach/[[thread]]/Thread.svelte,
 * src/lib/client/coach/turn.svelte.ts and stream.ts): the owner's message at once, 'Thinking…' until
 * the first step or words, activity chips that run and then complete, each block's words as they
 * arrive and then the checked block, labelled, with the sources it cites. Stop ends on 'Stopped'; a dropped
 * stream ends on the stored final; leaving mid-answer ends on 'Interrupted' with Retry. Nothing in
 * the browser talks to the model's API. The stream client is loaded on demand, never in the
 * route's initial JavaScript.
 *
 * Serial: the coach rows and the faults are the one owner's and the one server's
 * (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';
import {
	COACH_TZ,
	lastRun,
	openThread,
	ownerMessages,
	query,
	resetCoach,
	seedCoach,
	setCoachFault,
	type SeededCoach
} from './coach-support';
import {
	DESKTOP,
	expectCentredOver,
	expectMainCentred,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use({ timezoneId: COACH_TZ });
// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

const BENCH = 'How has my bench progressed this month?';

let seeded: SeededCoach;
test.beforeEach(async ({ request }) => {
	seeded = await seedCoach(request, 'bench-month');
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });
const live = (page: Page) => page.getByTestId('live-answer');
const ended = (page: Page) => page.getByTestId('answer-ended');

/** Type `text` and press Send once the stream client is there to take it. */
async function ask(page: Page, text: string) {
	await message(page).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
}

interface Seen {
	/** Milliseconds since Send was pressed. */
	t: number;
	thinking: boolean;
	chips: string;
	/** The labels of the blocks still arriving. */
	drafting: string;
	draft: string;
	blocks: number;
}

/**
 * Record, inside the page, every state the conversation passes through from the press of Send:
 * whether 'Thinking…' shows, each chip's state, the words of the block still arriving and how many
 * blocks are done. Read with `seen(page)`.
 */
async function watch(page: Page) {
	await page.evaluate(() => {
		const states: Seen[] = [];
		let sentAt: number | null = null;
		document.addEventListener(
			'click',
			(event) => {
				if ((event.target as Element).closest('button[aria-label="Send"]'))
					sentAt ??= performance.now();
			},
			true
		);
		const snap = () => {
			if (sentAt === null) return;
			const answer = document.querySelector('[data-testid="live-answer"]');
			states.push({
				t: performance.now() - sentAt,
				thinking: document.querySelector('[data-testid="thinking"]') !== null,
				chips: [...document.querySelectorAll('[data-testid="activity"]')]
					.map((chip) => chip.getAttribute('data-state'))
					.join(),
				drafting: [...document.querySelectorAll('[data-testid="answer-draft"] .kind')]
					.map((kind) => kind.textContent)
					.join('|'),
				draft: [...document.querySelectorAll('[data-testid="answer-draft"] p')]
					.map((p) => p.textContent)
					.join('|'),
				blocks: answer?.querySelectorAll('[data-testid="answer-block"]').length ?? 0
			});
		};
		new MutationObserver(snap).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true
		});
		(window as unknown as { coachSeen: Seen[] }).coachSeen = states;
	});
}

const seen = (page: Page) =>
	page.evaluate(() => (window as unknown as { coachSeen: Seen[] }).coachSeen);

/**
 * Hold every append to conversation `threadId` until the returned release: each append locks the
 * thread's row first (services/coach/threads.ts), so the turn's next stored step, and what the
 * stream sends after it, waits while the screen is read. Fails unless the turn has stored no step
 * of its own yet.
 */
async function holdThread(threadId: string): Promise<() => Promise<void>> {
	const client = new pg.Client({
		connectionString: process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e
	});
	await client.connect();
	const release = async () => {
		await client.query('rollback').catch(() => undefined);
		await client.end();
	};
	try {
		await client.query('begin');
		await client.query('select 1 from coach_threads where id = $1 for no key update', [threadId]);
		const { rows } = await client.query<{ n: number }>(
			`select count(*)::int as n from coach_messages where thread_id = $1 and kind = 'assistant'`,
			[threadId]
		);
		expect(rows[0]!.n, 'the hold comes before the turn stores a step').toBe(0);
	} catch (err) {
		await release();
		throw err;
	}
	return release;
}

/** Every request the page makes to a host other than the app's. */
function foreignHosts(page: Page): string[] {
	const hosts: string[] = [];
	page.on('request', (request) => {
		const { host } = new URL(request.url());
		if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) hosts.push(host);
	});
	return hosts;
}

/** The bench's oldest and newest logged day with its top load, from Postgres. */
async function benchTops(): Promise<{ first: string; last: string }> {
	const days = await query<{ day: string; top: number }>(
		`select to_char(performed_at at time zone $2, 'YYYY-MM-DD') as day, max(weight)::float8 as top
		from set_records
		where exercise_id = $1 and deleted_at is null and not is_warmup and not is_skipped
		group by 1 order by 1`,
		[seeded.exercises.bench_press, COACH_TZ]
	);
	expect(days.length, 'bench-month logs four sessions').toBe(4);
	const words = ({ day, top }: { day: string; top: number }) => `${day}: top set ${top} kg × 5`;
	return { first: words(days[0]!), last: words(days.at(-1)!) };
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

test('a suggestion starts a conversation whose answer streams: chips, words, then labelled blocks with their sources', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const hosts = foreignHosts(page);
	// A pause before every chunk, so each step and each block's words can be seen arriving.
	await setCoachFault(request, 'none', { chunkDelayMs: 120 });
	await gotoHydrated(page, '/coach');
	// The stream client is loaded on demand, never modulepreloaded with the page.
	await expect(page.locator('link[rel="modulepreload"][href*="turn"]')).toHaveCount(0);
	await watch(page);

	await page.getByRole('button', { name: BENCH }).click();
	await expect(message(page)).toHaveValue(BENCH);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	// The conversation exists as soon as the server names it: its own address, replacing /coach.
	await page.waitForURL(/\/coach\/[0-9a-f-]{36}$/);
	// The tool finishes in milliseconds: its step is held, so its chip is seen running.
	const release = await holdThread(new URL(page.url()).pathname.split('/').at(-1)!);
	try {
		await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH));
		await expect(message(page)).toHaveValue('');
		await expect(composer(page).getByRole('button', { name: 'Stop' })).toBeVisible();
		await expect(live(page).getByTestId('activity')).toHaveAttribute('data-state', 'running');
		await captureScreen(page, testInfo, 'coach-stream-chips');
	} finally {
		await release();
	}

	const answer = live(page);
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 20_000
	});
	await expect(answer).not.toHaveAttribute('aria-busy', 'true');
	await expect(answer.getByTestId('activity')).toHaveAttribute('data-state', 'done');
	await expect(answer.getByTestId('activity')).toContainText(/bench/i);
	await expect(answer.getByTestId('answer-draft')).toHaveCount(0);

	// Labelled in words, the metric with how it was calculated, each fact and the metric citing
	// the set it came from.
	const blocks = answer.getByTestId('answer-block');
	const facts = blocks.filter({ hasText: /^\s*Fact/ });
	await expect(facts).toHaveCount(2);
	const metric = blocks.filter({ hasText: /^\s*Calculated/ });
	await expect(metric).toHaveCount(1);
	await metric.getByText('How it’s calculated').click();
	await expect(metric.locator('details[open] p')).toContainText('estimated 1RM');
	for (const cited of [facts.first(), facts.last(), metric])
		await expect(cited.getByRole('list', { name: 'Sources' }).getByRole('listitem')).toHaveCount(1);

	// The numbers and days are the ones Postgres holds.
	const { first, last } = await benchTops();
	await expect(facts.first()).toContainText(first);
	await expect(facts.last()).toContainText(last);

	// Thinking first, then the chip running and done, and each block opening, labelled, before it
	// is checked. These blocks are a sentence each, and the output policy sends a block's words a
	// sentence at a time, so they come with the check: the Stop test sees words arrive in steps.
	const states = await seen(page);
	const thinking = states.find((s) => s.thinking);
	expect(thinking, 'Thinking… showed').toBeDefined();
	expect(thinking!.t, 'Thinking… within 300 ms of Send').toBeLessThanOrEqual(300);
	const chipStates = states.map((s) => s.chips).filter(Boolean);
	expect(chipStates[0]).toBe('running');
	expect(chipStates.at(-1)).toBe('done');
	expect(
		states.some((s) => s.drafting === 'Fact' && s.blocks < 3),
		'a fact opens as a labelled draft before it is checked'
	).toBe(true);
	expect(states.filter((s) => s.thinking && (s.draft || s.drafting || s.chips))).toEqual([]);

	// Read out once per block, then 'Answer complete': never the words as they arrive.
	const announced = answer.getByTestId('answer-announcer').locator('p');
	await expect(announced).toHaveCount((await blocks.count()) + 1);
	await expect(announced.last()).toHaveText('Answer complete');
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-stream-answer');
	await auditThemes(page, 'answered');

	// What streamed is what was stored.
	const shown = await blocks.allTextContents();
	await page.reload();
	await expect(page.getByTestId('coach-message').getByTestId('answer-block')).toHaveText(shown);
	expect(hosts.filter((host) => host.includes('anthropic'))).toEqual([]);
	expect(errors).toEqual([]);
});

test('Thinking shows while the coach is silent, then gives way to the answer', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'none', { script: 'thinking-pause' });
	await openThread(page, seeded.threads.bench!);
	await watch(page);
	await ask(page, 'Is my week on track?');
	const thinking = page.getByTestId('thinking');
	await expect(thinking).toHaveText(/Thinking…/);
	await expect(live(page)).toHaveAttribute('aria-busy', 'true');
	await captureScreen(page, testInfo, 'coach-thinking');
	await auditThemes(page, 'thinking');

	await expect(live(page).getByTestId('answer-block')).toHaveCount(1, { timeout: 10_000 });
	await expect(thinking).toHaveCount(0);
	const states = await seen(page);
	expect(states.find((s) => s.thinking)!.t).toBeLessThanOrEqual(300);
	expect(states.at(-1)!.thinking).toBe(false);
});

test('Stop ends the answer as Stopped and cancels the run', async ({ page, request }, testInfo) => {
	await setCoachFault(request, 'slow');
	await openThread(page, seeded.threads.bench!);
	await watch(page);
	await ask(page, 'Is my week on track?');
	await expect(live(page).getByTestId('answer-draft')).not.toBeEmpty();
	// The words arrive in steps, a sentence at a time.
	await expect
		.poll(async () => new Set((await seen(page)).map((s) => s.draft).filter(Boolean)).size, {
			message: 'at least two intermediate text states'
		})
		.toBeGreaterThanOrEqual(2);
	await captureScreen(page, testInfo, 'coach-streaming');

	await composer(page).getByRole('button', { name: 'Stop' }).click();
	await expect(ended(page)).toHaveText('Stopped');
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible();
	await expect.poll(async () => (await lastRun())?.status).toBe('cancelled');
	await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-stopped');

	await page.reload();
	await expect(ended(page)).toHaveText('Stopped');
});

test('a dropped stream ends on the answer the server stored', async ({ page }) => {
	await openThread(page, seeded.threads.bench!);
	// The server runs the whole turn; the browser's connection drops before it hears any of it.
	await page.route('**/api/coach/turns', async (route) => {
		await route.fetch();
		await route.abort('connectionreset');
	});
	await ask(page, BENCH);

	const answers = page.getByTestId('coach-message');
	await expect(answers).toHaveCount(2, { timeout: 20_000 });
	await expect(answers.last()).toContainText('top set');
	await expect(answers.last().getByTestId('answer-ended')).toHaveCount(0);
	await expect(page.getByTestId('live-answer')).toHaveCount(0);
	await expect(page.getByTestId('owner-message').last()).toHaveText(new RegExp(BENCH));
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible();

	await page.unrouteAll({ behavior: 'ignoreErrors' });
	await page.reload();
	await expect(answers).toHaveCount(2);
	await expect(answers.last()).toContainText('top set');
});

test('an answer that fails while it streams ends on its stored partial with Retry, no reload', async ({
	page,
	request
}) => {
	// The turn runs past a shortened deadline: the server stores what was shown as Failed.
	await setCoachFault(request, 'slow', { turnMs: 1_000 });
	await openThread(page, seeded.threads.bench!);
	const answers = page.getByTestId('coach-message');
	const before = await answers.count();
	await ask(page, BENCH);

	await expect(answers).toHaveCount(before + 1, { timeout: 20_000 });
	await expect(answers.last().getByTestId('answer-ended')).toHaveText('Failed');
	await expect(page.getByTestId('live-answer')).toHaveCount(0);
	const retry = page.getByRole('button', { name: 'Retry' });
	await expect(retry).toBeVisible();

	// Retry fails too: its own partial follows the first, and Retry still shows.
	await retry.click();
	await expect(answers).toHaveCount(before + 2, { timeout: 20_000 });
	await expect(answers.last().getByTestId('answer-ended')).toHaveText('Failed');
	await expect(page.getByTestId('live-answer')).toHaveCount(0);
	await expect(retry).toBeVisible();

	await setCoachFault(request, 'none');
	await retry.click();
	await expect(live(page)).toContainText('top set', { timeout: 20_000 });
	await expect(retry).toHaveCount(0);
});

test('leaving mid-answer interrupts it; back on the conversation, Retry asks the same question again', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'slow');
	await openThread(page, seeded.threads.bench!);
	await ask(page, BENCH);
	await expect(live(page).getByTestId('answer-draft')).not.toBeEmpty();

	await page
		.getByRole('navigation', { name: 'Primary' })
		.getByRole('link', { name: 'Today' })
		.click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
	await expect.poll(async () => (await lastRun())?.status).toBe('interrupted');

	await setCoachFault(request, 'none');
	await openThread(page, seeded.threads.bench!);
	await expect(ended(page).last()).toHaveText('Interrupted');
	const retry = page.getByRole('button', { name: 'Retry' });
	await expect(retry).toBeVisible();
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-interrupted');

	const asked = await ownerMessages(seeded.threads.bench!);
	await retry.click();
	await expect(live(page).getByTestId('answer-block').first()).toBeVisible({ timeout: 20_000 });
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 20_000
	});
	await expect(live(page)).toContainText('top set');
	await expect(retry).toHaveCount(0);
	expect(await ownerMessages(seeded.threads.bench!), 'Retry stores no new message').toEqual(asked);
});

test('a long answer collapses behind Show all, and the page follows it down', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'none', { script: 'many-blocks' });
	await openThread(page, seeded.threads.bench!);
	await ask(page, 'Give me the whole plan');
	const showAll = live(page).getByTestId('show-all-blocks');
	await expect(showAll).toBeVisible({ timeout: 10_000 });
	await expect(live(page).getByTestId('answer-block')).toHaveCount(12);
	await expect(showAll).toBeInViewport();
	await captureScreen(page, testInfo, 'coach-long-answer');

	await showAll.click();
	await expect(live(page).getByTestId('answer-block')).toHaveCount(14);
	await expect(live(page).getByTestId('answer-block').nth(12)).toBeFocused();
	// Live-region lines: one per block and 'Answer complete', never more.
	await expect(live(page).getByTestId('answer-announcer').locator('p')).toHaveCount(15);
});

test('an exercise source in the streamed answer opens its history sheet', async ({
	page,
	request
}) => {
	await setCoachFault(request, 'none', { script: 'exercise-source' });
	await openThread(page, seeded.threads.bench!);
	await ask(page, 'Where is my bench history?');
	const source = live(page)
		.getByRole('list', { name: 'Sources' })
		.getByRole('button', { name: 'Bench press, Exercise', exact: true });
	await expect(source).toBeVisible({ timeout: 10_000 });
	await source.click();
	const sheet = page.getByTestId('exercise-history-sheet');
	await expect(sheet.getByRole('heading', { name: 'Bench press' })).toBeVisible();
	await expect(sheet.getByTestId('history-session')).toHaveCount(4);
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(live(page)).toBeVisible();
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('Enter sends from the keyboard, and the streamed answer keeps the readable column', async ({
		page,
		request
	}, testInfo) => {
		await setCoachFault(request, 'none', { chunkDelayMs: 60 });
		await gotoHydrated(page, '/coach');
		await page.evaluate(() => document.fonts.ready);
		const readable = await tokenPx(page, '--content-readable');

		const suggestion = page.getByRole('button', { name: BENCH });
		const edge = await suggestion.evaluate((el) => getComputedStyle(el).borderColor);
		await suggestion.hover();
		await expect
			.poll(() => suggestion.evaluate((el) => getComputedStyle(el).borderColor))
			.not.toBe(edge);
		await suggestion.focus();
		await expect
			.poll(() => suggestion.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');

		await message(page).click();
		await page.keyboard.type(BENCH);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(BENCH));
		await expect(page).toHaveURL(/\/coach\/[0-9a-f-]{36}$/);
		await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
			timeout: 20_000
		});
		await expect(live(page).getByTestId('answer-block').first()).toBeVisible();
		await expectMainCentred(page, readable);
		await expectCentredOver(page, composer(page), page.locator('main#main'));
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-stream-desktop');
		await auditThemes(page, 'desktop answered');
	});
});
