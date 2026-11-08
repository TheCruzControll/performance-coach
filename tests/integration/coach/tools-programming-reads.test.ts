/**
 * The coach's programming read tools on real Postgres (the M5 plan's tools-programming-reads):
 * - each output equals the M3 or M5 read the screens use, and validates against its output schema
 * - no program, weeks past the plan, and decisions that carry their why word for word
 * - get_coach_proposals gives the status, the applied version and the owner's reason as
 *   untrusted_text; an unknown id, or someone else's ownerId, is NOT_FOUND
 * - after a rejection, the next turn's context lists the proposal by id (never its note), the
 *   scripted coach reads it by that id and the tool result carries the reason
 * - bad input is INVALID_INPUT, and the tool never runs
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026; the turn is Wednesday.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { buildProgrammingInput, generateProgram } from '../../../src/lib/domain/programming/index';
import { SCENARIOS } from '../../../src/lib/domain/programming/scenarios';
import type { ProgramPlan } from '../../../src/lib/domain/training/types';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import { programmingReadScripts } from '../../../src/lib/server/agent/provider/mock-scripts/programming-reads';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import {
	COACH_PROPOSALS_LIMIT,
	PROGRAMMING_READ_TOOLS,
	SCHEDULE_WEEKS
} from '../../../src/lib/server/agent/tools/programming-reads';
import type { Executor } from '../../../src/lib/server/db';
import { createCoachProposalsRepository } from '../../../src/lib/server/db/repositories/coach-proposals';
import {
	createProposal,
	listDecidedSince,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion,
	getTrainingWeek,
	getVersionHistory,
	skipSession,
	type StoredSession,
	type TrainingWeek
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, segmentIssues, storedRows, TURN_NOW } from './harness';

const MONDAY = '2026-11-09';
const TODAY = addDays(MONDAY, 2);
const MONDAY_MORNING = new Date(`${MONDAY}T08:00:00Z`);
const REASON = 'Fridays are for my kids, keep them free';
const HELLO: MockScript = { name: 'hello', matches: () => true, steps: [{ text: '[note] Hi.' }] };

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = PROGRAMMING_READ_TOOLS as Tools;
const toolNamed = (name: string) => TOOLS.find((tool) => tool.name === name)!;

/** One call of a programming read tool, as a turn runs it, for `ownerId`. */
async function call(db: Executor, ownerId: string, name: string, input: object = {}) {
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: () => new Date(TURN_NOW) }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: 'toolu_01Read', name, input }], ctx, {
		tools: TOOLS
	});
	return outcomes[0]!;
}

/** A successful call's output, checked against the tool's output schema. */
async function output<T = Record<string, unknown>>(
	db: Executor,
	ownerId: string,
	name: string,
	input: object = {}
): Promise<T> {
	const outcome = await call(db, ownerId, name, input);
	expect(outcome.error, name).toBeNull();
	const parsed = z.safeParse(toolNamed(name).outputSchema, outcome.output);
	expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
	return outcome.output as T;
}

async function seed(db: Executor, plan?: ProgramPlan) {
	const owner = await makeOwner(db);
	const program = plan ?? programFixture('hybrid', { monday: MONDAY, today: TODAY });
	const { programId, versionId } = await createProgramFromPlan(
		owner,
		program,
		{ source: 'rules' },
		{ db }
	);
	return { owner, programId, versionId };
}

const sessionsOf = (week: TrainingWeek) =>
	week.planned ? week.days.flatMap((day) => day.sessions) : [];
const text = (value: { untrusted_text: string }) => value.untrusted_text;

interface WeekOut {
	value: {
		planned: boolean;
		number?: number;
		phase: string | null;
		startsOn: string;
		sessions?: { source: { id: string }; status: string; title: { untrusted_text: string } }[];
	};
	sources: unknown[];
}

