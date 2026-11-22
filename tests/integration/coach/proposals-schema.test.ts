/**
 * Coach proposals and notes on real Postgres (the M5 plan's coach-proposals-db):
 * - A proposal names the conversation, run and tool call that made it, with its payload's
 *   version and hash, its diff and impact; a tool call names the proposal it made by foreign key.
 * - It is inserted 'proposed', its content never changes, its status moves only forward
 *   (proposed → accepted, rejected, applied or superseded; accepted → applied or superseded), and
 *   an applied, rejected or superseded row is frozen. Leaving 'proposed' stamps closed_at.
 * - program_id goes from null to a program only when a new_program is applied.
 * - The lifecycle columns are held coherent by CHECKs: applied names a version or a ref,
 *   superseded a reason, a decision time and note only off 'proposed'.
 * - Notes are insert-only. DELETE is refused on both, so deleting the owner is refused.
 * Refusals are pinned to their SQLSTATE, table and constraint (or guard).
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { payloadHash } from '../../../src/lib/domain/coach/proposals';
import { step } from '../../../src/lib/domain/lifecycle';
import { PROPOSAL } from '../../../src/lib/domain/training/lifecycles';
import type { ProposalEvent } from '../../../src/lib/domain/training/lifecycles';
import type { ProposalStatus } from '../../../src/lib/domain/training/vocabulary';
import {
	agentRuns,
	agentToolCalls,
	coachMessages,
	coachNotes,
	coachProposals,
	coachThreads,
	DECISION_NOTE_MAX,
	NOTE_SUMMARY_MAX,
	programs,
	programVersions,
	type Executor
} from '../../../src/lib/server/db';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Run `write` in a savepoint that is always undone: the Postgres error, or null if accepted. */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

const CHECK = '23514';
const FOREIGN_KEY = '23503';
const GUARD = '23001';
const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });
const ck = (name: string) => refused(CHECK, 'coach_proposals', `coach_proposals_${name}_ck`);
const guard = (name: string) => refused(GUARD, 'coach_proposals', `coach_proposals_${name}_guard`);
const noteCk = (name: string) => refused(CHECK, 'coach_notes', `coach_notes_${name}_ck`);

const MONDAY = '2026-11-09';
const PAYLOAD = { ops: [{ op: 'swap', from: 'back_squat', to: 'bulgarian_split_squat' }] };

type NewProposal = typeof coachProposals.$inferInsert;
type Change = Partial<NewProposal>;

/** An owner with a two-version program, a thread, its first message and a run on it. */
async function setup(db: Executor) {
	const ownerId = await makeOwner(db);
	const [program] = await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning();
	const version = async (number: number, parentVersionId: string | null) => {
		const [row] = await db
			.insert(programVersions)
			.values({
				programId: program!.id,
				number,
				parentVersionId,
				createdBy: number === 1 ? 'rules' : 'coach',
				summary: number === 1 ? 'Your first program' : 'Split squats on Thursday',
				startsOn: MONDAY,
				firstPlannedDay: MONDAY
			})
			.returning();
		return row!.id;
	};
	const v1 = await version(1, null);
	const v2 = await version(2, v1);

	const conversation = async () => {
		const [thread] = await db
			.insert(coachThreads)
			.values({
				ownerId,
				title: 'My knee after squats',
				titleSource: 'first_message',
				segmentPromptVersion: 'prompt-1',
				segmentProgramVersionId: v1
			})
			.returning();
		const [message] = await db
			.insert(coachMessages)
			.values({
				ownerId,
				threadId: thread!.id,
				seq: 1,
				segment: 1,
				role: 'user',
				kind: 'owner_message',
				apiVisible: true,
				content: 'My knee hurts after squats',
				clientMessageId: crypto.randomUUID()
			})
			.returning();
		const [run] = await db
			.insert(agentRuns)
			.values({
				ownerId,
				threadId: thread!.id,
				triggerMessageId: message!.id,
				kind: 'turn',
				provider: 'mock',
				model: 'claude-opus-5-5',
				effort: 'medium',
				promptVersion: 'prompt-1'
			})
			.returning();
		return { threadId: thread!.id, runId: run!.id };
	};
	const first = await conversation();
	const other = await conversation();

	/** A program adjustment against version 1, made by the first conversation's run. */
	const proposal = (values: Change = {}): NewProposal => ({
		ownerId,
		kind: 'program_adjustment',
		title: 'Split squats on Thursday',
		summary: 'Thursday’s back squats become split squats.',
		rationale: 'Your knee was sore after the last two squat sessions.',
		payload: PAYLOAD,
		payloadVersion: 1,
		payloadHash: payloadHash(PAYLOAD),
		evidence: { workouts: ['w1', 'w2'] },
		diff: { sessions: [{ day: 'thu', from: 'Back squat', to: 'Bulgarian split squat' }] },
		impact: { weeklySets: { quads: 0 } },
		programId: program!.id,
		baseVersionId: v1,
		threadId: first.threadId,
		runId: first.runId,
		toolUseId: 'toolu_01',
		...values
	});
	/** Store a proposal and move it through `path`: the stored row's id. */
	const store = async (tx: Executor, path: Change[] = [], values: Change = {}) => {
		const [row] = await tx.insert(coachProposals).values(proposal(values)).returning();
		for (const step of path) await update(tx, row!.id, step);
		return row!.id;
	};
	return { ownerId, programId: program!.id, v1, v2, first, other, proposal, store };
}

