/**
 * Accepting goal and preference proposals, and the coach-notes service, on real Postgres (the M5
 * plan's apply-profile-proposals):
 * - A goal_update runs through M2's goal services: every change is in goalHistory with source
 *   'coach', and applied_ref names the first goal it changed.
 * - One whose goal was deleted, or whose ranking no longer names every open goal, is refused and
 *   writes nothing.
 * - A preference_update is recorded through recordExercisePreference with source 'coach', under
 *   the preference lock, with applied_ref set and no program version.
 * - Each accept records a coach_decision note carrying the rationale.
 * - Notes are validated by kind, and a note for an owner that does not exist, or naming someone
 *   else's run or workout, is not found and writes nothing.
 */
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RULE_MESSAGES } from '../../../src/lib/domain/coach/proposal-rules';
import {
	coachNotes,
	exercisePreferences,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import {
	latestNotes,
	recordCoachDecision,
	saveNote,
	saveWorkoutAnalysis
} from '../../../src/lib/server/services/coach/notes';
import {
	acceptProposal,
	createProposal,
	getProposalView,
	ProposalRefusedError
} from '../../../src/lib/server/services/coach/proposals';
import {
	CoachInputError,
	CoachNotFoundError,
	type CoachDeps
} from '../../../src/lib/server/services/coach/shared';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createGoal,
	deleteGoal,
	goalHistory,
	listGoals
} from '../../../src/lib/server/services/profile';
import { createProgramsRepository } from '../../../src/lib/server/db/repositories/programs';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import {
	listExercisePreferences,
	recordExercisePreference
} from '../../../src/lib/server/services/training/preferences';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const RATIONALE = 'The fight is the priority this spring, so strength holds while camp runs.';

/** A clock that moves a second each read, so rows are created in order. */
function ticking(start = new Date(`${MONDAY}T08:00:00Z`)) {
	let t = start.getTime();
	return () => new Date((t += 1000));
}

async function owner(db: Executor) {
	const ownerId = await makeOwner(db);
	const deps: CoachDeps = { db, now: ticking() };
	return { ownerId, deps };
}

const draft = (kind: 'goal_update' | 'preference_update', payload: object, title: string) => ({
	kind,
	title,
	rationale: RATIONALE,
	payload
});

async function refusal(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	expect(error).toBeInstanceOf(ProposalRefusedError);
	return (error as ProposalRefusedError).errors;
}

async function inputError(promise: Promise<unknown>): Promise<[string, string]> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	expect(error).toBeInstanceOf(CoachInputError);
	return [(error as CoachInputError).field, (error as CoachInputError).message];
}

const noteCount = async (db: Executor) => (await db.select({ n: count() }).from(coachNotes))[0]!.n;
const coachGoalEvents = async (db: Executor, ownerId: string) =>
	(await goalHistory(ownerId, { db })).filter((e) => e.source === 'coach');

async function benchId(db: Executor) {
	return (await resolveKeys(['bench_press'], { db })).get('bench_press')!.id;
}

/** A workout of the owner's, by its client id (the id notes name it by). */
async function workoutOf(db: Executor, ownerId: string) {
	const clientId = crypto.randomUUID();
	await db.insert(workouts).values({
		ownerId,
		clientId,
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: 'Full body A',
		startedAt: new Date(`${MONDAY}T07:00:00Z`)
	});
	return clientId;
}

