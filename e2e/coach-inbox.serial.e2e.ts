/**
 * The Proposals inbox (src/routes/(app)/coach/proposals/[[id]]): every change the coach proposed,
 * in one place, reached from Coach's header.
 * - The proposals waiting for the owner come first, from every conversation, then every decision.
 *   Accept and Reject work from the inbox as on the card in the conversation; a decided proposal
 *   moves under Decided, and a reload keeps it, with the owner's reason.
 * - The filter lives in the URL, so a reload keeps it; an empty filter and no proposal at all have
 *   their designed empty states.
 * - 'Ask for changes' opens the conversation the proposal came from, with its sheet.
 * - On a desktop window it is a split screen: the list beside the proposal, which sits in the
 *   readable column. Opening another is busy until it renders; a failed load offers Retry.
 *
 * The split-squat-week fixture plans Bulgarian split squats: 'I hate Bulgarian split squats, so
 * replace them' proposes swapping them, and 'Plan my next cycle' drafts the next block, each in a
 * conversation of its own. Serial: the coach and program rows are the one owner's
 * (e2e/coach-support.ts).
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { COACH_TZ, postTurn, query, resetCoach, seedCoach } from './coach-support';
import { boxOf, DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

const REPLACE = 'I hate Bulgarian split squats, so replace them';
const NEXT_CYCLE = 'Plan my next cycle';
const REASON = 'Not before my fight in December';
const CLIENT = `${import.meta.dirname}/../.svelte-kit/output/client`;
const DETAIL_SOURCE = 'src/routes/(app)/coach/proposals/[[id]]/Detail.svelte';

test.use({ timezoneId: COACH_TZ });
// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

interface Proposed {
	id: string;
	title: string;
	threadId: string;
}

/** Ask `text` in a new conversation, as the composer does: the proposal its turn stored. */
async function propose(request: APIRequestContext, text: string): Promise<Proposed> {
	const turn = await postTurn(request, text);
	expect(turn.status, text).toBe(200);
	const started = turn.events.find((event) => event.type === 'run_started');
	if (started?.type !== 'run_started') throw new Error(`'${text}' started no run`);
	const [row] = await query<Proposed>(
		`select id::text, title, thread_id::text as "threadId" from coach_proposals
		where thread_id = $1 order by created_at desc limit 1`,
		[started.threadId]
	);
	if (!row) throw new Error(`'${text}' proposed nothing`);
	return row;
}

/** The fixture, then the swap and, newer, the next cycle: two conversations, two proposals. */
async function twoProposals(request: APIRequestContext) {
	await seedCoach(request, 'split-squat-week');
	const swap = await propose(request, REPLACE);
	const cycle = await propose(request, NEXT_CYCLE);
	expect(swap.threadId).not.toBe(cycle.threadId);
	return { swap, cycle };
}

/** The proposal's code (loaded on demand) in the build under test, from Vite's manifest. */
function detailChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[DETAIL_SOURCE];
	if (!chunk) throw new Error(`${DETAIL_SOURCE} is not in the build under test`);
	return chunk.file;
}

const stored = (id: string) =>
	query<{ status: string; decisionNote: string | null }>(
		`select status, decision_note as "decisionNote" from coach_proposals where id = $1`,
		[id]
	).then((rows) => rows[0]);

const waiting = (page: Page) => page.getByTestId('inbox-waiting').getByTestId('inbox-row');
const decided = (page: Page) => page.getByTestId('inbox-decided').getByTestId('inbox-row');
const detail = (page: Page) => page.getByTestId('inbox-detail');
const cardState = (page: Page) => detail(page).getByTestId('proposal-state');
const cardButton = (page: Page, name: string) =>
	detail(page).getByTestId('proposal-card').getByRole('button', { name });