const update = (tx: Executor, id: string, values: Change) =>
	tx.update(coachProposals).set(values).where(eq(coachProposals.id, id));
const row = async (db: Executor, id: string) =>
	(await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;

const ACCEPTED: Change = { status: 'accepted' };
const REJECTED: Change = { status: 'rejected', decisionNote: 'Not this week' };
const APPLIED_REF: Change = { status: 'applied', appliedRef: { kind: 'goal', id: 'g1' } };
const SUPERSEDED: Change = { status: 'superseded', supersededReason: 'program_changed' };

describe('coach proposals', () => {
	it('keep their conversation, run, tool call, payload version and hash, diff and impact', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const id = await s.store(tx);
			expect(await row(tx, id)).toMatchObject({
				status: 'proposed',
				threadId: s.first.threadId,
				runId: s.first.runId,
				toolUseId: 'toolu_01',
				payload: PAYLOAD,
				payloadVersion: 1,
				payloadHash: payloadHash(PAYLOAD),
				diff: { sessions: [{ day: 'thu', from: 'Back squat', to: 'Bulgarian split squat' }] },
				impact: { weeklySets: { quads: 0 } },
				appliedRef: null,
				closedAt: null,
				decisionNote: null,
				revisionOf: null,
				supersededReason: null
			});
			// A revision names the proposal it revises.
			const revised = await s.store(tx, [], { revisionOf: id, toolUseId: 'toolu_02' });
			expect((await row(tx, revised)).revisionOf).toBe(id);

			// The tool call that made it names it, by foreign key.
			const toolCall = (proposalId: string) => (db: Executor) =>
				db.insert(agentToolCalls).values({
					ownerId: s.ownerId,
					runId: s.first.runId,
					callIndex: 0,
					toolUseId: 'toolu_01',
					name: 'propose_program_adjustment',
					status: 'succeeded',
					input: {},
					proposalId,
					startedAt: new Date(),
					durationMs: 12
				});
			expect(await attempt(tx, toolCall(id))).toBeNull();
			expect(await attempt(tx, toolCall(crypto.randomUUID()))).toEqual(
				refused(
					FOREIGN_KEY,
					'agent_tool_calls',
					'agent_tool_calls_proposal_id_coach_proposals_id_fk'
				)
			);

			const insert = (values: Change) => (db: Executor) =>
				db.insert(coachProposals).values(s.proposal(values));
			expect(await attempt(tx, insert({ payloadHash: 'ABC' }))).toEqual(ck('payload_hash'));
			expect(await attempt(tx, insert({ payloadVersion: 0 }))).toEqual(ck('payload_version'));
			expect(await attempt(tx, insert({ toolUseId: '' }))).toEqual(ck('tool_use'));
		});
	});

	it('refuse every change to their content with the content guard', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const earlier = await s.store(tx);
			const changes: Record<string, Change> = {
				kind: { kind: 'workout_update' },
				title: { title: 'Lunges on Thursday' },
				summary: { summary: 'Thursday’s back squats become lunges.' },
				rationale: { rationale: 'Lunges load the knee less.' },
				payload: { payload: { ops: [] } },
				payloadVersion: { payloadVersion: 2 },
				payloadHash: { payloadHash: payloadHash({ ops: [] }) },
				evidence: { evidence: { workouts: [] } },
				diff: { diff: { sessions: [] } },
				impact: { impact: { weeklySets: { quads: -3 } } },
				baseVersionId: { baseVersionId: s.v2 },
				threadId: { threadId: s.other.threadId },
				runId: { runId: s.other.runId },
				toolUseId: { toolUseId: 'toolu_99' },
				revisionOf: { revisionOf: earlier },
				programId: { programId: null },
				// The guard refuses before the foreign key would (there is one owner).
				ownerId: { ownerId: crypto.randomUUID() },
				createdAt: { createdAt: new Date('2026-01-01T00:00:00Z') }
			};
			for (const path of [[], [ACCEPTED]]) {
				const id = await s.store(tx, path);
				const label = path.length ? 'accepted' : 'proposed';
				for (const [column, change] of Object.entries(changes)) {
					expect(await attempt(tx, (db) => update(db, id, change)), `${label}: ${column}`).toEqual(
						guard('content')
					);
				}
				// The same change, with a move to applied, is still a content change.
				expect(
					await attempt(tx, (db) =>
						update(db, id, { ...changes.title, status: 'applied', appliedVersionId: s.v2 })
					),
					label
				).toEqual(guard('content'));
			}
		});
	});

	it('are inserted as proposed only', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const insert = (values: Change) => (db: Executor) =>
				db.insert(coachProposals).values(s.proposal(values));
			const closedAt = new Date();
			for (const values of [
				{ ...ACCEPTED, closedAt },
				{ ...REJECTED, closedAt },
				{ ...APPLIED_REF, closedAt },
				{ ...SUPERSEDED, closedAt }
			]) {
				expect(await attempt(tx, insert(values)), values.status).toEqual(guard('insert'));
			}
			expect(await attempt(tx, insert({ status: 'proposed' }))).toBeNull();
		});
	});

	it('move forward only, and stamp the decision time on leaving proposed', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const allowed: [string, Change[]][] = [
				['proposed → accepted', [ACCEPTED]],
				['proposed → rejected', [REJECTED]],
				['proposed → applied', [APPLIED_REF]],
				['proposed → superseded', [SUPERSEDED]],
				['accepted → applied', [ACCEPTED, { status: 'applied', appliedVersionId: s.v2 }]],
				['accepted → superseded', [ACCEPTED, { ...SUPERSEDED, supersededReason: 'revised' }]]
			];
			// The stamp is now(): the transaction's start, the same for every statement in it.
			const { rows } = await tx.execute<{ now: string | Date }>(sql`select now() as now`);
			const now = new Date(rows[0]!.now);
			for (const [label, path] of allowed) {
				const id = await s.store(tx);
				for (const step of path) await update(tx, id, step);
				const stored = await row(tx, id);
				expect(stored.status, label).toBe(path.at(-1)!.status);
				expect(stored.closedAt, label).toEqual(now);
			}

			// The decision time is set once, at the decision, and an update may name it itself.
			const decidedAt = new Date('2026-11-10T08:00:00Z');
			const accepted = await s.store(tx, [{ ...ACCEPTED, closedAt: decidedAt }]);
			await update(tx, accepted, { status: 'applied', appliedVersionId: s.v2 });
			expect(await row(tx, accepted)).toMatchObject({ status: 'applied', closedAt: decidedAt });

			const transition = guard('transition');
			const proposed = await s.store(tx);
			const fromAccepted = await s.store(tx, [ACCEPTED]);
			expect(await attempt(tx, (db) => update(db, fromAccepted, { status: 'proposed' }))).toEqual(
				transition
			);
			expect(await attempt(tx, (db) => update(db, fromAccepted, REJECTED))).toEqual(transition);
			// An unknown status is the status CHECK's to name.
			expect(
				await attempt(tx, (db) => update(db, proposed, { status: 'pending' as ProposalStatus }))
			).toEqual(ck('status'));
		});
	});

	it('the PROPOSAL lifecycle agrees with the guards', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const reach: Record<ProposalStatus, Change[]> = {
				proposed: [],
				accepted: [ACCEPTED],
				rejected: [REJECTED],
				applied: [APPLIED_REF],
				superseded: [SUPERSEDED]
			};
			const change: Record<ProposalEvent, Change> = {
				accept: ACCEPTED,
				reject: REJECTED,
				apply: APPLIED_REF,
				supersede: SUPERSEDED
			};
			for (const from of PROPOSAL.states) {
				for (const event of Object.keys(change) as ProposalEvent[]) {
					if (from === 'accepted' && event === 'accept') continue;
					const id = await s.store(tx, reach[from]);
					const allowed = (await attempt(tx, (db) => update(db, id, change[event]))) === null;
					expect(allowed, `${from} × ${event}`).toBe(step(PROPOSAL, from, event).ok);
				}
			}
			// The guard lets a same-status update through; the table refuses it and the service never
			// issues it (acceptProposal returns early unless the proposal is proposed).
			const fromAccepted = await s.store(tx, [ACCEPTED]);
			expect(await attempt(tx, (db) => update(db, fromAccepted, ACCEPTED))).toBeNull();
			expect(step(PROPOSAL, 'accepted', 'accept').ok).toBe(false);
		});
	});

	it('freeze an applied, rejected or superseded proposal', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const terminal: [string, Change[]][] = [
				['applied', [ACCEPTED, { status: 'applied', appliedVersionId: s.v2 }]],
				['rejected', [REJECTED]],
				['superseded', [SUPERSEDED]]
			];
			for (const [label, path] of terminal) {
				const id = await s.store(tx, path);
				for (const change of [
					{ status: 'accepted' },
					{ status: 'proposed', closedAt: null },
					{ decisionNote: 'Changed my mind' },
					{ closedAt: new Date('2026-11-11T08:00:00Z') },
					{ updatedAt: new Date() }
				] satisfies Change[]) {
					expect(
						await attempt(tx, (db) => update(db, id, change)),
						`${label}: ${JSON.stringify(change)}`
					).toEqual(guard('frozen'));
				}
			}
		});
	});

	it('name a version or a ref exactly when applied', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const applied = await s.store(tx, [APPLIED_REF], { programId: null, baseVersionId: null });
			expect(await row(tx, applied)).toMatchObject({
				status: 'applied',
				appliedRef: { kind: 'goal', id: 'g1' },
				appliedVersionId: null
			});
			const move =
				(values: Change, path: Change[] = []) =>
				async (db: Executor) =>
					update(db, await s.store(db, path), values);
			expect(await attempt(tx, move({ status: 'applied' }))).toEqual(ck('applied'));
			expect(await attempt(tx, move({ status: 'applied' }, [ACCEPTED]))).toEqual(ck('applied'));
			expect(
				await attempt(tx, move({ appliedRef: { kind: 'goal', id: 'g1' } }, [ACCEPTED]))
			).toEqual(ck('applied'));
			for (const appliedRef of [
				{ kind: 'workout', id: 'w1' },
				{ kind: 'goal', id: '' },
				{ kind: 'goal', id: 7 },
				{ kind: 'goal' },
				{ id: 'g1' },
				'goal'
			]) {
				expect(
					await attempt(
						tx,
						move({ status: 'applied', appliedRef } as unknown as Change, [ACCEPTED])
					),
					JSON.stringify(appliedRef)
				).toEqual(ck('applied_ref'));
			}
		});
	});

	it('name a known reason exactly when superseded', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const insert = (values: Change) => (db: Executor) =>
				db.insert(coachProposals).values(s.proposal(values));
			const move =
				(values: Change, path: Change[] = []) =>
				async (db: Executor) =>
					update(db, await s.store(db, path), values);
			expect(await attempt(tx, move({ status: 'superseded' }))).toEqual(ck('superseded'));
			expect(await attempt(tx, move({ status: 'superseded' }, [ACCEPTED]))).toEqual(
				ck('superseded')
			);
			expect(await attempt(tx, insert({ supersededReason: 'revised' }))).toEqual(ck('superseded'));
			expect(await attempt(tx, move({ supersededReason: 'revised' }, [ACCEPTED]))).toEqual(
				ck('superseded')
			);
			expect(
				await attempt(
					tx,
					move({ status: 'superseded', supersededReason: 'expired' } as unknown as Change)
				)
			).toEqual(ck('superseded_reason'));
		});
	});

	it('take a decision time and note only once decided', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const insert = (values: Change) => (db: Executor) =>
				db.insert(coachProposals).values(s.proposal(values));
			const move =
				(values: Change, path: Change[] = []) =>
				async (db: Executor) =>
					update(db, await s.store(db, path), values);
			expect(await attempt(tx, insert({ closedAt: new Date() }))).toEqual(ck('closed'));
			expect(await attempt(tx, move({ closedAt: new Date() }))).toEqual(ck('closed'));
			// The decision time stays once decided.
			expect(await attempt(tx, move({ closedAt: null }, [ACCEPTED]))).toEqual(ck('closed'));

			expect(await attempt(tx, insert({ decisionNote: 'Later' }))).toEqual(ck('decision'));
			expect(await attempt(tx, move({ decisionNote: 'Later' }))).toEqual(ck('decision'));
			const note = (decisionNote: string) => move({ ...REJECTED, decisionNote });
			expect(await attempt(tx, note('x'.repeat(DECISION_NOTE_MAX)))).toBeNull();
			expect(await attempt(tx, note('x'.repeat(DECISION_NOTE_MAX + 1)))).toEqual(
				ck('decision_note')
			);
			expect(await attempt(tx, note(''))).toEqual(ck('decision_note'));
		});
	});

	it('take a program only when a new program is applied', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const unplanned = { programId: null, baseVersionId: null };
			const newProgram = await s.store(tx, [ACCEPTED], { ...unplanned, kind: 'new_program' });
			await update(tx, newProgram, {
				status: 'applied',
				programId: s.programId,
				appliedVersionId: s.v1
			});
			expect(await row(tx, newProgram)).toMatchObject({
				status: 'applied',
				programId: s.programId,
				appliedVersionId: s.v1
			});

			const apply = (kind: string, path: Change[], values: Change) => async (db: Executor) =>
				update(db, await s.store(db, path, { ...unplanned, kind }), values);
			const withProgram = { programId: s.programId, appliedVersionId: s.v1 };
			// Straight from proposed, too.
			expect(
				await attempt(tx, apply('new_program', [], { status: 'applied', ...withProgram }))
			).toBeNull();
			// Any other kind, or before it is applied, the program is content.
			expect(
				await attempt(
					tx,
					apply('program_adjustment', [ACCEPTED], { status: 'applied', ...withProgram })
				)
			).toEqual(guard('content'));
			expect(
				await attempt(tx, apply('new_program', [ACCEPTED], { programId: s.programId }))
			).toEqual(guard('content'));
			expect(
				await attempt(tx, apply('new_program', [], { status: 'accepted', programId: s.programId }))
			).toEqual(guard('content'));
		});
	});

	it('are never deleted, so deleting the owner is refused', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			for (const path of [[], [ACCEPTED], [REJECTED]]) {
				const id = await s.store(tx, path);
				expect(
					await attempt(tx, (db) => db.delete(coachProposals).where(eq(coachProposals.id, id)))
				).toEqual(refused(GUARD, 'coach_proposals', 'history_refuse_delete'));
			}
		});
		// An owner whose only record is a proposal about no program or conversation.
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			await tx.insert(coachProposals).values({
				ownerId: owner,
				kind: 'goal_update',
				title: 'Run a sub-50 10K',
				summary: 'A 10K goal for the spring.',
				rationale: 'You asked for a running goal.',
				payload: {}
			});
			expect(
				await attempt(tx, (db) => db.execute(sql`delete from owners where id = ${owner}`))
			).toEqual(refused(GUARD, 'coach_proposals', 'history_refuse_delete'));
		});
	});
});

