/**
 * 'Propose again' on a stale re-plan (m7/50; services/periodisation/propose.ts proposeAgain) on
 * real Postgres:
 * - a stale profile_changed re-plan is proposed again: a fresh proposal, the stale one unchanged
 * - a deload whose week has passed (superseded as sessions_passed) is asked for again for the week
 *   holding today, through the engine's guards (movedToThisWeek's unit test pins the week)
 * - an engine refusal stores nothing and returns the engine's sentence
 * - the source and provenance of the stale one are kept (a goal change's engine provenance)
 * - a re-plan superseded as program_changed is proposed again as a fresh proposal (the same reasons
 *   as the card offers it for)
 * - a second Propose again on the same stale id returns the duplicate: the same open proposal
 * - a weekly review's re-plan keeps its review provenance when it is proposed again
 * - a stale re-plan whose source cannot be read again is not_reproposable, writing nothing
 * - scope: another owner's proposal, or a missing id, is CoachNotFoundError; a proposal that is
 *   not a stale re-plan is not_stale and writes nothing
 * Today is Wednesday 18 Nov 2026 in Los Angeles (block-end), or the week-complete fixture seeded
 * on Monday 16 Nov: its planned weeks are the one before and this one, and next week is an outline.
 */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { ReplanDirective } from '../../../src/lib/domain/training/replan';
import type { Executor } from '../../../src/lib/server/db';
import { acceptProposal } from '../../../src/lib/server/services/coach/proposals';
import { CoachNotFoundError } from '../../../src/lib/server/services/coach/shared';
import {
	proposeAgain,
	proposeReplan,
	type ProposeDeps
} from '../../../src/lib/server/services/periodisation/propose';
import { getProgramVersion, skipSession } from '../../../src/lib/server/services/programs/index';
import { createWeeklyReview } from '../../../src/lib/server/services/reviews';
import { createGoal } from '../../../src/lib/server/services/profile';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const WEDNESDAY = '2026-11-18';
const MONDAY = '2026-11-16';
const NEXT_TUESDAY = '2026-11-24';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

const THURSDAY = '2026-11-19';
const PRIORITIES: ReplanDirective = { kind: 'priorities', cause: 'reorder' };
const deloadOf = (week: IsoDate): ReplanDirective => ({
	kind: 'deload',
	week,
	trigger: 'owner',
	reasons: ['Legs heavy since the weekend']
});

const clock = (day: IsoDate) => () => atLocal(day, '12:00', TZ);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A fixture seeded on `today`, with deps on that day's clock. */
async function seeded(db: Executor, name: 'block-end' | 'week-complete', today: IsoDate) {
	const owner = await makeOwner(db);
	const fixture = (await seedAnalyticsFixture(
		owner,
		name,
		{ timeZone: TZ, now: clock(today)() },
		{ db }
	)) as unknown as ReviewFixtureResult & { programId: string | null };
	const deps: ProposeDeps = { db, now: clock(today), statementTimeoutMs: SLOW_OK };
	return { owner, programId: fixture.programId!, fixture, deps };
}

/** Propose as the owner, failing the test unless a proposal comes back. */
async function propose(
	owner: string,
	request: { today: IsoDate; directive: ReplanDirective },
	deps: ProposeDeps
) {
	const made = await proposeReplan(owner, { source: 'owner', ...request }, deps);
	if (made.status !== 'proposed') throw new Error(`Not proposed: ${JSON.stringify(made)}`);
	return made.proposal;
}

