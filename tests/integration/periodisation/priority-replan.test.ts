/**
 * The goal-priority trigger (services/periodisation/priority.ts) on real Postgres, through
 * Profile's goal form actions (src/lib/server/forms/profile.ts), called as SvelteKit calls them,
 * on M3's hybrid (a marathon, then strength, then Muay Thai) built from Monday 9 Nov:
 * - a reorder proposes a goal_priority re-plan; putting it back gives unchanged and closes it as
 *   revised; pausing the leader, resuming it once that re-plan is accepted, and moving the
 *   marathon each propose; pausing every goal proposes the maintenance re-plan
 * - a title edit gives unchanged, and so does one after a rejected re-plan; no program no_program,
 *   every planned week behind deferred
 * - an injected fault saves the goal and returns failed with an app_errors row; two quick
 *   reorders leave one open re-plan; an accepted coach goal_update proposes; another owner's
 *   program is never read; onboarding's goal step saves through the same actions, with no
 *   proposal before a program exists
 * Today is Monday 23 Nov (week 3), so a re-plan starts today.
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { scenarioDay } from '../../../src/lib/domain/programming/scenarios';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import { coachProposals, type Executor } from '../../../src/lib/server/db';
import {
	deleteGoalAction,
	reorderGoalsAction,
	saveGoalAction
} from '../../../src/lib/server/forms/profile';
import {
	acceptProposal,
	createProposal,
	getProposalView,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import type { PriorityReplan } from '../../../src/lib/server/services/periodisation/priority';
import { getOpenReplan } from '../../../src/lib/server/services/periodisation/propose';
import {
	completeOnboarding,
	createGoal,
	listGoals,
	saveBaselines,
	saveEquipment,
	saveExperience,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import { buildProgram, previewProgram } from '../../../src/lib/server/services/programming/index';
import { getProgramVersion, skipSession } from '../../../src/lib/server/services/programs/index';
import { withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner, makeSecondOwner } from '../profile/fixtures';

const BUILT_ON = '2026-11-05';
const WEEK_3 = scenarioDay(3, 0);
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;
const at = (day: string) => () => new Date(`${day}T12:00:00Z`);

const general = (title: string, disciplines: string[]) => ({
	...{ kind: 'general', title, disciplines, focus: title },
	measure: 'Train every planned week'
});
const marathonGoal = (eventDate = scenarioDay(20, 6)) => ({
	...{ kind: 'event', title: 'Marathon', disciplines: ['distance_running'] },
	...{ eventType: 'Marathon', eventDate }
});

/** SCENARIOS.hybrid through M2's services, built on Thursday 5 Nov from Monday 9 Nov. */
async function hybridOwner(db: Executor) {
	const owner = await makeOwner(db);
	const deps = { db };
	const marathon = await createGoal(owner, marathonGoal(), deps);
	const strong = await createGoal(owner, general('Stay strong', ['strength']), deps);
	const thai = await createGoal(owner, general('Muay Thai', ['muay_thai']), deps);
	const entries = ['distance_running', 'strength', 'muay_thai'].map((discipline) => ({
		discipline,
		level: 'intermediate'
	}));
	await saveExperience(owner, { entries }, deps);
	const lift = (name: string, source: string, value: number) => ({
		...{ lift: name, source, value },
		unit: 'kg'
	});
	await saveBaselines(
		owner,
		{
			unknown: false,
			lifts: [lift('back_squat', 'tested', 140), lift('bench_press', 'estimate', 100)]
		},
		deps
	);
	await saveSpecifics(
		owner,
		{
			running: {
				...{ unit: 'km', weeklyDistance: 30, runsPerWeek: 4, longestRun: 18 },
				...{ easyPaceSeconds: 330, races: [] }
			},
			muayThai: null
		},
		deps
	);
	await saveEquipment(owner, { gymType: 'commercial', equipment: [], homeEquipment: [] }, deps);
	await saveSchedule(
		owner,
		{
			...{ daysPerWeek: 5, availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
			...{ preferredTimes: ['morning', 'evening'], sessionMinutes: 75, constraints: null },
			commitments: [
				{
					...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue', 'thu'] },
					...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard' }
				}
			]
		},
		deps
	);
	await completeOnboarding(owner, deps);
	const preview = await previewProgram(owner, { today: BUILT_ON, start: 'next_monday' }, deps);
	const built = await buildProgram(
		owner,
		{
			...{ today: BUILT_ON, start: 'next_monday', startsOn: preview.startsOn },
			...{ firstPlannedDay: preview.firstPlannedDay, fingerprint: preview.fingerprint },
			digest: preview.digest
		},
		deps
	);
	const ids = { marathon: marathon.id, strong: strong.id, thai: thai.id };
	return { owner, programId: built.programId, ...ids };
}

function session(ownerId: string, requestId = 'test'): App.Locals {
	return {
		requestId,
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

function post(payload: unknown): Request {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	return new Request('http://localhost/profile/goals?/saveGoal', { method: 'POST', body });
}

/** The action's replan, failing the test when the action failed. */
function replanOf(result: unknown): PriorityReplan {
	const data = result as { replan?: PriorityReplan };
	if (!data.replan) throw new Error(`No replan in ${JSON.stringify(result)}`);
	return data.replan;
}

/** The three goal actions as Profile → Goals runs them for `owner`, on `day`. */
function actions(db: Executor, owner: string, day = WEEK_3, extra: object = {}) {
	const deps = { db, now: at(day), replan: { statementTimeoutMs: SLOW_OK }, ...extra };
	const event = (payload: unknown) => ({ locals: session(owner), request: post(payload) });
	return {
		reorder: async (ids: string[]) => replanOf(await reorderGoalsAction(event({ ids }), deps)),
		save: async (payload: object) => replanOf(await saveGoalAction(event(payload), deps)),
		remove: async (id: string) => replanOf(await deleteGoalAction(event({ id }), deps))
	};
}

/** A proposeReplan that fails the trigger: where it is given, no preview may run. */
const neverPreview = () => Promise.reject(new Error('the trigger ran a preview'));

async function openReplans(db: Executor, owner: string) {
	const [row] = await db
		.select({ n: count() })
		.from(coachProposals)
		.where(
			and(
				eq(coachProposals.ownerId, owner),
				eq(coachProposals.kind, 'replan'),
				eq(coachProposals.status, 'proposed')
			)
		);
	return row!.n;
}

/** The proposed re-plan, with its directive and where it came from. */
async function proposed(db: Executor, owner: string, replan: PriorityReplan) {
	expect(replan).toMatchObject({ state: 'proposed', proposalId: expect.any(String) });
	expect(replan.summary).toBeTruthy();
	const view = await getProposalView(owner, replan.proposalId!, { db });
	const [row] = await db
		.select({ payload: coachProposals.payload })
		.from(coachProposals)
		.where(eq(coachProposals.id, view.id));
	return { view, directive: (row!.payload as { directive: unknown }).directive };
}

describe('a change of priorities on Profile → Goals', () => {
	it('a reorder proposes a goal_priority re-plan, starting today', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const replan = await actions(db, h.owner).reorder([h.strong, h.marathon, h.thai]);
			const { view, directive } = await proposed(db, h.owner, replan);
			expect(view).toMatchObject({ kind: 'replan', status: 'proposed' });
			expect(view.origin).toMatchObject({ kind: 'goal_priority', href: '/profile/goals' });
			expect(directive).toEqual({ kind: 'priorities', cause: 'reorder' });
			// The goals were saved as asked, whatever the trigger did.
			const ranking = (await listGoals(h.owner, { db })).map((g) => g.id);
			expect(ranking).toEqual([h.strong, h.marathon, h.thai]);
		});
	});

	it('putting the order back gives unchanged and closes the open re-plan as revised', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const act = actions(db, h.owner);
			const first = await act.reorder([h.strong, h.marathon, h.thai]);
			expect(first.state).toBe('proposed');

			expect(await act.reorder([h.marathon, h.strong, h.thai])).toEqual({ state: 'unchanged' });
			const closed = await getProposalView(h.owner, first.proposalId!, { db });
			expect(closed).toMatchObject({ status: 'superseded', supersededReason: 'revised' });
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('pausing the leader proposes, and resuming it once that re-plan is accepted proposes again', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const act = actions(db, h.owner);
			const paused = await act.save({ id: h.marathon, ...marathonGoal(), status: 'paused' });
			expect((await proposed(db, h.owner, paused)).directive).toEqual({
				kind: 'priorities',
				cause: 'status'
			});
			const accepted = await acceptProposal(h.owner, paused.proposalId!, {
				db,
				now: at(WEEK_3)
			});
			expect(accepted.proposal.status).toBe('applied');

			// The accepted re-plan is the new baseline: resuming is a change from it.
			const resumed = await act.save({ id: h.marathon, ...marathonGoal(), status: 'active' });
			expect((await proposed(db, h.owner, resumed)).directive).toEqual({
				kind: 'priorities',
				cause: 'status'
			});
		});
	});

	it('moving the marathon proposes', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const moved = await actions(db, h.owner).save({
				id: h.marathon,
				...marathonGoal(scenarioDay(24, 6))
			});
			expect((await proposed(db, h.owner, moved)).directive).toEqual({
				kind: 'priorities',
				cause: 'event'
			});
		});
	});

	it('pausing every goal proposes the maintenance re-plan', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const act = actions(db, h.owner);
			await act.save({ id: h.strong, ...general('Stay strong', ['strength']), status: 'paused' });
			await act.save({ id: h.thai, ...general('Muay Thai', ['muay_thai']), status: 'paused' });
			const all = await act.save({ id: h.marathon, ...marathonGoal(), status: 'paused' });
			const { view } = await proposed(db, h.owner, all);
			expect(view.summaryLines.join(' ')).toMatch(/maintenance/i);
			expect(await openReplans(db, h.owner)).toBe(1);
		});
	});

	it('a title edit gives unchanged without running a preview, and proposes nothing', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			// Only a change of ranking may reach the preview: here it would fail the trigger.
			const replan = { propose: neverPreview };
			const renamed = await actions(db, h.owner, WEEK_3, { replan }).save({
				id: h.strong,
				...general('Strong for life', ['strength'])
			});
			expect(renamed).toEqual({ state: 'unchanged' });
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('a re-plan the owner rejected does not come back on a title edit', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const first = await actions(db, h.owner).reorder([h.strong, h.marathon, h.thai]);
			expect(first.state).toBe('proposed');
			await rejectProposal(h.owner, first.proposalId!, {}, { db, now: at(WEEK_3) });

			const replan = { propose: neverPreview };
			const renamed = await actions(db, h.owner, WEEK_3, { replan }).save({
				id: h.thai,
				...general('Muay Thai twice a week', ['muay_thai'])
			});
			expect(renamed).toEqual({ state: 'unchanged' });
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('after an edit of the owner’s own (a version with no stored input), compares with the input before it', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const v1 = await getProgramVersion(h.owner, h.programId, 1, { db });
			const later = v1.blocks
				.flatMap((b) => b.weeks.flatMap((w) => w.sessions))
				.find((s) => s.date > WEEK_3)!;
			await skipSession(
				h.owner,
				{ sessionLineage: later.lineage },
				{ version: 1, today: WEEK_3 },
				{
					db
				}
			);
			const replan = { propose: neverPreview };
			const renamed = await actions(db, h.owner, WEEK_3, { replan }).save({
				id: h.thai,
				...general('Muay Thai twice a week', ['muay_thai'])
			});
			expect(renamed).toEqual({ state: 'unchanged' });
			const reordered = await actions(db, h.owner).reorder([h.strong, h.marathon, h.thai]);
			expect(reordered.state).toBe('proposed');
		});
	});

	it('every planned week behind today gives deferred, left to the cycle review', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const replan = { propose: neverPreview };
			const late = await actions(db, h.owner, '2028-06-05', { replan }).reorder([
				h.thai,
				h.strong,
				h.marathon
			]);
			expect(late).toEqual({ state: 'deferred' });
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('deleting a goal proposes, as a status change', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const deleted = await actions(db, h.owner).remove(h.thai);
			expect((await proposed(db, h.owner, deleted)).directive).toEqual({
				kind: 'priorities',
				cause: 'status'
			});
		});
	});
});

