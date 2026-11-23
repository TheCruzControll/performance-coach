/**
 * The goal-priority trigger (m7-plan priority-replan-trigger; PRD §2, §5): whenever the goals'
 * priorities change, in Profile or through an accepted coach goal_update, a re-plan is proposed
 * through M5's lifecycle (proposeReplan, source goal_priority). The goal change has committed
 * before this runs, and nothing here ever throws: the save never fails because of it.
 *
 * - No active program: no_program (onboarding's goal step included), nothing read beyond that.
 * - Every planned week behind today: deferred, left to M6's cycle review.
 * - Cheap first: today's ranking (active goals by rank, paused goals by rank, each with its event
 *   date) is compared with the same ranking in the input the plan was generated from. Only a
 *   difference runs proposeReplan, and so the preview. Decision: the input compared is the newest
 *   generated version's (PRIORITY_BASELINE), so a re-plan once accepted is the new baseline and a
 *   title or notes edit is never a change.
 * - A ranking this change did not move (request.before, the goals before the save): never a new
 *   proposal, so a re-plan the owner rejected does not come back on a title or notes edit.
 * - The same ranking again (a reorder put back), or a preview in which no week changes: unchanged,
 *   and an open goal_priority re-plan is closed as revised, since it no longer matches the goals.
 * - A preview refused for another reason (the engine's refusals): unchanged, with its sentence.
 * - Any error: recorded in app_errors (on deps.errorsDb, else deps.db), and failed.
 * Profile's saveGoal (a status, an event date or any other edit), reorderGoals and deleteGoal
 * call it (forms/profile.ts), and so does M5's acceptProposal for an applied goal_update. A status
 * has no action of its own: Profile sets it through saveGoal.
 * Every read goes through deps.db, awaited in turn. Owner-scoped. Imported by path.
 */
