/**
 * The coach's programming proposal tools on real Postgres (the M5 plan's
 * tools-programming-proposals):
 * - 'Move my intervals to Friday' stores a program_adjustment with its provenance, summary and
 *   program_id, and no version until it is accepted
 * - 'Plan my next cycle' drafts at effort high for 40 s and completes; accepting it changes no
 *   program (next_cycle is never applied)
 * - a draft that fails, or that today's rules refuse, stores nothing
 * - 'Build me a program' is refused while a program is active, and otherwise stores M3's preview
 * - a revision supersedes the proposal it revises; a decided one cannot be revised
 * - 'I hate Bulgarian split squats, so replace them' records the dislike and proposes the swap
 * - a random ownerId with the seeded owner's ids is NOT_FOUND for all three, storing nothing
 * - every output validates against its schema
 *
 * The workout-day fixture plans today, Wednesday 11 November 2026: 'Lower body & pull', intervals
 * and a class; here every strength session has Bulgarian split squats for Romanian deadlifts.
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { ASK_FOR_CHANGES } from '../../../src/lib/domain/coach/cards';
import type { ProgramPlan, StrengthSessionPlan } from '../../../src/lib/domain/training/types';
import {
	MockProvider,
	type MockContext,
	type MockScript,
	type MockStep
} from '../../../src/lib/server/agent/provider/mock';
import { programmingProposalScripts } from '../../../src/lib/server/agent/provider/mock-scripts/programming-proposals';
import type { LlmProvider, ModelRequest } from '../../../src/lib/server/agent/provider/types';
import type { TurnEntry } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { COACH_TOOLS } from '../../../src/lib/server/agent/tools/registry';
import {
	agentToolCalls,
	coachProposals,
	exercisePreferences,
	type Executor
} from '../../../src/lib/server/db';
import { programs, programVersions } from '../../../src/lib/server/db/schema/programs';
import { acceptProposal, rejectProposal } from '../../../src/lib/server/services/coach/proposals';
import type { ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	completeOnboarding,
	createGoal,
	saveEquipment,
	saveSchedule
} from '../../../src/lib/server/services/profile';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { previewProgram } from '../../../src/lib/server/services/programming/index';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion,
	getTodayPlan
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, storedRows, TURN_NOW } from './harness';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const FRIDAY = '2026-11-13';
const NOW = new Date(TURN_NOW);
const GYM = ['barbell', 'squat_rack', 'bench', 'dumbbells', 'kettlebells', 'cables', 'machines'];
const CYCLE_DRAFT_MS = 40_000;

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = COACH_TOOLS as Tools;
const toolNamed = (name: string) => TOOLS.find((tool) => tool.name === name)!;
const script = (name: string) => programmingProposalScripts.find((s) => s.name === name)!;

/** A MockProvider over `scripts` that keeps every draft request it is sent. */
function drafting(scripts: readonly MockScript[]) {
	const mock = new MockProvider(scripts, { overrides: () => ({}) });
	const drafts: Omit<ModelRequest, 'tools'>[] = [];
	const provider: LlmProvider = {
		name: mock.name,
		model: mock.model,
		stream: (request, signal) => mock.stream(request, signal),
		structured: (request, schema, signal) => {
			drafts.push(structuredClone(request));
			return mock.structured(request, schema, signal);
		},
		countTokens: (request, signal) => mock.countTokens(request, signal)
	};
	return { drafts, ready: { status: 'ready' as const, provider } };
}

/** A draft script answering `kind` with `step` instead of the default draft. */
const draftAs = (kind: string, step: MockStep): MockScript => ({
	name: `${kind}-draft-override`,
	matches: (text) => text.startsWith(`Kind: ${kind}`),
	steps: [step]
});

/** The workout-day plan with Bulgarian split squats in every strength session. */
function splitSquatDay(): ProgramPlan {
	const plan = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	for (const session of plan.blocks.flatMap((b) => b.weeks).flatMap((w) => w.sessions)) {
		if (session.kind !== 'strength') continue;
		for (const e of (session as StrengthSessionPlan).exercises)
			if ('key' in e.exercise && e.exercise.key === 'romanian_deadlift')
				e.exercise = { key: 'bulgarian_split_squat' };
	}
	return plan;
}

