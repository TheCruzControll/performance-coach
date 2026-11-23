/**
 * 'Propose again' on a deload from the weekly review's page (m7/51; forms/reviews.ts
 * proposeDeloadAgainAction) on real Postgres, through the real services:
 * - a deload the profile changed after it was proposed is out of date: Propose again makes a fresh
 *   deload proposal of the review's week, owner-scoped, with the review's provenance; the stale one
 *   is not rewritten
 * - a second Propose again on the same review, which still points at the stale proposal, answers
 *   the open proposal it made the first time, and writes no second one
 * - a deload still open is not stale: not_stale, and nothing is written
 * - an engine refusal stores nothing and returns the engine’s sentence (the deload's week has
 *   passed, so the week holding today has no change the engine will make)
 * - the owner's check comes first: a signed-out or recovery session is 401, before anything runs;
 *   another owner's review is the 404 page, as is a key that is not a weekly review
 * The review is the week-complete fixture's (the week of 9 Nov), reviewed on Monday 16 Nov with a
 * tired Sunday, so its deload is the week of 16 Nov. Times are in Los Angeles.
 */
import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import { proposeDeloadAgainAction, type ReviewOrigin } from '../../../src/lib/server/forms/reviews';
import {
	createWeeklyReview,
	decideNextWeek,
	getWeeklyReviewView,
	type StoredWeeklyReview
} from '../../../src/lib/server/services/reviews';
import { getOpenReplan } from '../../../src/lib/server/services/periodisation/propose';
import { createGoal } from '../../../src/lib/server/services/profile';
import { recordRecoveryNote } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const MONDAY = '2026-11-16';
const NEXT_TUESDAY = '2026-11-24';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;
const ORIGIN: ReviewOrigin = {
	requestId: 'req-test',
	method: 'POST',
	path: '/progress/reviews/w-2026-11-09',
	routeId: '/(app)/progress/reviews/[[key]]',
	appVersion: 'test'
};

const clock = (day: IsoDate) => () => atLocal(day, '12:00', TZ);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A signed-in request's locals, as the action's owner check reads them. */
function session(ownerId: string, kind: AuthSession['kind'] = 'owner'): App.Locals {
	return {
		requestId: crypto.randomUUID(),
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Owner',
			kind,
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	} as unknown as App.Locals;
}

/** The week-complete fixture's review of the week of 9 Nov, which proposes a deload of 16 Nov. */
async function reviewed(db: Executor) {
	const owner = await makeOwner(db);
	const fixture = (await seedAnalyticsFixture(
		owner,
		'week-complete',
		{ timeZone: TZ, now: clock(MONDAY)() },
		{ db }
	)) as unknown as ReviewFixtureResult;
	if (fixture.review.kind !== 'weekly') throw new Error('a weekly fixture');
	const weekStartsOn = fixture.review.weekStartsOn;
	const note = { sleepHours: 5, soreness: 4, energy: 2, stress: null, note: null };
	await recordRecoveryNote(
		owner,
		{ clientMutationId: crypto.randomUUID(), notedOn: addDays(weekStartsOn, 6), ...note },
		{ db }
	);
	const review: StoredWeeklyReview = (
		await createWeeklyReview(
			owner,
			{ weekStartsOn, today: MONDAY },
			{ db, now: clock(MONDAY), context: { statementTimeoutMs: SLOW_OK } }
		)
	).review;
	if (review.proposalId === null) throw new Error('the review proposed no deload');
	const propose = { db, now: clock(MONDAY), statementTimeoutMs: SLOW_OK };
	return { owner, weekStartsOn, review, propose };
}

/** Add a goal: a profile change that makes a stored deload stale at accept. */
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

async function proposalRow(db: Executor, id: string) {
	const { rows } = await db.execute<{
		kind: string;
		status: string;
		superseded_reason: string | null;
		evidence: Record<string, unknown> | null;
	}>(sql`select kind, status, superseded_reason, evidence from coach_proposals where id = ${id}`);
	return rows[0]!;
}

