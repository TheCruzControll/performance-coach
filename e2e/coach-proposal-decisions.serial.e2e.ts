/**
 * The owner's other answers to a proposal card, and every way a decision can fail
 * (src/lib/ui/coach/ProposalCard.svelte and RejectSheet.svelte, shown by
 * src/routes/(app)/coach/[[thread]]/Thread.svelte):
 * - Reject opens a sheet with an optional reason; the card shows it declined and Postgres keeps
 *   the reason. The next turn's context names only the proposal's id, kind and status; the coach
 *   reads the reason with get_coach_proposals, as untrusted_text, and acknowledges it.
 * - 'Ask for changes' sends the owner's words as a turn about the proposal: the revision's card
 *   follows, and the original is superseded as revised.
 * - An Accept the server failed, or whose answer was cut off after the server applied it, shows
 *   'Couldn’t save' with Retry, which sends the same id again: one version, one set of decisions.
 * - Offline, nothing can be decided; the sheet's code failing to load offers Retry.
 *
 * The split-squat-week fixture plans Bulgarian split squats; 'I hate Bulgarian split squats, so
 * replace them' proposes swapping them for their best alternative. Serial: the coach and program
 * rows are the one owner's (e2e/coach-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import {
	COACH_TZ,
	openThread,
	postTurn,
	query,
	resetCoach,
	seedCoach,
	type SeededCoach
} from './coach-support';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, SAME_ORIGIN, trackConsoleErrors } from './support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');
const SHEET_SOURCE = 'src/lib/ui/coach/RejectSheet.svelte';
const DECIDE_API = '**/api/coach/proposals/*';
const REPLACE = 'I hate Bulgarian split squats, so replace them';
const REASON = 'Lunges hurt my knee, keep the split squats for now';
const AFTER_REJECTING = 'I rejected that change';
const ONLY_THIS_WEEK = 'Only swap the Bulgarian split squats this week, not for good';

test.use({ timezoneId: COACH_TZ });
// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

let seeded: SeededCoach;
test.beforeEach(async ({ request }) => {
	seeded = await seedCoach(request, 'split-squat-week');
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

/** The sheet's chunk in the build under test, from Vite's manifest. */
function sheetChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[SHEET_SOURCE];
	if (!chunk) throw new Error(`${SHEET_SOURCE} is not in the build under test`);
	return chunk.file;
}

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const cards = (page: Page) => page.getByTestId('proposal-card');
const card = (page: Page) => cards(page).first();
const state = (page: Page) => card(page).getByTestId('proposal-state');
const button = (page: Page, name: string) => card(page).getByRole('button', { name });
const sheet = (page: Page, name: string) => page.getByRole('dialog', { name });

interface StoredProposal {
	id: string;
	status: string;
	decisionNote: string | null;
	supersededReason: string | null;
	revisionOf: string | null;
}

/** The owner's proposals, oldest first, as stored. */
const proposals = () =>
	query<StoredProposal>(
		`select id::text, status, decision_note as "decisionNote",
			superseded_reason as "supersededReason", revision_of::text as "revisionOf"
		from coach_proposals order by created_at`
	);

/** How many versions the fixture's program has, and how many decisions its versions record. */
async function versions(): Promise<{ versions: number; decisions: number }> {
	const [row] = await query<{ versions: number; decisions: number }>(
		`select (select count(*)::int from program_versions where program_id = $1) as versions,
			(select count(*)::int from programming_decisions where program_id = $1) as decisions`,
		[seeded.programId]
	);
	return row!;
}

/** Ask for the swap as the composer would, and open the conversation it started. */
async function proposed(page: Page, request: APIRequestContext): Promise<string> {
	const turn = await postTurn(request, REPLACE);
	expect(turn.status).toBe(200);
	const started = turn.events.find((event) => event.type === 'run_started');
	if (started?.type !== 'run_started') throw new Error('the turn started');
	await openThread(page, started.threadId);
	await expect(button(page, 'Accept')).toBeEnabled();
	return started.threadId;
}

/** Send `text` from the composer. */
async function ask(page: Page, text: string) {
	await composer(page).getByRole('textbox', { name: 'Message' }).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
}

/** A screenshot while a request is held: WebKit resolves document.fonts.ready only after load. */
async function captureHeld(page: Page, testInfo: TestInfo, name: string) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.screenshot({
		path: `test-results/screens/${testInfo.project.name}/${name}.png`,
		animations: 'disabled'
	});
}

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

/** Every stored row of a thread, parsed, oldest first. */
async function threadRows(threadId: string) {
	const rows = await query<{ kind: string; raw: string }>(
		`select kind, content::text as raw from coach_messages where thread_id = $1 order by seq`,
		[threadId]
	);
	return rows.map((row) => ({ kind: row.kind, content: JSON.parse(row.raw) as unknown }));
}

