/**
 * The proposal cards a conversation opens with (src/routes/(app)/coach/[[thread]]/coach.server.ts
 * through services/coach/proposals.ts listThreadProposals), on real Postgres and real turns:
 * - each card follows the answer of the run that proposed it, in the order the runs ran
 * - a card shows the proposal as it stands now: accepted, it is applied with the version it made
 * - someone else, or runs the conversation does not hold, see no proposal
 *
 * The workout-day fixture plans today, Wednesday 11 November 2026, with Bulgarian split squats in
 * every strength session and intervals today.
 */
import { describe, expect, it } from 'vitest';
import type { StrengthSessionPlan } from '../../../src/lib/domain/training/types';
import { MockProvider } from '../../../src/lib/server/agent/provider/mock';
import { programmingProposalScripts } from '../../../src/lib/server/agent/provider/mock-scripts/programming-proposals';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { COACH_TOOLS } from '../../../src/lib/server/agent/tools/registry';
import type { Executor } from '../../../src/lib/server/db';
import {
	acceptProposal,
	listThreadProposals
} from '../../../src/lib/server/services/coach/proposals';
import type { ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { saveEquipment } from '../../../src/lib/server/services/profile';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadCoachScreen } from '../../../src/routes/(app)/coach/[[thread]]/coach.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, TURN_NOW } from './harness';

const GYM = ['barbell', 'squat_rack', 'bench', 'dumbbells', 'kettlebells', 'cables', 'machines'];
const TOOLS = COACH_TOOLS as readonly CoachTool<ResolvedCoachDeps>[];
const MOVE = 'Move my intervals to Friday';
const REPLACE = 'I hate Bulgarian split squats, so replace them';

/** An owner with a full gym and the workout-day plan, split squats for Romanian deadlifts. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	await saveEquipment(
		owner,
		{ gymType: null, equipment: GYM, homeEquipment: [], notes: null },
		{ db }
	);
	const plan = programFixture('workout-day', { monday: '2026-11-09', today: '2026-11-11' });
	for (const session of plan.blocks.flatMap((b) => b.weeks).flatMap((w) => w.sessions)) {
		if (session.kind !== 'strength') continue;
		for (const e of (session as StrengthSessionPlan).exercises)
			if ('key' in e.exercise && e.exercise.key === 'romanian_deadlift')
				e.exercise = { key: 'bulgarian_split_squat' };
	}
	await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return owner;
}

/** One turn of `text` in `threadId` (a new conversation when null), playing the proposal scripts. */
async function turn(db: Executor, owner: string, text: string, threadId: string | null = null) {
	const provider = new MockProvider(programmingProposalScripts, { overrides: () => ({}) });
	const played = await runScripted(programmingProposalScripts[0]!, {
		db,
		owner,
		text,
		threadId,
		provider: { status: 'ready', provider },
		tools: TOOLS
	});
	expect(played.done.status).toBe('completed');
	const proposal = played.events.find((event) => event.type === 'proposal');
	expect(proposal, `“${text}” proposes a change`).toBeDefined();
	return { threadId: played.threadId!, runId: played.runId!, proposalId: proposal!.id };
}

async function screen(db: Executor, owner: string, thread: string) {
	const data = await loadCoachScreen(
		owner,
		{
			thread,
			search: new URLSearchParams(),
			origin: {
				requestId: crypto.randomUUID(),
				method: 'GET',
				path: `/coach/${thread}`,
				routeId: '/(app)/coach/[[thread]]',
				appVersion: '0.1.0+test'
			}
		},
		{ db }
	);
	if (data.failed || !data.thread) throw new Error('expected the conversation');
	return data.thread.messages;
}

describe('a conversation’s proposal cards', () => {
	it('follow the answer of the run that proposed each, and show what changes, why and the impact', async () => {
		await withRollback(async (db) => {
			const owner = await seed(db);
			const move = await turn(db, owner, MOVE);
			const replace = await turn(db, owner, REPLACE, move.threadId);

			const messages = await screen(db, owner, move.threadId);
			expect(messages.map((m) => (m.from === 'proposal' ? m.card.id : m.from))).toEqual([
				'owner',
				'coach',
				move.proposalId,
				'owner',
				'coach',
				replace.proposalId
			]);

			const card = messages.find((m) => m.from === 'proposal')!;
			if (card.from !== 'proposal') throw new Error('a card');
			expect(card.id).toBe(move.proposalId);
			expect(card.card).toMatchObject({
				id: move.proposalId,
				kind: 'program_adjustment',
				status: 'proposed',
				appliedVersion: null,
				supersededReason: null
			});
			expect(card.card.title).toBe('Move a session');
			expect(card.card.rationale.length).toBeGreaterThan(0);
			expect(card.card.rows).toEqual([
				{
					label: 'Intervals',
					before: 'Wed 11 Nov, Morning',
					after: 'Fri 13 Nov, Morning',
					date: '2026-11-13'
				}
			]);
			// A move inside its week leaves the week's totals as they were: the card says so.
			expect(card.card.impactLines).toEqual([]);
			// Only the card's fields reach the page: no payload, links or notes.
			expect(Object.keys(card.card).sort()).toEqual(
				[
					'appliedVersion',
					'id',
					'impactLines',
					'kind',
					'rationale',
					'rows',
					'status',
					'supersededReason',
					'title',
					'warnings'
				].sort()
			);
		});
	});

	it('show a proposal as it stands now: accepted, applied as the version it made', async () => {
		await withRollback(async (db) => {
			const owner = await seed(db);
			const move = await turn(db, owner, MOVE);
			await acceptProposal(owner, move.proposalId, { db, now: () => new Date(TURN_NOW) });

			const messages = await screen(db, owner, move.threadId);
			expect(messages.at(-1)).toMatchObject({
				from: 'proposal',
				card: { id: move.proposalId, status: 'applied', appliedVersion: 2 }
			});
		});
	});

	it('are no one else’s, and only the named runs’', async () => {
		await withRollback(async (db) => {
			const owner = await seed(db);
			const move = await turn(db, owner, MOVE);
			const stranger = crypto.randomUUID();

			const own = await listThreadProposals(owner, move.threadId, [move.runId], { db });
			expect(own.map((p) => [p.runId, p.proposal.id])).toEqual([[move.runId, move.proposalId]]);
			expect(await listThreadProposals(stranger, move.threadId, [move.runId], { db })).toEqual([]);
			expect(
				await listThreadProposals(owner, move.threadId, [crypto.randomUUID()], { db })
			).toEqual([]);
			expect(await listThreadProposals(owner, move.threadId, [], { db })).toEqual([]);
			expect(await listThreadProposals(owner, 'not-a-uuid', [move.runId], { db })).toEqual([]);
		});
	});
});