/** The owner, with a full gym and the plan, and today's intervals. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	await saveEquipment(
		owner,
		{ gymType: null, equipment: GYM, homeEquipment: [], notes: null },
		{ db }
	);
	const { programId } = await createProgramFromPlan(
		owner,
		splitSquatDay(),
		{ source: 'rules' },
		{ db }
	);
	const today = await getTodayPlan(owner, TODAY, { db });
	const intervals = today!.sessions.find((s) => s.kind === 'run')!;
	const current = await getCurrentProgram(owner, TODAY, { db });
	const version = await getProgramVersion(owner, programId, current!.version.number, { db });
	return { owner, programId, intervals, version };
}

/** An onboarded owner with no program. */
async function onboarded(db: Executor) {
	const owner = await makeOwner(db);
	const goal = {
		kind: 'general',
		title: 'Get stronger',
		disciplines: ['strength'],
		focus: 'Get stronger',
		measure: 'Train every planned week'
	};
	await createGoal(owner, goal, { db });
	const schedule = {
		daysPerWeek: 3,
		availableDays: [],
		preferredTimes: [],
		sessionMinutes: null,
		constraints: null,
		commitments: []
	};
	await saveSchedule(owner, schedule, { db });
	await completeOnboarding(owner, { db });
	return owner;
}

/** Every succeeded tool call of a run, checked against its tool's output schema. */
async function checkedCalls(db: Executor, runId: string) {
	const rows = await db
		.select()
		.from(agentToolCalls)
		.where(eq(agentToolCalls.runId, runId))
		.orderBy(agentToolCalls.callIndex);
	for (const row of rows.filter((r) => r.status === 'succeeded')) {
		const parsed = z.safeParse(toolNamed(row.name).outputSchema, row.output);
		expect(parsed.success, `${row.name}: ${parsed.error?.message ?? ''}`).toBe(true);
	}
	return rows;
}

/** Every owner's coach_proposals and program_versions rows. */
async function rows(db: Executor) {
	const n = async (table: typeof coachProposals | typeof programVersions) =>
		(await db.select({ n: count() }).from(table))[0]!.n;
	return { proposals: await n(coachProposals), versions: await n(programVersions) };
}

/** The tool_result the model was sent for `toolUseId`, parsed. */
async function toolResult(db: Executor, threadId: string, toolUseId: string) {
	const blocks = (await storedRows(db, threadId)).flatMap((row) =>
		Array.isArray(row.content) ? (row.content as Record<string, unknown>[]) : []
	);
	const result = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
	const content = result?.content;
	const text = Array.isArray(content)
		? content.map((part: { text?: string }) => part.text ?? '').join('')
		: String(content);
	return JSON.parse(text) as unknown;
}

const proposalsOf = (db: Executor, owner: string) =>
	db.select().from(coachProposals).where(eq(coachProposals.ownerId, owner));

/** One turn of `text`, playing the proposal scripts (and `extra` first), from `entry`. */
async function turn(
	db: Executor,
	owner: string,
	text: string,
	extra: MockScript[] = [],
	entry: TurnEntry | null = null
) {
	const { drafts, ready } = drafting([...extra, ...programmingProposalScripts]);
	const played = await runScripted(script('move-session'), {
		db,
		owner,
		text,
		entry,
		provider: ready,
		tools: TOOLS
	});
	expect(played.done.status).toBe('completed');
	const calls = await checkedCalls(db, played.runId!);
	return { ...played, calls, drafts };
}

