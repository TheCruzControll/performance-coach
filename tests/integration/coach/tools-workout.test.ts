/**
 * The coach's workout tools on real Postgres (the M5 plan's tools-workout):
 * - get_current_workout gives the live workout, and today's plan with each exercise's ids
 * - alternatives with the equipment unavailable rank those needing none of the slot's equipment
 *   first; with a body area they are M4's gentler options for it (gentlerFor)
 * - 'Can we change today's workout?' drafts for 12 s, past a tool's own 10 s, and stores a
 *   workout_update proposal, not a TIMEOUT
 * - 'The leg press is taken' with the coach asking for from_now_on stays a session substitution:
 *   accepted, it is one substitution in the live workout, with no preference and the same version
 * - update_workout refuses a past session and a started one
 * - a saved analysis is in the coaching memory
 * - 'My knee hurts on lunges': the policy's stored safety block names the alternatives returned
 * - a random ownerId with the seeded owner's ids writes nothing and is NOT_FOUND
 * - every output validates against its schema
 *
 * The workout-day fixture plans today, Wednesday 11 November 2026: 'Lower body & pull' (back
 * squat, leg press, Romanian deadlift, pull-up and plank), intervals and a class.
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../../../src/lib/domain/calendar';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import type { ProgramPlan, StrengthSessionPlan } from '../../../src/lib/domain/training/types';
import { rankFor } from '../../../src/lib/domain/workout/substitution';
import {
	MockProvider,
	type MockContext,
	type MockScript
} from '../../../src/lib/server/agent/provider/mock';
import {
	WORKOUT_DRAFT_DELAY_MS,
	workoutScripts
} from '../../../src/lib/server/agent/provider/mock-scripts/workout';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { HISTORY_TOOLS } from '../../../src/lib/server/agent/tools/history';
import { WORKOUT_TOOLS } from '../../../src/lib/server/agent/tools/workout';
import { DRAFT_CALL_INDEX_BASE } from '../../../src/lib/server/agent/turn';
import {
	agentModelCalls,
	agentToolCalls,
	coachNotes,
	coachProposals,
	exercisePreferences,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { programVersions } from '../../../src/lib/server/db/schema/programs';
import { getCoachingMemory } from '../../../src/lib/server/services/coach/memory';
import { acceptProposal } from '../../../src/lib/server/services/coach/proposals';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { saveEquipment } from '../../../src/lib/server/services/profile';
import {
	createProgramFromPlan,
	getTodayPlan
} from '../../../src/lib/server/services/programs/index';
import { kitForLineage } from '../../../src/lib/server/services/workouts/kit';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, storedRows, TURN_NOW } from './harness';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(TURN_NOW);
const GYM = ['barbell', 'squat_rack', 'bench', 'dumbbells', 'kettlebells', 'cables', 'machines'];

type Tools = readonly CoachTool<ResolvedCoachDeps>[];
/** Sorted by name, as every request lists them. */
const TOOLS = [...(WORKOUT_TOOLS as Tools)].sort((a, b) => (a.name < b.name ? -1 : 1));
const toolNamed = (name: string) =>
	[...TOOLS, ...(HISTORY_TOOLS as Tools)].find((tool) => tool.name === name)!;
const ready = (scripts: readonly MockScript[]) => ({
	status: 'ready' as const,
	provider: new MockProvider(scripts, { overrides: () => ({}) })
});

/** The 'workout-day' plan, with `edit` applied to today's strength session. */
function workoutDay(edit?: (session: StrengthSessionPlan) => void): ProgramPlan {
	const plan = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	const session = plan.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'strength');
	edit?.(session as StrengthSessionPlan);
	return plan;
}

/** The owner, with a full gym, and today's strength kit. */
async function seed(db: Executor, plan: ProgramPlan = workoutDay()) {
	const owner = await makeOwner(db);
	await saveEquipment(
		owner,
		{ gymType: null, equipment: GYM, homeEquipment: [], notes: null },
		{ db }
	);
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const today = await getTodayPlan(owner, TODAY, { db });
	const strength = today!.sessions.find((x) => x.kind === 'strength')!;
	const kit = await kitForLineage(owner, strength.lineage, { db, now: () => NOW });
	if (kit?.kind !== 'strength') throw new Error('a strength kit');
	return { owner, programId, kit };
}

