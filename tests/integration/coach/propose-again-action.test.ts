/**
 * The 'Propose again' action of a proposal's detail (routes/(app)/coach/proposals/[[id]]/
 * propose-again.server.ts) on real Postgres, through the real service: the owner's check comes
 * first (a signed-out or recovery session is 401 before anything runs), the id must be a
 * proposal's (anything else, or another owner's, is the 404 page), a stale re-plan is answered
 * with the fresh proposal's id, and a failure is recorded and answered as failed, so the card can
 * offer Try again.
 */
import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import { acceptProposal } from '../../../src/lib/server/services/coach/proposals';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { proposeReplan } from '../../../src/lib/server/services/periodisation/propose';
import { createGoal } from '../../../src/lib/server/services/profile';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { proposeAgainAction } from '../../../src/routes/(app)/coach/proposals/[[id]]/propose-again.server';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const WEDNESDAY = '2026-11-18';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

const clock = () => atLocal(WEDNESDAY, '12:00', TZ);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A signed-in request's locals, with the request id a failure is recorded under. */
function session(
	ownerId: string,
	kind: AuthSession['kind'] = 'owner',
	requestId = crypto.randomUUID()
): App.Locals {
	return {
		requestId,
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind,
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

/** The action's event: the route's id and the POST it came with. */
function event(locals: App.Locals, id: string | undefined) {
	return {
		locals,
		params: { id },
		request: new Request(`http://localhost/coach/proposals/${id ?? ''}?/proposeAgain`, {
			method: 'POST',
			body: new FormData()
		})
	};
}

/** An owner with the block-end program, and a stale profile_changed re-plan of theirs. */
async function staleOwner(db: Executor) {
	const owner = await makeOwner(db);
	await seedAnalyticsFixture(owner, 'block-end', { timeZone: TZ, now: clock() }, { db });
	const deps = { db, now: clock, statementTimeoutMs: SLOW_OK };
	const made = await proposeReplan(
		owner,
		{ today: WEDNESDAY, directive: { kind: 'priorities', cause: 'reorder' }, source: 'owner' },
		deps
	);
	if (made.status !== 'proposed') throw new Error(`Not proposed: ${JSON.stringify(made)}`);
	await createGoal(
		owner,
		{
			...{ kind: 'general', title: 'Run more', disciplines: ['running'] },
			...{ focus: 'Running', measure: 'Run three times a week' }
		},
		{ db }
	);
	await acceptProposal(owner, made.proposal.id, deps);
	return { owner, stale: made.proposal.id, deps };
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

describe('the Propose again action', () => {
	it('answers a stale re-plan with the fresh proposal’s id', async () => {
		await withRollback(async (db) => {
			const { owner, stale, deps } = await staleOwner(db);
			const outcome = await proposeAgainAction(event(session(owner), stale), deps);
			expect(outcome).toMatchObject({ status: 'proposed' });
			if (outcome.status !== 'proposed') throw new Error('unreachable');
			expect(outcome.id).not.toBe(stale);
		});
	});

	it('answers a proposal that is not a stale re-plan as not_stale', async () => {
		await withRollback(async (db) => {
			const { owner, stale, deps } = await staleOwner(db);
			const fresh = await proposeAgainAction(event(session(owner), stale), deps);
			if (fresh.status !== 'proposed') throw new Error('unreachable');
			expect(await proposeAgainAction(event(session(owner), fresh.id), deps)).toEqual({
				status: 'not_stale'
			});
		});
	});

	it('is behind the owner check: a signed-out or recovery session is 401, before anything runs', async () => {
		await withRollback(async (db) => {
			const { owner, stale, deps } = await staleOwner(db);
			const refused = [
				{ requestId: 'r', session: undefined },
				session(owner, 'recovery')
			] as App.Locals[];
			for (const locals of refused) {
				const err = await thrown(proposeAgainAction(event(locals, stale), deps));
				expect(isHttpError(err, 401)).toBe(true);
			}
		});
	});

	it('is the 404 page for another owner’s proposal, a missing one and a malformed id', async () => {
		await withRollback(async (db) => {
			const { stale, deps } = await staleOwner(db);
			const other = await makeSecondOwner(db);
			for (const id of [stale, crypto.randomUUID(), 'not-an-id', undefined]) {
				const err = await thrown(proposeAgainAction(event(session(other), id), deps));
				expect(isHttpError(err, 404)).toBe(true);
			}
		});
	});

	it('records a failure and answers failed, so the card can offer Try again', async () => {
		await withRollback(async (db) => {
			const { owner, stale, deps } = await staleOwner(db);
			const requestId = crypto.randomUUID();
			const broken = {
				...deps,
				now: () => {
					throw new Error('the clock is down');
				}
			};
			const outcome = await proposeAgainAction(
				event(session(owner, 'owner', requestId), stale),
				broken
			);
			expect(outcome).toEqual({ status: 'failed' });
			const errors = await findErrorsByRequestId(requestId, { db });
			expect(errors).toHaveLength(1);
		});
	});

	it('answers a source that cannot be asked again as not_reproposable: not a failure, nothing recorded', async () => {
		await withRollback(async (db) => {
			const { owner, stale, deps } = await staleOwner(db);
			await db.execute(
				sql`alter table coach_proposals disable trigger coach_proposals_content_guard`
			);
			await db.execute(
				sql`alter table coach_proposals disable trigger coach_proposals_frozen_guard`
			);
			await db.execute(
				sql`update coach_proposals set evidence = ${JSON.stringify({ source: { kind: 'nope' } })}::jsonb where id = ${stale}`
			);
			const requestId = crypto.randomUUID();
			const outcome = await proposeAgainAction(
				event(session(owner, 'owner', requestId), stale),
				deps
			);
			expect(outcome).toEqual({ status: 'not_reproposable' });
			expect(await findErrorsByRequestId(requestId, { db })).toHaveLength(0);
		});
	});
});