import type { IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { Goal } from '../../../domain/profile/types';
import { PROPOSAL } from '../../../domain/training/lifecycles';
import type { PRIORITY_CAUSES } from '../../../domain/training/replan';
import { getDb } from '../../db';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { inTransaction, resolveDeps, type CoachDeps } from '../coach/shared';
import { recordServerError } from '../errors';
import { transition } from '../lifecycle-guard';
import { getAthleteProfile, listGoals } from '../profile/index';
import { getOpenReplan, proposeReplan, type ProposeDeps } from './propose';

/**
 * Decision (m7-plan priority-replan-trigger): the ranking is compared with the input of the
 * program's newest generated version (a first build, a next block or an accepted re-plan), not
 * the first version that planned today's block.
 */
export const PRIORITY_BASELINE = 'newest_generated_version';

/** Why the priorities moved, as the priorities directive names it. */
export type PriorityCause = (typeof PRIORITY_CAUSES)[number];

export type PriorityReplanState = 'proposed' | 'unchanged' | 'deferred' | 'no_program' | 'failed';

/** What the trigger did, as a goal action returns it in its data. */
export interface PriorityReplan {
	state: PriorityReplanState;
	/** proposed: the open re-plan. */
	proposalId?: string;
	/** proposed: its summary line; unchanged by a refusal: the refusal's sentence. */
	summary?: string;
}

export type PriorityDeps = ProposeDeps & {
	/** proposeReplan unless given, for a test to fail. */
	propose?: typeof proposeReplan;
};

/** One goal in a ranking: its id and event date. */
type Ranked = readonly [string, string | null];
interface Ranking {
	active: Ranked[];
	paused: Ranked[];
}

/** Today's ranking from the goals, as buildProgrammingInput ranks them. */
function rankingOf(goals: readonly Goal[]): Ranking {
	const ranked = (status: Goal['status']) =>
		goals
			.filter((g) => g.status === status)
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
			.map((g): Ranked => [g.id, g.eventDate]);
	return { active: ranked('active'), paused: ranked('paused') };
}

/** The ranking a stored input snapshot holds; null when it holds none that can be read. */
function storedRanking(snapshot: Record<string, unknown> | null): Ranking | null {
	const input = snapshot as {
		goals?: { eventDate?: string | null }[];
		paused?: { eventDate?: string | null }[];
		refs?: { goals?: string[]; paused?: string[] };
	} | null;
	const zip = (ids: string[] | undefined, goals: { eventDate?: string | null }[] | undefined) =>
		Array.isArray(ids) && Array.isArray(goals) && ids.length === goals.length
			? ids.map((id, i): Ranked => [id, goals[i]!.eventDate ?? null])
			: null;
	// With every open goal paused, the input plans them at maintenance and its goals are [].
	const active = zip(input?.refs?.goals, input?.goals);
	const paused = zip(input?.refs?.paused, input?.paused);
	return active && paused ? { active, paused } : null;
}

const same = (a: Ranking, b: Ranking) => JSON.stringify(a) === JSON.stringify(b);

/** Why the ranking moved, when the caller did not say: a status, then the order, then a date. */
function causeOf(before: Ranking | null, now: Ranking): PriorityCause {
	if (!before) return 'reorder';
	const ids = (list: Ranked[]) => list.map(([id]) => id);
	const goals = (r: Ranking) => JSON.stringify([ids(r.active).sort(), ids(r.paused).sort()]);
	if (goals(before) !== goals(now)) return 'status';
	const order = (r: Ranking) => JSON.stringify([ids(r.active), ids(r.paused)]);
	return order(before) !== order(now) ? 'reorder' : 'event';
}

/** Close the owner's open goal_priority re-plan as revised: the goals no longer ask for it. */
async function closeOpen(ownerId: string, deps: CoachDeps) {
	await inTransaction(deps, async ({ db, now }) => {
		const repo = createCoachProposalsRepository(db);
		await repo.lockCreates(ownerId);
		const open = await getOpenReplan(ownerId, { db, now });
		if (open?.origin?.kind !== 'goal_priority') return;
		const at = now();
		await repo.decide(ownerId, open.id, transition(PROPOSAL, open.status, 'supersede'), {
			supersededReason: 'revised',
			closedAt: at,
			updatedAt: at
		});
	});
}

/**
 * Propose a re-plan when the goals' priorities moved, as the header says. `today` is the owner's
 * local day unless given; `cause` is worked out from the change unless given; `before`, the goals
 * before the change, when the caller read them.
 */
export async function replanForPriorities(
	ownerId: string,
	request: { today?: IsoDate; cause?: PriorityCause; before?: readonly Goal[] } = {},
	deps: PriorityDeps = {}
): Promise<PriorityReplan> {
	const db = deps.db ?? getDb();
	const { now } = resolveDeps(deps);
	try {
		const programs = createProgramsRepository(db);
		const found = await programs.currentProgram(ownerId);
		if (!found) return { state: 'no_program' };
		const { blocks } = await programs.versionOutline(found.version.id);
		const lastPlanned = blocks.reduce<IsoDate | null>(
			(last, b) => (!b.outline && (last === null || b.endsOn > last) ? b.endsOn : last),
			null
		);
		const today =
			request.today ?? localDay(now(), (await getAthleteProfile(ownerId, { db })).timeZone);
		if (lastPlanned === null || today > lastPlanned) return { state: 'deferred' };

		const snapshot =
			(found.version.inputSnapshot as Record<string, unknown> | null) ??
			(await programs.latestInput(found.program.id));
		const before = storedRanking(snapshot);
		const ranking = rankingOf(await listGoals(ownerId, { db }));
		if (before && same(before, ranking)) {
			await closeOpen(ownerId, { db, now });
			return { state: 'unchanged' };
		}
		if (request.before && same(rankingOf(request.before), ranking)) return { state: 'unchanged' };
		const cause = request.cause ?? causeOf(before, ranking);
		const propose = deps.propose ?? proposeReplan;
		const made = await propose(
			ownerId,
			{ today, directive: { kind: 'priorities', cause }, source: 'goal_priority' },
			{ ...deps, db, now }
		);
		switch (made.status) {
			case 'proposed':
				return {
					state: 'proposed',
					proposalId: made.proposal.id,
					summary: made.proposal.summary
				};
			case 'unchanged':
				await closeOpen(ownerId, { db, now });
				return { state: 'unchanged' };
			case 'refused':
				if (made.refusal === 'no_program') return { state: 'no_program' };
				if (made.refusal === 'block_complete') return { state: 'deferred' };
				return { state: 'unchanged', summary: made.why };
		}
	} catch (error) {
		await recordServerError(
			{
				error,
				kind: 'app',
				status: 500,
				...deps.origin,
				context: { part: 'priority-replan', cause: request.cause ?? null }
			},
			{ db: deps.errorsDb ?? db }
		);
		return { state: 'failed' };
	}
}