/** Two proposals on the hybrid week: a move the owner rejects, and a set change applied as v2. */
async function decidedProposals(db: Executor, owner: string, programId: string) {
	const deps = { db, now: () => MONDAY_MORNING };
	const stored = await getProgramVersion(owner, programId, 1, { db });
	const week1 = stored.blocks[0]!.weeks[0]!.sessions;
	const fullBody = week1.find((s) => s.title === 'Full body') as Extract<
		StoredSession,
		{ kind: 'strength' }
	>;
	const intervals = week1.find((s) => s.title === 'Intervals')!;
	const squat = fullBody.exercises.find(
		(e) => 'key' in e.exercise && e.exercise.key === 'back_squat'
	)!;
	const rationale = 'The week is crowded midweek.';
	const move = await createProposal(
		owner,
		{
			proposal: {
				kind: 'program_adjustment',
				title: 'Move intervals to Friday',
				rationale,
				payload: { ops: [{ op: 'move', sessionLineage: intervals.lineage, toDate: '2026-11-13' }] }
			}
		},
		deps
	);
	const sets = await createProposal(
		owner,
		{
			proposal: {
				kind: 'workout_update',
				title: 'Three squat back-off sets',
				rationale,
				payload: {
					ops: [
						{
							op: 'adjust_set',
							sessionLineage: fullBody.lineage,
							plannedExerciseLineage: squat.lineage,
							position: 2,
							sets: 3
						}
					]
				}
			}
		},
		{ db, now: () => new Date(MONDAY_MORNING.getTime() + 1000) }
	);
	return { move: move.proposal, sets: sets.proposal };
}

/** Version 2: a session later this week skipped, with its decision. */
async function skipLater(db: Executor, owner: string) {
	const week = (await getTrainingWeek(owner, { date: TODAY }, {}, { db }))!;
	const later = sessionsOf(week).find((s) => s.date > TODAY)!;
	return skipSession(
		owner,
		{ sessionLineage: later.lineage, reason: 'Travelling' },
		{ version: 1, today: TODAY },
		{ db }
	);
}

