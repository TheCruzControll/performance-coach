/**
 * Where M5's proposal view says a review's proposal came from, and the review every M6 path leads
 * back to (services/coach/proposals.ts getProposalView; the M6 plan's proposal-origin-label), on
 * real Postgres from the review-ahead and block-end fixtures:
 * - a weekly review's proposal names its review and its week, in the view and in the inbox's list
 * - the cycle review's own next_cycle is chosen in the review (chooseStart), never accepted here
 * - a coach next_cycle names the live cycle review it waits for, was folded into, or was closed by
 *   once the block was planned; one with no review for its block names none. So do its card in
 *   the conversation (listThreadProposals) and the accept's answer
 * Today is Wednesday 18 Nov 2026 in Los Angeles.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CHOOSE_START as CARD_CHOOSE_START } from '../../../src/lib/domain/coach/cards';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { agentRuns, coachMessages, coachThreads } from '../../../src/lib/server/db/schema';
import {
	acceptProposal,
	createProposal,
	getProposalView,
	listProposals,
	listThreadProposals
} from '../../../src/lib/server/services/coach/proposals';
// After proposals.ts, which the appliers import back.
import {
	CHOOSE_START,
	cycleReviewHref
} from '../../../src/lib/server/services/coach/apply/next-cycle';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import {
	createCycleReview,
	decideNextCycle,
	getCycleReviewView,
	getWeeklyReviewView
} from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { loadInbox } from '../../../src/routes/(app)/coach/proposals/[[id]]/inbox.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-18';
const now = () => atLocal(TODAY, '12:00', TZ);

interface Seeded {
	programId: string;
	review: { weekStartsOn: IsoDate };
}

async function seed(db: Executor, fixture: 'review-ahead' | 'block-end') {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: now() },
		{ db }
	)) as unknown as Seeded;
	return { owner, seeded, deps: { db, now } };
}

/** block-end with nothing reviewed yet: its block, and how to create its review. */
async function blockEnd(db: Executor) {
	const s = await seed(db, 'block-end');
	const programId = s.seeded.programId;
	const v1 = await getProgramVersion(s.owner, programId, 1, { db });
	const target = { programId, blockLineage: v1.blocks[0]!.lineage };
	const review = async () =>
		(await createCycleReview(s.owner, { ...target, today: TODAY }, s.deps)).review;
	/** A coach next_cycle for the block, as the coach's propose tool drafts one (in `origin`'s run). */
	const coachNextCycle = async (
		focus = 'Coach: heavier triples',
		origin?: { threadId: string; runId: string; toolUseId: string }
	) => {
		const payload = {
			...{ fromBlockLineage: target.blockLineage, focus, phase: 'accumulation', weeks: 4 },
			...{ emphasis: [], rotation: [], running: null, ending: 'none', constraints: [] },
			targets: { rpeCap: 8, volumeFactor: 0.8, loadStep: 0.025, runVolumeFactor: 1 }
		};
		const draft = { kind: 'next_cycle', title: 'Next block', rationale: 'Go heavier', payload };
		return (await createProposal(s.owner, { proposal: draft, origin }, s.deps)).proposal;
	};
	return { ...s, target, review, coachNextCycle };
}

describe("a review's proposal", () => {
	it('names its weekly review and week, in the view and in the list', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'review-ahead');
			const { weekStartsOn } = seeded.review;
			const review = await getWeeklyReviewView(owner, weekStartsOn, deps);
			const id = review.proposal!.id;

			const view = await getProposalView(owner, id, deps);
			expect(view.origin).toMatchObject({
				kind: 'weekly_review',
				href: `/progress/reviews/w-${weekStartsOn}`,
				weekStartsOn
			});
			expect(view.chooseStart).toBeNull();
			expect(view.cycleReview).toBeNull();
			const listed = (await listProposals(owner, {}, deps)).proposals.find((p) => p.id === id);
			expect(listed?.origin).toEqual(view.origin);
		});
	});

	it("is labelled with its review in the inbox's row and card, the coach's with none", async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const review = await s.review();
			const coach = await s.coachNextCycle();
			const request = {
				id: review.proposalId!,
				search: new URLSearchParams(),
				origin: {
					...{ requestId: crypto.randomUUID(), method: 'GET', path: '/coach/proposals' },
					...{ routeId: '/(app)/coach/proposals/[[id]]', appVersion: '0.1.0+test' }
				}
			};
			const data = await loadInbox(s.owner, request, { db });
			if (data.state !== 'ready') throw new Error('expected the inbox');
			const origins = Object.fromEntries(data.rows.map((r) => [r.id, r.origin]));
			expect(origins).toEqual({ [review.proposalId!]: 'Cycle review', [coach.id]: null });
			const href = cycleReviewHref(review.id);
			// Waiting for the owner in the list, but chosen in the review, not accepted here.
			expect(data.rows.find((r) => r.id === review.proposalId)?.state).toBe('Waiting for you');
			expect(data.detail).toMatchObject({
				threadId: null,
				card: {
					origin: { words: 'From your cycle review', href },
					reviewHref: href,
					chooseStart: true
				}
			});
		});
	});

	it("leads the cycle review's own next_cycle to the review to choose its start", async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const review = await s.review();
			const href = cycleReviewHref(review.id);

			const view = await getProposalView(s.owner, review.proposalId!, s.deps);
			expect(view).toMatchObject({
				kind: 'next_cycle',
				status: 'proposed',
				origin: { kind: 'cycle_review', href, weekStartsOn: null },
				chooseStart: { href },
				cycleReview: null
			});
			// The card's words are the 409's.
			expect(CARD_CHOOSE_START).toBe(CHOOSE_START);
		});
	});
});

