/**
 * The weekly loop (PRD §19 'weekly review' and 'generate next week'; M6 journey-weekly-review),
 * end to end through real screens only, on an iPhone and in a desktop window:
 * 1. From journey-week (today's evening easy run is the week's last session to log), Today →
 *    Start workout → the run logged on /workout/run and finished (M4's screens).
 * 2. Today now offers this week's review; Create opens it. Planned against completed and
 *    adherence equal the SQL oracle, and the coach's write-up (the MockProvider) says the same.
 * 3. One bench change at its half step, the other bench change left out, the rest kept;
 *    Generate next week.
 * 4. Train's next week: the notice with every applied why; the halved session at 86.25 kg, the
 *    left-out one still at 85 kg.
 * 5. History: version 2 with every why (the review's own decision included), current; version 1
 *    still viewable, read-only. History has no link to the review: Train's notice carries it,
 *    and it leads back to the review, which reads applied.
 * 6. M5's inbox: the applied revision labelled 'Weekly review', 'Applied as version 2'.
 * The reviews oracle (e2e/oracles/reviews.ts) counts the versions and reads the proposal chain.
 * Then review-aged (decided late in the week): the passed changes are struck through, Generate
 * applies the rest, and Train's notice lists only those. Every step is captured.
 *
 * Serial: the history is the one owner's, which every browser and worker shares. No request is
 * held or faked, so the service worker stays on.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { seedAnalytics } from './analytics-support';
import { DESKTOP, expectNoSideScroll, isDesktopPage } from './desktop';
import { adherence } from './oracles/general';
import { programVersions, proposalChain, weeklyReviews } from './oracles/reviews';
import { ANALYTICS_TZ, query, resetReviews, type ReviewTarget } from './review-support';
import { captureScreen, gotoHydrated, toastWith } from './support';
import { readOutbox } from './workout-support';

test.use({ timezoneId: ANALYTICS_TZ });
// Whole journeys through a workout, the review, Train, History and the inbox: past the default.
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const LIST = '/progress/reviews';
const INBOX = '/coach/proposals';
const HALF = 'Half step · 86.25 kg';

interface Seeded {
	programId: string;
	today: string;
	review: Extract<ReviewTarget, { kind: 'weekly' }>;
	lineages: { pending?: string; benchMonday: string; benchThursday: string };
}

/**
 * Reset, then seed `fixture` (journey-week.ts, or review-aged.ts's review-aged), with onboarding
 * complete: Today shows the plan only then, and no earlier spec is relied on to have done it.
 */
async function seed(request: APIRequestContext, fixture: 'journey-week' | 'review-aged') {
	await resetReviews(request);
	const seeded = (await seedAnalytics(request, fixture)) as unknown as Seeded;
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

const todaySession = (page: Page, title: string) =>
	page.getByTestId('today-session').filter({ has: page.getByText(title, { exact: true }) });
const prompt = (page: Page) => page.getByTestId('review-prompt');
const card = (page: Page) => page.getByTestId('review-next-week');
const items = (page: Page) => page.getByTestId('review-next-item');
const passedItems = (page: Page) => items(page).filter({ has: page.locator('input:disabled') });
const notice = (page: Page) => page.getByTestId('review-notice');
const writeUp = (page: Page) => page.getByTestId('review-write-up');
const pageOf = (s: Seeded) => `${LIST}/w-${s.review.weekStartsOn}`;

/** Every step captured, the desktop window's under its own name, nothing scrolling sideways. */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
	const where = isDesktopPage(page) ? 'desktop' : 'phone';
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, `journey-weekly-${where}-${name}`);
}

/** Version 2's decisions, read in SQL: the changes, and the review's own decision. */
async function applied(s: Seeded) {
	const versions = await programVersions(s.programId);
	expect(versions.map((v) => [v.number, v.current])).toEqual([
		[1, false],
		[2, true]
	]);
	const decisions = versions[1]!.decisions;
	return {
		decisions,
		changes: decisions.filter((d) => d.kind !== 'review_applied'),
		review: decisions.find((d) => d.kind === 'review_applied')!
	};
}