describe('get_current_program and get_current_training_week', () => {
	it('equal the program reads Train uses, and validate against their output schemas', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const read = (await getCurrentProgram(owner, TODAY, { db }))!;
			const { program } = await output<{
				program: { value: Record<string, unknown>; sources: unknown[] };
			}>(db, owner, 'get_current_program');
			expect(program.sources).toEqual([{ type: 'version', id: '1', label: 'Version 1' }]);
			expect(program.value).toMatchObject({
				title: { untrusted_text: read.title },
				version: { number: 1, createdBy: read.version.createdBy, current: true },
				startsOn: read.startsOn,
				firstPlannedDay: read.firstPlannedDay,
				lastPlannedDay: read.lastPlannedDay,
				plannedWeeks: 5,
				currentWeek: 1,
				baseline: true,
				notStarted: false,
				blockComplete: false
			});
			expect(program.value.blocks).toEqual(
				read.blocks.map((b) => ({
					name: { untrusted_text: b.name },
					phase: b.phase,
					startsOn: b.startsOn,
					endsOn: b.endsOn,
					outline: b.outline,
					plannedWeeks: b.plannedWeeks,
					goals: b.goalRefs.map((id) => ({ type: 'goal', id }))
				}))
			);

			const thisWeek = (await getTrainingWeek(owner, { date: TODAY }, {}, { db }))!;
			const { week } = await output<{ week: WeekOut }>(db, owner, 'get_current_training_week');
			expect(week.sources).toEqual([{ type: 'version', id: '1', label: 'Version 1' }]);
			expect(week.value).toMatchObject({ planned: true, number: 1, startsOn: MONDAY });
			expect(week.value.sessions!.map((s) => [s.source.id, text(s.title), s.status])).toEqual(
				sessionsOf(thisWeek).map((s) => [s.lineage, s.title, s.status])
			);

			const third = (await getTrainingWeek(owner, { block: 1, week: 3 }, {}, { db }))!;
			const byNumber = await output<{ week: WeekOut }>(db, owner, 'get_current_training_week', {
				week: 3
			});
			expect(byNumber.week.value).toMatchObject({ planned: true, number: 3 });
			expect(byNumber.week.value.sessions!.map((s) => s.source.id)).toEqual(
				sessionsOf(third).map((s) => s.lineage)
			);
		});
	});

	it('give null with no program, and nothing of the owner’s to someone else', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await output(db, owner, 'get_current_program')).toEqual({ program: null });
			expect(await output(db, owner, 'get_current_training_week')).toEqual({ week: null });
			expect(await output(db, owner, 'get_training_schedule')).toEqual({ weeks: [] });
			expect(await output(db, owner, 'get_program_history')).toEqual({
				versions: [],
				more: false,
				next: null
			});
		});
		await withRollback(async (db) => {
			const seeded = await seed(db);
			const stranger = crypto.randomUUID();
			expect(await output(db, stranger, 'get_current_program')).toEqual({ program: null });
			expect(await output(db, stranger, 'get_program_history')).toMatchObject({ versions: [] });
			expect(await output(db, seeded.owner, 'get_current_program')).not.toEqual({ program: null });
		});
	});

	it('say planned: false past the planned weeks, with the outline phase there', async () => {
		await withRollback(async (db) => {
			const hybrid = await seed(db);
			const past = await output<{ week: WeekOut }>(db, hybrid.owner, 'get_current_training_week', {
				week: 6
			});
			expect(past.week.value).toEqual({
				planned: false,
				phase: null,
				startsOn: addDays(MONDAY, 35),
				endsOn: addDays(MONDAY, 41)
			});
		});
		await withRollback(async (db) => {
			const oneWeek = await seed(db, programFixture('one-week', { monday: MONDAY, today: TODAY }));
			const outline = await output<{ week: WeekOut }>(
				db,
				oneWeek.owner,
				'get_current_training_week',
				{ week: 2 }
			);
			expect(outline.week.value).toMatchObject({ planned: false, phase: 'accumulation' });
			const { weeks } = await output<{ weeks: WeekOut[] }>(
				db,
				oneWeek.owner,
				'get_training_schedule',
				{ weeks: SCHEDULE_WEEKS.max }
			);
			expect(weeks.map((w) => [w.value.planned, w.value.phase])).toEqual([
				[true, 'baseline'],
				[false, 'accumulation'],
				[false, 'accumulation'],
				[false, 'accumulation']
			]);
		});
	});
});

describe('get_training_schedule', () => {
	it('reads the weeks from today’s on as getTrainingWeek does, two unless asked', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const reads = [];
			for (let n = 0; n < 3; n += 1)
				reads.push((await getTrainingWeek(owner, { date: addDays(TODAY, 7 * n) }, {}, { db }))!);
			const { weeks } = await output<{ weeks: WeekOut[] }>(db, owner, 'get_training_schedule', {
				weeks: 3
			});
			expect(weeks.map((w) => [w.value.number, w.value.startsOn])).toEqual(
				reads.map((r) => [r.planned && r.number, r.startsOn])
			);
			expect(weeks.map((w) => w.value.sessions!.map((s) => s.source.id))).toEqual(
				reads.map((r) => sessionsOf(r).map((s) => s.lineage))
			);
			const byDefault = await output<{ weeks: WeekOut[] }>(db, owner, 'get_training_schedule');
			expect(byDefault.weeks).toHaveLength(SCHEDULE_WEEKS.default);
		});
	});
});

