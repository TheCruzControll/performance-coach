/**
 * A review's proposal in M5's Proposals inbox and card (src/lib/ui/coach/ProposalCard.svelte,
 * src/routes/(app)/coach/proposals/[[id]]): where it came from, and every way M6 closes one.
 * - review-ahead (a weekly review and its proposal stored): the inbox labels the proposal
 *   'Weekly review' and its card says 'From your weekly review · Week of …', linking to the
 *   review; a coach proposal beside it names no review. After an edit makes the review stale and
 *   Refresh writes its next revision, the old proposal reads 'Replaced by a refreshed review ·
 *   open', and open leads to the review.
 * - review-aged (stored on Monday, decided later): Accept in the inbox reads 'Some sessions have
 *   passed · Finish in your weekly review', and the link opens the review.
 * - block-end with its cycle review created from the list: the review's own next cycle offers
 *   'Choose when it starts in your cycle review' and no Accept; a coach next cycle accepted in the
 *   inbox reads 'Folded into your cycle review · open'; another closed once the block is planned
 *   reads 'Your next block is already planned · open' (that close is next-cycle-apply's, pinned by
 *   tests/integration/reviews/next-cycle.test.ts; here it is stored as the service stores it).
 * - axe in both themes on each card; screenshots at 393 × 659 and 1440 × 900.
 *
 * The coach's proposals are the review's, copied without their rules provenance (evidence.source)
 * under a title of their own: what the coach's propose tool stores for the same change.
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { seedAnalytics } from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { cycleReviews, weeklyReviews } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type ReviewTarget
} from './review-support';
import { captureScreen, gotoHydrated, SAME_ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
const INBOX = '/coach/proposals';

const detail = (page: Page) => page.getByTestId('inbox-detail');
const card = (page: Page) => detail(page).getByTestId('proposal-card');
const state = (page: Page) => card(page).getByTestId('proposal-state');
const reviewLink = (page: Page) => card(page).getByTestId('proposal-review');
const row = (page: Page, id: string) =>
	page.locator(`[data-testid="inbox-row"][href^="${INBOX}/${id}"]`);

/** A copy of proposal `id` as the coach would store it: no rules provenance, its own title. */
async function asCoach(id: string, title: string): Promise<string> {
	const [copy] = await query<{ id: string }>(
		`insert into coach_proposals
		select (jsonb_populate_record(null::coach_proposals, to_jsonb(p) || jsonb_build_object(
			'id', gen_random_uuid(), 'title', $2::text, 'evidence', p.evidence - 'source',
			'revision_of', null, 'created_at', now(), 'updated_at', now()))).*
		from coach_proposals p where p.id = $1::uuid
		returning id::text`,
		[id, title]
	);
	return copy!.id;
}

/** The live weekly review's first proposal, for the week `weekStartsOn`. */
async function weeklyProposal(weekStartsOn: string): Promise<string> {
	const live = (await weeklyReviews(weekStartsOn)).find((r) => r.live);
	expect(live?.proposalId, 'the review proposed a change').toBeTruthy();
	return live!.proposalId!;
}

type Weekly = Extract<ReviewTarget, { kind: 'weekly' }>;

async function seedWeekly(request: APIRequestContext, fixture: 'review-ahead' | 'review-aged') {
	await resetReviews(request);
	const seeded = (await seedAnalytics(request, fixture)) as unknown as { review: Weekly };
	return seeded.review;
}

test.describe('a weekly review’s proposal', () => {
	let week: Weekly;
	let proposal: string;
	let coach: string;

	test.beforeAll(async ({ request }) => {
		week = await seedWeekly(request, 'review-ahead');
		proposal = await weeklyProposal(week.weekStartsOn);
		coach = await asCoach(proposal, 'Coach: bench a little heavier');
	});

	test('the inbox labels it Weekly review, its card names the week and links to the review; the coach’s names none', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, INBOX);
		await expect(row(page, proposal).getByTestId('inbox-origin')).toHaveText('Weekly review');
		await expect(row(page, coach)).toBeVisible();
		await expect(row(page, coach).getByTestId('inbox-origin')).toHaveCount(0);

		await gotoHydrated(page, `${INBOX}/${proposal}`);
		const origin = card(page).getByTestId('proposal-origin');
		await expect(origin).toHaveText(/^From your weekly review · Week of \d{1,2} [A-Z][a-z]{2}$/);
		await expect(origin).toHaveAttribute('href', `${LIST}/w-${week.weekStartsOn}`);
		await expect(detail(page).getByTestId('open-conversation')).toHaveCount(0);
		await auditBothThemes(page, 'a weekly review’s proposal');
		await captureScreen(page, testInfo, 'review-proposal-origin');

		await gotoHydrated(page, `${INBOX}/${coach}`);
		await expect(card(page)).toContainText('Coach: bench a little heavier');
		await expect(card(page).getByTestId('proposal-origin')).toHaveCount(0);

		await gotoHydrated(page, `${INBOX}/${proposal}`);
		await origin.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week.weekStartsOn}$`));
	});

	test('after a refresh, the old proposal reads ‘Replaced by a refreshed review · open’, and open leads to the review', async ({
		page
	}) => {
		// Edit one of the week's logged sets, as editing its RPE in History does: the review is stale.
		await query(
			`update set_records set rpe = 9, updated_at = now() where id = (
				select s.id from set_records s
				join workouts w on w.id = s.workout_id
				join athlete_profiles p on p.owner_id = s.owner_id
				where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
					and not s.is_warmup and not s.is_skipped
					and (s.performed_at at time zone p.time_zone)::date between $1::date and $2::date
				order by s.performed_at, s.id limit 1)`,
			[week.weekStartsOn, addDays(week.weekStartsOn, 6)]
		);
		await gotoHydrated(page, `${LIST}/w-${week.weekStartsOn}`);
		await page.getByTestId('review-refresh').click();
		await expect(page.getByTestId('review-stale')).toHaveCount(0);
		const [first, second] = await weeklyReviews(week.weekStartsOn);
		expect(second?.live).toBe(true);
		expect(first!.proposalId).toBe(proposal);

		await gotoHydrated(page, `${INBOX}/${proposal}`);
		await expect(state(page)).toContainText('Superseded');
		await expect(state(page).getByTestId('proposal-superseded-reason')).toContainText(
			'Replaced by a refreshed review · open'
		);
		await expect(reviewLink(page)).toHaveAttribute('href', `${LIST}/w-${week.weekStartsOn}`);
		await auditBothThemes(page, 'a refreshed review’s old proposal');
		await reviewLink(page).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week.weekStartsOn}$`));
	});
});