type Seeded = Awaited<ReturnType<typeof seed>>;
const exerciseOf = (s: Seeded, key: string) => s.kit.exercises.find((e) => e.exercise.key === key)!;
const slotOf = (s: Seeded, key: string) => ({
	sessionLineage: s.kit.plannedLineage!,
	plannedExerciseLineage: exerciseOf(s, key).plannedLineage!
});

/** A workout of the owner's on today's strength session, as M4's workout.start stores it. */
async function logWorkout(db: Executor, s: Seeded, status: 'in_progress' | 'completed') {
	const clientId = crypto.randomUUID();
	const startedAt = new Date(`${TODAY}T08:00:00Z`);
	const [row] = await db
		.insert(workouts)
		.values({
			ownerId: s.owner,
			clientId,
			kind: 'strength',
			discipline: 'strength',
			sessionType: 'strength',
			title: s.kit.title,
			plannedSessionId: s.kit.plannedSessionId,
			plannedLineageId: s.kit.plannedLineage,
			programId: s.programId,
			status,
			startedAt,
			finishedAt: status === 'in_progress' ? null : new Date(startedAt.getTime() + 3_600_000)
		})
		.returning({ id: workouts.id });
	return { clientId, id: row!.id };
}

/** One call of a workout tool, as a turn runs it, for `ownerId` on `today`. */
async function call(
	db: Executor,
	ownerId: string,
	name: string,
	input: object,
	today: string = TODAY
) {
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: () => NOW }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: 'toolu_01Workout', name, input }], ctx, {
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

interface Alternatives {
	exercise: { exerciseId: string; equipment: string[] };
	ranking: string;
	items: { exerciseId: string; name: string; equipment: string[] }[];
}

const ids = (items: readonly { exerciseId: string }[]) => items.map((i) => i.exerciseId);
const proposalEvents = (events: readonly CoachEvent[]) =>
	events.filter((event) => event.type === 'proposal');

describe('get_current_workout', () => {
	it('gives today’s plan with each strength exercise’s ids, and no live workout', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const out = await output<{
				live: unknown;
				noProgram: boolean;
				sessions: {
					source: { id: string };
					kind: string;
					started: boolean;
					exercises: { plannedExerciseLineage: string; position: number; exerciseId: string }[];
				}[];
			}>(db, s.owner, 'get_current_workout');
			expect(out.live).toBeNull();
			expect(out.noProgram).toBe(false);
			expect(out.sessions.map((x) => x.kind)).toEqual(['strength', 'run', 'other']);
			const strength = out.sessions[0]!;
			expect(strength).toMatchObject({ source: { id: s.kit.plannedLineage }, started: false });
			expect(strength.exercises).toEqual(
				s.kit.exercises.map((e) =>
					expect.objectContaining({
						plannedExerciseLineage: e.plannedLineage,
						position: e.position,
						exerciseId: e.exercise.id
					})
				)
			);
		});
	});

	it('gives the live workout, on its session, with its sets and substitutions', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const live = await logWorkout(db, s, 'in_progress');
			const out = await output<{
				live: { workoutId: string; session: { id: string } | null; setsLogged: number };
				sessions: { started: boolean }[];
			}>(db, s.owner, 'get_current_workout');
			expect(out.live).toMatchObject({
				workoutId: live.clientId,
				session: { type: 'session', id: s.kit.plannedLineage },
				setsLogged: 0,
				substitutions: []
			});
			expect(out.sessions.map((x) => x.started)).toEqual([true, false, false]);
		});
	});

	it('reads nothing of the seeded owner’s for a random ownerId', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await logWorkout(db, s, 'in_progress');
			const out = await output(db, crypto.randomUUID(), 'get_current_workout');
			expect(out).toEqual({ today: TODAY, live: null, sessions: [], noProgram: true });
		});
	});
});

