/**
 * A weekly review's next-week card (src/routes/(app)/progress/reviews/[[key]], NextWeekCard):
 * accept, change or skip each recommended change, generate next week and see it in Train and
 * History, with every no-decision, late and failure state.
 *
 * - review-ahead (every change ahead): accept all, then Train's next week holds bench at the new
 *   load and History the version with its why; one left out and one at its half step applies
 *   exactly those; keep as planned stores the reason and makes no version; a second tap posts
 *   nothing (one version); offline disables the actions and keeps the choices; a plan changed
 *   since reads superseded; a failed post's Retry resends it; accepted untouched in M5's inbox,
 *   the review reads applied.
 * - review-aged (stored on Monday): the changes whose sessions have passed are struck through,
 *   Generate applies only the rest and the toast says how many had passed; accepted in M5's
 *   inbox, the review offers the rest, and applying it makes one version. On a Saturday or
 *   Sunday every one has passed: the card says it is too late, and both skip the rest (the
 *   integration test pins Thursday).
 * - next-week-deload (no ops), no program (to the build), block-end (a new block: to the cycle
 *   review) and week-late (late), each created from the list.
 * - axe in both themes on the card and the Keep sheet; the screen at 393 × 659 and 1440 × 900.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { seedAnalytics } from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { programVersions, proposalChain, weeklyReviews } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type ReviewTarget
} from './review-support';
import { captureScreen, gotoHydrated, SAME_ORIGIN, toastWith } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';

interface Seeded {
	programId: string;
	review: Extract<ReviewTarget, { kind: 'weekly' }>;
	lineages: { benchMonday: string; benchThursday: string };
}

/** Reset, then seed one of the stored-review scenarios (analytics-fixtures/review-aged.ts). */
async function seedStored(request: APIRequestContext, fixture: 'review-ahead' | 'review-aged') {
	await resetReviews(request);
	return (await seedAnalytics(request, fixture)) as unknown as Seeded;
}

const card = (page: Page) => page.getByTestId('review-next-week');
const items = (page: Page) => page.getByTestId('review-next-item');
const passedItems = (page: Page) => items(page).filter({ has: page.locator('input:disabled') });
const generate = (page: Page) => page.getByTestId('review-next-generate');
const keep = (page: Page) => page.getByTestId('review-next-keep');
const keepSheet = (page: Page) => page.getByTestId('keep-sheet');
const isDecide = (url: URL) => url.pathname.startsWith(LIST) && url.search === '?/decide';
const pageOf = (s: Seeded) => `${LIST}/w-${s.review.weekStartsOn}`;

/** The review's proposal chain head, read in SQL. */
async function head(s: Seeded) {
	const [live] = (await weeklyReviews(s.review.weekStartsOn)).filter((r) => r.live);
	return (await proposalChain(live!.proposalId!)).head;
}

async function decisionNote(id: string) {
	const [row] = await query<{ note: string | null }>(
		'select decision_note as note from coach_proposals where id = $1::uuid',
		[id]
	);
	return row!.note;
}

/**
 * Accept the review's proposal from M5's inbox, as its Accept posts it: 200 when it applied, 409
 * (the inbox card's answer all the same) when it was superseded because some sessions had passed.
 */
async function acceptInInbox(request: APIRequestContext, s: Seeded, status: 200 | 409 = 200) {
	const { id } = (await proposalChain((await weeklyReviews(s.review.weekStartsOn))[0]!.proposalId!))
		.chain[0]!;
	const response = await request.post(`/api/coach/proposals/${id}`, {
		headers: SAME_ORIGIN,
		data: { action: 'accept' }
	});
	expect(response.status()).toBe(status);
}