test('Reject keeps the owner’s reason, and the next turn reads it as untrusted text and acknowledges it', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const threadId = await proposed(page, request);
	const [stored] = await proposals();

	await button(page, 'Reject').click();
	const reject = sheet(page, 'Reject this change');
	await expect(reject).toBeVisible();
	await expect(reject.getByRole('textbox', { name: /Why not\?/ })).toHaveAttribute(
		'maxlength',
		'500'
	);
	await reject.getByRole('textbox', { name: /Why not\?/ }).fill(REASON);
	await captureScreen(page, testInfo, 'coach-reject-sheet');
	await auditThemes(page, 'reject sheet');

	// Held on the way: the form is busy, and Reject sends once.
	let release!: () => void;
	const held = new Promise<void>((done) => (release = done));
	const posted: unknown[] = [];
	await page.route(DECIDE_API, async (route) => {
		posted.push(JSON.parse(route.request().postData() ?? '{}'));
		await held;
		await route.continue();
	});
	await reject.getByTestId('decision-submit').click();
	await expect(reject.getByTestId('decision-form')).toHaveAttribute('aria-busy', 'true');
	await expect(reject.getByTestId('decision-submit')).toBeDisabled();
	await captureHeld(page, testInfo, 'coach-reject-pending');
	release();

	await expect(reject).toBeHidden();
	await expect(state(page)).toContainText('Declined');
	await expect(button(page, 'Accept')).toHaveCount(0);
	expect(posted).toEqual([{ action: 'reject', reason: REASON }]);
	expect((await proposals())[0]).toMatchObject({
		id: stored!.id,
		status: 'rejected',
		decisionNote: REASON
	});
	expect((await versions()).versions).toBe(1);
	await page.unroute(DECIDE_API);
	await captureScreen(page, testInfo, 'coach-proposal-rejected');
	await auditThemes(page, 'rejected');

	await ask(page, AFTER_REJECTING);
	await expect(page.getByTestId('live-answer').last()).toContainText(REASON, { timeout: 20_000 });
	await expect(page.getByTestId('live-answer').last()).toContainText('Understood');

	const rows = await threadRows(threadId);
	const context = rows.filter((row) => row.kind === 'context').at(-1)!;
	const text = String(context.content);
	const facts = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
		decidedProposals: unknown[];
	};
	expect(facts.decidedProposals).toEqual([
		{ id: stored!.id, kind: 'program_adjustment', status: 'rejected' }
	]);
	expect(text).not.toContain('Lunges hurt');

	type Block = {
		type?: string;
		id?: string;
		name?: string;
		tool_use_id?: string;
		content?: unknown;
	};
	const blocks = rows.flatMap((row) =>
		Array.isArray(row.content) ? (row.content as Block[]) : []
	);
	const reads = new Set(
		blocks.filter((b) => b.type === 'tool_use' && b.name === 'get_coach_proposals').map((b) => b.id)
	);
	const results = blocks
		.filter((b) => b.type === 'tool_result' && reads.has(b.tool_use_id))
		.map((b) =>
			typeof b.content === 'string'
				? b.content
				: (b.content as { text?: string }[]).map((part) => part.text ?? '').join('')
		);
	expect(results).toHaveLength(1);
	const listed = JSON.parse(results[0]!) as { items: { decisionNote: unknown }[] };
	expect(listed.items[0]!.decisionNote).toEqual({ untrusted_text: REASON });
	expect(errors).toEqual([]);
});

test('Ask for changes sends the owner’s words to the coach: the revision’s card follows, and the original is superseded as revised', async ({
	page,
	request
}, testInfo) => {
	await proposed(page, request);
	const [original] = await proposals();

	await button(page, 'Ask for changes').click();
	const revise = sheet(page, 'Ask for changes');
	await expect(revise).toBeVisible();
	await expect(revise.getByTestId('decision-submit')).toBeDisabled();
	await revise.getByRole('textbox', { name: 'What should change?' }).fill(ONLY_THIS_WEEK);
	await captureScreen(page, testInfo, 'coach-ask-for-changes-sheet');
	await revise.getByTestId('decision-submit').click();
	await expect(revise).toBeHidden();

	await expect(page.getByTestId('owner-message').last()).toHaveText(`You: ${ONLY_THIS_WEEK}`);
	await expect(cards(page)).toHaveCount(2, { timeout: 20_000 });
	await expect(state(page)).toContainText('Superseded');
	await expect(state(page)).toContainText('Replaced by a revised proposal');
	await expect(cards(page).last().getByRole('button', { name: 'Accept' })).toBeEnabled();

	const [first, second] = await proposals();
	expect(first).toMatchObject({
		id: original!.id,
		status: 'superseded',
		supersededReason: 'revised'
	});
	expect(second).toMatchObject({ status: 'proposed', revisionOf: original!.id });
	await captureScreen(page, testInfo, 'coach-proposal-revised');
	await auditThemes(page, 'revised');
});