/** The live review's proposal chain, read in SQL. */
async function chainOf(s: Seeded) {
	const [live] = (await weeklyReviews(s.review.weekStartsOn)).filter((r) => r.live);
	expect(live?.proposalId, 'the review proposed changes').toBeTruthy();
	return proposalChain(live!.proposalId!);
}

async function weeklyJourney(page: Page, request: APIRequestContext, testInfo: TestInfo) {
	const s = await seed(request, 'journey-week');
	const week = s.review.weekStartsOn;
	let total = 0;
	/** Train's next week, where Generate landed. */
	let train = '';

	await test.step('1. Today → Start workout: today’s last session, the easy run, logged and finished', async () => {
		await gotoHydrated(page, '/today');
		await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
			timeout: 10_000
		});
		const start = todaySession(page, 'Easy run').getByTestId('start-workout');
		await expect(start).toHaveAttribute('href', `/workout?start=${s.lineages.pending}`);
		await shoot(page, testInfo, 'today-start');
		await start.click();
		await expect(page).toHaveURL(/\/workout\/run$/);

		const entry = page.getByTestId('run-entry');
		for (const [which, value] of [
			['distance', '5'],
			['time', '27:30']
		] as const) {
			const field = entry.getByTestId(`segment-${which}`).getByRole('spinbutton');
			await field.click();
			await field.fill(value);
			await field.press('Enter');
		}
		await entry.getByTestId('log-segment').click();
		await expect(page.getByTestId('run-segment').filter({ hasText: 'Done' })).toHaveCount(1);
		await expect
			.poll(() => readOutbox(page), { timeout: 15_000, message: 'the outbox drains' })
			.toEqual([]);
		await shoot(page, testInfo, 'run-logged');

		await page.getByTestId('workout-menu-button').click();
		await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
		const sheet = page.getByTestId('finish-sheet');
		await expect(sheet.getByTestId('workout-summary')).toBeVisible();
		await shoot(page, testInfo, 'run-summary');
		await sheet.getByTestId('finish-done').click();
		await page.waitForURL(/\/progress\/workouts\/[0-9a-f-]{36}$/);
		await expect(page.getByTestId('workout-detail')).toBeVisible();
		const [run] = await query<{ status: string }>(
			`select w.status from workouts w join planned_sessions s on s.id = w.planned_session_id
			where s.lineage_id = $1::uuid`,
			[s.lineages.pending]
		);
		expect(run?.status).toBe('completed');
	});

	await test.step('2. Today offers this week’s review; Create opens it, the figures equal the oracle and the coach’s notes say the same', async () => {
		await gotoHydrated(page, '/today');
		await expect(prompt(page)).toHaveAttribute('data-kind', 'weekly');
		await expect(prompt(page)).toHaveAttribute('data-state', 'due');
		await expect(prompt(page).locator('input[name="weekStartsOn"]')).toHaveValue(week);
		await shoot(page, testInfo, 'today-review-due');
		await prompt(page).getByRole('button', { name: 'Create review' }).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
		expect(await weeklyReviews(week)).toHaveLength(1);

		const [oracle] = await adherence(week, addDays(week, 6), s.today);
		expect(oracle, 'the week plans sessions').toBeDefined();
		expect(oracle!.completed, 'every session done').toBe(oracle!.planned);
		for (const [label, value] of [
			['planned', oracle!.planned],
			['completed', oracle!.completed],
			['skipped', oracle!.skipped],
			['missed', oracle!.missed]
		] as const) {
			await expect(page.getByTestId(`review-count-${label}`), label).toHaveAttribute(
				'data-value',
				String(value)
			);
		}
		const pct = Number(await page.getByTestId('review-adherence').getAttribute('data-value'));
		expect(pct, 'adherence: the oracle').toBeCloseTo(oracle!.pct!, 1);

		await expect(writeUp(page)).toHaveAttribute('data-state', 'written', { timeout: 30_000 });
		await expect(writeUp(page).getByTestId('answer-block').first()).toBeVisible();
		const text = (await writeUp(page).textContent()) ?? '';
		const said = /Completed that week: (\d+)\D+(\d+)/.exec(text);
		expect(said, 'the write-up says what was completed').not.toBeNull();
		expect([Number(said![1]), Number(said![2])]).toEqual([oracle!.completed, oracle!.planned]);
		await shoot(page, testInfo, 'review');
	});

	await test.step('3. one bench change at its half step, the other left out; Generate next week', async () => {
		await expect(card(page)).toHaveAttribute('data-state', 'open');
		total = await items(page).count();
		const bench = items(page).filter({ hasText: HALF });
		await expect(bench).toHaveCount(2);
		await bench.nth(0).getByLabel(HALF).check();
		await bench.nth(1).locator('input[name="item"]').uncheck();
		await card(page).scrollIntoViewIfNeeded();
		await shoot(page, testInfo, 'review-choices');
		await page.getByTestId('review-next-generate').click();
		await expect(page).toHaveURL(/\/train\?week=\d+$/);
		await expect(toastWith(page, 'Next week updated · version 2')).toBeVisible();
		train = new URL(page.url()).pathname + new URL(page.url()).search;

		const { chain, head } = await chainOf(s);
		expect(head).toMatchObject({ status: 'applied', appliedVersionNumber: 2 });
		expect(chain.at(-2)).toMatchObject({ status: 'superseded' });
		const [row] = await query<{ ops: { loadValue?: number }[] }>(
			`select payload->'ops' as ops from coach_proposals where id = $1::uuid`,
			[head.id]
		);
		expect(row!.ops).toHaveLength(total - 1);
		expect(row!.ops.filter((op) => op.loadValue === 86.25)).toHaveLength(1);
	});

	await test.step('4. Train’s next week: the notice with every why, and the changed prescriptions', async () => {
		const { changes, review } = await applied(s);
		expect(changes).toHaveLength(total - 1);
		await expect(notice(page)).toContainText('Updated from your weekly review');
		await expect(notice(page)).toContainText(review.why);
		await expect(notice(page).getByRole('listitem')).toHaveCount(changes.length);
		for (const change of changes) await expect(notice(page)).toContainText(change.why);
		await notice(page).scrollIntoViewIfNeeded();
		await shoot(page, testInfo, 'train-notice');

		const shown: string[] = [];
		for (const lineage of [s.lineages.benchMonday, s.lineages.benchThursday]) {
			await gotoHydrated(page, `/train/session/${lineage}`);
			const exercises = page.getByTestId('exercises');
			await expect(exercises).toContainText('Bench press');
			const words = (await exercises.textContent()) ?? '';
			expect(words, 'no bench at the full step').not.toContain('87.5 kg');
			shown.push(words.includes('86.25 kg') ? 'half' : words.includes('85 kg') ? 'kept' : '?');
		}
		expect(shown.sort()).toEqual(['half', 'kept']);
		await shoot(page, testInfo, 'train-session');
	});

	await test.step('5. History: version 2 with every why, current; version 1 still viewable', async () => {
		const { decisions } = await applied(s);
		await gotoHydrated(page, '/train/history');
		const newest = page.getByTestId('version').first();
		await expect(newest.getByTestId('decision')).toHaveCount(decisions.length);
		for (const d of decisions) await expect(newest).toContainText(d.why);
		await shoot(page, testInfo, 'history');

		await gotoHydrated(page, '/train/history/2');
		await expect(page.getByTestId('current-version')).toBeVisible();
		const changes = page.getByTestId('version-changes');
		for (const d of decisions) {
			await expect(changes.getByTestId('decision').filter({ hasText: d.why })).toBeVisible();
		}
		await gotoHydrated(page, '/train/history/1');
		await expect(page.getByTestId('older-version')).toBeVisible();
		await expect(page.getByTestId('version-detail')).toBeVisible();
		await shoot(page, testInfo, 'history-version-1');

		// The review link lives on Train's notice: back to the review, which reads applied.
		await gotoHydrated(page, train);
		await notice(page).getByTestId('review-notice-review').click();
		await expect(page).toHaveURL(new RegExp(`${pageOf(s)}$`));
		await expect(card(page)).toHaveAttribute('data-state', 'applied');
		await expect(page.getByTestId('review-next-link')).toHaveAttribute('href', '/train/history/2');
	});

	await test.step('6. M5’s inbox: the applied revision, labelled Weekly review', async () => {
		const { head } = await chainOf(s);
		await gotoHydrated(page, INBOX);
		const row = page.locator(`[data-testid="inbox-row"][href^="${INBOX}/${head.id}"]`);
		await expect(row.getByTestId('inbox-origin')).toHaveText('Weekly review');
		await shoot(page, testInfo, 'inbox');
		await gotoHydrated(page, `${INBOX}/${head.id}`);
		const proposal = page.getByTestId('inbox-detail').getByTestId('proposal-card');
		await expect(proposal.getByTestId('proposal-state')).toContainText('Applied as version 2');
		await expect(proposal.getByTestId('proposal-origin')).toHaveAttribute('href', pageOf(s));
		await shoot(page, testInfo, 'inbox-applied');
	});

	expect(await programVersions(s.programId), 'one version made').toHaveLength(2);
}