describe('accepting a goal_update', () => {
	it('runs every op through the goal services with source coach, and records why', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const fight = await createGoal(ownerId, eventGoal(), { db });
			const strength = await createGoal(ownerId, generalGoal(), { db });
			const before = await goalHistory(ownerId, { db });
			expect(before.every((e) => e.source === 'profile')).toBe(true);

			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'goal_update',
						{
							ops: [
								{ op: 'add', goal: generalGoal({ title: 'Run a sub-25 5K' }) },
								{ op: 'edit', goalId: fight.id, goal: eventGoal({ weightClass: '-67 kg' }) },
								{ op: 'set_status', goalId: strength.id, status: 'achieved' }
							]
						},
						'Add a 5K goal'
					)
				},
				deps
			);
			const { proposal: applied, changed } = await acceptProposal(ownerId, proposal.id, deps);
			expect(changed).toBe(true);

			const goals = await listGoals(ownerId, { db });
			const fiveK = goals.find((g) => g.title === 'Run a sub-25 5K')!;
			expect(applied).toMatchObject({
				status: 'applied',
				appliedRef: { kind: 'goal', id: fiveK.id },
				appliedVersion: null
			});
			expect(goals.map((g) => [g.title, g.status, g.priority])).toEqual([
				['First Muay Thai fight', 'active', 1],
				['Run a sub-25 5K', 'active', 2],
				['Keep my strength', 'achieved', null]
			]);
			expect(goals.find((g) => g.id === fight.id)!.weightClass).toBe('-67 kg');

			// Every change is in goal history, as the coach's.
			const history = await coachGoalEvents(db, ownerId);
			const byChange = (events: typeof history) =>
				events.map((e) => `${e.change} ${e.goalId}`).sort();
			expect(byChange(history)).toEqual(
				[
					`created ${fiveK.id}`,
					`updated ${fight.id}`,
					`status_changed ${strength.id}`,
					// Achieving it closes it, so the 5K moves up from 3 to 2.
					`reprioritized ${fiveK.id}`
				].sort()
			);
			expect(await goalHistory(ownerId, { db })).toHaveLength(before.length + history.length);

			// A second proposal reranks them: the new top goal is its applied_ref.
			const { proposal: rerank } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'goal_update',
						{ ops: [{ op: 'reorder', ids: [fiveK.id, fight.id] }] },
						'Put the 5K first'
					)
				},
				deps
			);
			const reranked = await acceptProposal(ownerId, rerank.id, deps);
			expect(reranked.proposal.appliedRef).toEqual({ kind: 'goal', id: fiveK.id });
			expect((await listGoals(ownerId, { db })).slice(0, 2).map((g) => g.id)).toEqual([
				fiveK.id,
				fight.id
			]);
			const moves = (await coachGoalEvents(db, ownerId)).filter(
				(e) => e.change === 'reprioritized'
			);
			expect(moves.map((e) => e.goalId).sort()).toEqual([fiveK.id, fiveK.id, fight.id].sort());

			// Each accept wrote one decision note with the rationale as its why.
			const notes = await latestNotes(ownerId, 'coach_decision', {}, deps);
			expect(notes).toHaveLength(2);
			expect(notes[1]).toMatchObject({
				kind: 'coach_decision',
				body: {
					kind: 'goal_update',
					what: 'Add a 5K goal',
					why: RATIONALE,
					proposalId: proposal.id,
					ownerWords: null
				},
				summary: `Add a 5K goal: ${RATIONALE}`,
				runId: null
			});
			expect(notes[1]!.subjects).toEqual([
				{ type: 'goal', id: fiveK.id },
				{ type: 'goal', id: fight.id },
				{ type: 'goal', id: strength.id },
				{ type: 'proposal', id: proposal.id }
			]);
			expect(notes[0]!.body).toMatchObject({ what: 'Put the 5K first', proposalId: rerank.id });
		});
	});

	it('refuses a proposal whose goal was deleted, or whose ranking is stale, writing nothing', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const fight = await createGoal(ownerId, eventGoal(), { db });
			const strength = await createGoal(ownerId, generalGoal(), { db });
			const { proposal: edit } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'goal_update',
						{ ops: [{ op: 'set_status', goalId: strength.id, status: 'achieved' }] },
						'Mark strength done'
					)
				},
				deps
			);
			const { proposal: rerank } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'goal_update',
						{ ops: [{ op: 'reorder', ids: [strength.id, fight.id] }] },
						'Strength first'
					)
				},
				deps
			);

			await deleteGoal(ownerId, strength.id, { db });
			expect(await refusal(acceptProposal(ownerId, edit.id, deps))).toEqual({
				'payload.ops.0.goalId': RULE_MESSAGES.unknownGoal
			});

			// The ranking named every open goal when it was proposed; a goal added since is missing.
			const { proposal: rerank2 } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'goal_update',
						{ ops: [{ op: 'reorder', ids: [fight.id] }] },
						'Fight first'
					)
				},
				deps
			);
			await createGoal(ownerId, generalGoal({ title: 'Run a sub-25 5K' }), { db });
			const history = await goalHistory(ownerId, { db });
			expect(await refusal(acceptProposal(ownerId, rerank2.id, deps))).toEqual({
				'payload.ops.0.ids': 'Rank every open goal exactly once'
			});
			expect(await refusal(acceptProposal(ownerId, rerank.id, deps))).toEqual({
				'payload.ops.0.ids.0': RULE_MESSAGES.unknownGoal
			});

			for (const id of [edit.id, rerank.id, rerank2.id]) {
				expect(await getProposalView(ownerId, id, deps)).toMatchObject({
					status: 'proposed',
					appliedRef: null
				});
			}
			expect(await goalHistory(ownerId, { db })).toEqual(history);
			expect(await coachGoalEvents(db, ownerId)).toEqual([]);
			expect(await noteCount(db)).toBe(0);
		});
	});
});