/** Skip a session through Train's own action, as another tab would: the plan moves on. */
async function skipThroughAction(request: APIRequestContext, lineage: string) {
	const response = await request.post(`/train/session/${lineage}?/skip`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: JSON.stringify({ sessionLineage: lineage, version: 1 }) }
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

test.describe('review-ahead: every change still ahead', () => {
	let seeded: Seeded;

	test.beforeEach(async ({ request }) => {
		seeded = await seedStored(request, 'review-ahead');
	});

	test('accept all: Train holds bench at the new load, History the version and its why', async ({
		page
	}) => {
		await gotoHydrated(page, pageOf(seeded));
		await expect(card(page)).toHaveAttribute('data-state', 'open');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText('Next week’s changes');
		const count = await items(page).count();
		expect(count).toBeGreaterThan(1);
		await expect(passedItems(page)).toHaveCount(0);

		await generate(page).click();
		await expect(page).toHaveURL(/\/train\?week=4$/);
		await expect(toastWith(page, 'Next week updated · version 2')).toBeVisible();
		const versions = await programVersions(seeded.programId);
		expect(versions.map((v) => [v.number, v.current])).toEqual([
			[1, false],
			[2, true]
		]);
		expect((await head(seeded)).appliedVersionNumber).toBe(2);

		await gotoHydrated(page, `/train/session/${seeded.lineages.benchThursday}`);
		await expect(page.getByTestId('exercises')).toContainText('87.5 kg');

		const why = versions[1]!.decisions.find((d) => d.why.includes('Bench press'))!.why;
		await gotoHydrated(page, '/train/history');
		await expect(page.getByTestId('version').first().getByTestId('decision')).toContainText([why]);

		await gotoHydrated(page, pageOf(seeded));
		await expect(card(page)).toHaveAttribute('data-state', 'applied');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Next week updated · version 2'
		);
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', '/train/history/2');
		await expect(page.getByTestId('review-next-generate')).toHaveCount(0);
	});

	test('one left out and one at its half step: exactly those, then the card reads applied', async ({
		page
	}) => {
		await gotoHydrated(page, pageOf(seeded));
		const idOf = (item: Locator) => item.locator('input[name="item"]').getAttribute('value');
		const halved = items(page).filter({ hasText: 'Half step · 86.25 kg' }).first();
		const halvedId = await idOf(halved);
		await halved.getByLabel('Half step · 86.25 kg').check();
		// Leave every other change out.
		for (const item of await items(page).all()) {
			if ((await idOf(item)) !== halvedId) await item.locator('input[name="item"]').uncheck();
		}
		await generate(page).click();
		await expect(page).toHaveURL(/\/train\?week=4$/);
		await expect(toastWith(page, 'Next week updated · version 2')).toBeVisible();

		const { chain, head: applied } = await proposalChain((await head(seeded)).id);
		expect(applied).toMatchObject({ status: 'applied', appliedVersionNumber: 2 });
		expect(chain.at(-2)).toMatchObject({ status: 'superseded' });
		const [row] = await query<{ ops: { loadValue?: number }[] }>(
			`select payload->'ops' as ops from coach_proposals where id = $1::uuid`,
			[applied.id]
		);
		expect(row!.ops).toEqual([expect.objectContaining({ loadValue: 86.25 })]);

		await gotoHydrated(page, pageOf(seeded));
		await expect(card(page)).toHaveAttribute('data-state', 'applied');
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', '/train/history/2');
	});

	test('keep as planned: the reason is stored, and no version is made', async ({ page }) => {
		await gotoHydrated(page, pageOf(seeded));
		await keep(page).click();
		await expect(keepSheet(page)).toBeVisible();
		await auditBothThemes(page, 'Keep sheet');
		await keepSheet(page)
			.getByLabel(/^Why keep it/)
			.fill('A race this weekend');
		await page.getByTestId('keep-submit').click();
		await expect(keepSheet(page)).toBeHidden();
		await expect(card(page)).toHaveAttribute('data-state', 'rejected');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText('Kept as planned');
		await expect(page.getByTestId('review-next-words')).toHaveText('A race this weekend');

		expect(await programVersions(seeded.programId)).toHaveLength(1);
		const decided = await head(seeded);
		expect(decided.status).toBe('rejected');
		expect(await decisionNote(decided.id)).toBe('A race this weekend');
	});

	test('offline: the actions are disabled and the choices kept', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await gotoHydrated(page, pageOf(seeded));
		const first = items(page).first().locator('input[name="item"]');
		await first.uncheck();
		await context.setOffline(true);
		await expect(generate(page)).toBeDisabled();
		await expect(keep(page)).toBeDisabled();
		// The shell says the app is offline; the card keeps the choices as they were.
		await expect(page.getByTestId('offline-notice')).toBeVisible();
		await expect(first).not.toBeChecked();
		await context.setOffline(false);
		await expect(generate(page)).toBeEnabled();
		await expect(first).not.toBeChecked();
		expect(await programVersions(seeded.programId)).toHaveLength(1);
	});

	test('a plan changed since the review: Generate applies nothing, and the card says why', async ({
		page,
		request
	}) => {
		await gotoHydrated(page, pageOf(seeded));
		await skipThroughAction(request, seeded.lineages.benchThursday);
		await generate(page).click();
		await expect(card(page)).toHaveAttribute('data-state', 'superseded');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Your plan changed since this review'
		);
		// Only the skip made a version.
		expect((await programVersions(seeded.programId)).map((v) => v.createdBy)).toEqual([
			'rules',
			'owner'
		]);
		expect((await head(seeded)).supersededReason).toBe('program_changed');
	});

	test('accepted untouched in M5’s inbox: the review reads applied', async ({ page, request }) => {
		await acceptInInbox(request, seeded);
		await gotoHydrated(page, pageOf(seeded));
		await expect(card(page)).toHaveAttribute('data-state', 'applied');
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', '/train/history/2');
		expect(await programVersions(seeded.programId)).toHaveLength(2);
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('pending: aria-busy, and a second tap posts nothing (one version)', async ({ page }) => {
			await gotoHydrated(page, pageOf(seeded));
			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(isDecide, async (route) => {
				posts += 1;
				await held;
				await route.continue();
			});
			await generate(page).click();
			await expect(generate(page)).toHaveAttribute('aria-busy', 'true');
			await expect(card(page).locator('form[aria-busy="true"]')).toHaveCount(1);
			await generate(page).dispatchEvent('click');
			await card(page)
				.locator('form[action="?/decide"]')
				.evaluate((form: HTMLFormElement) => form.requestSubmit());
			release();
			await expect(page).toHaveURL(/\/train\?week=4$/);
			expect(posts).toBe(1);
			expect(await programVersions(seeded.programId)).toHaveLength(2);
		});

		test('a failed post says so, and Retry resends the same choices', async ({ page }) => {
			await gotoHydrated(page, pageOf(seeded));
			await items(page).first().locator('input[name="item"]').uncheck();
			const bodies: string[] = [];
			await page.route(isDecide, async (route) => {
				bodies.push(route.request().postData() ?? '');
				if (bodies.length === 1) return route.fulfill({ status: 500, body: 'boom' });
				await route.continue();
			});
			await generate(page).click();
			await expect(page.getByTestId('review-next-failure')).toContainText('Couldn’t save it');
			await expect(generate(page)).toHaveText('Retry');
			expect(await programVersions(seeded.programId)).toHaveLength(1);
			await generate(page).click();
			await expect(page).toHaveURL(/\/train\?week=4$/);
			expect(bodies).toHaveLength(2);
			// The same fields and values; only the multipart boundary differs.
			const fields = (body: string) => body.replace(/^--.*$/gm, '').trim();
			expect(fields(bodies[1]!)).toBe(fields(bodies[0]!));
			expect(fields(bodies[0]!)).toContain('name="item"');
			expect(await programVersions(seeded.programId)).toHaveLength(2);
		});
	});

	test('on a phone: axe is clean on the card, and the screen is captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, pageOf(seeded));
		await card(page).scrollIntoViewIfNeeded();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Next week card');
		await captureScreen(page, testInfo, 'review-next-week-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the card in the review column, nothing scrolls sideways', async ({ page }, testInfo) => {
			await gotoHydrated(page, pageOf(seeded));
			await expect(card(page)).toBeVisible();
			await expectNoSideScroll(page);
			await generate(page).hover();
			await captureScreen(page, testInfo, 'review-next-week-desktop');
		});
	});
});

