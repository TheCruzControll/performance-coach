/**
 * Proposal cards in the conversation (src/lib/ui/coach/ProposalCard.svelte and DiffRows.svelte,
 * shown by src/routes/(app)/coach/[[thread]]/Thread.svelte): a change the coach proposes appears
 * inline after its answer, saying what changes, why and the impact on the week. Nothing changes
 * until Accept, which applies the stored proposal by id and shows the version it made, linked to
 * that version in Train, where the decision keeps the coach's why; a reload keeps the applied
 * card. A double tap applies it once, a modified request still applies only what was stored, and
 * a proposal the owner's own edit overtook is superseded instead. The card's code loads with the
 * first card; a failed fetch is the chunk-failed notice, whose Retry shows the card. The
 * conversation says things once: titled by the proposal, the answer's note a footnote under the
 * card, no recommendation repeating it, and 'Nothing changes until you accept' only on the card.
 * A next cycle's pitch says what its card doesn't (the current program stays), so it stays.
 *
 * The split-squat-week fixture plans Bulgarian split squats; 'I hate Bulgarian split squats, so
 * replace them' records the dislike and proposes swapping them for their best alternative.
 * Serial: the coach and program rows are the one owner's (e2e/coach-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
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
import { captureScreen, gotoHydrated, SAME_ORIGIN, trackConsoleErrors } from './support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');
const CARD_SOURCE = 'src/lib/ui/coach/ProposalCard.svelte';
const ACCEPT_API = '**/api/coach/proposals/*';
const REPLACE = 'I hate Bulgarian split squats, so replace them';

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

/** The card's chunk in the build under test, from Vite's manifest. */
function cardChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[CARD_SOURCE];
	if (!chunk) throw new Error(`${CARD_SOURCE} is not in the build under test`);
	return chunk.file;
}

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const card = (page: Page) => page.getByTestId('proposal-card');
const accept = (page: Page) => card(page).getByRole('button', { name: 'Accept' });

interface StoredProposal {
	id: string;
	title: string;
	rationale: string;
	status: string;
	payload: unknown;
}

/** The owner's proposals, oldest first, as stored. */
const proposals = () =>
	query<StoredProposal>(
		`select id::text, title, rationale, status, payload from coach_proposals order by created_at`
	);

/** How many versions the fixture's program has. */
async function versions(): Promise<number> {
	const [row] = await query<{ n: number }>(
		`select count(*)::int as n from program_versions where program_id = $1`,
		[seeded.programId]
	);
	return row!.n;
}

/** Ask for the swap as the composer would, and open the conversation it started. */
async function proposed(page: Page, request: APIRequestContext) {
	const turn = await postTurn(request, REPLACE);
	expect(turn.status).toBe(200);
	const started = turn.events.find((event) => event.type === 'run_started');
	expect(turn.events.some((event) => event.type === 'proposal')).toBe(true);
	if (started?.type !== 'run_started') throw new Error('the turn started');
	await openThread(page, started.threadId);
	return started.threadId;
}

