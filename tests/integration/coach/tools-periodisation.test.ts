/**
 * The coach's periodisation reads on real Postgres (M7's tools-periodisation-reads), on the
 * periodisation-week fixture at the turn's Wednesday 11 November 2026: next week the owner moved
 * Lower A to Monday, the day before Tuesday's hard Muay Thai class.
 * - outputs validate against their schemas; the score is a metric with its method, and the
 *   owner's move is one avoid finding citing its sessions and the owner's decision, by id
 * - every evaluation is judged 'full' with no evaluation-context error recorded: the owner is
 *   profiled, so the context's reads ran, and a degraded context cannot pass
 * - a what-if move returns its finding and writes no row
 * - a what-if re-models the load, so the moved session's load lands on its new day
 * - suggestedRepair moves Lower A back with one move op, which propose_program_adjustment stores
 *   byte for byte (canonical JSON) without a draft: no structured-output call, and checkProposal
 *   still ran (a move into the past is refused, storing nothing)
 * - with a hard session on the Sunday before the week, every finding the suggested repair clears
 *   is one the week shows: the Sunday's load is counted once, in the repair's model too
 * - propose_program_adjustment's ops take moves and adds only: a skip in ops is INVALID_INPUT,
 *   storing nothing
 * - explain_schedule_tradeoffs: the goal's priority as a metric, the decisions with their ids,
 *   the owner's first, the kept clash and the road; for one session, only its decisions
 * - the scripted answers' [metric] and [fact] blocks are grounded, and the chips read as listed
 * - a random ownerId given the seeded owner's lineages is NOT_FOUND and reads nothing of theirs
 * - on an M7-built multiGoal program both outputs stay under the 8 KB cap, untruncated
 * - plan_block, schedule_deload and plan_taper each store exactly one replan proposal naming the
 *   coach's thread, run and tool call, and answer with its card (at most 12 rows, under the cap);
 *   a refusal is a REFUSED tool error with the engine's sentence and stores nothing; another
 *   owner's program and goals are never read; no evaluation-context error is recorded
 * - the scripted turns for those tools propose through them, with their chips, and the refused one
 *   is recorded as a failed call
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { TURN_LIMITS } from '../../../src/lib/domain/coach/budgets';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { canonicalJson, programOpSchema } from '../../../src/lib/domain/coach/proposals';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import type { TrainingProfile } from '../../../src/lib/domain/profile/types';
import { generateProgram } from '../../../src/lib/domain/programming/generate';
import { buildProgrammingInput } from '../../../src/lib/domain/programming/input';
import { M7_SCENARIOS } from '../../../src/lib/domain/programming/periodisation/scenarios';
import { GENERATOR_ID } from '../../../src/lib/domain/programming/random';
import { SCENARIO_START } from '../../../src/lib/domain/programming/scenarios';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import { periodisationScripts } from '../../../src/lib/server/agent/provider/mock-scripts/periodisation';
import type { LlmProvider } from '../../../src/lib/server/agent/provider/types';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import {
	LOAD_METHOD,
	PLAN_BLOCK_WEEKS,
	PRIORITY_METHOD,
	SCORE_METHOD
} from '../../../src/lib/server/agent/tools/periodisation';
import { COACH_TOOLS } from '../../../src/lib/server/agent/tools/registry';
import {
	agentRuns,
	agentToolCalls,
	coachProposals,
	type Executor
} from '../../../src/lib/server/db';
import { createAppErrorsRepository } from '../../../src/lib/server/db/repositories/app-errors';
import { plannedSessionDetails } from '../../../src/lib/server/db/schema/prescriptions';
import { plannedSessions, programVersions } from '../../../src/lib/server/db/schema/programs';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	createGoal,
	saveExperience,
	saveSchedule
} from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { PeriodisationWeekResult } from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';
import { runScripted, TURN_NOW } from './harness';

const TODAY = '2026-11-11';
const NOW = new Date(TURN_NOW);

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = COACH_TOOLS as Tools;
const toolNamed = (name: string) => TOOLS.find((tool) => tool.name === name)!;

interface Ref {
	type: string;
	id: string;
}
interface Evaluated {
	week: { startsOn: string; kind: string };
	checked: string;
	score: { value: number; method: string; sources: Ref[] };
	grade: string;
	whatIf: { session: string; from: string; toDate: string }[];
	findings: {
		rule: string;
		headline: string;
		severity: string;
		resolution: { kind: string } | null;
		sources: Ref[];
	}[];
	loads: {
		system: string;
		worst: string;
		load: { value: number; unit: string; method: string };
	}[];
	suggestedRepair: {
		ops: { op: string; sessionLineage: string; toDate: string }[];
		clears: { rule: string; headline: string }[];
	} | null;
	truncated?: true;
}
interface Explained {
	priorities: { goal: Ref; mode: string; weight: { value: number; method: string } }[];
	decisions: {
		value: { source: Ref; kind: string; decidedBy: string; version: number };
		sources: Ref[];
	}[];
	doses: Ref[];
	keptConflicts: { rule: string; sources: Ref[] }[];
	road: { value: { untrusted_text: string } } | null;
	session: Ref | null;
	truncated?: true;
}

async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		'periodisation-week',
		{ timeZone: 'UTC', now: NOW },
		{ db }
	)) as unknown as PeriodisationWeekResult;
	return { owner, seeded };
}

/**
 * A hard session the owner plans on `date`, in the evening after the week's easy run: Muay Thai
 * sparring at 45 minutes and RPE 8, written as the generator writes one, in the week it is in.
 * Returns its lineage.
 */