describe('propose_program_adjustment', () => {
	it('stores “Move my intervals to Friday” with its provenance, summary and program, and no version until accepted', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const before = await rows(db);
			const t = await turn(db, s.owner, 'Move my intervals to Friday');
			const call = t.calls.find((c) => c.name === 'propose_program_adjustment')!;
			expect(call).toMatchObject({
				status: 'succeeded',
				input: { sessionLineages: [s.intervals.lineage] }
			});

			const [proposal] = await proposalsOf(db, s.owner);
			expect(proposal).toMatchObject({
				kind: 'program_adjustment',
				status: 'proposed',
				threadId: t.threadId,
				runId: t.runId,
				toolUseId: call.toolUseId,
				programId: s.programId,
				baseVersionId: s.version.version.id,
				appliedVersionId: null
			});
			expect(proposal!.payload).toEqual({
				ops: [{ op: 'move', sessionLineage: s.intervals.lineage, toDate: FRIDAY }]
			});
			expect(proposal!.summary.length).toBeGreaterThan(0);
			expect(proposal!.summary).toBe(
				(proposal!.diff as { summaryLines: string[] }).summaryLines[0]
			);
			expect(t.drafts.map((d) => d.output_config?.effort)).toEqual(['high']);
			expect(await rows(db)).toEqual({
				proposals: before.proposals + 1,
				versions: before.versions
			});

			const accepted = await acceptProposal(s.owner, proposal!.id, { db, now: () => NOW });
			expect(accepted.proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			expect((await rows(db)).versions).toBe(before.versions + 1);
		});
	});

	it('stores nothing when the draft fails or is refused by the model', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const before = await rows(db);
			const invalid = draftAs('program_adjustment', { json: { title: 'Move it' } });
			const refused = draftAs('program_adjustment', { refusal: { category: 'cyber' } });
			for (const [extra, reason] of [
				[invalid, 'invalid_output'],
				[refused, 'refused']
			] as const) {
				const t = await turn(db, s.owner, 'Move my intervals to Friday', [extra]);
				const call = t.calls.find((c) => c.name === 'propose_program_adjustment')!;
				expect(call).toMatchObject({ status: 'failed', errorCode: 'DRAFT_FAILED' });
				expect(await toolResult(db, t.threadId!, call.toolUseId)).toMatchObject({ reason });
			}
			expect(await rows(db)).toEqual(before);
		});
	});

	it('stores nothing when today’s rules refuse the drafted change', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const before = await rows(db);
			const past = draftAs('program_adjustment', {
				json: {
					title: 'Move the intervals back',
					rationale: 'To Monday.',
					payload: { ops: [{ op: 'move', sessionLineage: s.intervals.lineage, toDate: MONDAY }] }
				}
			});
			const t = await turn(db, s.owner, 'Move my intervals to Friday', [past]);
			const call = t.calls.find((c) => c.name === 'propose_program_adjustment')!;
			expect(call).toMatchObject({ status: 'failed', errorCode: 'REFUSED' });
			expect(await toolResult(db, t.threadId!, call.toolUseId)).toMatchObject({
				errors: { 'payload.ops.0.toDate': expect.any(String) }
			});
			expect(await rows(db)).toEqual(before);
		});
	});

	it('is NOT_FOUND for a session that is not the owner’s from today on, before drafting', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const past = s.version.blocks[0]!.weeks[0]!.sessions.find((x) => x.date < TODAY);
			const name = (lineage: string): MockScript => ({
				name: 'named-session',
				matches: (text) => text.startsWith('Change'),
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: {
									request: 'Make it lighter.',
									sessionLineages: [s.intervals.lineage, lineage]
								}
							}
						]
					},
					{ text: '[note] Not found.' }
				]
			});
			const before = await rows(db);
			for (const lineage of [crypto.randomUUID(), ...(past ? [past.lineage] : [])]) {
				const t = await turn(db, s.owner, 'Change that session', [name(lineage)]);
				expect(t.calls[0]).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' });
				expect(t.drafts).toEqual([]);
			}
			expect(await rows(db)).toEqual(before);
		});
	});

	it('replaces the open proposal it revises, and refuses to revise a decided one', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await turn(db, s.owner, 'Move my intervals to Friday');
			const [first] = await proposalsOf(db, s.owner);
			const revise = (revises: string): MockScript => ({
				name: 'revise',
				matches: (text) => text.startsWith('Revise'),
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: {
									request: 'Move Intervals to 2026-11-14 instead.',
									sessionLineages: [s.intervals.lineage],
									revises
								}
							}
						]
					},
					{ text: '[note] Revised.' }
				]
			});
			const t = await turn(db, s.owner, 'Revise it to Saturday', [revise(first!.id)]);
			expect(t.calls[0]).toMatchObject({ status: 'succeeded' });
			const all = await proposalsOf(db, s.owner);
			const second = all.find((p) => p.id !== first!.id)!;
			expect(second).toMatchObject({ status: 'proposed', revisionOf: first!.id });
			expect(second.payload).toMatchObject({ ops: [{ toDate: '2026-11-14' }] });
			expect(all.find((p) => p.id === first!.id)).toMatchObject({
				status: 'superseded',
				supersededReason: 'revised'
			});

			await rejectProposal(s.owner, second.id, {}, { db, now: () => NOW });
			const before = await rows(db);
			const again = await turn(db, s.owner, 'Revise it to Saturday', [revise(second.id)]);
			expect(again.calls[0]).toMatchObject({ status: 'failed', errorCode: 'CLOSED' });
			expect(again.drafts).toEqual([]);
			expect(await rows(db)).toEqual(before);
		});
	});

	it('refuses to revise a proposal of another kind, before drafting', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await turn(db, s.owner, 'Plan my next cycle');
			const [cycle] = await proposalsOf(db, s.owner);
			const revise: MockScript = {
				name: 'revise-cycle',
				matches: (text) => text.startsWith('Revise'),
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: { request: 'Move Intervals to 2026-11-14.', revises: cycle!.id }
							}
						]
					},
					{ text: '[note] Not that one.' }
				]
			};
			const before = await rows(db);
			const t = await turn(db, s.owner, 'Revise it to Saturday', [revise]);
			expect(t.calls[0]).toMatchObject({ status: 'failed', errorCode: 'WRONG_KIND' });
			expect(t.drafts).toEqual([]);
			expect(await rows(db)).toEqual(before);
			expect((await proposalsOf(db, s.owner))[0]).toMatchObject({ status: 'proposed' });
		});
	});

	it('stores nothing when a situational request drafts a never_again swap', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const split = (await resolveKeys(['bulgarian_split_squat'], { db })).get(
				'bulgarian_split_squat'
			)!;
			const situational: MockScript = {
				name: 'bench-taken',
				matches: (text) => text.startsWith('The bench'),
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: {
									request: `Swap ${split.name} (exercise ${split.id}) for its best alternative for a few weeks.`
								}
							}
						]
					},
					{ text: '[note] Not stored.' }
				]
			};
			const before = await rows(db);
			const t = await turn(
				db,
				s.owner,
				'The bench is taken, so swap the Bulgarian split squats for a few weeks',
				[situational]
			);
			expect(t.drafts).toHaveLength(1);
			expect(t.calls[0]).toMatchObject({ status: 'failed', errorCode: 'NEEDS_DISLIKE' });
			expect(await rows(db)).toEqual(before);
			expect(
				await db.select().from(exercisePreferences).where(eq(exercisePreferences.ownerId, s.owner))
			).toEqual([]);
		});
	});

	it('records “I hate Bulgarian split squats, so replace them” and proposes swapping them never again', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const t = await turn(db, s.owner, 'I hate Bulgarian split squats, so replace them');
			expect(t.calls.map((c) => [c.name, c.status])).toEqual([
				['update_exercise_preferences', 'succeeded'],
				['propose_program_adjustment', 'succeeded']
			]);
			expect(t.calls[0]!.output).toMatchObject({ outcome: 'recorded' });
			const [dislike] = await db
				.select()
				.from(exercisePreferences)
				.where(eq(exercisePreferences.ownerId, s.owner));
			expect(dislike).toMatchObject({ sentiment: 'dislike', source: 'coach' });

			const [proposal] = await proposalsOf(db, s.owner);
			const swap = (proposal!.payload as { ops: Record<string, string>[] }).ops[0]!;
			expect(proposal).toMatchObject({ kind: 'program_adjustment', status: 'proposed' });
			expect(swap).toMatchObject({ op: 'swap', scope: 'never_again' });
			const strength = s.version.blocks
				.flatMap((b) => b.weeks)
				.flatMap((w) => w.sessions)
				.find((x) => x.lineage === swap.sessionLineage);
			const planned =
				strength?.kind === 'strength'
					? strength.exercises.find((e) => e.lineage === swap.plannedExerciseLineage)
					: undefined;
			expect(planned?.exercise).toEqual({ key: 'bulgarian_split_squat' });
			expect(swap.toExerciseId).not.toBe(dislike!.exerciseId);

			const accepted = await acceptProposal(s.owner, proposal!.id, { db, now: () => NOW });
			expect(accepted.proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			const v2 = await getProgramVersion(s.owner, s.programId, 2, { db });
			const left = v2.blocks
				.flatMap((b) => b.weeks)
				.flatMap((w) => w.sessions)
				.filter((x) => x.date >= TODAY)
				.flatMap((x) => (x.kind === 'strength' ? x.exercises : []))
				.filter((e) => 'key' in e.exercise && e.exercise.key === 'bulgarian_split_squat');
			expect(left).toEqual([]);
		});
	});
});

