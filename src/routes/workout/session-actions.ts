/**
 * A run's and a class's quick actions as what they send (PRD §6, 'equivalents for other
 * disciplines'), pure, loaded with SessionActionsSheet, never before.
 * - This hurts: one pain.report naming no exercise, at the run's segment on screen (a class:
 *   position 1), action ended_workout (SESSION_PAIN_CHOICES); the sheet then opens Finish.
 *   Never a preference or a program change.
 * - Skip this segment sends nothing: a goTo to run-log.ts nextToLog's segment, since a run has
 *   no skipped-segment row and a planned segment left unlogged already reads as not done.
 */
import type { Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import type { PainDetails } from './actions.ts';

/** This hurts in a run or a class: the report, ending the session; a blank note is none. */
export function sessionPain(view: WorkoutView, details: PainDetails, at: string): Mutation {
	const position = view.workout.kind === 'run' ? view.device.position : 1;
	const payload = {
		position,
		plannedLineage: null,
		exerciseId: null,
		area: details.area,
		severity: details.severity,
		note: details.note?.trim() || null,
		action: 'ended_workout' as const,
		substitutionId: null
	};
	return createMutation('pain.report', { workoutId: view.workout.id, at, payload });
}