async function planSparring(db: Executor, date: IsoDate) {
	const [run] = await db
		.select({ weekId: plannedSessions.weekId })
		.from(plannedSessions)
		.where(eq(plannedSessions.scheduledOn, date));
	const [row] = await db
		.insert(plannedSessions)
		.values({
			weekId: run!.weekId,
			scheduledOn: date,
			timeOfDay: 'evening',
			orderInDay: 2,
			discipline: 'muay_thai',
			sessionType: 'muay_thai',
			title: 'Sparring',
			estMinutes: 45,
			estLoad: 360,
			intensity: 'hard',
			targetRpe: 8,
			source: 'generator'
		})
		.returning({ id: plannedSessions.id, lineageId: plannedSessions.lineageId });
	await db.insert(plannedSessionDetails).values({
		sessionId: row!.id,
		kind: 'sparring',
		durationMinutes: 45,
		targetRpe: 8
	});
	return row!.lineageId;
}

/** The ids of the evaluation-context errors recorded so far (the context's failures, app_errors). */
async function contextErrorIds(db: Executor) {
	const recent = await createAppErrorsRepository(db).recent(200);
	return recent.flatMap((e) => (e.context?.part === 'evaluation-context' ? [e.id] : []));
}

/** Fails when an evaluation context failed since `before` (a turn judged its weeks degraded). */
async function expectNoContextErrors(db: Executor, before: number[]) {
	const failed = (await contextErrorIds(db)).filter((id) => !before.includes(id));
	expect(failed, 'evaluation-context errors').toEqual([]);
}

/**
 * One call of a tool, as a turn runs it, for `ownerId`. Any evaluation context that fails while
 * the call runs is a test failure: a week judged on a degraded context must not pass.
 */
async function call(db: Executor, ownerId: string, name: string, input: object = {}) {
	const before = await contextErrorIds(db);
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: () => NOW }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: 'toolu_01Engine', name, input }], ctx, {
		tools: TOOLS
	});
	const failed = (await contextErrorIds(db)).filter((id) => !before.includes(id));
	expect(failed, `${name}: evaluation-context errors`).toEqual([]);
	return outcomes[0]!;
}

/** A successful call's output, checked against the tool's output schema. */
async function output<T>(db: Executor, ownerId: string, name: string, input: object = {}) {
	const outcome = await call(db, ownerId, name, input);
	expect(outcome.error, name).toBeNull();
	const parsed = z.safeParse(toolNamed(name).outputSchema, outcome.output);
	expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
	return outcome.output as T;
}

/** What a turn could change: every program version and proposal. */
async function rows(db: Executor) {
	const n = async (table: typeof coachProposals | typeof programVersions) =>
		(await db.select({ n: count() }).from(table))[0]!.n;
	return { proposals: await n(coachProposals), versions: await n(programVersions) };
}

/** A MockProvider over `scripts` that counts the structured-output (draft) calls it is sent. */
function counting(scripts: readonly MockScript[]) {
	const mock = new MockProvider(scripts, { overrides: () => ({}) });
	const structured: unknown[] = [];
	const provider: LlmProvider = {
		name: mock.name,
		model: mock.model,
		stream: (request, signal) => mock.stream(request, signal),
		structured: (request, schema, signal) => {
			structured.push(request);
			return mock.structured(request, schema, signal);
		},
		countTokens: (request, signal) => mock.countTokens(request, signal)
	};
	return { structured, ready: { status: 'ready' as const, provider } };
}

const script = (name: string) => periodisationScripts.find((s) => s.name === name)!;
const blocksOf = (events: CoachEvent[]) =>
	events.flatMap((e) => (e.type === 'block_completed' || e.type === 'block_replaced' ? [e] : []));
const chips = (events: CoachEvent[], state: string) =>
	events.flatMap((e) => (e.type === 'activity' && e.state === state ? [e.label] : []));