describe('get_exercise_alternatives', () => {
	it('ranks the alternatives needing none of the leg press’s equipment first when it is unavailable', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const slot = slotOf(s, 'leg_press');
			const ranked = await output<Alternatives>(db, s.owner, 'get_exercise_alternatives', slot);
			const taken = await output<Alternatives>(db, s.owner, 'get_exercise_alternatives', {
				...slot,
				reason: 'equipment_unavailable'
			});
			const needs = taken.exercise.equipment;
			expect(needs.length).toBeGreaterThan(0);
			const free = (i: { equipment: string[] }) => !i.equipment.some((e) => needs.includes(e));
			const partitioned = (flags: boolean[]) => [...flags].sort((a, b) => Number(b) - Number(a));
			// M3's own order puts a machine (the belt squat) before free ones.
			const rankedFlags = ranked.items.map(free);
			expect(rankedFlags).not.toEqual(partitioned(rankedFlags));
			expect(taken.ranking).toBe('equipment_free_first');
			expect(new Set(ids(taken.items))).toEqual(new Set(ids(ranked.items)));
			const flags = taken.items.map(free);
			expect(flags[0]).toBe(true);
			expect(flags).toEqual(partitioned(flags));
			const leg = exerciseOf(s, 'leg_press');
			const kitOrder = rankFor('equipment_unavailable', leg.alternatives!, {
				plannedLineage: leg.plannedLineage,
				exerciseId: leg.exercise.id,
				kit: leg
			});
			expect(ids(taken.items)).toEqual(kitOrder.map((a) => a.exercise.id));
		});
	});

	it('gives the gentler options for a body area, from gentlerFor, never the original', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const squat = exerciseOf(s, 'back_squat');
			const out = await output<Alternatives>(db, s.owner, 'get_exercise_alternatives', {
				...slotOf(s, 'back_squat'),
				reason: 'pain',
				area: 'knee'
			});
			expect(out.ranking).toBe('gentler');
			const gentler = squat.gentler!.knee!.map((a) => a.exercise.id);
			expect(gentler.length).toBeGreaterThan(0);
			expect(ids(out.items)).toEqual(gentler);
			expect(ids(out.items)).not.toEqual(squat.alternatives!.map((a) => a.exercise.id));
			expect(ids(out.items)).not.toContain(squat.exercise.id);
		});
	});

	it('is NOT_FOUND for a random ownerId', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const outcome = await call(
				db,
				crypto.randomUUID(),
				'get_exercise_alternatives',
				slotOf(s, 'leg_press')
			);
			expect(outcome.error?.code).toBe('NOT_FOUND');
		});
	});
});

describe('update_workout', () => {
	it('drafts “Can we change today’s workout?” for 12 s and stores a proposal, not a TIMEOUT', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			expect(WORKOUT_DRAFT_DELAY_MS).toBeGreaterThan(10_000);
			const turn = await runScripted(workoutScripts[0]!, {
				db,
				owner: s.owner,
				text: 'Can we change today’s workout?',
				provider: ready(workoutScripts),
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			const update = calls.find((c) => c.name === 'update_workout')!;
			expect(update).toMatchObject({ status: 'succeeded', errorCode: null });
			expect(update.durationMs).toBeGreaterThanOrEqual(WORKOUT_DRAFT_DELAY_MS);

			const [proposal] = await db
				.select()
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, s.owner));
			expect(proposal).toMatchObject({
				kind: 'workout_update',
				status: 'proposed',
				runId: turn.runId,
				toolUseId: update.toolUseId,
				programId: s.programId
			});
			expect(proposal!.payload).toEqual({
				ops: [expect.objectContaining({ op: 'adjust_set', sessionLineage: s.kit.plannedLineage })]
			});
			expect(proposalEvents(turn.events)).toEqual([
				{ type: 'proposal', id: proposal!.id, kind: 'workout_update', title: proposal!.title }
			]);
			const drafts = await db
				.select({ index: agentModelCalls.callIndex })
				.from(agentModelCalls)
				.where(
					and(
						eq(agentModelCalls.runId, turn.runId!),
						eq(agentModelCalls.callIndex, DRAFT_CALL_INDEX_BASE)
					)
				);
			expect(drafts).toHaveLength(1);
		});
	}, 40_000);

	it('refuses a past session and a started one, before drafting', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const input = { sessionLineage: s.kit.plannedLineage, request: 'Make it lighter' };
			const past = await call(db, s.owner, 'update_workout', input, addDays(TODAY, 1));
			expect(past).toMatchObject({ status: 'failed', error: { code: 'NOT_TODAY' } });
			await logWorkout(db, s, 'in_progress');
			const started = await call(db, s.owner, 'update_workout', input);
			expect(started).toMatchObject({ status: 'failed', error: { code: 'STARTED' } });
			expect(await rows(db)).toEqual({ proposals: 0, notes: 0, substitutions: 0 });
		});
	});

	it('stores nothing when the draft swaps an exercise of today’s session never again', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const leg = exerciseOf(s, 'leg_press');
			const lasting: MockScript = {
				name: 'lasting-swap-draft',
				matches: (text) => text.startsWith('Kind: workout_update'),
				steps: [
					{
						json: {
							title: 'No more leg press',
							rationale: 'Swap it for good.',
							payload: {
								ops: [
									{
										op: 'swap',
										...slotOf(s, 'leg_press'),
										toExerciseId: leg.alternatives![0]!.exercise.id,
										scope: 'never_again',
										reason: 'Not a fan'
									}
								]
							}
						}
					}
				]
			};
			const turn = await runScripted(workoutScripts[0]!, {
				db,
				owner: s.owner,
				text: 'Can we change today’s workout?',
				provider: ready([lasting, workoutScripts[0]!]),
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			expect(calls.find((c) => c.name === 'update_workout')).toMatchObject({
				status: 'failed',
				errorCode: 'NOT_TODAY'
			});
			expect(await rows(db)).toEqual({ proposals: 0, notes: 0, substitutions: 0 });
		});
	});
});