test.describe('review-aged: stored on Monday, decided later in the week', () => {
	let seeded: Seeded;

	test.beforeEach(async ({ request }) => {
		seeded = await seedStored(request, 'review-aged');
	});

	test('the passed changes are struck through, and Generate applies only the rest', async ({
		page
	}) => {
		await gotoHydrated(page, pageOf(seeded));
		const total = await items(page).count();
		const passed = await passedItems(page).count();
		expect(passed).toBeGreaterThan(0);
		await expect(passedItems(page).first()).toContainText(/has passed|has started/);
		if (passed === total) {
			// Saturday or Sunday: every change has passed.
			await expect(card(page)).toHaveAttribute('data-state', 'all_past');
			await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
				'Too late to change next week'
			);
			await expect(generate(page)).toHaveCount(0);
			test.skip(true, 'Saturday or Sunday: every change has passed, so there is no rest to apply');
		}
		await expect(card(page)).toHaveAttribute('data-state', 'partly_past');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Some sessions have passed — apply the rest?'
		);
		await generate(page).click();
		await expect(page).toHaveURL(/\/train/);
		const changes = passed === 1 ? '1 change was' : `${passed} changes were`;
		await expect(
			toastWith(page, `Next week updated · version 2 · ${changes} for sessions already past`)
		).toBeVisible();
		expect(await programVersions(seeded.programId)).toHaveLength(2);
		const [row] = await query<{ n: number }>(
			`select jsonb_array_length(payload->'ops')::int as n from coach_proposals where id = $1::uuid`,
			[(await head(seeded)).id]
		);
		expect(row!.n).toBe(total - passed);
	});

	test('accepted in M5’s inbox: the review offers the rest, and applying it makes one version', async ({
		page,
		request
	}) => {
		await acceptInInbox(request, seeded, 409);
		expect((await head(seeded)).supersededReason).toBe('sessions_passed');
		expect(await programVersions(seeded.programId)).toHaveLength(1);

		await gotoHydrated(page, pageOf(seeded));
		const total = await items(page).count();
		const passed = await passedItems(page).count();
		if (passed === total) {
			await expect(card(page)).toHaveAttribute('data-state', 'all_past');
			test.skip(true, 'Saturday or Sunday: every change has passed, so there is no rest to apply');
		}
		await expect(card(page)).toHaveAttribute('data-state', 'partly_past');
		await generate(page).click();
		await expect(page).toHaveURL(/\/train/);
		expect(await programVersions(seeded.programId)).toHaveLength(2);
		expect(await head(seeded)).toMatchObject({ status: 'applied', appliedVersionNumber: 2 });
	});
});