describe('evaluate_week_interference', () => {
	it('judges the owner’s move as one avoid finding, scored with its method, citing the sessions', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', { week: 'next' });
			expect(r.week).toMatchObject({ startsOn: seeded.mondays.moved, kind: 'accumulation' });
			expect(r.checked).toBe('full');
			expect(r.score.method).toBe(SCORE_METHOD);
			expect(r.score.value).toBeLessThan(100);
			const avoid = r.findings.filter((f) => f.severity === 'avoid');
			expect(avoid).toHaveLength(1);
			expect(avoid[0]).toMatchObject({
				rule: 'placement.heavy_lower_before_hard',
				resolution: { kind: 'owner_moved' }
			});
			const ids = avoid[0]!.sources.map((s) => `${s.type}:${s.id}`);
			expect(ids).toEqual(
				expect.arrayContaining([
					`session:${seeded.lineages.moved}`,
					`session:${seeded.lineages.hardMuayThai}`
				])
			);
			expect(r.loads.map((l) => l.system)).toEqual(['lower', 'upper', 'aerobic', 'combat', 'cns']);
			for (const { load } of r.loads)
				expect(load).toMatchObject({ unit: 'AU', method: LOAD_METHOD });
			expect(r.loads.find((l) => l.system === 'lower')!.load.value).toBeGreaterThan(0);
		});
	});

	it('suggests the scheduler’s repair of the owner’s move as one move op of a session still ahead', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', { week: 'next' });
			expect(r.suggestedRepair).not.toBeNull();
			const [op, ...rest] = r.suggestedRepair!.ops;
			expect(rest).toEqual([]);
			expect(op).toMatchObject({ op: 'move', sessionLineage: seeded.lineages.moved });
			expect(op!.toDate > TODAY).toBe(true);
			expect(op!.toDate).not.toBe(seeded.mondays.moved);
			expect(z.safeParse(programOpSchema, op).success).toBe(true);
			expect(r.suggestedRepair!.clears.map((c) => c.rule)).toContain(
				'placement.heavy_lower_before_hard'
			);
			// This week breaks nothing ahead: nothing to suggest.
			const now = await output<Evaluated>(db, owner, 'evaluate_week_interference', {});
			expect(now.suggestedRepair).toBeNull();
		});
	});

	it('clears only findings the week itself shows, with a hard session on the Sunday before it', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			// The Sunday before next week. At 45 minutes of RPE 8 the week's own load shows no residual
			// fatigue, but counted twice, as the repair's load model would count it, it does: the repair
			// would then clear a finding the week does not show.
			await planSparring(db, addDays(seeded.mondays.moved, -1));
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', { week: 'next' });
			const clears = r.suggestedRepair?.clears ?? [];
			expect(clears.length).toBeGreaterThan(0);
			for (const clear of clears) {
				expect(
					r.findings.some((f) => f.rule === clear.rule && f.headline === clear.headline),
					`${clear.rule}: ${clear.headline}`
				).toBe(true);
			}
		});
	});

	it('judges a what-if move in memory, returning its finding, and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const before = await getProgramVersion(owner, program.id, program.version.number, { db });
			const clean = before.blocks[0]!.weeks.find((w) => w.startsOn === seeded.mondays.clean)!;
			const lowerA = clean.sessions.find((s) => s.title === 'Lower A')!;
			const wednesday = addDays(seeded.mondays.clean, 2);
			const counted = await rows(db);

			const plain = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: seeded.mondays.clean
			});
			expect(plain.checked).toBe('full');
			expect(plain.findings.filter((f) => f.severity === 'avoid')).toEqual([]);
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: seeded.mondays.clean,
				moves: [{ session: lowerA.lineage, toDate: wednesday }]
			});
			expect(r.whatIf).toEqual([{ session: lowerA.lineage, from: lowerA.date, toDate: wednesday }]);
			const found = r.findings.find((f) => f.rule === 'placement.heavy_lower_before_hard');
			expect(found, 'the what-if’s clash').toBeDefined();
			expect(found!.sources.map((s) => s.id)).toContain(lowerA.lineage);
			expect(r.score.value).toBeLessThan(plain.score.value);

			expect(await rows(db)).toEqual(counted);
			const after = await getProgramVersion(owner, program.id, program.version.number, { db });
			expect(after).toEqual(before);
		});
	});

	it('re-models the load for a what-if move, so the moved session’s load lands on its new day', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const version = await getProgramVersion(owner, program.id, program.version.number, { db });
			const clean = version.blocks[0]!.weeks.find((w) => w.startsOn === seeded.mondays.clean)!;
			const [tuesday, thursday] = clean.sessions.filter((s) => s.title === 'Muay Thai class');
			const combat = (r: Evaluated) => r.loads.find((l) => l.system === 'combat')!.worst;

			const plain = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: seeded.mondays.clean
			});
			expect(combat(plain)).toBe('elevated');
			// Both hard classes on Thursday: combat carries two classes' fatigue that day.
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: seeded.mondays.clean,
				moves: [{ session: tuesday!.lineage, toDate: thursday!.date }]
			});
			expect(combat(r)).toBe('overloaded');
		});
	});

	it('cites the stored decisions that explain a finding, by the ids explain_schedule_tradeoffs gives', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const r = await output<Evaluated>(db, owner, 'evaluate_week_interference', { week: 'next' });
			const [avoid] = r.findings.filter((f) => f.severity === 'avoid');
			const cited = avoid!.sources.filter((s) => s.type === 'decision');
			expect(cited.length).toBeGreaterThan(0);
			// Each cited decision is one explain_schedule_tradeoffs lists, by the same id.
			const why = await output<Explained>(db, owner, 'explain_schedule_tradeoffs', {
				week: 'next'
			});
			const listed = why.decisions.map((d) => d.value.source);
			for (const source of cited) expect(listed).toContainEqual(source);
			// The owner's move is among them: it is the decision that put Lower A where it is.
			const ownerMove = why.decisions.find((d) => d.value.decidedBy === 'owner')!;
			expect(cited).toContainEqual(ownerMove.value.source);
		});
	});

	it('refuses a what-if of a session that is not this week’s, or to a day outside it', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const elsewhere = await call(db, owner, 'evaluate_week_interference', {
				week: 'current',
				moves: [{ session: seeded.lineages.moved, toDate: TODAY }]
			});
			expect(elsewhere.error).toMatchObject({ code: 'NOT_FOUND' });
			const outside = await call(db, owner, 'evaluate_week_interference', {
				week: 'next',
				moves: [{ session: seeded.lineages.moved, toDate: addDays(seeded.mondays.moved, 7) }]
			});
			expect(outside.error).toMatchObject({ code: 'INVALID_INPUT' });
		});
	});
});