describe('coach notes', () => {
	const note = (ownerId: string, values: Partial<typeof coachNotes.$inferInsert> = {}) =>
		({
			ownerId,
			kind: 'thread_summary',
			subjects: [{ type: 'exercise', id: 'back_squat', label: 'Back squat' }],
			body: { decisions: ['Split squats on Thursday'], openQuestions: [] },
			summary: 'Knee sore after squats; split squats proposed for Thursday.',
			evidence: { messages: 12 },
			...values
		}) satisfies typeof coachNotes.$inferInsert;

	it('round-trip, with their run, and refuse what their CHECKs refuse', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const [stored] = await tx
				.insert(coachNotes)
				.values(note(s.ownerId, { runId: s.first.runId }))
				.returning();
			expect(stored).toMatchObject({
				kind: 'thread_summary',
				subjects: [{ type: 'exercise', id: 'back_squat', label: 'Back squat' }],
				body: { decisions: ['Split squats on Thursday'], openQuestions: [] },
				evidence: { messages: 12 },
				runId: s.first.runId
			});

			const insert = (values: Partial<typeof coachNotes.$inferInsert>) => (db: Executor) =>
				db.insert(coachNotes).values(note(s.ownerId, values));
			// Kind is open: a kind no service names yet is stored.
			expect(await attempt(tx, insert({ kind: 'workout_analysis', runId: null }))).toBeNull();
			expect(await attempt(tx, insert({ kind: '' }))).toEqual(noteCk('kind'));
			expect(
				await attempt(tx, insert({ subjects: { type: 'exercise' } as unknown as [] }))
			).toEqual(noteCk('subjects'));
			expect(await attempt(tx, insert({ summary: 'x'.repeat(NOTE_SUMMARY_MAX) }))).toBeNull();
			expect(await attempt(tx, insert({ summary: 'x'.repeat(NOTE_SUMMARY_MAX + 1) }))).toEqual(
				noteCk('summary')
			);
			expect(await attempt(tx, insert({ summary: '' }))).toEqual(noteCk('summary'));
			expect(await attempt(tx, insert({ runId: crypto.randomUUID() }))).toEqual(
				refused(FOREIGN_KEY, 'coach_notes', 'coach_notes_run_id_agent_runs_id_fk')
			);
		});
	});

	it('are insert-only and never deleted, so deleting the owner is refused', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const [stored] = await tx.insert(coachNotes).values(note(owner)).returning();
			expect(
				await attempt(tx, (db) =>
					db.update(coachNotes).set({ summary: 'Edited' }).where(eq(coachNotes.id, stored!.id))
				)
			).toEqual(refused(GUARD, 'coach_notes', 'coach_insert_only'));
			expect(
				await attempt(tx, (db) => db.delete(coachNotes).where(eq(coachNotes.id, stored!.id)))
			).toEqual(refused(GUARD, 'coach_notes', 'history_refuse_delete'));
			expect(
				await attempt(tx, (db) => db.execute(sql`delete from owners where id = ${owner}`))
			).toEqual(refused(GUARD, 'coach_notes', 'history_refuse_delete'));
		});
	});
});

describe('the guards', () => {
	it('are row triggers only, so TRUNCATE stays the test and reset bypass', async () => {
		await withRollback(async (tx) => {
			const { rows } = await tx.execute<{ table: string; name: string; truncate: boolean }>(
				sql`select tgrelid::regclass::text as table, tgname as name,
						(tgtype & 32) <> 0 as truncate
					from pg_trigger
					where not tgisinternal and tgrelid in ('coach_proposals'::regclass, 'coach_notes'::regclass)
					order by 1, 2`
			);
			expect(rows).toEqual(
				[
					['coach_notes', 'coach_notes_refuse_delete'],
					['coach_notes', 'coach_notes_refuse_update'],
					['coach_proposals', 'coach_proposals_content_guard'],
					['coach_proposals', 'coach_proposals_frozen_guard'],
					['coach_proposals', 'coach_proposals_insert_guard'],
					['coach_proposals', 'coach_proposals_refuse_delete'],
					['coach_proposals', 'coach_proposals_transition_guard']
				].map(([table, name]) => ({ table, name, truncate: false }))
			);
		});
	});
});
