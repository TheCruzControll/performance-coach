/**
 * Every table the scratch source would otherwise leave empty, given one row each through the
 * services (or, where a table has no service writer, its repository), on top of prepareSource's
 * owner, profile, program and history. Nothing here adds a set_records row.
 */
import { eq } from 'drizzle-orm';
import { createMutation } from '../../../src/lib/domain/workout/index';
import { createAppErrorsRepository, workouts, type Executor } from '../../../src/lib/server/db';
import { MockProvider } from '../../../src/lib/server/agent/provider/mock';
import { runTurn } from '../../../src/lib/server/agent/turn';
import { recordCoachDecision } from '../../../src/lib/server/services/coach/notes';
import {
	saveBaselines,
	saveBody,
	saveEquipment,
	saveExercisePreferences,
	saveExperience,
	saveInjuries,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import {
	createCycleReview,
	createWeeklyReview,
	reviewableBlock
} from '../../../src/lib/server/services/reviews/index';
import {
	addRunSegment,
	editRun,
	recordRecoveryNote,
	recordSubstitution
} from '../../../src/lib/server/services/training/log';
import { recordVitals } from '../../../src/lib/server/services/vitals';
import { applyMutation } from '../../../src/lib/server/services/workouts/sync';

export interface EveryTableContext {
	ownerId: string;
	now: () => Date;
	/** prepareSource's strength workout and run, by workouts.id. */
	strengthWorkoutId: string;
	runWorkoutId: string;
	exercises: { back_squat: string; bench_press: string };
}

async function clientIdOf(db: Executor, id: string): Promise<string> {
	const [row] = await db
		.select({ clientId: workouts.clientId })
		.from(workouts)
		.where(eq(workouts.id, id));
	return row!.clientId;
}

export async function seedEveryTable(db: Executor, ctx: EveryTableContext): Promise<void> {
	const { ownerId } = ctx;
	const deps = { db, now: ctx.now };
	const strengthClientId = await clientIdOf(db, ctx.strengthWorkoutId);
	const runClientId = await clientIdOf(db, ctx.runWorkoutId);

	// Profile sections.
	await saveExperience(
		ownerId,
		{ entries: [{ discipline: 'strength', level: 'intermediate', years: 5, sessionsPerWeek: 3 }] },
		deps
	);
	await saveBaselines(
		ownerId,
		{
			unknown: false,
			lifts: [
				{ lift: 'back_squat', source: 'tested', value: 160, unit: 'kg', achievedOn: '2026-10-01' }
			]
		},
		deps
	);
	await saveSpecifics(
		ownerId,
		{
			running: {
				unit: 'km',
				weeklyDistance: 25,
				runsPerWeek: 3,
				longestRun: 12,
				easyPaceSeconds: 330,
				races: [{ distance: '5k', timeSeconds: 1380, racedOn: '2026-09-20', eventName: null }],
				notes: null
			},
			muayThai: { sessionsPerWeek: 2, sparringPerWeek: 1, fights: 0, notes: null }
		},
		deps
	);
	await saveEquipment(
		ownerId,
		{
			gymType: 'commercial',
			equipment: ['barbell', 'squat_rack', 'bench'],
			homeEquipment: [],
			notes: null
		},
		deps
	);
	await saveInjuries(
		ownerId,
		{
			injuries: [
				{
					bodyArea: 'knee',
					side: 'left',
					severity: 'mild',
					notes: null,
					avoid: [],
					active: true,
					since: null
				}
			]
		},
		deps
	);
	await saveExercisePreferences(
		ownerId,
		{ items: [{ exercise: 'Back squat', sentiment: 'like', reason: null }] },
		deps
	);
	await saveBody(
		ownerId,
		{
			birthYear: null,
			weightUnit: 'kg',
			bodyWeight: 80,
			nutritionPhase: null,
			targetWeight: null,
			targetDate: null
		},
		deps
	);

	// Training log.
	await recordRecoveryNote(
		ownerId,
		{
			clientMutationId: crypto.randomUUID(),
			notedOn: '2026-11-10',
			sleepHours: 7.5,
			soreness: 2,
			energy: 4,
			stress: 2,
			note: null
		},
		{ db }
	);
	await recordSubstitution(
		ownerId,
		{
			clientMutationId: crypto.randomUUID(),
			workoutClientId: strengthClientId,
			plannedExerciseLineageId: null,
			exercisePosition: 1,
			fromExerciseId: ctx.exercises.back_squat,
			toExerciseId: ctx.exercises.bench_press,
			reason: 'equipment_unavailable'
		},
		{ db }
	);
	await addRunSegment(
		ownerId,
		runClientId,
		{
			clientMutationId: crypto.randomUUID(),
			position: 1,
			kind: 'easy',
			distance: { value: 8042, unit: 'm' },
			durationSeconds: 2700,
			avgHr: null,
			rpe: null
		},
		{ db }
	);
	// A real change to the run, so its audit trigger writes a training_audit row.
	const edited = await editRun(
		ownerId,
		runClientId,
		{
			distance: { value: 8042, unit: 'm' },
			durationSeconds: 2700,
			avgHr: null,
			rpe: null,
			notes: null
		},
		{ db }
	);
	if (!edited.changed) throw new Error('editRun changed nothing, so no training_audit row');
	// One pain.report through the sync path: a sync_mutations row and a pain_reports row.
	const pain = createMutation('pain.report', {
		workoutId: strengthClientId,
		at: '2026-11-09T17:20:00Z',
		payload: {
			position: 1,
			plannedLineage: null,
			exerciseId: ctx.exercises.back_squat,
			area: 'knee',
			severity: 'mild',
			action: 'stopped',
			substitutionId: null,
			note: 'Knee twinge'
		}
	});
	const applied = await applyMutation(ownerId, JSON.parse(JSON.stringify(pain)), deps);
	if (applied.status !== 'applied') throw new Error(`pain.report ${applied.status}`);

	// Telemetry.
	await recordVitals(
		{
			id: 'v1-scratch-lcp',
			name: 'LCP',
			value: 1234,
			rating: 'good',
			path: '/today',
			route: '/(app)/today'
		},
		{},
		{ db }
	);
	await createAppErrorsRepository(db).insert({ kind: 'client', message: 'Error: scratch seed' });

	// One coach turn: a thread, its messages, a run, its model and tool calls, and a proposal.
	const turnNow = () => new Date('2026-11-11T09:00:00Z');
	const provider = new MockProvider(
		[
			{
				name: 'scratch-propose',
				matches: () => true,
				steps: [
					{
						tools: [
							{
								name: 'update_exercise_preferences',
								input: {
									exercise: 'Bulgarian split squat',
									sentiment: 'dislike',
									reason: 'Balance',
									title: 'No more Bulgarian split squat',
									rationale: 'You said you dislike it.'
								}
							}
						]
					},
					{ text: '[note] Done.' }
				]
			}
		],
		{ overrides: () => ({}) }
	);
	let runId: string | null = null;
	let proposalId: string | null = null;
	for await (const event of runTurn(
		{
			ownerId,
			threadId: null,
			clientMessageId: crypto.randomUUID(),
			text: 'What do you make of my leg day?',
			signal: new AbortController().signal
		},
		{ provider: { status: 'ready', provider }, deps: { db, now: turnNow } }
	)) {
		if (event.type === 'run_started') runId = event.runId;
		if (event.type === 'proposal') proposalId = event.id;
		if (event.type === 'done' && event.status !== 'completed')
			throw new Error(`scratch turn ended ${event.status}`);
	}
	if (!runId || !proposalId) throw new Error('the scratch turn stored no proposal');
	await recordCoachDecision(
		ownerId,
		{
			decision: {
				kind: 'preference_update',
				what: 'No more Bulgarian split squat',
				why: 'You said you dislike it.',
				proposalId: null,
				ownerWords: 'What do you make of my leg day?'
			},
			runId
		},
		{ db, now: turnNow }
	);

	// The reviews, once the program's first week and block have ended.
	const reviewNow = () => new Date('2026-11-16T09:00:00Z');
	await createWeeklyReview(
		ownerId,
		{ weekStartsOn: '2026-11-09', today: '2026-11-16' },
		{ db, now: reviewNow }
	);
	const block = await reviewableBlock(ownerId, '2026-11-16', { db });
	if (!block) throw new Error('no reviewable block on 2026-11-16');
	await createCycleReview(
		ownerId,
		{ programId: block.programId, blockLineage: block.blockLineage, today: '2026-11-16' },
		{ db, now: reviewNow }
	);
}