test('review-aged: Accept in the inbox reads ‘Some sessions have passed · Finish in your weekly review’, and the link opens the review', async ({
	page,
	request
}, testInfo) => {
	const week = await seedWeekly(request, 'review-aged');
	const proposal = await weeklyProposal(week.weekStartsOn);

	await gotoHydrated(page, `${INBOX}/${proposal}`);
	await card(page).getByTestId('proposal-accept').click();
	await expect(state(page)).toContainText('Superseded');
	await expect(state(page).getByTestId('proposal-superseded-reason')).toContainText(
		'Some sessions have passed · Finish in your weekly review'
	);
	await expect(reviewLink(page)).toHaveAttribute('href', `${LIST}/w-${week.weekStartsOn}`);
	const [stored] = await query<{ status: string; reason: string | null }>(
		'select status, superseded_reason as reason from coach_proposals where id = $1::uuid',
		[proposal]
	);
	expect(stored).toEqual({ status: 'superseded', reason: 'sessions_passed' });
	await auditBothThemes(page, 'sessions passed');
	await captureScreen(page, testInfo, 'review-proposal-sessions-passed');

	await reviewLink(page).click();
	await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week.weekStartsOn}$`));
});

test.describe('a cycle review’s next cycle', () => {
	let reviewId: string;
	let own: string;
	let folded: string;
	let planned: string;

	test.beforeAll(async ({ request }) => {
		const seeded = await seedReview(request, 'block-end');
		if (seeded.review.kind !== 'cycle') throw new Error('a cycle scenario');
		const { blockLineageId } = seeded.review;
		// Created as the list's Create posts it from its script: a redirect to the review.
		const created = await request.post(`${LIST}?/createCycle`, {
			headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
			form: { programId: seeded.programId!, blockLineage: blockLineageId }
		});
		const [review] = await cycleReviews(blockLineageId);
		reviewId = review!.id;
		expect(await created.json()).toMatchObject({
			type: 'redirect',
			location: `${LIST}/c-${reviewId}`
		});
		own = review!.proposalId!;
		folded = await asCoach(own, 'Coach: heavier triples next block');
		planned = await asCoach(own, 'Coach: one more idea for next block');
	});

	test('the review’s own offers ‘Choose when it starts…’ and no Accept', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, INBOX);
		await expect(row(page, own).getByTestId('inbox-origin')).toHaveText('Cycle review');
		await expect(row(page, folded).getByTestId('inbox-origin')).toHaveCount(0);

		await gotoHydrated(page, `${INBOX}/${own}`);
		await expect(card(page).getByTestId('proposal-origin')).toHaveText('From your cycle review');
		const choose = card(page).getByTestId('proposal-choose-start');
		await expect(choose).toHaveText('Choose when it starts in your cycle review');
		await expect(choose).toHaveAttribute('href', `${LIST}/c-${reviewId}`);
		await expect(card(page).getByTestId('proposal-accept')).toHaveCount(0);
		await expect(card(page).getByRole('button', { name: 'Accept' })).toHaveCount(0);
		await auditBothThemes(page, 'the review’s own next cycle');
		await captureScreen(page, testInfo, 'review-proposal-choose-start');

		await choose.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-${reviewId}$`));
	});

	test('a coach next cycle accepted in the inbox reads ‘Folded into your cycle review · open’', async ({
		page
	}) => {
		await gotoHydrated(page, `${INBOX}/${folded}`);
		await expect(card(page).getByTestId('proposal-origin')).toHaveCount(0);
		await card(page).getByTestId('proposal-accept').click();
		await expect(state(page).getByTestId('proposal-superseded-reason')).toContainText(
			'Folded into your cycle review · open'
		);
		await expect(reviewLink(page)).toHaveAttribute('href', `${LIST}/c-${reviewId}`);
		await auditBothThemes(page, 'folded into the review');
	});

	test('once the block is planned, another reads ‘Your next block is already planned · open’', async ({
		page
	}) => {
		// As applyNextCycle closes every other open next cycle for the planned block.
		await query(
			`update coach_proposals set status = 'superseded', superseded_reason = 'cycle_planned',
				closed_at = now(), updated_at = now() where id = $1::uuid`,
			[planned]
		);
		await gotoHydrated(page, `${INBOX}/${planned}`);
		await expect(state(page).getByTestId('proposal-superseded-reason')).toContainText(
			'Your next block is already planned · open'
		);
		await expect(reviewLink(page)).toHaveAttribute('href', `${LIST}/c-${reviewId}`);
		await reviewLink(page).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-${reviewId}$`));
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('the inbox list beside the review’s card, labelled, with nothing scrolling sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, `${INBOX}/${planned}`);
			await expect(page.getByTestId('inbox-origin').first()).toBeVisible();
			await expect(reviewLink(page)).toBeVisible();
			await reviewLink(page).hover();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'review-proposal-origin-desktop');
		});
	});
});
