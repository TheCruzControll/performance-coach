/**
 * A run's and a class's quick actions as what they send (PRD §6, 'equivalents for other
 * disciplines'), pure, loaded with SessionActionsSheet, never before.
 * - This hurts: one pain.report naming no exercise, at the run's segment on screen (a class:
 *   position 1), action ended_workout (SESSION_PAIN_CHOICES); the sheet then opens Finish.
 *   Never a preference or a program change.
 * - Skip this segment sends nothing: a goTo to run-log.ts nextToLog's segment, since a run has
 *   no skipped-segment row and a planned segment left unlogged already reads as not done.
 * - Swap in a run: the run ends where it is (runEnd: its finish with finishValues when anything
 *   was run, else its abandon, with the stopwatch's pause), then a zone 2 bike session starts,
 *   pinned to the run's planned session (bikeStart). Two workouts, two dispatches; no new
 *   mutation type. Its minutes are the run's unlogged segments' (run-log.ts minutesToRun).
 * - Swap in a class: a lighter Muay Thai format (lighterKinds), which the class view sets as
 *   its type field; nothing is sent until Save.
 */
import type { OtherSessionKind } from '#lib/domain/training/vocabulary.ts';
import type {
	LocalAction,
	Mutation,
	OtherKit,
	RunKit,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { lighterKinds, SWAP_BIKE } from '#lib/domain/workout/substitution.ts';
import type { PainDetails } from './actions.ts';
import { finishMutation, finishValues } from './finish.ts';

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

/** What Swap's options panel offers, one choice each. */
export type SwapChoice =
	{ to: 'bike'; minutes: number } | { to: 'lighter'; kind: OtherSessionKind };

/**
 * Swap's choices: in a run with its kit, the bike for `minutesLeft` (SWAP_BIKE.fallbackMinutes
 * when null); in a class, lighterKinds of `sessionKind` (the type its fields show). Empty hides
 * Swap: a run without its kit, or a class with nothing lighter.
 */
export function swapOptions(
	view: WorkoutView,
	sessionKind: OtherSessionKind | null,
	minutesLeft: number | null
): SwapChoice[] {
	if (view.workout.kind === 'run') {
		return view.kit?.kind === 'run'
			? [{ to: 'bike', minutes: minutesLeft ?? SWAP_BIKE.fallbackMinutes }]
			: [];
	}
	if (sessionKind === null) return [];
	return lighterKinds(sessionKind, view.workout.discipline).map((kind): SwapChoice => ({
		to: 'lighter',
		kind
	}));
}

/**
 * The run's end before the bike: its finish, with the Finish sheet's starting values, when
 * anything was run (a segment, or a run distance or duration); else its abandon. With the
 * stopwatch's pause. `at` is epoch ms on this device.
 */
export function runEnd(view: WorkoutView, at: number): [Mutation, LocalAction] {
	const workoutId = view.workout.id;
	const run = view.run;
	const ran =
		run !== null &&
		(run.segments.length > 0 || run.distanceMetres !== null || run.durationSeconds !== null);
	const end = ran
		? finishMutation(workoutId, finishValues(view, at), at)
		: createMutation('workout.abandon', {
				workoutId,
				at: new Date(at).toISOString(),
				payload: {}
			});
	return [end, { type: 'stopwatch.pause', workoutId, at }];
}

/**
 * The bike session's kit: the run's kit as an OtherKit (date, units, versionNumber kept), titled
 * and typed as SWAP_BIKE, no target RPE and no metrics, pinned as the run's workout row is (a run
 * kept unplanned stays unplanned, whatever its kit says).
 */
export function bikeKit(view: WorkoutView, kit: RunKit, minutes: number): OtherKit {
	const { run: _segments, ...base } = kit;
	return {
		...base,
		kind: 'other',
		title: SWAP_BIKE.title,
		sessionType: SWAP_BIKE.sessionType,
		plannedSessionId: view.workout.plannedSessionId,
		plannedLineage: view.workout.plannedLineage,
		programId: view.workout.programId,
		other: { kind: SWAP_BIKE.kind, durationMinutes: minutes, targetRpe: null, metrics: [] }
	};
}

/**
 * The bike session's start, as start.ts begins one: workout.start under a new workout id (the
 * kit's title, session type, the run's discipline, the row's pins), kit.attach and
 * stopwatch.start at `at`.
 */
export function bikeStart(
	view: WorkoutView,
	kit: RunKit,
	minutes: number,
	at: number,
	newId: () => string = () => crypto.randomUUID()
): [Mutation, LocalAction, LocalAction] {
	const workoutId = newId();
	const { plannedSessionId, plannedLineage, programId } = view.workout;
	const start = createMutation('workout.start', {
		workoutId,
		at: new Date(at).toISOString(),
		payload: {
			kind: 'other',
			title: SWAP_BIKE.title,
			sessionType: SWAP_BIKE.sessionType,
			discipline: kit.discipline,
			plannedSessionId,
			plannedLineage,
			programId
		}
	});
	return [
		start,
		{ type: 'kit.attach', workoutId, kit: bikeKit(view, kit, minutes) },
		{ type: 'stopwatch.start', workoutId, at }
	];
}