describe('propose_program_adjustment with ops', () => {
	it('stores the suggested repair byte for byte, with no draft, through checkProposal', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const before = await rows(db);
			const evaluated = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: 'next'
			});
			const ops = evaluated.suggestedRepair!.ops;
			const adopt: MockScript = {
				name: 'adopt-repair',
				matches: () => true,
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: { request: 'Move Lower A back before the hard class.', ops }
							}
						]
					},
					{ text: '[note] I have proposed moving Lower A back.' }
				]
			};
			const { structured, ready } = counting([adopt]);
			const turn = await runScripted(adopt, {
				db,
				owner,
				text: 'Fix next week for me',
				provider: ready,
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await db
				.select()
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, turn.runId!))
				.orderBy(agentToolCalls.callIndex);
			expect(calls.map((c) => [c.name, c.status])).toEqual([
				['propose_program_adjustment', 'succeeded']
			]);
			const [proposal] = await db
				.select()
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, owner));
			expect(proposal).toMatchObject({ kind: 'program_adjustment', status: 'proposed' });
			expect(canonicalJson((proposal!.payload as { ops: unknown }).ops)).toBe(canonicalJson(ops));
			expect(proposal!.title).toMatch(/^Move Lower A to /);
			expect(structured).toEqual([]);
			expect(await rows(db)).toEqual({ ...before, proposals: before.proposals + 1 });
		});
	});

	it('refuses ops that move a session into the past, storing nothing and drafting nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const before = await rows(db);
			const past: MockScript = {
				name: 'past-move',
				matches: () => true,
				steps: [
					{
						tools: [
							{
								name: 'propose_program_adjustment',
								input: {
									request: 'Move Lower A to last Monday.',
									ops: [
										{
											op: 'move',
											sessionLineage: seeded.lineages.moved,
											toDate: seeded.mondays.current
										}
									]
								}
							}
						]
					},
					{ text: '[note] That move is not possible.' }
				]
			};
			const { structured, ready } = counting([past]);
			const turn = await runScripted(past, {
				db,
				owner,
				text: 'Move it back',
				provider: ready,
				tools: TOOLS
			});
			const [refused] = await db
				.select()
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, turn.runId!));
			expect(refused).toMatchObject({ status: 'failed', errorCode: 'REFUSED' });
			expect(structured).toEqual([]);
			expect(await rows(db)).toEqual(before);
		});
	});

	it('refuses an op that is not a move at the input, storing nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const before = await rows(db);
			const skip = await call(db, owner, 'propose_program_adjustment', {
				request: 'Skip Lower A next week.',
				ops: [{ op: 'skip', sessionLineage: seeded.lineages.moved }]
			});
			expect(skip.error).toMatchObject({ code: 'INVALID_INPUT' });
			expect(await rows(db)).toEqual(before);
		});
	});
});

describe('explain_schedule_tradeoffs', () => {
	it('gives the goal’s priority as a metric, the decisions with their ids, the owner’s first, the kept clash and the road', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const r = await output<Explained>(db, owner, 'explain_schedule_tradeoffs', { week: 'next' });
			expect(r.priorities).toHaveLength(1);
			expect(r.priorities[0]).toMatchObject({
				mode: 'primary',
				weight: { value: 1, method: PRIORITY_METHOD }
			});
			const kinds = r.decisions.map((d) => d.value.kind);
			expect(kinds[0]).toBe('session_moved');
			expect(r.decisions[0]!.value.decidedBy).toBe('owner');
			expect(kinds).toEqual(expect.arrayContaining(['commitment_placed', 'interference_resolved']));
			for (const d of r.decisions) {
				expect(d.value.source).toEqual({ type: 'decision', id: expect.stringMatching(/^\d+$/) });
				expect(d.sources).toContainEqual(d.value.source);
			}
			expect(r.keptConflicts.map((k) => k.rule)).toEqual(['placement.heavy_lower_before_hard']);
			expect(r.road?.value.untrusted_text).toMatch(/^Now: /);
			expect(r.session).toBeNull();

			const one = await output<Explained>(db, owner, 'explain_schedule_tradeoffs', {
				session: seeded.lineages.hardMuayThai
			});
			expect(one.session).toMatchObject({ type: 'session', id: seeded.lineages.hardMuayThai });
			expect(one.decisions.map((d) => d.value.kind)).toEqual(['commitment_placed']);
		});
	});
});

