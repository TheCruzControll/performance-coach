/**
 * Train's replan note (src/routes/(app)/train/week.server.ts, `noteParts.replan`) on real
 * Postgres: Train links only the open re-plan a goal priority proposed, by its proposal's page, and
 * never the plan. No
 * open re-plan, or one the owner made, gives null. A read that fails is recorded (part 'replanNote')
 * and the week renders without the note.
 */
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import { saveGoalAction } from '../../../src/lib/server/forms/profile';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import type { PriorityReplan } from '../../../src/lib/server/services/periodisation/priority';
import {
	getOpenReplan,
	proposeReplan
} from '../../../src/lib/server/services/periodisation/propose';
import { listGoals, updateGoal } from '../../../src/lib/server/services/profile';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { loadTrainWeek } from '../../../src/routes/(app)/train/week.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** The periodisation-week fixture's clock (its program is planned around it). */
const NOW = new Date('2026-11-11T12:00:00Z');
const TODAY = '2026-11-11';
const SLOW_OK = 10_000;

/** The fixture's one goal, as Profile saves it. */
const goalFields = {
	kind: 'general',
	title: 'Strong, fit and sharp',
	disciplines: ['strength', 'running', 'muay_thai'],
	focus: 'Lifts and long run up around two classes a week',
	measure: 'Working sets and long-run time'
};

function session(ownerId: string): App.Locals {
	return {
		requestId: 'test',
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind: 'owner' as AuthSession['kind'],
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

/** The request Train's load gets (the page's own origin for any recorded failure). */
const origin = (requestId: string) => ({
	requestId,
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

/** An owner with the periodisation-week program, its one goal, and the goal's id. */
async function plannedOwner(db: Executor) {
	const owner = await makeOwner(db);
	await seedAnalyticsFixture(owner, 'periodisation-week', { timeZone: 'UTC', now: NOW }, { db });
	const [goal] = await listGoals(owner, { db });
	return { owner, goal: goal!.id };
}

/** Pause the goal as Profile does: the goal action, which runs the priority trigger. */
async function pause(db: Executor, owner: string, goal: string) {
	const body = new FormData();
	body.set('payload', JSON.stringify({ id: goal, ...goalFields, status: 'paused' }));
	const result = await saveGoalAction(
		{
			locals: session(owner),
			request: new Request('http://localhost/profile/goals?/saveGoal', { method: 'POST', body })
		},
		{ db, now: () => NOW, replan: { statementTimeoutMs: SLOW_OK } }
	);
	return (result as { replan: PriorityReplan }).replan;
}

/** Train's load for the owner's current week, as the page calls it. */
function train(owner: string, db: Executor, requestId = crypto.randomUUID(), deps = {}) {
	return loadTrainWeek(owner, { now: NOW, week: null, origin: origin(requestId) }, { db, ...deps });
}

describe('Train’s replan note', () => {
	it('is null when no re-plan is open', async () => {
		await withRollback(async (db) => {
			const { owner } = await plannedOwner(db);
			const week = await train(owner, db);
			expect(week.state).toBe('program');
			if (week.state !== 'program') return;
			expect(week.noteParts.replan).toBeNull();
		});
	});

	it('names the open re-plan a goal priority proposed, by its id, and no more', async () => {
		await withRollback(async (db) => {
			const { owner, goal } = await plannedOwner(db);
			const paused = await pause(db, owner, goal);
			expect(paused).toMatchObject({ state: 'proposed', proposalId: expect.any(String) });

			const week = await train(owner, db);
			if (week.state !== 'program') throw new Error(`expected a program, got ${week.state}`);
			// The week's note links to its proposal, and holds no more of it (v2/07).
			expect(week.noteParts.replan).toEqual({ href: `/coach/proposals/${paused.proposalId}` });
			expect(Object.keys(week.noteParts.replan ?? {})).toEqual(['href']);
			expect(week.noteParts.replan).toEqual({
				href: `/coach/proposals/${(await getOpenReplan(owner, { db }))!.id}`
			});
			expect(week.note?.opens).toBe(true);
		});
	});

	it('is null for an open re-plan the owner made, which is not a goal priority', async () => {
		await withRollback(async (db) => {
			const { owner, goal } = await plannedOwner(db);
			// The owner's own change, saved without the trigger: then the owner asks for a re-plan.
			await updateGoal(owner, goal, { ...goalFields, status: 'paused' }, { db });
			const made = await proposeReplan(
				owner,
				{ today: TODAY, directive: { kind: 'priorities', cause: 'status' }, source: 'owner' },
				{ db, now: () => NOW }
			);
			expect(made).toMatchObject({ status: 'proposed' });
			expect(await getOpenReplan(owner, { db })).not.toBeNull();

			const week = await train(owner, db);
			if (week.state !== 'program') throw new Error(`expected a program, got ${week.state}`);
			expect(week.noteParts.replan).toBeNull();
		});
	});

	it('records a failed read and renders the week without the note', async () => {
		await withRollback(async (db) => {
			const { owner, goal } = await plannedOwner(db);
			await pause(db, owner, goal);
			// Every access to this database throws, so only the note's read fails.
			const broken = new Proxy(
				{},
				{
					get() {
						throw new Error('the proposals read exploded');
					}
				}
			) as unknown as Executor;
			const requestId = crypto.randomUUID();
			const week = await train(owner, db, requestId, {
				replanNote: { db: broken },
				errorsDb: db
			});
			if (week.state !== 'program') throw new Error(`expected a program, got ${week.state}`);
			expect(week.noteParts.replan).toBeNull();
			expect(week.lines.length).toBeGreaterThan(0);

			const [recorded] = await findErrorsByRequestId(requestId, { db });
			expect(recorded).toMatchObject({ kind: 'load' });
			expect(JSON.stringify(recorded?.context)).toContain('replanNote');
		});
	});
});