describe('get_program_history', () => {
	it('lists every version newest first, each decision with its why exactly as stored', async () => {
		await withRollback(async (db) => {
			const plan = programFixture('hybrid', { monday: MONDAY, today: TODAY });
			// A why longer than the usual untrusted_text cap: it is never shortened.
			const longWhy = `${'Every set builds on the last one. '.repeat(29)}So it stays.`;
			expect(longWhy.length).toBeGreaterThan(900);
			plan.decisions[1] = { ...plan.decisions[1]!, why: longWhy };
			const { owner } = await seed(db, plan);
			await skipLater(db, owner);
			const read = (await getVersionHistory(owner, {}, { db }))!;
			const out = await output<{
				versions: {
					number: number;
					source: unknown;
					decisions: {
						source: { type: string; id: string };
						kind: string;
						why: { untrusted_text: string; truncated?: true };
						summary: { untrusted_text: string };
					}[];
				}[];
				more: boolean;
				next: unknown;
			}>(db, owner, 'get_program_history');

			expect(out.versions.map((v) => v.number)).toEqual([2, 1]);
			expect(out.versions[0]!.source).toEqual({ type: 'version', id: '2', label: 'Version 2' });
			expect(out).toMatchObject({ more: false, next: null });
			const decisions = out.versions.flatMap((v) => v.decisions);
			expect(decisions.map((d) => [d.source, d.kind, d.why, d.summary])).toEqual(
				read.versions
					.flatMap((v) => v.decisions)
					.map((d) => [
						{ type: 'decision', id: d.id },
						d.kind,
						{ untrusted_text: d.why },
						{ untrusted_text: d.summary }
					])
			);
			expect(decisions.map((d) => d.why.untrusted_text)).toContain(longWhy);
			expect(decisions.every((d) => d.why.untrusted_text.length > 0)).toBe(true);
		});
	});

	it('pages a generated program’s decisions within the output cap, every why word for word', async () => {
		await withRollback(async (db) => {
			const input = buildProgrammingInput(SCENARIOS.minimal(), { catalogue: CATALOGUE });
			const plan = generateProgram(input, { startsOn: MONDAY, firstPlannedDay: MONDAY });
			const { owner } = await seed(db, plan);
			await skipLater(db, owner);
			const read = (await getVersionHistory(owner, {}, { db }))!;
			const stored = read.versions.flatMap((v) => v.decisions.map((d) => [v.number, d.id, d.why]));
			const seen: unknown[] = [];
			let from: object | undefined;
			let pages = 0;
			do {
				const outcome = await call(db, owner, 'get_program_history', from && { from });
				expect(outcome.error).toBeNull();
				expect(outcome.truncated).toBe(false);
				const page = outcome.output as {
					versions: {
						number: number;
						decisions: { source: { id: string }; why: { untrusted_text: string } }[];
					}[];
					more: boolean;
					next: { version: number; decision: number } | null;
				};
				for (const v of page.versions)
					for (const d of v.decisions) seen.push([v.number, d.source.id, d.why.untrusted_text]);
				expect(page.more).toBe(page.next !== null);
				from = page.next ?? undefined;
				pages += 1;
			} while (from && pages < 20);
			expect(pages).toBeGreaterThan(1);
			expect(seen).toEqual(stored);
		});
	});
});

