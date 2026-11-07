/** A valid coach proposal of every kind (test-only, never imported by app code). */
import type { ProposalKind } from '../../src/lib/domain/coach/proposals';

export const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
export const OTHER_SESSION = 'a1b2c3d4-0000-4000-8000-000000000011';
export const PAST_SESSION = 'a1b2c3d4-0000-4000-8000-000000000021';
export const PLANNED = 'a1b2c3d4-0000-4000-8000-000000000002';
export const EXERCISE = 'a1b2c3d4-0000-4000-8000-000000000003';
export const ALTERNATIVE = 'a1b2c3d4-0000-4000-8000-000000000004';
export const DISLIKED = 'a1b2c3d4-0000-4000-8000-000000000005';
export const BLOCK = 'a1b2c3d4-0000-4000-8000-000000000006';
export const GOAL = 'a1b2c3d4-0000-4000-8000-000000000007';
export const WORKOUT = 'a1b2c3d4-0000-4000-8000-000000000008';

const envelope = (kind: ProposalKind, payload: unknown) => ({
	kind,
	title: 'A change',
	rationale: 'Your squat has stalled for three weeks.',
	payload
});

export const FIXTURES: Record<ProposalKind, ReturnType<typeof envelope>> = {
	program_adjustment: envelope('program_adjustment', {
		ops: [
			{ op: 'move', sessionLineage: SESSION, toDate: '2026-11-12' },
			{
				op: 'swap',
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				toExerciseId: ALTERNATIVE,
				scope: 'once'
			},
			{
				op: 'adjust_set',
				sessionLineage: OTHER_SESSION,
				plannedExerciseLineage: PLANNED,
				position: 1,
				sets: 3
			}
		]
	}),
	workout_update: envelope('workout_update', {
		ops: [
			{
				op: 'adjust_set',
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				position: 1,
				targetRpe: 7
			},
			{ op: 'skip', sessionLineage: SESSION }
		]
	}),
	session_substitution: envelope('session_substitution', {
		workoutId: WORKOUT,
		sessionLineage: SESSION,
		plannedExerciseLineage: PLANNED,
		position: 2,
		fromExerciseId: EXERCISE,
		toExerciseId: ALTERNATIVE,
		reason: 'equipment_unavailable'
	}),
	new_program: envelope('new_program', {
		start: 'next_monday',
		startsOn: '2026-11-16',
		firstPlannedDay: '2026-11-16',
		fingerprint: '0123456789abcdef',
		digest: 'fedcba9876543210'
	}),
	next_cycle: envelope('next_cycle', {
		fromBlockLineage: BLOCK,
		focus: 'Build squat strength toward a 3RM test',
		phase: 'intensification',
		weeks: 4,
		emphasis: ['quads', 'hips'],
		targets: { rpeCap: 9, volumeFactor: 0.9, loadStep: 0.025, runVolumeFactor: 1 },
		rotation: [{ fromExerciseId: EXERCISE, toExerciseId: ALTERNATIVE }],
		running: { weeklyMetres: 25_000, longRunMetres: 10_000 },
		ending: 'deload',
		constraints: ['Muay Thai on Tuesdays and Thursdays']
	}),
	goal_update: envelope('goal_update', {
		ops: [
			{
				op: 'add',
				goal: {
					kind: 'general',
					title: 'Squat 140 kg',
					disciplines: ['powerlifting'],
					focus: 'Squat strength',
					measure: 'A 140 kg single'
				}
			},
			{ op: 'set_status', goalId: GOAL, status: 'paused' },
			{ op: 'reorder', ids: [GOAL] }
		]
	}),
	preference_update: envelope('preference_update', {
		exerciseId: DISLIKED,
		sentiment: 'dislike',
		reason: 'Hurts my knee'
	})
};