describe("a coach's next_cycle", () => {
	it('names no review while its block has none, and the review that folded it in at creation', async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const coach = await s.coachNextCycle();
			expect((await acceptProposal(s.owner, coach.id, s.deps)).proposal.status).toBe('accepted');
			const waiting = await getProposalView(s.owner, coach.id, s.deps);
			expect(waiting).toMatchObject({ status: 'accepted', origin: null, cycleReview: null });

			const review = await s.review();
			expect(await getProposalView(s.owner, coach.id, s.deps)).toMatchObject({
				status: 'superseded',
				supersededReason: 'folded_into_review',
				origin: null,
				chooseStart: null,
				cycleReview: { href: cycleReviewHref(review.id) }
			});
		});
	});

	it('names the live review it waits for, and the one it was folded into when accepted later', async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const review = await s.review();
			const href = cycleReviewHref(review.id);

			// Accepted and still waiting while the review is live (as a race between the two leaves it).
			const waiting = await s.coachNextCycle('Coach: waiting');
			await db.execute(
				sql`update coach_proposals set status = 'accepted' where id = ${waiting.id}`
			);
			expect((await getProposalView(s.owner, waiting.id, s.deps)).cycleReview).toEqual({ href });

			const folded = await s.coachNextCycle();
			await acceptProposal(s.owner, folded.id, s.deps);
			const view = await getProposalView(s.owner, folded.id, s.deps);
			expect(view).toMatchObject({ supersededReason: 'folded_into_review', origin: null });
			expect(view.cycleReview).toEqual({ href });
			// Only the one proposal's view reads it: the list stays one query a page.
			const listed = (await listProposals(s.owner, {}, s.deps)).proposals;
			expect(listed.find((p) => p.id === folded.id)?.cycleReview).toBeNull();
		});
	});

	it('names the review in its conversation card and in the accept that folded it in', async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const ownerId = s.owner;
			const [thread] = await db
				.insert(coachThreads)
				.values({
					ownerId,
					title: 'Next block',
					titleSource: 'first_message',
					segmentPromptVersion: 'p'
				})
				.returning();
			const threadId = thread!.id;
			const [said] = await db
				.insert(coachMessages)
				.values({
					...{ ownerId, threadId, seq: 1, segment: 1, role: 'user', kind: 'owner_message' },
					...{ apiVisible: true, content: 'Plan my next block', display: { text: 'Plan' } },
					clientMessageId: crypto.randomUUID()
				})
				.returning();
			const [run] = await db
				.insert(agentRuns)
				.values({
					...{ ownerId, threadId, triggerMessageId: said!.id, kind: 'turn' },
					...{ provider: 'mock', model: 'mock', effort: 'medium', promptVersion: 'p' }
				})
				.returning();
			const runId = run!.id;
			const review = await s.review();
			const href = cycleReviewHref(review.id);
			const coach = await s.coachNextCycle('Coach: in a conversation', {
				...{ threadId, runId, toolUseId: 'toolu_01' }
			});

			const answer = await acceptProposal(s.owner, coach.id, s.deps);
			expect(answer.proposal).toMatchObject({ supersededReason: 'folded_into_review' });
			expect(answer.proposal.cycleReview).toEqual({ href });
			const [card] = await listThreadProposals(s.owner, threadId, [runId], s.deps);
			expect(card?.proposal).toMatchObject({ id: coach.id, cycleReview: { href } });
		});
	});

	it('names the review that planned its block once it is closed as cycle_planned', async () => {
		await withRollback(async (db) => {
			const s = await blockEnd(db);
			const review = await s.review();
			const open = await s.coachNextCycle();
			const view = await getCycleReviewView(s.owner, { ...s.target, today: TODAY }, s.deps);
			const shown = view.previews.find((p) => p.start === 'next_monday')!;
			await decideNextCycle(
				s.owner,
				review.id,
				{ start: 'next_monday', fingerprint: shown.fingerprint },
				s.deps
			);
			expect(await getProposalView(s.owner, open.id, s.deps)).toMatchObject({
				status: 'superseded',
				supersededReason: 'cycle_planned',
				cycleReview: { href: cycleReviewHref(review.id) }
			});
			// The review's own, now applied, is chosen no more.
			expect((await getProposalView(s.owner, review.proposalId!, s.deps)).chooseStart).toBeNull();
		});
	});
});