describe('get_coach_proposals', () => {
	it('gives each proposal’s status, applied version and the owner’s reason as untrusted_text', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await seed(db);
			const { move, sets } = await decidedProposals(db, owner, programId);
			const decidedAt = new Date(`${TODAY}T07:00:00Z`);
			await rejectProposal(owner, move.id, { reason: REASON }, { db, now: () => decidedAt });
			// The set change lands as version 2 (its applier is another slice's), recorded as applied.
			const v2 = await skipLater(db, owner);
			await createCoachProposalsRepository(db).decide(owner, sets.id, {
				status: 'applied',
				appliedVersionId: v2.versionId,
				closedAt: decidedAt,
				updatedAt: decidedAt
			});

			const all = await output<{ items: Record<string, unknown>[]; more: boolean }>(
				db,
				owner,
				'get_coach_proposals'
			);
			expect(all.more).toBe(false);
			expect(all.items).toEqual([
				{
					source: { type: 'proposal', id: sets.id },
					kind: 'workout_update',
					title: { untrusted_text: 'Three squat back-off sets' },
					status: 'applied',
					summaryLines: sets.summaryLines.map((line) => ({ untrusted_text: line })),
					appliedVersion: 2,
					supersededReason: null,
					createdAt: sets.createdAt.toISOString(),
					decidedAt: decidedAt.toISOString(),
					decisionNote: null
				},
				{
					source: { type: 'proposal', id: move.id },
					kind: 'program_adjustment',
					title: { untrusted_text: 'Move intervals to Friday' },
					status: 'rejected',
					summaryLines: move.summaryLines.map((line) => ({ untrusted_text: line })),
					appliedVersion: null,
					supersededReason: null,
					createdAt: move.createdAt.toISOString(),
					decidedAt: decidedAt.toISOString(),
					decisionNote: { untrusted_text: REASON }
				}
			]);

			const byId = await output<{ items: { source: { id: string } }[] }>(
				db,
				owner,
				'get_coach_proposals',
				{ ids: [move.id.toUpperCase()] }
			);
			expect(byId.items.map((p) => p.source.id)).toEqual([move.id]);
			const rejected = await output<{ items: { status: string }[] }>(
				db,
				owner,
				'get_coach_proposals',
				{ status: 'rejected' }
			);
			expect(rejected.items.map((p) => p.status)).toEqual(['rejected']);
			const notApplied = await output(db, owner, 'get_coach_proposals', {
				ids: [move.id],
				status: 'applied'
			});
			expect(notApplied).toEqual({ items: [], more: false });
			const one = await output(db, owner, 'get_coach_proposals', { limit: 1 });
			expect(one).toMatchObject({ items: [{ status: 'applied' }], more: true });
		});
	});

	it('answers an unknown id, or the owner’s id under someone else’s ownerId, with NOT_FOUND', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await seed(db);
			const { move } = await decidedProposals(db, owner, programId);
			const unknown = crypto.randomUUID();
			const missing = await call(db, owner, 'get_coach_proposals', { ids: [move.id, unknown] });
			expect(missing).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
			expect(JSON.parse(missing.content)).toMatchObject({ error: 'NOT_FOUND', ids: [unknown] });

			const stranger = crypto.randomUUID();
			const foreign = await call(db, stranger, 'get_coach_proposals', { ids: [move.id] });
			expect(foreign).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
			expect(foreign.content).not.toContain('Move intervals');
			expect(await output(db, stranger, 'get_coach_proposals')).toEqual({
				items: [],
				more: false
			});
		});
	});
});

describe('listDecidedSince', () => {
	it('lists a proposal rejected since the last turn, however many newer ones exist', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const repo = createCoachProposalsRepository(db);
			const ids: string[] = [];
			for (let n = 0; n < 51; n += 1) {
				ids.push(
					await repo.insertProposal({
						ownerId: owner,
						kind: 'program_adjustment',
						title: `Proposal ${n}`,
						summary: 'A change',
						rationale: 'A reason',
						payload: {},
						createdAt: new Date(MONDAY_MORNING.getTime() + n * 1000)
					})
				);
			}
			const since = new Date(`${TODAY}T09:00:00Z`);
			const oldest = ids[0]!;
			await rejectProposal(
				owner,
				oldest,
				{ reason: REASON },
				{ db, now: () => new Date(since.getTime() + 60_000) }
			);
			expect(await listDecidedSince(owner, since, { db })).toEqual([
				{ id: oldest, kind: 'program_adjustment', status: 'rejected' }
			]);
			expect(await listDecidedSince(crypto.randomUUID(), since, { db })).toEqual([]);
		});
	});
});