/** An owner edit through Train's own action: a session next week moves a day, as version 2. */
async function ownerMove(request: APIRequestContext) {
	const nextWeek = addDays(seeded.weekStart, 7);
	const [session] = await query<{ lineage: string; day: string; version: number }>(
		`select ps.lineage_id::text as lineage, ps.scheduled_on::text as day, pv.number as version
		from programs p
		join program_versions pv on pv.id = p.current_version_id
		join program_version_weeks pvw on pvw.version_id = pv.id
		join planned_sessions ps on ps.week_id = pvw.week_id
		where p.id = $1 and ps.status = 'planned' and ps.scheduled_on >= $2
		order by ps.scheduled_on limit 1`,
		[seeded.programId, nextWeek]
	);
	expect(session, 'the fixture plans next week').toBeDefined();
	const toDate = addDays(session!.day, session!.day < addDays(nextWeek, 6) ? 1 : -1);
	const response = await request.post(`/train/session/${session!.lineage}?/move`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: {
			payload: JSON.stringify({ sessionLineage: session!.lineage, toDate, version: 1 })
		}
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

/** The thread says things once: by its outcome, the note as a footnote, one 'nothing changes'. */
async function expectSaidOnce(page: Page, title: string) {
	const thread = page.getByTestId('thread');
	await expect(thread.getByRole('heading', { level: 2 })).toHaveText(title);
	await expect(thread.getByTestId('answer-footnote')).toHaveText(
		/Noted that you dislike Bulgarian split squats\./
	);
	await expect(thread.getByTestId('answer-block')).toHaveCount(0);
	// What the screen shows, not what a screen reader is told, and only once.
	const shown = () =>
		thread.evaluate((el) => {
			const copy = el.cloneNode(true) as HTMLElement;
			for (const hidden of copy.querySelectorAll('.visually-hidden')) hidden.remove();
			return copy.textContent ?? '';
		});
	await expect.poll(async () => (await shown()).match(/nothing changes until/gi)?.length).toBe(1);
	expect(await shown()).not.toMatch(/Recommendation/);
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

test('a proposed change shows inline with what changes, why and its impact; Accept applies it as version 2, which Train shows with the why, and a reload keeps it', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/coach');
	await composer(page).getByRole('textbox', { name: 'Message' }).fill(REPLACE);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(page).toHaveURL(/\/coach\/[0-9a-f-]{36}$/);

	// After the answer that proposed it, read from what was stored.
	await expect(card(page)).toBeVisible({ timeout: 20_000 });
	const [stored] = await proposals();
	expect(stored).toMatchObject({ status: 'proposed' });
	await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(stored!.title);
	const row = card(page).getByTestId('diff-row');
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Bulgarian split squat');
	await expect(row).toContainText(/from\s*Bulgarian split squat\s*to\s*\S/);
	await expect(card(page).getByTestId('proposal-why')).toHaveText(stored!.rationale);
	await expect(card(page).getByTestId('proposal-impact')).toBeVisible();
	await expect(card(page)).toContainText('Nothing changes until you accept.');
	await expectSaidOnce(page, stored!.title);
	expect(await versions()).toBe(1);
	await captureScreen(page, testInfo, 'coach-proposal-card');
	await auditThemes(page, 'proposed');

	await accept(page).click();
	const state = card(page).getByTestId('proposal-state');
	await expect(state).toContainText('Applied as version 2');
	await expect(accept(page)).toHaveCount(0);
	expect(await versions()).toBe(2);
	expect((await proposals())[0]).toMatchObject({ id: stored!.id, status: 'applied' });
	await captureScreen(page, testInfo, 'coach-proposal-applied');
	await auditThemes(page, 'applied');

	await page.reload();
	await expect(card(page).getByTestId('proposal-state')).toContainText('Applied as version 2');
	await expect(page.getByTestId('thread').getByRole('heading', { level: 2 })).toHaveText(
		stored!.title
	);
	await expect(page.getByTestId('answer-footnote')).toHaveCount(1);
	await expect(page.getByTestId('answer-block')).toHaveCount(0);

	await card(page).getByRole('link', { name: 'View in Train' }).click();
	await expect(page).toHaveURL(/\/train\/history\/2$/);
	await expect(page.getByTestId('current-version')).toBeVisible();
	await expect(page.getByTestId('version-changes')).toContainText(stored!.rationale);
	expect(errors).toEqual([]);
});

test('a double tap applies it once, and a modified request still applies only the stored proposal', async ({
	page,
	request
}) => {
	await proposed(page, request);
	const [stored] = await proposals();
	const posted: unknown[] = [];
	// What a tampered client might send: another payload, title, status and owner.
	await page.route(ACCEPT_API, async (route) => {
		const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
		posted.push(body);
		await route.continue({
			postData: JSON.stringify({
				...body,
				payload: { ops: [] },
				title: 'Something else',
				status: 'rejected',
				ownerId: crypto.randomUUID()
			})
		});
	});

	await accept(page).dblclick();
	await expect(card(page).getByTestId('proposal-state')).toContainText('Applied as version 2');
	expect(posted, 'one Accept, by id').toEqual([{ action: 'accept' }]);
	expect(await versions()).toBe(2);
	const [after] = await proposals();
	expect(after).toEqual({ ...stored, status: 'applied' });

	// The same Accept again, from anywhere, answers the stored result and writes nothing.
	const again = await request.post(`/api/coach/proposals/${stored!.id}`, {
		headers: SAME_ORIGIN,
		data: { action: 'accept' }
	});
	expect(again.status()).toBe(200);
	expect(await again.json()).toMatchObject({ changed: false, proposal: { status: 'applied' } });
	expect(await versions()).toBe(2);
});

test('an owner edit since it was proposed supersedes it: Accept says why, and applies nothing', async ({
	page,
	request
}, testInfo) => {
	await proposed(page, request);
	await ownerMove(request);
	expect(await versions()).toBe(2);

	await accept(page).click();
	const state = card(page).getByTestId('proposal-state');
	await expect(state).toContainText('Superseded');
	await expect(state).toContainText('The program changed since it was proposed');
	await expect(accept(page)).toHaveCount(0);
	expect(await versions()).toBe(2);
	expect((await proposals())[0]!.status).toBe('superseded');
	await captureScreen(page, testInfo, 'coach-proposal-superseded');
	await auditThemes(page, 'superseded');

	await page.reload();
	await expect(card(page).getByTestId('proposal-state')).toContainText('Superseded');
});

test('a next-cycle proposal keeps its pitch, which says the current program doesn’t change', async ({
	page,
	request
}) => {
	const turn = await postTurn(request, 'Plan my next cycle');
	expect(turn.status).toBe(200);
	const started = turn.events.find((event) => event.type === 'run_started');
	expect(turn.events.some((event) => event.type === 'proposal')).toBe(true);
	if (started?.type !== 'run_started') throw new Error('the turn started');
	await openThread(page, started.threadId);

	await expect(card(page)).toBeVisible({ timeout: 20_000 });
	await expect(card(page)).toContainText('Nothing changes until you accept.');
	// The card doesn’t say Accept leaves the current program alone; the pitch does, so it stays.
	const pitch = page.getByTestId('thread').getByTestId('answer-block');
	await expect(pitch).toHaveCount(1);
	await expect(pitch).toContainText('your current program doesn’t change');
});

test('the card’s code failing to load is the chunk-failed notice, whose Retry shows the card', async ({
	page,
	request
}) => {
	const turn = await postTurn(request, REPLACE);
	const started = turn.events.find((event) => event.type === 'run_started');
	if (started?.type !== 'run_started') throw new Error('the turn started');
	const chunk = `**/${cardChunk()}`;
	await page.route(chunk, (route) => route.abort());
	await openThread(page, started.threadId);
	// Fetched as a module, never as a modulepreload, which WebKit would never fetch again.
	await expect(page.locator(`link[rel="modulepreload"][href$="/${cardChunk()}"]`)).toHaveCount(0);

	const failed = page.getByTestId('proposal-failed');
	await expect(failed).toContainText('Couldn’t load this part of the coach');
	await expect(card(page)).toHaveCount(0);

	// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of the
	// conversation.
	await page.unroute(chunk);
	await failed.getByRole('button', { name: 'Retry' }).click();
	await expect(card(page)).toBeVisible();
	await expect(accept(page)).toBeEnabled();
	await expect(page.getByTestId('proposal-failed')).toHaveCount(0);
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the card keeps the readable column, and Accept works from the keyboard', async ({
		page,
		request
	}, testInfo) => {
		await proposed(page, request);
		await expect(card(page)).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));

		const button = accept(page);
		for (let i = 0; i < 80 && !(await button.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(button).toBeFocused();
		expect(await button.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-proposal-card-desktop');
		await auditThemes(page, 'desktop proposed');

		await page.keyboard.press('Enter');
		await expect(card(page).getByTestId('proposal-state')).toContainText('Applied as version 2');
		const link = card(page).getByRole('link', { name: 'View in Train' });
		const before = await link.evaluate((el) => getComputedStyle(el).textDecorationLine);
		await link.hover();
		await expect
			.poll(() => link.evaluate((el) => getComputedStyle(el).textDecorationLine))
			.not.toBe(before);
		await captureScreen(page, testInfo, 'coach-proposal-applied-desktop');
		await auditThemes(page, 'desktop applied');
	});
});