describe('scripted turns', () => {
	it('the week-repair script proposes the engine’s repair exactly as computed, with three model calls and no draft', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const before = await rows(db);
			const errors = await contextErrorIds(db);
			const { structured, ready } = counting(periodisationScripts);
			const turn = await runScripted(script('week-repair'), {
				db,
				owner,
				text: 'Fix next week for me',
				provider: ready,
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await db
				.select()
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, turn.runId!))
				.orderBy(agentToolCalls.callIndex);
			expect(calls.map((c) => [c.name, c.status])).toEqual([
				['evaluate_week_interference', 'succeeded'],
				['propose_program_adjustment', 'succeeded']
			]);
			const evaluated = calls[0]!.output as unknown as Evaluated;
			const [proposal] = await db
				.select()
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, owner));
			expect(proposal).toMatchObject({ kind: 'program_adjustment', status: 'proposed' });
			expect(canonicalJson((proposal!.payload as { ops: unknown }).ops)).toBe(
				canonicalJson(evaluated.suggestedRepair!.ops)
			);
			expect(proposal!.title).toMatch(/^Move Lower A to /);
			expect(structured).toEqual([]);
			const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, turn.runId!));
			expect(run!.modelCalls).toBe(3);
			expect(await rows(db)).toEqual({ ...before, proposals: before.proposals + 1 });
			await expectNoContextErrors(db, errors);
		});
	});

	it('answer ‘Does next week clash?’ with grounded metrics and facts, under the listed chips', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const errors = await contextErrorIds(db);
			const turn = await runScripted(script('week-clash'), {
				db,
				owner,
				text: 'Does next week clash with anything?',
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const blocks = blocksOf(turn.events);
			expect(blocks.every((b) => b.type === 'block_completed')).toBe(true);
			const checked = blocks.filter((b) => b.kind === 'metric' || b.kind === 'fact');
			expect(checked.map((b) => b.kind)).toEqual(['metric', 'fact', 'metric']);
			expect(checked.every((b) => b.grounded)).toBe(true);
			expect(checked[0]!.method).toBe(SCORE_METHOD);
			expect(blocks.some((b) => b.kind === 'recommendation')).toBe(true);
			expect(chips(turn.events, 'running')).toEqual(['Checking this week’s schedule…']);
			expect(chips(turn.events, 'done')).toEqual(['Checked this week’s schedule']);
			await expectNoContextErrors(db, errors);
		});
	});

	it('answer ‘Why is my week shaped like this?’ quoting the decisions, every block grounded', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const errors = await contextErrorIds(db);
			const turn = await runScripted(script('week-shape'), {
				db,
				owner,
				text: 'Why is next week shaped like this?',
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const blocks = blocksOf(turn.events);
			expect(blocks.every((b) => b.type === 'block_completed')).toBe(true);
			const checked = blocks.filter((b) => b.kind === 'metric' || b.kind === 'fact');
			expect(checked[0]).toMatchObject({ kind: 'metric', method: PRIORITY_METHOD });
			expect(checked.filter((b) => b.kind === 'fact').length).toBeGreaterThanOrEqual(2);
			expect(checked.every((b) => b.grounded)).toBe(true);
			expect(chips(turn.events, 'running')).toEqual([
				'Looking at why your week is shaped this way…'
			]);
			await expectNoContextErrors(db, errors);
		});
	});
});

describe('owner scoping', () => {
	it('a random ownerId given the seeded owner’s lineages is NOT_FOUND and reads nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const stranger = crypto.randomUUID();
			const outcome = await call(db, stranger, 'evaluate_week_interference', {
				week: 'next',
				moves: [{ session: seeded.lineages.moved, toDate: addDays(seeded.mondays.moved, 2) }]
			});
			expect(outcome.error).toMatchObject({ code: 'NOT_FOUND' });
			expect(JSON.stringify(outcome)).not.toContain('Lower A');
			// The same call for the owner does read the week.
			expect(
				(
					await call(db, owner, 'evaluate_week_interference', {
						week: 'next',
						moves: [{ session: seeded.lineages.moved, toDate: addDays(seeded.mondays.moved, 2) }]
					})
				).error
			).toBeNull();
		});
	});

	it('a random ownerId given the seeded owner’s lineage is NOT_FOUND for explain_schedule_tradeoffs and reads nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const stranger = crypto.randomUUID();
			const outcome = await call(db, stranger, 'explain_schedule_tradeoffs', {
				session: seeded.lineages.moved
			});
			expect(outcome.error).toMatchObject({ code: 'NOT_FOUND' });
			expect(JSON.stringify(outcome)).not.toContain('Lower A');
			// The same call for the owner does read the session's week.
			expect(
				(await call(db, owner, 'explain_schedule_tradeoffs', { session: seeded.lineages.moved }))
					.error
			).toBeNull();
		});
	});
});

/** `profile`'s goals (in rank order), schedule and experience, saved through M2's services. */
async function saveProfile(db: Executor, owner: string, profile: TrainingProfile) {
	for (const g of profile.goals.toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
		const common = { title: g.title, disciplines: g.disciplines };
		await createGoal(
			owner,
			g.kind === 'event'
				? { kind: 'event', ...common, eventType: g.eventType, eventDate: g.eventDate }
				: {
						kind: 'general',
						...common,
						focus: g.focus,
						measure: g.measure,
						targetDate: g.targetDate
					},
			{ db }
		);
	}
	const { daysPerWeek, availableDays, preferredTimes, sessionMinutes, commitments } =
		profile.schedule;
	await saveSchedule(
		owner,
		{
			daysPerWeek,
			availableDays,
			preferredTimes,
			sessionMinutes,
			commitments: commitments.map(({ id: _id, ...c }) => c)
		},
		{ db }
	);
	const entries = profile.experience.map((e) => ({ discipline: e.discipline, level: e.level }));
	await saveExperience(owner, { entries }, { db });
}