/** Every owner's coach_proposals, coach_notes and workout_substitutions rows. */
async function rows(db: Executor) {
	const n = async (
		table: typeof coachProposals | typeof coachNotes | typeof workoutSubstitutions
	) => (await db.select({ n: count() }).from(table))[0]!.n;
	return {
		proposals: await n(coachProposals),
		notes: await n(coachNotes),
		substitutions: await n(workoutSubstitutions)
	};
}

describe('substitute_exercise', () => {
	it('keeps “The leg press is taken” in the session when the coach asks for from_now_on', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const live = await logWorkout(db, s, 'in_progress');
			const taken = workoutScripts.find((script) => script.name === 'machine-taken')!;
			// The coach overreaches: it asks for a lasting swap on a situational message.
			const overreaching: MockScript = {
				...taken,
				steps: taken.steps.map((step) => ({
					...step,
					tools: step.tools?.map((tool) =>
						tool.name !== 'substitute_exercise'
							? tool
							: {
									...tool,
									input: (context: MockContext) => ({
										...(tool.input as (c: MockContext) => Record<string, unknown>)(context),
										scope: 'from_now_on',
										reason: 'dislike'
									})
								}
					)
				}))
			};
			const turn = await runScripted(overreaching, {
				db,
				owner: s.owner,
				text: 'The leg press is taken',
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			const substitute = calls.find((c) => c.name === 'substitute_exercise')!;
			expect(substitute.status).toBe('succeeded');
			expect(substitute.output).toMatchObject({
				scope: 'session',
				reason: 'equipment_unavailable',
				changed: expect.any(String)
			});

			const leg = exerciseOf(s, 'leg_press');
			const [proposal] = await db
				.select()
				.from(coachProposals)
				.where(eq(coachProposals.ownerId, s.owner));
			expect(proposal).toMatchObject({ kind: 'session_substitution', status: 'proposed' });
			expect(proposal!.payload).toMatchObject({
				workoutId: live.clientId,
				plannedExerciseLineage: leg.plannedLineage,
				position: leg.position,
				fromExerciseId: leg.exercise.id,
				reason: 'equipment_unavailable'
			});

			const versions = () =>
				db
					.select({ n: count() })
					.from(programVersions)
					.where(eq(programVersions.programId, s.programId));
			const before = (await versions())[0]!.n;
			const accepted = await acceptProposal(s.owner, proposal!.id, { db, now: () => NOW });
			expect(accepted.proposal).toMatchObject({ status: 'applied', appliedVersion: null });
			expect((await versions())[0]!.n).toBe(before);
			const preferences = await db
				.select({ n: count() })
				.from(exercisePreferences)
				.where(eq(exercisePreferences.ownerId, s.owner));
			expect(preferences[0]!.n).toBe(0);
			const substitutions = await db
				.select()
				.from(workoutSubstitutions)
				.where(eq(workoutSubstitutions.ownerId, s.owner));
			expect(substitutions).toMatchObject([
				{ reason: 'equipment_unavailable', fromExerciseId: leg.exercise.id }
			]);
		});
	});

	it('refuses a lasting swap without the owner’s explicit dislike this turn', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const leg = exerciseOf(s, 'leg_press');
			const outcome = await call(db, s.owner, 'substitute_exercise', {
				...slotOf(s, 'leg_press'),
				toExerciseId: leg.alternatives![0]!.exercise.id,
				reason: 'dislike',
				scope: 'from_now_on',
				title: 'No more leg press',
				rationale: 'You said you dislike it.'
			});
			expect(outcome.error?.code).toBe('NEEDS_DISLIKE');
			expect(await rows(db)).toEqual({ proposals: 0, notes: 0, substitutions: 0 });
		});
	});
});