const JOURNEY =
	'journey: log today’s last session → review the week from Today → a half step and one left out → next week in Train, History and the inbox';

test.describe('on an iPhone', () => {
	test(JOURNEY, async ({ page, request }, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await weeklyJourney(page, request, testInfo);
	});
});

test.describe('in a desktop window', () => {
	test.use({ ...DESKTOP });

	test(JOURNEY, async ({ page, request }, testInfo) => {
		await weeklyJourney(page, request, testInfo);
	});
});

test.describe('review-aged: decided late in the week', () => {
	test('the passed changes are struck through, the rest are applied, and Train lists only those', async ({
		page,
		request
	}, testInfo) => {
		const s = await seed(request, 'review-aged');
		await gotoHydrated(page, pageOf(s));
		const total = await items(page).count();
		const passed = await passedItems(page).count();
		expect(passed).toBeGreaterThan(0);
		for (const item of await passedItems(page).all()) {
			await expect(item).toContainText(/has passed|has started/);
			const line = await item
				.locator('.what')
				.evaluate((el) => getComputedStyle(el).textDecorationLine);
			expect(line, 'a passed change is struck through').toContain('line-through');
		}
		await card(page).scrollIntoViewIfNeeded();
		await shoot(page, testInfo, 'aged-review');
		if (passed === total) {
			await expect(card(page)).toHaveAttribute('data-state', 'all_past');
			test.skip(true, 'From Friday: every change has passed, so there is no rest to apply');
		}
		await expect(card(page)).toHaveAttribute('data-state', 'partly_past');
		await page.getByTestId('review-next-generate').click();
		await expect(page).toHaveURL(/\/train/);

		const { changes } = await applied(s);
		expect(changes).toHaveLength(total - passed);
		await expect(notice(page).getByRole('listitem')).toHaveCount(total - passed);
		for (const change of changes) await expect(notice(page)).toContainText(change.why);
		await notice(page).scrollIntoViewIfNeeded();
		await shoot(page, testInfo, 'aged-train-notice');
		expect((await chainOf(s)).head).toMatchObject({ status: 'applied', appliedVersionNumber: 2 });
	});
});