describe('bad input', () => {
	it('is INVALID_INPUT with the field at fault, and the tool never runs', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const cases: [string, object, string][] = [
				['get_coach_proposals', { ids: ['not-a-uuid'] }, 'ids.0'],
				['get_coach_proposals', { limit: COACH_PROPOSALS_LIMIT.max + 1 }, 'limit'],
				[
					'get_coach_proposals',
					{ ids: Array.from({ length: COACH_PROPOSALS_LIMIT.max + 1 }, () => crypto.randomUUID()) },
					'ids'
				],
				['get_coach_proposals', { status: 'pending' }, 'status'],
				['get_current_training_week', { week: 0 }, 'week'],
				['get_training_schedule', { weeks: SCHEDULE_WEEKS.max + 1 }, 'weeks'],
				['get_program_history', { from: { version: 0, decision: 0 } }, 'from.version']
			];
			for (const [name, input, field] of cases) {
				const outcome = await call(db, owner, name, input);
				expect(outcome, `${name} ${JSON.stringify(input)}`).toMatchObject({
					status: 'invalid_input',
					error: { code: 'INVALID_INPUT' }
				});
				expect(Object.keys(JSON.parse(outcome.content).issues)).toContain(field);
			}
		});
	});
});

describe('scripted turns', () => {
	const script = (name: string) => programmingReadScripts.find((s) => s.name === name)!;

	it('after a rejection, reads the proposal by the id the turn context lists, and hears the reason', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await seed(db);
			const { move } = await decidedProposals(db, owner, programId);
			const first = await runScripted(script('after-rejection'), {
				db,
				owner,
				text: 'Hello, what is planned?',
				provider: {
					status: 'ready',
					provider: new MockProvider([HELLO], { overrides: () => ({}) })
				}
			});
			const at = new Date(TURN_NOW).getTime();
			await rejectProposal(
				owner,
				move.id,
				{ reason: REASON },
				{ db, now: () => new Date(at + 60_000) }
			);
			const turn = await runScripted(script('after-rejection'), {
				db,
				owner,
				threadId: first.threadId,
				text: 'I rejected that change you suggested.',
				now: () => new Date(at + 120_000)
			});
			expect(turn.done.status).toBe('completed');

			const rows = (await storedRows(db, first.threadId!)).slice(-5);
			expect(rows.map((r) => r.kind)).toEqual([
				'owner_message',
				'context',
				'assistant',
				'tool_results',
				'assistant'
			]);
			const [, context, toolUse, results, answer] = rows;
			// The context names the decision by id, kind and status; the reason never reaches it.
			expect(context!.content).toContain(
				`"decidedProposals":[{"id":"${move.id}","kind":"program_adjustment","status":"rejected"}]`
			);
			expect(JSON.stringify(context!.content)).not.toContain('Fridays');
			expect(toolUse!.content).toContainEqual(
				expect.objectContaining({
					type: 'tool_use',
					name: 'get_coach_proposals',
					input: { ids: [move.id] }
				})
			);
			const result = (results!.content as { content: string; is_error?: boolean }[])[0]!;
			expect(result.is_error).toBeUndefined();
			expect(JSON.parse(result.content).items[0]).toMatchObject({
				source: { type: 'proposal', id: move.id },
				status: 'rejected',
				decisionNote: { untrusted_text: REASON }
			});
			expect(JSON.stringify(answer!.content)).toContain(REASON);
			expect(await segmentIssues(db, owner, first.threadId!)).toEqual([]);
		});
	});

	it('answers ‘Why am I doing this exercise?’ with the newest decision’s why, word for word', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const turn = await runScripted(script('why-this-exercise'), {
				db,
				owner,
				text: 'Why am I doing this exercise?'
			});
			expect(turn.done.status).toBe('completed');
			const read = (await getVersionHistory(owner, {}, { db }))!;
			const newest = read.versions[0]!.decisions[0]!;
			const rows = await storedRows(db, turn.threadId!);
			const answer = JSON.stringify(rows.at(-1)!.content);
			expect(answer).toContain(JSON.stringify(newest.why).slice(1, -1));
			expect(answer).toContain(`[[decision:${newest.id}|`);
			const results = rows.find((r) => r.kind === 'tool_results')!.content as {
				is_error?: boolean;
			}[];
			expect(results).toHaveLength(2);
			expect(results.every((r) => r.is_error === undefined)).toBe(true);
		});
	});
});