describe('‘Ask for changes’', () => {
	const REPLACE = 'I hate Bulgarian split squats, so replace them';
	const ONLY_THIS_WEEK = 'Only swap the Bulgarian split squats this week, not for good';
	const askingAbout = (id: string): TurnEntry => ({
		from: ASK_FOR_CHANGES,
		ref: { type: 'proposal', id }
	});

	it('drafts the owner’s words as a revision of the proposal its entry names, which it supersedes', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await turn(db, s.owner, REPLACE);
			const [first] = await proposalsOf(db, s.owner);
			const before = (first!.payload as { ops: Record<string, string>[] }).ops[0]!;

			const t = await turn(db, s.owner, ONLY_THIS_WEEK, [], askingAbout(first!.id));
			expect(t.calls.map((c) => [c.name, c.status])).toEqual([
				['propose_program_adjustment', 'succeeded']
			]);
			expect(t.calls[0]!.input).toMatchObject({ revises: first!.id });
			const all = await proposalsOf(db, s.owner);
			expect(all).toHaveLength(2);
			const second = all.find((p) => p.id !== first!.id)!;
			expect(second).toMatchObject({ status: 'proposed', revisionOf: first!.id });
			const swap = (second.payload as { ops: Record<string, string>[] }).ops[0]!;
			expect(swap).toMatchObject({
				op: 'swap',
				scope: 'once',
				plannedExerciseLineage: before.plannedExerciseLineage
			});
			expect(all.find((p) => p.id === first!.id)).toMatchObject({
				status: 'superseded',
				supersededReason: 'revised'
			});
		});
	});
});