describe('the save never depends on the trigger', () => {
	it('an injected fault still saves the goal, returns failed and records an app_errors row', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const requestId = crypto.randomUUID();
			const replan = {
				statementTimeoutMs: SLOW_OK,
				propose: () => Promise.reject(new Error('preview exploded'))
			};
			// The request's id reaches the row from the form event: no origin is injected.
			const request = post({ ids: [h.thai, h.marathon, h.strong] });
			const result = await reorderGoalsAction(
				{ locals: session(h.owner, requestId), request },
				{ db, now: at(WEEK_3), replan }
			);
			expect(result).toMatchObject({ replan: { state: 'failed' } });
			expect((await listGoals(h.owner, { db })).map((g) => g.id)).toEqual([
				h.thai,
				h.marathon,
				h.strong
			]);
			const errors = await findErrorsByRequestId(requestId, { db });
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				message: 'preview exploded',
				path: '/profile/goals',
				context: { part: 'priority-replan', cause: 'reorder' }
			});
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('two quick reorders leave one open re-plan, the later one', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const act = actions(db, h.owner);
			const first = await act.reorder([h.strong, h.marathon, h.thai]);
			const second = await act.reorder([h.thai, h.strong, h.marathon]);
			expect(first.state).toBe('proposed');
			expect(second.state).toBe('proposed');
			expect(second.proposalId).not.toBe(first.proposalId);
			expect(await openReplans(db, h.owner)).toBe(1);
			expect((await getOpenReplan(h.owner, { db }))?.id).toBe(second.proposalId);
		});
	});

	it('an accepted coach goal_update proposes a re-plan after the accept', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const deps = { db, now: at(WEEK_3) };
			const { proposal } = await createProposal(
				h.owner,
				{
					proposal: {
						kind: 'goal_update',
						title: 'Put strength first',
						rationale: 'You asked to lead with strength this winter.',
						payload: { ops: [{ op: 'reorder', ids: [h.strong, h.marathon, h.thai] }] }
					}
				},
				deps
			);
			const accepted = await acceptProposal(h.owner, proposal.id, deps);
			expect(accepted.proposal.status).toBe('applied');
			const open = await getOpenReplan(h.owner, deps);
			expect(open?.origin?.kind).toBe('goal_priority');
		});
	});

	it('another owner’s change reads nothing of this owner’s plan', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const other = await makeSecondOwner(db);
			await createGoal(other, eventGoal(), { db });
			await createGoal(other, generalGoal(), { db });
			const goals = await listGoals(other, { db });
			const act = actions(db, other, WEEK_3, { replan: { propose: neverPreview } });
			const replan = await act.reorder(goals.map((g) => g.id).reverse());
			expect(replan).toEqual({ state: 'no_program' });
			expect(await openReplans(db, other)).toBe(0);
			expect(await openReplans(db, h.owner)).toBe(0);
		});
	});

	it('onboarding’s goal step saves through the same actions, with no proposal before a program', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const replan = { propose: neverPreview };
			const act = actions(db, owner, WEEK_3, { source: 'onboarding', replan });
			expect(await act.save(eventGoal())).toEqual({ state: 'no_program' });
			expect(await act.save(generalGoal())).toEqual({ state: 'no_program' });
			const goals = await listGoals(owner, { db });
			expect(goals).toHaveLength(2);
			expect(await act.reorder(goals.map((g) => g.id).reverse())).toEqual({
				state: 'no_program'
			});
			const [row] = await db
				.select({ n: count() })
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, owner));
			expect(row!.n).toBe(0);
		});
	});
});