describe('output size', () => {
	it('stays under the output cap, untruncated, on an M7-built multiGoal program', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveProfile(db, owner, M7_SCENARIOS.multiGoal());
			const input = buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE });
			const plan = generateProgram(input, {
				startsOn: SCENARIO_START,
				firstPlannedDay: SCENARIO_START
			});
			const snapshot = input as unknown as Record<string, unknown>;
			await createProgramFromPlan(
				owner,
				plan,
				{ source: 'rules', generator: GENERATOR_ID, snapshot },
				{ db }
			);
			for (const week of ['current', 'next']) {
				for (const name of ['evaluate_week_interference', 'explain_schedule_tradeoffs']) {
					const outcome = await call(db, owner, name, { week });
					expect(outcome.error, `${name} ${week}`).toBeNull();
					expect(
						(outcome.output as { truncated?: true }).truncated,
						`${name} ${week}`
					).toBeUndefined();
					const bytes = new TextEncoder().encode(canonicalJson(outcome.output)).length;
					expect(bytes, `${name} ${week}`).toBeLessThanOrEqual(TURN_LIMITS.toolOutputBytes);
				}
			}
			// Judged in full: the goals' priorities and the load model are in.
			const busy = await output<Evaluated>(db, owner, 'evaluate_week_interference', {
				week: 'current'
			});
			expect(busy.checked).toBe('full');
			expect(busy.loads).toHaveLength(5);
			const why = await output<Explained>(db, owner, 'explain_schedule_tradeoffs', {});
			expect(why.priorities.map((p) => p.mode)).toContain('primary');
		});
	});
});

// ---- plan_block, schedule_deload and plan_taper -----------------------------------------------

/** A goal id no owner in these tests has: the engine refuses a focus or a taper on it. */
const UNKNOWN_GOAL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
/** The tool_use the direct calls answer, and the one a turn's call names. */
const TOOL_USE = 'toolu_01Replan';
const MONDAY_THIS_WEEK = '2026-11-09';
const MONDAY_NEXT_WEEK = '2026-11-16';
/** The engine's refusals, as the tool answers them: its standard sentence, then the specifics. */
const NOT_APPLICABLE = 'This change does not apply to your plan as it stands.';
const NO_PROGRAM = 'There is no plan to change yet: build one first.';

interface Replanned {
	proposalId: string;
	title: { untrusted_text: string };
	summaryLines: { untrusted_text: string }[];
	rows: unknown[];
	from: string;
	truncated?: true;
}

/**
 * One call of a re-plan tool, as a turn runs it, for `ownerId`: the outcome and the conversation
 * it ran in. Nothing is stored by a refusal, so its ids need no rows; a call that stores a proposal
 * runs in a real turn (replanTurn). A failing evaluation context is a test failure, as in call.
 */
async function proposing(db: Executor, ownerId: string, name: string, input: object = {}) {
	const before = await contextErrorIds(db);
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: () => NOW }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: TOOL_USE, name, input }], ctx, {
		tools: TOOLS
	});
	const failed = (await contextErrorIds(db)).filter((id) => !before.includes(id));
	expect(failed, `${name}: evaluation-context errors`).toEqual([]);
	return outcomes[0]!;
}

/**
 * A turn in which the coach calls `name` once with `input`, as the mock plays it, so the proposal
 * it stores names a real thread and run. Returns the turn and the call's stored row. Fails on any
 * evaluation-context error the call recorded.
 */
async function replanTurn(
	db: Executor,
	owner: string,
	name: string,
	input: Record<string, unknown>
) {
	const before = await contextErrorIds(db);
	const once: MockScript = {
		name: `once-${name}`,
		matches: () => true,
		steps: [{ tools: [{ name, input }] }, { text: '[note] Done.' }]
	};
	const turn = await runScripted(once, {
		db,
		owner,
		text: 'Propose it',
		provider: counting([once]).ready,
		tools: TOOLS
	});
	const [call] = await db
		.select()
		.from(agentToolCalls)
		.where(eq(agentToolCalls.runId, turn.runId!));
	const failed = (await contextErrorIds(db)).filter((id) => !before.includes(id));
	expect(failed, `${name}: evaluation-context errors`).toEqual([]);
	return { turn, call: call! };
}

/** The owner's replan proposals, oldest first. */
async function replansOf(db: Executor, ownerId: string) {
	return db
		.select()
		.from(coachProposals)
		.where(and(eq(coachProposals.ownerId, ownerId), eq(coachProposals.kind, 'replan')));
}

/**
 * An event goal for the owner, on `eventDate`, still ahead. A block refuses to run through an
 * event's run-up, so a test makes it only after the block it checks.
 */