/** How many proposals the owner has stored, of any status. */
async function proposalCount(db: Executor, owner: string) {
	const { rows } = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from coach_proposals where owner_id = ${owner}`
	);
	return rows[0]!.n;
}

/** Add a goal: a profile change that makes a stored re-plan stale at accept. */
async function changeProfile(db: Executor, owner: string) {
	await createGoal(
		owner,
		{
			...{ kind: 'general', title: 'Run more', disciplines: ['running'] },
			...{ focus: 'Running', measure: 'Run three times a week' }
		},
		{ db }
	);
}

describe('proposeAgain', () => {
	it('proposes a stale profile_changed re-plan again as a fresh proposal', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const stale = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			await changeProfile(db, owner);
			expect(await acceptProposal(owner, stale.id, deps)).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'profile_changed' }
			});

			const again = await proposeAgain(owner, stale.id, deps);
			expect(again).toMatchObject({
				status: 'proposed',
				proposal: { kind: 'replan', status: 'proposed', origin: null }
			});
			if (again.status !== 'proposed') throw new Error('unreachable');
			expect(again.proposal.id).not.toBe(stale.id);
			// The stale one is not rewritten: it is still superseded as it was.
			expect((await acceptProposal(owner, stale.id, deps)).proposal.supersededReason).toBe(
				'profile_changed'
			);
		});
	});

	it('keeps the source and provenance of the stale re-plan: a goal change’s engine', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const made = await proposeReplan(
				owner,
				{ today: WEDNESDAY, directive: PRIORITIES, source: 'goal_priority' },
				deps
			);
			if (made.status !== 'proposed') throw new Error('unreachable');
			await changeProfile(db, owner);
			await acceptProposal(owner, made.proposal.id, deps);

			expect(await proposeAgain(owner, made.proposal.id, deps)).toMatchObject({
				status: 'proposed',
				proposal: { origin: { kind: 'goal_priority', href: '/profile/goals' } }
			});
		});
	});

	it('asks a passed deload again for the week holding today, so the engine answers about that week', async () => {
		await withRollback(async (db) => {
			// Accepted on Tuesday 24 Nov, once its week has passed: superseded as sessions_passed.
			const { owner, deps } = await seeded(db, 'week-complete', MONDAY);
			const stale = await propose(owner, { today: MONDAY, directive: deloadOf(MONDAY) }, deps);
			const later = { ...deps, now: clock(NEXT_TUESDAY) };
			expect(await acceptProposal(owner, stale.id, later)).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'sessions_passed' }
			});
			// Asked again for the week holding 24 Nov (23 Nov, an outline week), the engine refuses
			// it as block_complete. Asked for the passed week it would answer nothing_ahead, so the
			// sentence shows the week moved. A stored moved deload is covered by movedToThisWeek.
			expect(await proposeAgain(owner, stale.id, later)).toMatchObject({
				status: 'refused',
				refusal: 'block_complete'
			});
		});
	});

	it('an engine refusal stores nothing and returns the engine’s sentence', async () => {
		await withRollback(async (db) => {
			// Accepted on Tuesday 24 Nov: every planned week is behind, so the engine refuses.
			const { owner, deps } = await seeded(db, 'week-complete', MONDAY);
			const stale = await propose(owner, { today: MONDAY, directive: deloadOf(MONDAY) }, deps);
			const later = { ...deps, now: clock(NEXT_TUESDAY) };
			await acceptProposal(owner, stale.id, later);
			const before = await proposalCount(db, owner);

			expect(await proposeAgain(owner, stale.id, later)).toEqual({
				status: 'refused',
				refusal: 'block_complete',
				why: 'Every planned week is behind you, so the next block comes from your cycle review instead.'
			});
			expect(await proposalCount(db, owner)).toBe(before);
		});
	});

	it('answers a proposal that is not a stale re-plan with not_stale, writing nothing', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const fresh = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const before = await proposalCount(db, owner);
			expect(await proposeAgain(owner, fresh.id, deps)).toEqual({ status: 'not_stale' });
			expect(await proposalCount(db, owner)).toBe(before);
		});
	});

	it('is scoped to its owner: another owner’s proposal, or a missing id, is not found', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const stale = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			await changeProfile(db, owner);
			await acceptProposal(owner, stale.id, deps);
			const other = await makeSecondOwner(db);
			const before = await proposalCount(db, other);

			await expect(proposeAgain(other, stale.id, deps)).rejects.toBeInstanceOf(CoachNotFoundError);
			await expect(proposeAgain(owner, crypto.randomUUID(), deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			await expect(proposeAgain(owner, 'not-an-id', deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			expect(await proposalCount(db, other)).toBe(before);
		});
	});

	it('proposes a re-plan superseded as program_changed again as a fresh proposal', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'week-complete', MONDAY);
			const stale = await propose(owner, { today: MONDAY, directive: PRIORITIES }, deps);
			// A newer version: Thursday is skipped, so the stored replan's base is no longer current.
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const thursday = v1.blocks
				.flatMap((b) => b.weeks)
				.flatMap((w) => w.sessions)
				.find((s) => s.date === THURSDAY)!;
			await skipSession(
				owner,
				{ sessionLineage: thursday.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);
			expect(await acceptProposal(owner, stale.id, deps)).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'program_changed' }
			});

			expect(await proposeAgain(owner, stale.id, deps)).toMatchObject({
				status: 'proposed',
				proposal: { kind: 'replan', status: 'proposed' }
			});
		});
	});

	it('a second Propose again on the same stale id returns the duplicate: the same open proposal', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const stale = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			await changeProfile(db, owner);
			await acceptProposal(owner, stale.id, deps);

			const first = await proposeAgain(owner, stale.id, deps);
			if (first.status !== 'proposed') throw new Error(`Not proposed: ${JSON.stringify(first)}`);
			const before = await proposalCount(db, owner);
			expect(await proposeAgain(owner, stale.id, deps)).toMatchObject({
				status: 'proposed',
				duplicate: true,
				proposal: { id: first.proposal.id, status: 'proposed' }
			});
			expect(await proposalCount(db, owner)).toBe(before);
		});
	});

	it('keeps a weekly review’s provenance when its re-plan is proposed again', async () => {
		await withRollback(async (db) => {
			const { owner, fixture, deps } = await seeded(db, 'week-complete', MONDAY);
			if (fixture.review.kind !== 'weekly') throw new Error('a weekly fixture');
			const { weekStartsOn: reviewed } = fixture.review;
			const { review } = await createWeeklyReview(
				owner,
				{ weekStartsOn: reviewed, today: MONDAY },
				deps
			);
			const provenance = { reviewId: review.id, revision: review.revision, weekStartsOn: reviewed };
			const made = await proposeReplan(
				owner,
				{ today: MONDAY, directive: PRIORITIES, source: 'weekly_review', review: provenance },
				deps
			);
			if (made.status !== 'proposed') throw new Error(`Not proposed: ${JSON.stringify(made)}`);
			await changeProfile(db, owner);
			const stale = await acceptProposal(owner, made.proposal.id, deps);
			expect(stale.proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'profile_changed'
			});

			const again = await proposeAgain(owner, made.proposal.id, deps);
			expect(again).toMatchObject({
				status: 'proposed',
				proposal: {
					origin: {
						kind: 'weekly_review',
						reviewId: review.id,
						href: `/progress/reviews/w-${reviewed}`
					}
				}
			});
			if (again.status !== 'proposed') throw new Error('unreachable');
			expect(again.proposal.origin).toEqual(stale.proposal.origin);
		});
	});

	it('a stale re-plan whose source cannot be read again is not_reproposable, and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const stale = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			await changeProfile(db, owner);
			await acceptProposal(owner, stale.id, deps);
			// A source this app does not write: the stored evidence is edited inside this transaction
			// only, with the content and frozen guards lifted for it.
			await db.execute(
				sql`alter table coach_proposals disable trigger coach_proposals_content_guard`
			);
			await db.execute(
				sql`alter table coach_proposals disable trigger coach_proposals_frozen_guard`
			);
			await db.execute(
				sql`update coach_proposals set evidence = ${JSON.stringify({ source: { kind: 'nope' } })}::jsonb where id = ${stale.id}`
			);
			const before = await proposalCount(db, owner);

			expect(await proposeAgain(owner, stale.id, deps)).toEqual({ status: 'not_reproposable' });
			expect(await proposalCount(db, owner)).toBe(before);
		});
	});
});