async function proposalCount(db: Executor, owner: string) {
	const { rows } = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from coach_proposals where owner_id = ${owner}`
	);
	return rows[0]!.n;
}

/** What a call threw (fails the test if it returned instead). */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		(value) => {
			throw new Error(`expected it to throw, it returned ${JSON.stringify(value)}`);
		},
		(err: unknown) => err
	);
}

describe('Propose again on a deload from the review page', () => {
	it('a deload the profile changed after it was proposed: a fresh deload of the same week, owner-scoped', async () => {
		await withRollback(async (db) => {
			const { owner, weekStartsOn, review, propose } = await reviewed(db);
			const stale = review.proposalId!;
			await changeProfile(db, owner);
			expect(
				await decideNextWeek(owner, review.id, { items: [], accept: true }, propose)
			).toMatchObject({ outcome: 'superseded', reason: 'profile_changed' });
			expect((await getWeeklyReviewView(owner, weekStartsOn, { db })).decision).toMatchObject({
				state: 'superseded',
				reason: 'profile_changed'
			});

			const made = await proposeDeloadAgainAction(
				{ locals: session(owner), weekStartsOn, origin: ORIGIN },
				propose
			);
			expect(made).toMatchObject({ status: 'proposed' });
			if (made.status !== 'proposed') throw new Error('unreachable');
			expect(made.id).not.toBe(stale);
			expect(await proposalRow(db, made.id)).toMatchObject({ kind: 'replan', status: 'proposed' });
			// The id the card opens is the open replan the inbox lists: the fresh proposal, not the stale one.
			expect((await getOpenReplan(owner, { db }))?.id).toBe(made.id);
			// The review's provenance is kept: the fresh deload names the review it came from.
			expect((await proposalRow(db, made.id)).evidence?.source).toMatchObject({
				kind: 'weekly_review',
				reviewId: review.id
			});
			// The stale one stays as it was.
			expect(await proposalRow(db, stale)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'profile_changed'
			});

			// Another owner's review of the same week is the 404 page, and writes nothing.
			const other = await makeSecondOwner(db);
			const before = await proposalCount(db, other);
			const err = await thrown(
				proposeDeloadAgainAction({ locals: session(other), weekStartsOn, origin: ORIGIN }, propose)
			);
			expect(isHttpError(err, 404)).toBe(true);
			expect(await proposalCount(db, other)).toBe(before);
		});
	});

	it('a second Propose again on the same review answers the same open proposal, and writes no second one', async () => {
		await withRollback(async (db) => {
			const { owner, weekStartsOn, review, propose } = await reviewed(db);
			await changeProfile(db, owner);
			expect(
				await decideNextWeek(owner, review.id, { items: [], accept: true }, propose)
			).toMatchObject({ outcome: 'superseded', reason: 'profile_changed' });
			const ask = { locals: session(owner), weekStartsOn, origin: ORIGIN };
			const first = await proposeDeloadAgainAction(ask, propose);
			expect(first).toMatchObject({ status: 'proposed' });
			if (first.status !== 'proposed') throw new Error('unreachable');
			const before = await proposalCount(db, owner);

			// The review still names the stale proposal, so the second post asks again and gets the open one back.
			expect(await proposeDeloadAgainAction(ask, propose)).toEqual({
				status: 'proposed',
				id: first.id
			});
			expect(await proposalCount(db, owner)).toBe(before);
			expect(await proposalRow(db, first.id)).toMatchObject({ kind: 'replan', status: 'proposed' });
		});
	});

	it('a deload still open is not stale: not_stale, and nothing is written', async () => {
		await withRollback(async (db) => {
			const { owner, weekStartsOn, review, propose } = await reviewed(db);
			const open = review.proposalId!;
			const before = await proposalCount(db, owner);

			expect(
				await proposeDeloadAgainAction(
					{ locals: session(owner), weekStartsOn, origin: ORIGIN },
					propose
				)
			).toEqual({ status: 'not_stale' });
			expect(await proposalCount(db, owner)).toBe(before);
			expect(await proposalRow(db, open)).toMatchObject({ status: 'proposed' });
		});
	});

	it('an engine refusal stores nothing and returns the engine’s sentence', async () => {
		await withRollback(async (db) => {
			// Accepted on Tuesday 24 Nov, once its week has passed: the review reads late.
			const { owner, weekStartsOn, review } = await reviewed(db);
			const later = { db, now: clock(NEXT_TUESDAY), statementTimeoutMs: SLOW_OK };
			expect(
				await decideNextWeek(owner, review.id, { items: [], accept: true }, later)
			).toMatchObject({ outcome: 'superseded', reason: 'sessions_passed' });
			expect((await getWeeklyReviewView(owner, weekStartsOn, { db })).decision.state).toBe('late');
			const before = await proposalCount(db, owner);

			expect(
				await proposeDeloadAgainAction(
					{ locals: session(owner), weekStartsOn, origin: ORIGIN },
					later
				)
			).toEqual({
				status: 'refused',
				why: 'Every planned week is behind you, so the next block comes from your cycle review instead.'
			});
			expect(await proposalCount(db, owner)).toBe(before);
		});
	});

	it('is behind the owner check: a signed-out or recovery session is 401, before anything runs', async () => {
		await withRollback(async (db) => {
			const { owner, weekStartsOn, propose } = await reviewed(db);
			const signedOut = { requestId: 'r' } as App.Locals;
			for (const locals of [signedOut, session(owner, 'recovery')]) {
				const err = await thrown(
					proposeDeloadAgainAction({ locals, weekStartsOn, origin: ORIGIN }, propose)
				);
				expect(isHttpError(err, 401)).toBe(true);
			}
		});
	});

	it('a key that is not a weekly review is the 404 page', async () => {
		await withRollback(async (db) => {
			const { owner, propose } = await reviewed(db);
			const err = await thrown(
				proposeDeloadAgainAction(
					{ locals: session(owner), weekStartsOn: null, origin: ORIGIN },
					propose
				)
			);
			expect(isHttpError(err, 404)).toBe(true);
		});
	});
});