describe('accepting a preference_update', () => {
	it('records it with source coach: applied_ref set, no program version, and a decision note', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const { versionId } = await createProgramFromPlan(ownerId, plan, { source: 'rules' }, { db });
			const bench = await benchId(db);
			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'preference_update',
						{ exerciseId: bench, sentiment: 'like', reason: 'It suits my shoulders' },
						'Like bench press'
					)
				},
				deps
			);
			const { proposal: applied } = await acceptProposal(ownerId, proposal.id, deps);

			const [preference] = await listExercisePreferences(ownerId, { db });
			expect(preference).toMatchObject({
				exerciseId: bench,
				exercise: 'Bench press',
				sentiment: 'like',
				reason: 'It suits my shoulders',
				source: 'coach'
			});
			expect(applied).toMatchObject({
				status: 'applied',
				appliedRef: { kind: 'preference', id: preference!.id },
				appliedVersion: null
			});
			const current = await createProgramsRepository(db).currentProgram(ownerId);
			expect(current?.version.id).toBe(versionId);

			const [note] = await latestNotes(ownerId, 'coach_decision', {}, deps);
			expect(note).toMatchObject({
				body: { kind: 'preference_update', what: 'Like bench press', why: RATIONALE },
				subjects: [
					{ type: 'preference', id: preference!.id, label: 'Bench press' },
					{ type: 'exercise', id: bench, label: 'Bench press' },
					{ type: 'proposal', id: proposal.id }
				]
			});
		});
	});

	it('waits for the preference lock, and applies on top of what the other writer stored', async () => {
		await withCommitted(async (db) => {
			const { ownerId, deps } = await owner(db);
			const bench = await benchId(db);
			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: draft(
						'preference_update',
						{ exerciseId: bench, sentiment: 'like', reason: null },
						'Like bench press'
					)
				},
				deps
			);
			// Profile → Exercises (or a swap) is saving a dislike of the same exercise right now.
			const held = await holdTransaction((tx) =>
				recordExercisePreference(
					ownerId,
					{ exerciseId: bench, sentiment: 'dislike', reason: 'Old shoulder', source: 'profile' },
					{ db: tx }
				)
			);
			let settled = false;
			const accepting = acceptProposal(ownerId, proposal.id, deps).finally(() => {
				settled = true;
			});
			await lockWaiters(1);
			expect(settled).toBe(false);
			await held.commit();
			expect((await accepting).proposal.status).toBe('applied');

			const rows = await db
				.select()
				.from(exercisePreferences)
				.where(eq(exercisePreferences.ownerId, ownerId));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				exerciseId: bench,
				sentiment: 'like',
				source: 'coach',
				reason: null
			});
		});
	});
});