/** axe on the page as it is, in the dark and the light theme. */
async function auditThemes(page: Page, label: string) {
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
		expect(found, `axe, ${label}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test('waiting proposals from two conversations come first; Accept and Reject from the inbox move them under Decided, and a reload keeps them', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const { swap, cycle } = await twoProposals(request);

	await gotoHydrated(page, '/coach');
	await page.getByRole('link', { name: 'Proposals' }).click();
	await expect(page).toHaveURL(/\/coach\/proposals$/);
	await expect(waiting(page)).toHaveCount(2);
	await expect(waiting(page).nth(0)).toContainText(cycle.title);
	await expect(waiting(page).nth(1)).toContainText(swap.title);
	await expect(waiting(page).first()).toContainText('Waiting for you');
	await expect(decided(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-inbox');
	await auditThemes(page, 'inbox');

	// The swap: its conversation, then Accept, by id.
	await waiting(page).nth(1).click();
	await expect(detail(page)).toBeVisible();
	await expect(page.getByTestId('all-proposals')).toBeVisible();
	await expect(detail(page).getByTestId('open-conversation')).toHaveAttribute(
		'href',
		`/coach/${swap.threadId}`
	);
	await expect(cardButton(page, 'Accept')).toBeEnabled();
	await captureScreen(page, testInfo, 'coach-inbox-detail');
	await auditThemes(page, 'detail');
	await cardButton(page, 'Accept').click();
	await expect(cardState(page)).toContainText('Applied as version 2');
	await expect.poll(async () => (await stored(swap.id))?.status).toBe('applied');

	await page.getByTestId('all-proposals').click();
	await expect(waiting(page)).toHaveCount(1);
	await expect(waiting(page).first()).toContainText(cycle.title);
	await expect(decided(page)).toHaveCount(1);
	await expect(decided(page).first()).toContainText('Applied as version 2');

	// The next cycle, from the other conversation: Reject, with a reason.
	await waiting(page).first().click();
	await expect(detail(page).getByTestId('open-conversation')).toHaveAttribute(
		'href',
		`/coach/${cycle.threadId}`
	);
	await cardButton(page, 'Reject').click();
	const sheet = page.getByRole('dialog', { name: 'Reject this change' });
	await sheet.getByRole('textbox', { name: /Why not\?/ }).fill(REASON);
	await sheet.getByTestId('decision-submit').click();
	await expect(sheet).toBeHidden();
	await expect(cardState(page)).toContainText('Declined');
	await expect(detail(page).getByTestId('decision-note')).toContainText(REASON);
	expect(await stored(cycle.id)).toEqual({ status: 'rejected', decisionNote: REASON });

	await page.reload();
	await expect(cardState(page)).toContainText('Declined');
	await expect(detail(page).getByTestId('decision-note')).toContainText(REASON);
	await captureScreen(page, testInfo, 'coach-inbox-detail-rejected');
	await auditThemes(page, 'rejected detail');

	await page.getByTestId('all-proposals').click();
	await expect(waiting(page)).toHaveCount(0);
	await expect(decided(page)).toHaveCount(2);
	await expect(decided(page).nth(0)).toContainText('Declined');
	await expect(decided(page).nth(1)).toContainText('Applied as version 2');
	expect(errors).toEqual([]);
});

test('the filter lives in the URL, so a reload keeps it; an empty filter says so', async ({
	page,
	request
}, testInfo) => {
	const { swap } = await twoProposals(request);
	await gotoHydrated(page, '/coach/proposals');

	await page.getByTestId('filter-decided').click();
	await expect(page).toHaveURL(/\?show=decided$/);
	await expect(page.getByTestId('filter-decided')).toHaveAttribute('aria-current', 'page');
	const empty = page.getByTestId('inbox-filter-empty');
	await expect(empty).toContainText('Nothing decided yet');
	await page.reload();
	await expect(page.getByTestId('filter-decided')).toHaveAttribute('aria-current', 'page');
	await expect(empty).toContainText('Nothing decided yet');
	await captureScreen(page, testInfo, 'coach-inbox-filter-empty');
	await auditThemes(page, 'empty filter');

	await page.getByTestId('filter-waiting').click();
	await expect(page).toHaveURL(/\?show=waiting$/);
	await expect(waiting(page)).toHaveCount(2);
	// A row keeps the filter: back from the proposal is the same list.
	await waiting(page).nth(1).click();
	await expect(detail(page)).toBeVisible();
	await page.getByTestId('all-proposals').click();
	await expect(page).toHaveURL(/\/coach\/proposals\?show=waiting$/);

	await page.getByTestId('filter-all').click();
	await expect(page).toHaveURL(/\/coach\/proposals$/);
	await expect(waiting(page)).toHaveCount(2);
	await expect(waiting(page).nth(1)).toContainText(swap.title);
});

test('with no proposal at all, the inbox says what it is for and points to the coach', async ({
	page,
	request
}, testInfo) => {
	await resetCoach(request);
	await gotoHydrated(page, '/coach/proposals');
	const empty = page.getByTestId('inbox-empty');
	await expect(empty).toContainText('No proposals yet');
	await expect(page.getByTestId('inbox')).not.toHaveAttribute('data-layout');
	await captureScreen(page, testInfo, 'coach-inbox-empty');
	await auditThemes(page, 'empty');
	await empty.getByRole('link', { name: 'Ask the coach' }).click();
	await expect(page).toHaveURL(/\/coach$/);
});

test('Ask for changes opens the conversation the proposal came from, with its sheet', async ({
	page,
	request
}) => {
	const { swap } = await twoProposals(request);
	await gotoHydrated(page, `/coach/proposals/${swap.id}`);
	await cardButton(page, 'Ask for changes').click();
	await expect(page).toHaveURL(new RegExp(`/coach/${swap.threadId}`));
	await expect(page.getByRole('dialog', { name: 'Ask for changes' })).toBeVisible();
	await page.keyboard.press('Escape');
	expect((await stored(swap.id))?.status).toBe('proposed');
});

test('an unknown or malformed proposal is the 404 page', async ({ page }) => {
	for (const path of [`/coach/proposals/${crypto.randomUUID()}`, '/coach/proposals/nope']) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(404);
		await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
	}
});

test('the proposal’s code failing to load says so, and its Retry opens the proposal', async ({
	page,
	request
}, testInfo) => {
	const { cycle } = await twoProposals(request);
	await gotoHydrated(page, '/coach/proposals');
	const chunk = `**/${detailChunk()}`;
	await page.route(chunk, (route) => route.abort());

	await waiting(page).first().click();
	const failed = page.getByTestId('detail-failed');
	await expect(failed).toContainText('Couldn’t load this proposal');
	await expect(detail(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-inbox-detail-failed');
	await auditThemes(page, 'detail failed');

	// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of the
	// proposal's page.
	await page.unroute(chunk);
	await failed.getByRole('button', { name: 'Retry' }).click();
	await expect(detail(page).getByTestId('proposal-card')).toContainText(cycle.title);
	await expect(page.getByTestId('detail-failed')).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`/coach/proposals/${cycle.id}$`));
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the list sits beside the proposal, which keeps the readable column, with hover and focus', async ({
		page,
		request
	}, testInfo) => {
		const { swap, cycle } = await twoProposals(request);
		await gotoHydrated(page, `/coach/proposals/${swap.id}`);
		await expectMainCentred(page, await tokenPx(page, '--content-wide'));
		await expectNoSideScroll(page);
		await expect(page.getByTestId('inbox')).toHaveAttribute('data-layout', 'split');

		const list = await boxOf(page.getByRole('region', { name: 'Proposals' }));
		const pane = await boxOf(page.getByTestId('inbox-pane'));
		expect(Math.abs(list.width - (await tokenPx(page, '--content-list')))).toBeLessThanOrEqual(1);
		expect(Math.abs(pane.width - (await tokenPx(page, '--content-readable')))).toBeLessThanOrEqual(
			1
		);
		expect(pane.x).toBeGreaterThan(list.x + list.width);
		expect(Math.abs(pane.y - list.y)).toBeLessThanOrEqual(1);
		await expect(waiting(page).nth(1)).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('all-proposals')).toBeHidden();

		const row = waiting(page).first();
		for (let i = 0; i < 30 && !(await row.evaluate((a) => a === document.activeElement)); i++) {
			await page.keyboard.press('Tab');
		}
		await expect(row).toBeFocused();
		expect(await row.evaluate((a) => a.matches(':focus-visible'))).toBe(true);
		expect(await row.evaluate((a) => getComputedStyle(a).outlineStyle)).toBe('solid');
		await captureScreen(page, testInfo, 'coach-inbox-desktop');
		await auditThemes(page, 'desktop');

		// Opening the other proposal: the one shown stays, dimmed and busy, until it renders. Its
		// data is held from the hover on: hovering preloads it, and opening it reuses that.
		let release!: () => void;
		const held = new Promise<void>((done) => (release = done));
		await page.route(`**/coach/proposals/${cycle.id}/__data.json*`, async (route) => {
			await held;
			await route.continue();
		});
		const border = () => row.evaluate((el) => getComputedStyle(el).borderColor);
		const resting = await border();
		await row.hover();
		await expect.poll(border).not.toBe(resting);
		await page.mouse.move(720, 880);
		await expect(row).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('inbox-pane')).toHaveAttribute('aria-busy', 'true');
		await expect(row).toHaveAttribute('aria-busy', 'true');
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await page.screenshot({
			path: `test-results/screens/${testInfo.project.name}/coach-inbox-opening-desktop.png`,
			animations: 'disabled'
		});
		release();
		await expect(detail(page).getByTestId('proposal-card')).toContainText(cycle.title);
		await expect(page.getByTestId('inbox-pane')).not.toHaveAttribute('aria-busy');
		await expect(row).toHaveAttribute('aria-current', 'page');
		await expect(row).toBeFocused();
	});

	// The plan's 'a 500 → Retry recovers', as the server answers it: a failed database read is
	// recorded as a 500 (app_errors) but answered with the load's soft failure, never an HTTP 500
	// (inbox.server.ts), so this sends that: a 200 whose page data is
	// { canAsk, state: 'failed', filter } (devalue's flattened form).
	test('a load that fails shows Couldn’t load your proposals, and Retry loads them', async ({
		page,
		request
	}, testInfo) => {
		const { swap, cycle } = await twoProposals(request);
		await gotoHydrated(page, `/coach/proposals/${swap.id}`);
		await page.route(
			`**/coach/proposals/${cycle.id}/__data.json*`,
			async (route) => {
				const response = await route.fetch();
				const body = (await response.json()) as { nodes: { data: unknown }[] };
				body.nodes.at(-1)!.data = [{ canAsk: 1, state: 2, filter: 3 }, true, 'failed', 'all'];
				await route.fulfill({ response, json: body });
			},
			{ times: 1 }
		);
		await waiting(page).first().click();
		const failed = page.getByTestId('inbox-failed');
		await expect(failed).toContainText('Couldn’t load your proposals');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-inbox-failed-desktop');
		await auditThemes(page, 'failed');

		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(detail(page).getByTestId('proposal-card')).toContainText(cycle.title);
		await expect(failed).toHaveCount(0);
	});
});