describe('save_workout_analysis', () => {
	it('saves a note on the workout History names, which the coaching memory reads back', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const done = await logWorkout(db, s, 'completed');
			expect(done.clientId).not.toBe(done.id);
			const headline = 'Squat top set moved fast at RPE 7';
			const script: MockScript = {
				name: 'analyse',
				matches: () => true,
				steps: [
					{ tools: [{ name: 'get_recent_workouts', input: {} }] },
					{
						tools: [
							{
								name: 'save_workout_analysis',
								input: (context: MockContext) => ({
									workoutId: (
										context.result('get_recent_workouts') as { items: { source: { id: string } }[] }
									).items[0]!.source.id,
									headline,
									points: ['Bar speed held on the back-offs.']
								})
							}
						]
					},
					{ text: '[note] Saved.' }
				]
			};
			const tools = [...TOOLS, ...(HISTORY_TOOLS as Tools)].sort((a, b) =>
				a.name < b.name ? -1 : 1
			);
			const turn = await runScripted(script, { db, owner: s.owner, tools });
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			expect(calls.map((c) => [c.name, c.status])).toEqual([
				['get_recent_workouts', 'succeeded'],
				['save_workout_analysis', 'succeeded']
			]);
			expect(calls[1]!.input).toMatchObject({ workoutId: done.clientId });
			const memory = await getCoachingMemory(s.owner, { today: TODAY }, { db });
			expect(JSON.stringify(memory.records.analyses)).toContain(headline);
		});
	});
});

describe('a pain turn', () => {
	it('stores a safety block naming the gentler options “My knee hurts on lunges” returned', async () => {
		await withRollback(async (db) => {
			const plan = workoutDay((session) => {
				const rdl = session.exercises.find(
					(e) => 'key' in e.exercise && e.exercise.key === 'romanian_deadlift'
				)!;
				rdl.exercise = { key: 'forward_lunge' };
			});
			const s = await seed(db, plan);
			const turn = await runScripted(workoutScripts[0]!, {
				db,
				owner: s.owner,
				text: 'My knee hurts on lunges',
				provider: ready(workoutScripts),
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			const alternatives = calls.find((c) => c.name === 'get_exercise_alternatives')!;
			expect(alternatives.input).toMatchObject({
				...slotOf(s, 'forward_lunge'),
				area: 'knee'
			});
			const names = (alternatives.output as Alternatives).items.map((i) => i.name);
			expect(names.length).toBeGreaterThan(0);

			const answer = (await storedRows(db, turn.threadId!)).at(-1)!;
			const blocks = (answer.display as { blocks: { kind: string }[] }).blocks;
			const safety = blocks.filter((block) => block.kind === 'safety');
			expect(safety).toHaveLength(1);
			for (const name of names.slice(0, 3)) expect(JSON.stringify(safety[0])).toContain(name);
		});
	});
});

describe('someone else’s ids', () => {
	it('write nothing: substitute_exercise, update_workout and save_workout_analysis are NOT_FOUND', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const done = await logWorkout(db, s, 'completed');
			const leg = exerciseOf(s, 'leg_press');
			const script: MockScript = {
				name: 'foreign',
				matches: () => true,
				steps: [
					{
						tools: [
							{
								name: 'substitute_exercise',
								input: {
									...slotOf(s, 'leg_press'),
									toExerciseId: leg.alternatives![0]!.exercise.id,
									reason: 'equipment_unavailable',
									scope: 'session',
									title: 'Swap it for today',
									rationale: 'The leg press is taken.'
								}
							},
							{
								name: 'update_workout',
								input: { sessionLineage: s.kit.plannedLineage, request: 'Make it lighter' }
							},
							{
								name: 'save_workout_analysis',
								input: { workoutId: done.clientId, headline: 'A good session', points: [] }
							}
						]
					},
					{ text: '[note] Nothing found.' }
				]
			};
			const before = await rows(db);
			const turn = await runScripted(script, {
				db,
				owner: s.owner,
				ownerId: crypto.randomUUID(),
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const calls = await checkedCalls(db, turn.runId!);
			expect(calls.map((c) => [c.name, c.errorCode])).toEqual([
				['substitute_exercise', 'NOT_FOUND'],
				['update_workout', 'NOT_FOUND'],
				['save_workout_analysis', 'NOT_FOUND']
			]);
			expect(await rows(db)).toEqual(before);
		});
	});
});