describe('create_next_training_cycle', () => {
	it('drafts “Plan my next cycle” at effort high for 40 s, completes, and accepting it changes no program', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const slow = script('next-cycle-draft');
			const delayed = {
				...slow,
				name: 'next-cycle-draft-slow',
				steps: [{ ...slow.steps[0]!, firstDelayMs: CYCLE_DRAFT_MS }]
			};
			const before = await rows(db);
			const t = await turn(db, s.owner, 'Plan my next cycle', [delayed]);
			const call = t.calls.find((c) => c.name === 'create_next_training_cycle')!;
			expect(call).toMatchObject({ status: 'succeeded', errorCode: null });
			expect(call.durationMs).toBeGreaterThanOrEqual(CYCLE_DRAFT_MS);
			expect(call.output).toMatchObject({ awaits: 'cycle_review' });
			expect(t.drafts.map((d) => d.output_config?.effort)).toEqual(['high']);

			const [proposal] = await proposalsOf(db, s.owner);
			const baseline = s.version.blocks.find((b) => b.startsOn <= TODAY && TODAY <= b.endsOn)!;
			expect(proposal).toMatchObject({
				kind: 'next_cycle',
				status: 'proposed',
				programId: s.programId,
				runId: t.runId,
				toolUseId: call.toolUseId
			});
			expect(proposal!.payload).toMatchObject({ fromBlockLineage: baseline.lineage });

			const accepted = await acceptProposal(s.owner, proposal!.id, { db, now: () => NOW });
			expect(accepted.proposal).toMatchObject({ status: 'accepted', appliedVersion: null });
			expect(await rows(db)).toEqual({
				proposals: before.proposals + 1,
				versions: before.versions
			});
		});
	}, 70_000);

	it('briefs the block after the current one, whichever block the draft named', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const [baseline, accumulation] = s.version.blocks;
			const named = script('next-cycle-draft');
			const elsewhere: MockScript = {
				...named,
				name: 'next-cycle-draft-elsewhere',
				steps: [
					{
						json: (context: MockContext) => {
							const drafted = (named.steps[0]!.json as (c: MockContext) => object)(context) as {
								payload: object;
							};
							return {
								...drafted,
								payload: { ...drafted.payload, fromBlockLineage: accumulation!.lineage }
							};
						}
					}
				]
			};
			await turn(db, s.owner, 'Plan my next cycle', [elsewhere]);
			const [proposal] = await proposalsOf(db, s.owner);
			expect(proposal!.payload).toMatchObject({ fromBlockLineage: baseline!.lineage });
		});
	});
});