test('an Accept the server failed shows Couldn’t save; Retry sends the same id and applies it once', async ({
	page,
	request
}, testInfo) => {
	await proposed(page, request);
	const [stored] = await proposals();
	const posted: string[] = [];
	await page.route(DECIDE_API, async (route) => {
		posted.push(route.request().url());
		if (posted.length === 1) await route.fulfill({ status: 500, json: { error: 'internal' } });
		else await route.continue();
	});

	await button(page, 'Accept').click();
	const failure = card(page).getByTestId('proposal-failure');
	await expect(failure).toContainText('Couldn’t save');
	await expect(button(page, 'Accept')).toBeEnabled();
	expect(await versions()).toMatchObject({ versions: 1 });
	expect((await proposals())[0]!.status).toBe('proposed');
	await captureScreen(page, testInfo, 'coach-proposal-save-failed');
	await auditThemes(page, 'save failed');

	await failure.getByRole('button', { name: 'Try again' }).click();
	await expect(state(page)).toContainText('Applied as version 2');
	await expect(card(page).getByTestId('proposal-failure')).toHaveCount(0);
	expect(posted).toEqual([
		expect.stringContaining(`/api/coach/proposals/${stored!.id}`),
		expect.stringContaining(`/api/coach/proposals/${stored!.id}`)
	]);
	const once = await versions();
	expect(once.versions).toBe(2);
	expect((await proposals())[0]!.status).toBe('applied');

	// The same decision again, from anywhere, writes nothing.
	const again = await request.post(`/api/coach/proposals/${stored!.id}`, {
		headers: SAME_ORIGIN,
		data: { action: 'accept' }
	});
	expect(await again.json()).toMatchObject({ changed: false });
	expect(await versions()).toEqual(once);
});

test('an Accept cut off after the server applied it: Retry shows it applied, with no second version', async ({
	page,
	request
}) => {
	await proposed(page, request);
	let calls = 0;
	await page.route(DECIDE_API, async (route) => {
		calls += 1;
		if (calls > 1) return route.continue();
		await route.fetch(); // the server applies it…
		await route.abort('connectionreset'); // …and its answer never arrives
	});

	await button(page, 'Accept').click();
	const failure = card(page).getByTestId('proposal-failure');
	await expect(failure).toContainText('Couldn’t save');
	const applied = await versions();
	expect(applied.versions).toBe(2);
	expect((await proposals())[0]!.status).toBe('applied');

	await failure.getByRole('button', { name: 'Try again' }).click();
	await expect(state(page)).toContainText('Applied as version 2');
	expect(calls).toBe(2);
	expect(await versions()).toEqual(applied);
});

test('offline, Accept and Reject are disabled and the card says why; back online they work', async ({
	page,
	request
}, testInfo) => {
	await proposed(page, request);
	await page.context().setOffline(true);
	await expect(button(page, 'Accept')).toBeDisabled();
	await expect(button(page, 'Reject')).toBeDisabled();
	await expect(button(page, 'Ask for changes')).toBeDisabled();
	await expect(card(page).getByTestId('proposal-offline')).toContainText('You’re offline');
	await captureScreen(page, testInfo, 'coach-proposal-offline');
	await auditThemes(page, 'offline');

	await page.context().setOffline(false);
	await expect(button(page, 'Accept')).toBeEnabled();
	await expect(button(page, 'Reject')).toBeEnabled();
	await expect(card(page).getByTestId('proposal-offline')).toHaveCount(0);
});

test('the sheet’s code failing to load is the chunk-failed notice, whose Retry opens the sheet', async ({
	page,
	request
}, testInfo) => {
	await proposed(page, request);
	const chunk = `**/${sheetChunk()}`;
	await page.route(chunk, (route) => route.abort());
	// Fetched as a module on the first tap, never as a modulepreload.
	await expect(page.locator(`link[rel="modulepreload"][href$="/${sheetChunk()}"]`)).toHaveCount(0);

	await button(page, 'Reject').click();
	const failed = page.getByTestId('decision-sheet-failed');
	await expect(failed).toContainText('Couldn’t load this part of the coach');
	await expect(sheet(page, 'Reject this change')).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-reject-sheet-failed');
	await auditThemes(page, 'sheet failed');

	// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of the
	// conversation that opens the sheet.
	await page.unroute(chunk);
	await failed.getByRole('button', { name: 'Try again' }).click();
	await expect(sheet(page, 'Reject this change')).toBeVisible();
	await expect(page.getByTestId('decision-sheet-failed')).toHaveCount(0);
	await expect(page).not.toHaveURL(/[?&]reject=/);
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('Reject opens a centred dialog from the keyboard, and closing it returns focus to Reject', async ({
		page,
		request
	}, testInfo) => {
		await proposed(page, request);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));

		const reject = button(page, 'Reject');
		for (let i = 0; i < 80 && !(await reject.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(reject).toBeFocused();
		expect(await reject.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		await page.keyboard.press('Enter');

		const dialog = sheet(page, 'Reject this change');
		await expect(dialog).toBeVisible();
		const box = (await dialog.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(20);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-reject-sheet-desktop');
		await auditThemes(page, 'desktop reject sheet');

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(reject).toBeFocused();
		expect((await proposals())[0]!.status).toBe('proposed');
	});
});