describe('coach notes', () => {
	it('validates a note by its kind, its summary and what it names, writing nothing', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const workoutId = await workoutOf(db, ownerId);
			const decision = {
				kind: 'preference_update',
				what: 'Dislike lunges',
				why: 'You said they hurt your knee',
				proposalId: null,
				ownerWords: 'I hate lunges'
			} as const;
			const save = (input: Partial<Parameters<typeof saveNote>[1]>) =>
				saveNote(
					ownerId,
					{ kind: 'coach_decision', body: decision, summary: 'Dislike lunges', ...input },
					deps
				);

			expect(await inputError(save({ kind: 'diary' as never }))).toEqual([
				'kind',
				'Unknown note kind'
			]);
			expect(await inputError(save({ body: { ...decision, ownerWords: null } }))).toEqual([
				'body.proposalId',
				'A decision rests on an accepted proposal or the owner’s own words'
			]);
			expect(await inputError(save({ body: { ...decision, mood: 'great' } }))).toEqual([
				'body',
				'Unknown field: mood'
			]);
			expect(await inputError(save({ body: { ...decision, why: '  ' } }))).toEqual([
				'body.why',
				'Say why'
			]);
			expect(await inputError(save({ summary: ' ' }))).toEqual(['summary', 'Say what it is']);
			expect(await inputError(save({ summary: 'x'.repeat(1001) }))).toEqual([
				'summary',
				'Up to 1000 characters'
			]);
			expect(await inputError(save({ subjects: [{ type: 'diary' as never, id: 'x' }] }))).toEqual([
				'subjects.0.type',
				'Unknown record type'
			]);
			expect(
				await inputError(
					saveWorkoutAnalysis(
						ownerId,
						{
							analysis: {
								workoutId,
								headline: 'Solid',
								points: Array.from({ length: 9 }, () => 'A point')
							}
						},
						deps
					)
				)
			).toEqual(['body.points', 'Up to 8 points']);
			await expect(save({ runId: crypto.randomUUID() })).rejects.toBeInstanceOf(CoachNotFoundError);
			expect(await inputError(latestNotes(ownerId, 'coach_decision', { limit: 0 }, deps))).toEqual([
				'limit',
				'1 to 20 at a time'
			]);
			expect(await noteCount(db)).toBe(0);

			// A direct preference write quotes the owner; an analysis names its workout.
			const quoted = await recordCoachDecision(
				ownerId,
				{ decision, subjects: [{ type: 'exercise', id: 'lunge' }] },
				deps
			);
			expect(quoted).toMatchObject({
				summary: 'Dislike lunges: You said they hurt your knee',
				subjects: [{ type: 'exercise', id: 'lunge' }],
				body: decision
			});
			const analysis = await saveWorkoutAnalysis(
				ownerId,
				{
					analysis: {
						workoutId,
						headline: 'Squat moved well',
						points: ['Top set at RPE 8', 'Rest ran long']
					}
				},
				deps
			);
			expect(analysis).toMatchObject({
				summary: 'Squat moved well Top set at RPE 8 Rest ran long',
				subjects: [{ type: 'workout', id: workoutId }]
			});
			expect(await latestNotes(ownerId, 'workout_analysis', {}, deps)).toEqual([analysis]);
			expect(await noteCount(db)).toBe(2);
		});
	});

	it('saves nothing for a random owner id, even naming the seeded owner’s workout: not found', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const workoutId = await workoutOf(db, ownerId);
			await saveWorkoutAnalysis(
				ownerId,
				{ analysis: { workoutId, headline: 'Solid', points: [] } },
				deps
			);
			const stranger = crypto.randomUUID();
			const before = await noteCount(db);
			const decision = {
				kind: 'preference_update' as const,
				what: 'Dislike lunges',
				why: 'You said so',
				proposalId: null,
				ownerWords: 'I hate lunges'
			};

			// One at a time: they share the test's transaction.
			for (const attempt of [
				() =>
					saveNote(
						stranger,
						{ kind: 'coach_decision', body: decision, summary: 'Dislike lunges' },
						deps
					),
				() => recordCoachDecision(stranger, { decision }, deps),
				() =>
					saveWorkoutAnalysis(
						stranger,
						{ analysis: { workoutId, headline: 'Solid', points: [] } },
						deps
					)
			]) {
				await expect(attempt()).rejects.toBeInstanceOf(CoachNotFoundError);
			}
			// The owner may analyse only a workout of theirs that is still there.
			await expect(
				saveWorkoutAnalysis(
					ownerId,
					{ analysis: { workoutId: crypto.randomUUID(), headline: 'Solid', points: [] } },
					deps
				)
			).rejects.toThrow('workout not found');
			await db
				.update(workouts)
				.set({ deletedAt: new Date() })
				.where(eq(workouts.clientId, workoutId));
			await expect(
				saveWorkoutAnalysis(
					ownerId,
					{ analysis: { workoutId, headline: 'Solid', points: [] } },
					deps
				)
			).rejects.toThrow('workout not found');

			expect(await noteCount(db)).toBe(before);
			expect(
				await db.select({ n: count() }).from(coachNotes).where(eq(coachNotes.ownerId, stranger))
			).toEqual([{ n: 0 }]);
			expect(await latestNotes(stranger, 'workout_analysis', {}, deps)).toEqual([]);
		});
	});
});
