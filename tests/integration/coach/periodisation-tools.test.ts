/**
 * The coach's periodisation reads on real Postgres (tools-periodisation-reads), on the
 * periodisation-week fixture at the turn's Wednesday 11 November 2026: next week the owner moved
 * Lower A to Monday, the day before Tuesday's hard Muay Thai class.
 * - outputs validate against their schemas; the score is a metric with its method, and the
 *   owner's move is one avoid finding citing its sessions and the owner's decision
 * - a what-if move returns its finding and writes no row
 * - suggestedRepair moves Lower A back with one move op, which propose_program_adjustment stores
 *   byte for byte (canonical JSON) without a draft: no structured-output call, no draft model
 *   call, and checkProposal still ran (a move into the past is refused, storing nothing)
 * - explain_schedule_tradeoffs: the goal's priority as a metric, the decisions with their ids,
 *   the owner's first, the kept clash and the road; for one session, only its decisions
 * - the scripted answers' [metric] and [fact] blocks are grounded, and the chips read as listed
 * - a random ownerId given the seeded owner's lineages is NOT_FOUND and reads nothing of theirs
 * - on an M7-built multiGoal program both outputs stay under the 8 KB cap, untruncated
 */
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../../../src/lib/domain/calendar';
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
import { programVersions } from '../../../src/lib/server/db/schema/programs';
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
import { makeOwner } from '../profile/fixtures';
import { runScripted, TURN_NOW } from './harness';

const TODAY = '2026-11-11';
const NOW = new Date(TURN_NOW);

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = COACH_TOOLS as Tools;
const toolNamed = (name: string) => TOOLS.find((tool) => tool.name === name)!;
const script = (name: string) => periodisationScripts.find((s) => s.name === name)!;

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
		clears: { rule: string }[];
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

/** One call of a tool, as a turn runs it, for `ownerId`. */
async function call(db: Executor, ownerId: string, name: string, input: object = {}) {
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

const blocksOf = (events: CoachEvent[]) =>
	events.flatMap((e) => (e.type === 'block_completed' || e.type === 'block_replaced' ? [e] : []));
const chips = (events: CoachEvent[], state: string) =>
	events.flatMap((e) => (e.type === 'activity' && e.state === state ? [e.label] : []));

describe('evaluate_week_interference', () => {
	it('judges the owner’s move as one avoid finding, scored with its method, citing the sessions and the owner’s decision', async () => {
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
			expect(avoid[0]!.sources.some((s) => s.type === 'decision')).toBe(true);
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

describe('propose_program_adjustment with ops', () => {
	it('stores the suggested repair byte for byte, with no draft, through checkProposal', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const before = await rows(db);
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
			// Three chat steps and no draft call.
			const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, turn.runId!));
			expect(run!.modelCalls).toBe(3);
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
});

describe('scripted turns', () => {
	it('answer ‘Does next week clash?’ with grounded metrics and facts, under the listed chips', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
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
		});
	});

	it('answer ‘Why is my week shaped like this?’ quoting the decisions, every block grounded', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
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
		});
	});
});

describe('owner scoping', () => {
	it('a random ownerId given the seeded owner’s lineages is NOT_FOUND and reads nothing', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const stranger = crypto.randomUUID();
			for (const [name, input] of [
				[
					'evaluate_week_interference',
					{
						week: 'next',
						moves: [{ session: seeded.lineages.moved, toDate: addDays(seeded.mondays.moved, 2) }]
					}
				],
				['explain_schedule_tradeoffs', { session: seeded.lineages.moved }]
			] as const) {
				const outcome = await call(db, stranger, name, input);
				expect(outcome.error, name).toMatchObject({ code: 'NOT_FOUND' });
				expect(JSON.stringify(outcome)).not.toContain('Lower A');
			}
			// The same calls for the owner do read the week.
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
					expect(outcome.error, name).toBeNull();
					expect((outcome.output as { truncated?: true }).truncated, name).toBeUndefined();
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
