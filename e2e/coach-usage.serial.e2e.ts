/**
 * The coach's usage sheet (src/routes/(app)/coach/[[thread]]/UsageSheet.svelte), opened from the
 * Coach header and read from stored runs (GET /api/coach/runs):
 * - a turn that called two tools costs what domain/coach/pricing.ts gives its stored calls, and a
 *   lookup answered with no model call costs $0.00
 * - a fresh owner sees 'No coach runs yet'
 * - a run served by a model with no price is 'Not priced', with the daily cap's caption
 * - loading rows while the read is held; a 500 offers Retry, which loads it
 * - axe in both themes, on an iPhone and on a desktop window, where the runs are a table in a
 *   wide centred dialog with a focus ring
 *
 * Serial: the coach rows and the faults are the one owner's and the one server's
 * (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { costMicros, formatCost } from '../src/lib/domain/coach/pricing';
import {
	COACH_TZ,
	lastRun,
	postTurn,
	query,
	resetCoach,
	seedCoach,
	setCoachFault
} from './coach-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: COACH_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

/** A lookup the server answers with no model call (domain/coach/intents.ts). */
const LOOKUP = "What's on this week?";
/** Answered by the forced 'running-and-lifting' script: two tools, then the answer. */
const TWO_TOOLS = 'How are my running and lifting going together?';

const sheet = (page: Page) => page.getByTestId('usage-sheet');
const runCards = (page: Page) => page.getByTestId('usage-run');

async function openUsage(page: Page) {
	await gotoHydrated(page, '/coach');
	await page.getByRole('button', { name: 'Coach usage' }).click();
	await expect(sheet(page)).toBeVisible();
}

/** What the domain's pricing gives a run's stored model calls, as the screen writes it. */
async function domainCost(runId: string): Promise<string> {
	const calls = await query<{
		model: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	}>(
		`select model, input_tokens::int as "inputTokens", output_tokens::int as "outputTokens",
			cache_read_tokens::int as "cacheReadTokens", cache_write_tokens::int as "cacheWriteTokens"
		from agent_model_calls where run_id = $1 order by call_index`,
		[runId]
	);
	expect(calls.length, 'a tool step, then the answer').toBe(2);
	const micros = calls.reduce((sum, { model, ...usage }) => sum + costMicros(usage, model)!, 0);
	return formatCost(micros);
}

/** axe on the open sheet in the dark and the light theme. */
async function auditSheet(page: Page) {
	await gotoHydrated(page, '/coach');
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await openUsage(page);
		await expect(page.getByTestId('usage-loading')).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // the sheet's entrance settles: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe on the usage sheet, ${theme}`).toEqual([]);
	}
}

test('a two-tool turn costs what the domain prices its calls at, and a lookup costs $0.00', async ({
	page,
	request
}, testInfo) => {
	await setCoachFault(request, 'none', { script: 'running-and-lifting' });
	expect((await postTurn(request, TWO_TOOLS)).status).toBe(200);
	const tools = (await lastRun())!;
	expect(tools.status).toBe('completed');
	const [counted] = await query<{ toolCalls: number }>(
		`select count(*)::int as "toolCalls" from agent_tool_calls where run_id = $1`,
		[tools.id]
	);
	expect(counted!.toolCalls).toBe(2);
	const expected = await domainCost(tools.id);

	await setCoachFault(request, 'none');
	expect((await postTurn(request, LOOKUP)).status).toBe(200);

	await openUsage(page);
	await expect(runCards(page)).toHaveCount(2);
	const [direct, priced] = [runCards(page).nth(0), runCards(page).nth(1)];
	await expect(direct.getByTestId('usage-run-cost')).toHaveText('$0.00');
	await expect(direct).toContainText('No model call');
	await expect(priced.getByTestId('usage-run-cost')).toHaveText(expected);
	await expect(priced).toContainText('2 tool calls');
	await expect(page.getByTestId('usage-total-cost')).toContainText(expected);
	await expect(page.getByTestId('usage-tools')).toContainText('get_performance_trends');
	await expect(page.getByTestId('usage-tools')).toContainText('get_training_load');
	await expect(page.getByTestId('usage-statuses')).toContainText('Completed');
	await expect(sheet(page)).toContainText('$4 / $20 per million tokens');
	await expect(page.getByTestId('usage-unpriced')).toHaveCount(0);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-usage');
});

test('a fresh owner sees No coach runs yet', async ({ page }, testInfo) => {
	await openUsage(page);
	await expect(page.getByTestId('usage-empty')).toContainText('No coach runs yet');
	await expect(page.getByTestId('usage-totals')).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-usage-empty');
});

test('a run served by a model with no price is Not priced, with the cap’s caption', async ({
	page,
	request
}, testInfo) => {
	await seedCoach(request, 'unpriced-run');
	await openUsage(page);
	await expect(runCards(page)).toHaveCount(1);
	await expect(runCards(page).first().getByTestId('usage-run-cost')).toHaveText('Not priced');
	await expect(page.getByTestId('usage-total-cost')).toContainText('1 run not priced');
	await expect(page.getByTestId('usage-unpriced')).toContainText(
		'The daily cap counts it at the highest known rate.'
	);
	await captureScreen(page, testInfo, 'coach-usage-unpriced');
});

test('the usage sheet has no WCAG A/AA violations in either theme', async ({ page, request }) => {
	await seedCoach(request, 'unpriced-run');
	await auditSheet(page);
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('loading rows while the read is held; a 500 offers Retry, which loads it', async ({
		page
	}, testInfo) => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let answered = 0;
		await page.route('**/api/coach/runs*', async (route) => {
			answered += 1;
			if (answered === 1) {
				await held;
				return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
			}
			return route.continue();
		});

		await openUsage(page);
		const loading = page.getByTestId('usage-loading');
		await expect(loading).toHaveAttribute('aria-busy', 'true');
		await expect(loading).toContainText('Loading usage…');
		await page.evaluate(async () => {
			while (document.fonts.status !== 'loaded') await new Promise((r) => setTimeout(r, 20));
		});
		await captureScreen(page, testInfo, 'coach-usage-loading');
		release();

		const failed = page.getByTestId('usage-failed');
		await expect(failed).toContainText('Couldn’t load usage');
		await captureScreen(page, testInfo, 'coach-usage-failed');
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(page.getByTestId('usage-empty')).toContainText('No coach runs yet');
		await expect(failed).toHaveCount(0);
		expect(answered).toBe(2);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the runs are a table in a wide centred dialog, with a focus ring and hover', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'unpriced-run');
		await openUsage(page);
		const table = page.getByTestId('usage-run-table');
		await expect(table).toBeVisible();
		await expect(page.getByTestId('usage-run-cards')).toBeHidden();
		await expect(table.getByTestId('usage-row-cost')).toHaveText(['Not priced']);

		// Wider than a plain sheet's 32rem dialog, centred in the window.
		const box = (await sheet(page).locator('.sheet').boundingBox())!;
		const width = page.viewportSize()!.width;
		expect(box.width).toBeGreaterThan(32 * 16);
		expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);

		const region = page.getByRole('region', { name: 'Runs, table' });
		await region.focus();
		await expect
			.poll(() => region.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');
		const row = page.getByTestId('usage-row').first();
		const resting = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
		await row.hover();
		await expect
			.poll(() => row.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(resting);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-usage-desktop');
	});

	test('the usage sheet has no WCAG A/AA violations on a desktop window in either theme', async ({
		page,
		request
	}) => {
		await seedCoach(request, 'unpriced-run');
		await auditSheet(page);
	});
});