describe('create_training_program', () => {
	it('is refused while a program is active, storing nothing', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const before = await rows(db);
			const t = await turn(db, s.owner, 'Build me a program');
			expect(t.calls).toMatchObject([
				{ name: 'create_training_program', status: 'failed', errorCode: 'PROGRAM_ACTIVE' }
			]);
			expect(await rows(db)).toEqual(before);
		});
	});

	it('proposes M3’s preview for an onboarded owner, building nothing until accepted', async () => {
		await withRollback(async (db) => {
			const owner = await onboarded(db);
			const t = await turn(db, owner, 'Build me a program');
			const [call] = t.calls;
			expect(call).toMatchObject({ name: 'create_training_program', status: 'succeeded' });
			expect(t.drafts).toEqual([]);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const [proposal] = await proposalsOf(db, owner);
			expect(proposal).toMatchObject({
				kind: 'new_program',
				status: 'proposed',
				programId: null,
				baseVersionId: null,
				runId: t.runId,
				toolUseId: call!.toolUseId
			});
			expect(proposal!.payload).toEqual({
				start: 'next_monday',
				startsOn: preview.startsOn,
				firstPlannedDay: preview.firstPlannedDay,
				fingerprint: preview.fingerprint,
				digest: preview.digest
			});
			expect(call!.output).toMatchObject({
				preview: { title: { untrusted_text: preview.summary.title } }
			});
			expect(await db.select().from(programs).where(eq(programs.ownerId, owner))).toEqual([]);

			const accepted = await acceptProposal(owner, proposal!.id, { db, now: () => NOW });
			expect(accepted.proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 1 } });
		});
	});

	it('is PROFILE_INCOMPLETE before onboarding, storing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const before = await rows(db);
			const t = await turn(db, owner, 'Build me a program');
			expect(t.calls).toMatchObject([{ status: 'failed', errorCode: 'PROFILE_INCOMPLETE' }]);
			expect(await rows(db)).toEqual(before);
		});
	});
});

describe('someone else’s ids', () => {
	it('store nothing: all three tools are NOT_FOUND for a random ownerId', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await turn(db, s.owner, 'Move my intervals to Friday');
			const [own] = await proposalsOf(db, s.owner);
			const foreign: MockScript = {
				name: 'foreign',
				matches: () => true,
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: {
									request: 'Move Intervals to 2026-11-13.',
									sessionLineages: [s.intervals.lineage],
									revises: own!.id
								}
							},
							{ name: 'create_training_program', input: { rationale: 'A fresh start.' } },
							{
								name: 'create_next_training_cycle',
								input: { request: 'Plan the next block.', revises: own!.id }
							}
						]
					},
					{ text: '[note] Nothing found.' }
				]
			};
			const before = await rows(db);
			const { drafts, ready } = drafting([foreign, ...programmingProposalScripts]);
			const played = await runScripted(foreign, {
				db,
				owner: s.owner,
				ownerId: crypto.randomUUID(),
				provider: ready,
				tools: TOOLS
			});
			expect(played.done.status).toBe('completed');
			const calls = await checkedCalls(db, played.runId!);
			expect(calls.map((c) => [c.name, c.errorCode])).toEqual([
				['propose_program_adjustment', 'NOT_FOUND'],
				['create_training_program', 'NOT_FOUND'],
				['create_next_training_cycle', 'NOT_FOUND']
			]);
			expect(drafts).toEqual([]);
			expect(await rows(db)).toEqual(before);
			const open = await db
				.select({ n: count() })
				.from(coachProposals)
				.where(and(eq(coachProposals.id, own!.id), eq(coachProposals.status, 'proposed')));
			expect(open[0]!.n).toBe(1);
		});
	});
});