async function eventGoal(db: Executor, ownerId: string, eventDate: IsoDate) {
	const goal = await createGoal(
		ownerId,
		{
			...{ kind: 'event', title: '10K race', disciplines: ['running'] },
			...{ eventType: '10K race', eventDate }
		},
		{ db }
	);
	return goal.id;
}

/** A stored replan's card, checked against the tool's output schema and the budget. */
function expectCard(call: { output: unknown; truncated: boolean; name: string }) {
	expect(z.safeParse(toolNamed(call.name).outputSchema, call.output).success).toBe(true);
	expect(call.truncated, call.name).toBe(false);
	expect(Buffer.byteLength(canonicalJson(call.output)), call.name).toBeLessThanOrEqual(
		TURN_LIMITS.toolOutputBytes
	);
	expect((call.output as Replanned).rows.length, call.name).toBeLessThanOrEqual(12);
}

describe('plan_block, schedule_deload and plan_taper', () => {
	it('plan_block stores one replan proposal naming the coach’s thread, run and tool call, and answers with its card', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const before = await rows(db);
			const { turn, call } = await replanTurn(db, owner, 'plan_block', {
				phase: 'accumulation',
				weeks: 4
			});
			expect(call).toMatchObject({ name: 'plan_block', status: 'succeeded' });
			expectCard(call);
			expect(await rows(db)).toEqual({ ...before, proposals: before.proposals + 1 });

			const [stored] = await replansOf(db, owner);
			expect(stored).toMatchObject({
				kind: 'replan',
				status: 'proposed',
				threadId: turn.threadId,
				runId: turn.runId,
				toolUseId: call.toolUseId
			});
			expect(stored!.payload).toMatchObject({
				directive: { kind: 'block', phase: 'accumulation', weeks: 4 }
			});
			expect(call.proposalId).toBe(stored!.id);
			const card = call.output as Replanned;
			expect(card.proposalId).toBe(stored!.id);
			expect(card.from).toBe((stored!.payload as { from: string }).from);
			expect(card.summaryLines.length).toBeGreaterThan(0);
		});
	});

	it('plan_block with only a phase stores PLAN_BLOCK_WEEKS weeks', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const { call } = await replanTurn(db, owner, 'plan_block', { phase: 'accumulation' });
			expect(call).toMatchObject({ name: 'plan_block', status: 'succeeded' });
			const [stored] = await replansOf(db, owner);
			const directive = (stored!.payload as { directive: { weeks: number } }).directive;
			expect(directive.weeks).toBe(PLAN_BLOCK_WEEKS);
			expect(directive).toMatchObject({ kind: 'block', phase: 'accumulation' });
		});
	});

	it('schedule_deload stores one deload by the coach, of this week or of next, with its reason', async () => {
		for (const [when, week] of [
			['this_week', MONDAY_THIS_WEEK],
			['next_week', MONDAY_NEXT_WEEK]
		] as const) {
			await withRollback(async (db) => {
				const { owner } = await seed(db);
				const { turn, call } = await replanTurn(db, owner, 'schedule_deload', {
					when,
					reason: 'Legs are heavy after the weekend.'
				});
				expect(call, when).toMatchObject({ status: 'succeeded' });
				const [stored] = await replansOf(db, owner);
				expect(stored, when).toMatchObject({
					threadId: turn.threadId,
					runId: turn.runId,
					toolUseId: call.toolUseId
				});
				expect(stored!.payload).toMatchObject({
					directive: {
						kind: 'deload',
						week,
						trigger: 'coach',
						reasons: ['Legs are heavy after the weekend.']
					}
				});
				expect((call.output as Replanned).from, when).toBe(week);
			});
		}
	});

	it('schedule_deload defaults to next week, with no reason invented', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const { call } = await replanTurn(db, owner, 'schedule_deload', {});
			expect(call).toMatchObject({ status: 'succeeded' });
			const [stored] = await replansOf(db, owner);
			expect(stored!.payload).toMatchObject({
				directive: { kind: 'deload', week: MONDAY_NEXT_WEEK, trigger: 'coach', reasons: [] }
			});
		});
	});

	it('plan_taper stores one taper for an event goal, as a full or a mini taper', async () => {
		for (const kind of ['full', 'mini'] as const) {
			await withRollback(async (db) => {
				const { owner, seeded } = await seed(db);
				const goal = await eventGoal(db, owner, addDays(seeded.mondays.clean, 2));
				const { turn, call } = await replanTurn(db, owner, 'plan_taper', { goal, kind });
				expect(call, kind).toMatchObject({ status: 'succeeded' });
				const [stored] = await replansOf(db, owner);
				expect(stored, kind).toMatchObject({ threadId: turn.threadId, toolUseId: call.toolUseId });
				expect(stored!.payload).toMatchObject({
					directive: { kind: 'taper', goalRef: goal, form: kind }
				});
			});
		}
	});

	it('plan_taper with no kind follows the goal’s priority: full for the leader, mini for a secondary event, none for one held at maintenance', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			// Three events in their lead window, ranked as they were added: the first leads, the
			// second is secondary (rank weight 0.6) and the third is held at maintenance (0.4).
			const leader = await eventGoal(db, owner, addDays(seeded.mondays.clean, 2));
			const second = await eventGoal(db, owner, addDays(seeded.mondays.clean, 4));
			const held = await eventGoal(db, owner, addDays(seeded.mondays.clean, 6));

			const refused = await proposing(db, owner, 'plan_taper', { goal: held });
			expect(refused.error).toMatchObject({ code: 'REFUSED' });
			expect(refused.error!.message).toMatch(
				new RegExp(`^${NOT_APPLICABLE} A goal held at maintenance is trained through`)
			);
			expect(await replansOf(db, owner)).toEqual([]);

			for (const [goal, form] of [
				[leader, 'full'],
				[second, 'mini']
			] as const) {
				const { call } = await replanTurn(db, owner, 'plan_taper', { goal });
				expect(call, form).toMatchObject({ status: 'succeeded' });
				const stored = (await replansOf(db, owner)).find((p) => p.id === call.proposalId);
				expect(stored!.payload, form).toMatchObject({
					directive: { kind: 'taper', goalRef: goal, form }
				});
			}
		});
	});

	it('refuses with the engine’s sentence and stores nothing: a focus on an unknown goal, a taper for a goal with no event', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const before = await rows(db);
			const focus = await proposing(db, owner, 'plan_block', {
				phase: 'maintenance',
				focusGoal: UNKNOWN_GOAL
			});
			const why = `${NOT_APPLICABLE} That goal is not one you are training for.`;
			expect(focus.error).toMatchObject({ code: 'REFUSED', message: why });
			expect(JSON.parse(focus.content)).toMatchObject({ reason: why });
			const general = await createGoal(
				owner,
				{
					...{ kind: 'general', title: 'Run more', disciplines: ['running'] },
					...{ focus: 'Running', measure: 'Run three times a week' }
				},
				{ db }
			);
			const taper = await proposing(db, owner, 'plan_taper', { goal: general.id });
			expect(taper.error).toMatchObject({ code: 'REFUSED' });
			expect(taper.error!.message).toMatch(
				new RegExp(`^${NOT_APPLICABLE} Only an event still ahead can be tapered for\\.$`)
			);
			expect(await rows(db)).toEqual(before);
			expect(await replansOf(db, owner)).toEqual([]);
		});
	});

	it('refuses a block for an owner with no program, with the engine’s sentence', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const outcome = await proposing(db, owner, 'plan_block', { phase: 'accumulation' });
			expect(outcome.error).toMatchObject({ code: 'REFUSED', message: NO_PROGRAM });
			expect(await replansOf(db, owner)).toEqual([]);
		});
	});

	it('is owner-scoped: another owner’s event goal is never read, and nothing is stored for either', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const other = await makeSecondOwner(db);
			const theirs = await eventGoal(db, other, addDays(seeded.mondays.clean, 2));
			const outcome = await proposing(db, owner, 'plan_taper', { goal: theirs });
			expect(outcome.error).toMatchObject({ code: 'REFUSED' });
			expect(outcome.error!.message).toBe(
				`${NOT_APPLICABLE} Only an event still ahead can be tapered for.`
			);
			expect(await replansOf(db, owner)).toEqual([]);
			expect(await replansOf(db, other)).toEqual([]);
		});
	});

	it('answers each within the output budget, untruncated, with at most 12 rows', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const calls = [
				await replanTurn(db, owner, 'plan_block', { phase: 'maintenance', weeks: 8 }),
				await replanTurn(db, owner, 'schedule_deload', { when: 'this_week' })
			];
			const goal = await eventGoal(db, owner, addDays(seeded.mondays.clean, 2));
			calls.push(await replanTurn(db, owner, 'plan_taper', { goal }));
			for (const { call } of calls) expectCard(call);
		});
	});

	it('the scripted turns propose through these tools, with their chips, and a refused one is a failed call', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const cases = [
				['block-plan', 'Plan the block as maintenance', 'Planning the block…', 'Planned the block'],
				['deload-week', 'Deload this week', 'Preparing a deload week…', 'Prepared a deload week'],
				['taper-plan', 'Taper for my 10K race', 'Planning your taper…', 'Planned your taper']
			] as const;
			for (const [name, text, running, done] of cases) {
				if (name === 'taper-plan') await eventGoal(db, owner, addDays(seeded.mondays.clean, 2));
				const turn = await runScripted(script(name), {
					db,
					owner,
					text,
					provider: counting([script(name)]).ready,
					tools: TOOLS
				});
				expect(turn.done.status, name).toBe('completed');
				expect(chips(turn.events, 'running'), name).toContain(running);
				expect(chips(turn.events, 'done'), name).toContain(done);
				const stored = (await replansOf(db, owner)).filter((p) => p.threadId === turn.threadId);
				expect(stored, name).toHaveLength(1);
				expect(stored[0]).toMatchObject({ runId: turn.runId });
			}
			const before = await rows(db);
			const refused = await runScripted(script('block-refused'), {
				db,
				owner,
				text: 'Plan the block with a focus on another goal',
				provider: counting([script('block-refused')]).ready,
				tools: TOOLS
			});
			const [call] = await db
				.select()
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, refused.runId!));
			expect(call).toMatchObject({ name: 'plan_block', status: 'failed', errorCode: 'REFUSED' });
			expect(await rows(db)).toEqual(before);
		});
	});
});