test.describe('nothing to decide', () => {
	/**
	 * Create the review of `week` from the list (by default the week due for review: this week is
	 * still in progress until it ends), then open it.
	 */
	async function create(page: Page, week?: string) {
		await gotoHydrated(page, LIST);
		const form = week
			? page.locator(`[data-testid="review-create"]:has(input[value="${week}"])`)
			: page.locator('[data-testid="review-create"][data-state="due"]');
		await form.getByRole('button').click();
		await expect(page).toHaveURL(/\/progress\/reviews\/w-/);
		await expect(card(page)).toBeVisible();
	}

	test('next week already light: it stays as planned, with no actions', async ({
		page,
		request
	}) => {
		const seeded = await seedReview(request, 'next-week-deload');
		await create(page, seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : undefined);
		await expect(card(page)).toHaveAttribute('data-state', 'no_ops');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Next week stays as planned'
		);
		await expect(generate(page)).toHaveCount(0);
		await auditBothThemes(page, 'No changes');
	});

	test('no program: build one, from Today', async ({ page, request }) => {
		await resetReviews(request);
		await create(page);
		await expect(card(page)).toHaveAttribute('data-state', 'no_program');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Build a program to get adjustments'
		);
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', '/today');
	});

	test('a new block next week: to the cycle review', async ({ page, request }) => {
		const seeded = await seedReview(request, 'block-end');
		await create(page, seeded.weekStart);
		await expect(card(page)).toHaveAttribute('data-state', 'boundary');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'Next week starts a new block'
		);
		await expect(page.getByTestId('review-next-link')).toHaveText(/Open your cycle review/);
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', LIST);
	});

	test('a review after next week ended: late', async ({ page, request }) => {
		const seeded = await seedReview(request, 'week-late');
		if (seeded.review.kind !== 'weekly') throw new Error('A weekly scenario');
		// The list offers only this week and last until an older review is stored: create two
		// weeks back through its Create action, as the form posts it without JavaScript.
		const { weekStartsOn } = seeded.review;
		const created = await request.post(`${LIST}?/create`, {
			headers: SAME_ORIGIN,
			form: { weekStartsOn },
			maxRedirects: 0
		});
		expect(created.status()).toBe(303);
		expect(created.headers().location).toBe(`${LIST}/w-${weekStartsOn}`);
		await gotoHydrated(page, `${LIST}/w-${weekStartsOn}`);
		await expect(card(page)).toHaveAttribute('data-state', 'late');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(
			'This review came after next week ended'
		);
		await expect(generate(page)).toHaveCount(0);
	});
});
