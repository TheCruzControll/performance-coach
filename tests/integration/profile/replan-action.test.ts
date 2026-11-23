/**
 * Profile → Goals' `replan` action (src/lib/server/forms/profile.ts) on real Postgres, through the
 * real services: Retry runs the priority trigger again for the signed-in owner and answers with its
 * state, as a goal action's `replan` does. It reads and changes that owner's plan only, a signed-out
 * or recovery session is refused before anything runs, and only the goals section routes it.
 */
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import { coachProposals, type Executor } from '../../../src/lib/server/db';
import { replanAction, saveGoalAction } from '../../../src/lib/server/forms/profile';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import type { PriorityReplan } from '../../../src/lib/server/services/periodisation/priority';
import { getOpenReplan } from '../../../src/lib/server/services/periodisation/propose';
import { listGoals } from '../../../src/lib/server/services/profile';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { actions as profileActions } from '../../../src/routes/(app)/profile/[section]/+page.server';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from './fixtures';

/** The periodisation-week fixture's clock (its program is planned around it). */
const NOW = new Date('2026-11-11T12:00:00Z');
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

/** The fixture's one goal, as Profile saves it (its own general goal). */
const goalFields = {
	kind: 'general',
	title: 'Strong, fit and sharp',
	disciplines: ['strength', 'running', 'muay_thai'],
	focus: 'Lifts and long run up around two classes a week',
	measure: 'Working sets and long-run time'
};

/** A signed-in request's locals, with the request id a failure is recorded under. */
function session(
	ownerId: string,
	kind: AuthSession['kind'] = 'owner',
	requestId = 'test'
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

/** The request a Retry sends: a form action with no payload. */
function retry(): Request {
	return new Request('http://localhost/profile/goals?/replan', {
		method: 'POST',
		body: new FormData()
	});
}

/** The trigger's own deps, as a goal action gets them: the clock pinned to NOW. */
const deps = (db: Executor, replan: object = {}) => ({
	db,
	now: () => NOW,
	replan: { statementTimeoutMs: SLOW_OK, ...replan }
});

/** An owner with the periodisation-week program, its one goal ranked first. */
async function plannedOwner(db: Executor) {
	const owner = await makeOwner(db);
	await seedAnalyticsFixture(owner, 'periodisation-week', { timeZone: 'UTC', now: NOW }, { db });
	const [goal] = await listGoals(owner, { db });
	return { owner, goal: goal!.id };
}

/** Pause the owner's goal as Profile does: the goal action, which runs the trigger. */
function pause(db: Executor, owner: string, goal: string, replan?: object) {
	const requestId = crypto.randomUUID();
	const body = new FormData();
	body.set('payload', JSON.stringify({ id: goal, ...goalFields, status: 'paused' }));
	const event = {
		locals: session(owner, 'owner', requestId),
		request: new Request('http://localhost/profile/goals?/saveGoal', { method: 'POST', body })
	};
	return saveGoalAction(event, deps(db, replan)).then((result) => ({
		requestId,
		replan: (result as { replan: PriorityReplan }).replan
	}));
}

/** What a Retry returned, failing the test when it returned something else. */
async function replanOf(result: unknown): Promise<PriorityReplan> {
	const data = result as { replan?: PriorityReplan };
	if (!data.replan) throw new Error(`No replan in ${JSON.stringify(result)}`);
	return data.replan;
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

describe('Profile → Goals’ replan action (Retry)', () => {
	it('reruns the trigger for the owner and returns its state', async () => {
		await withRollback(async (db) => {
			const { owner } = await plannedOwner(db);
			// The goals still fit the plan they were planned from: the trigger says so.
			const replan = await replanOf(
				await replanAction({ locals: session(owner), request: retry() }, deps(db))
			);
			expect(replan).toEqual({ state: 'unchanged' });
		});
	});

	it('retries a failed re-plan, which then proposes it, and the failure stays recorded once', async () => {
		await withRollback(async (db) => {
			const { owner, goal } = await plannedOwner(db);
			const fault = { propose: () => Promise.reject(new Error('preview exploded')) };
			const failed = await pause(db, owner, goal, fault);
			expect(failed.replan).toEqual({ state: 'failed' });
			expect(await getOpenReplan(owner, { db })).toBeNull();

			const retried = await replanOf(
				await replanAction({ locals: session(owner), request: retry() }, deps(db))
			);
			expect(retried).toMatchObject({ state: 'proposed', proposalId: expect.any(String) });
			expect(await getOpenReplan(owner, { db })).toMatchObject({
				id: retried.proposalId,
				origin: { kind: 'goal_priority' }
			});
			// The app_errors row belongs to the failed save; the Retry that worked adds none.
			const errors = await findErrorsByRequestId(failed.requestId, { db });
			expect(errors).toHaveLength(1);
		});
	});

	it('leaves another owner’s plan and goals untouched', async () => {
		await withRollback(async (db) => {
			const { owner, goal } = await plannedOwner(db);
			const paused = await pause(db, owner, goal);
			expect(paused.replan.state).toBe('proposed');
			const open = await getOpenReplan(owner, { db });

			const other = await makeSecondOwner(db);
			const answer = await replanOf(
				await replanAction({ locals: session(other), request: retry() }, deps(db))
			);
			// Someone else has no program: their Retry reads nothing of this owner's plan.
			expect(answer).toEqual({ state: 'no_program' });
			expect(await getOpenReplan(owner, { db })).toEqual(open);
			expect((await listGoals(owner, { db })).find((g) => g.id === goal)?.status).toBe('paused');
			const theirs = await db
				.select({ id: coachProposals.id })
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, other));
			expect(theirs).toEqual([]);
		});
	});

	it('refuses a signed-out request and a recovery session before reading the form', async () => {
		await withRollback(async (db) => {
			const { owner } = await plannedOwner(db);
			const refused: App.Locals[] = [
				{ requestId: 'test', session: null },
				session(owner, 'recovery')
			];
			for (const locals of refused) {
				const err = await thrown(replanAction({ locals, request: retry() }, deps(db)));
				expect(isHttpError(err, 401)).toBe(true);
			}
		});
	});

	it('is routed by the goals section only', async () => {
		await withRollback(async (db) => {
			const { owner } = await plannedOwner(db);
			const route = profileActions.replan as unknown as (event: unknown) => Promise<unknown>;
			const other = await thrown(
				Promise.resolve().then(() =>
					route({ params: { section: 'equipment' }, locals: session(owner), request: retry() })
				)
			);
			expect(isHttpError(other, 404)).toBe(true);

			// The route runs on the app's own database, which cannot see this test's rolled-back plan,
			// so the action reaches the trigger and it answers for a plan the database does not hold.
			const answer = await route({
				params: { section: 'goals' },
				locals: session(owner),
				request: retry()
			});
			expect(answer).toEqual({ replan: { state: 'no_program' } });
		});
	});
});
