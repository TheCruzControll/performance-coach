/**
 * Words for each mutation, as the sync sheet lists a change waiting or refused (PRD §18, failed
 * sync recovery): 'Set 3 of Back squat · 100 kg × 5', and why it needs the owner: 'Weight: Up to
 * 1000 kg', 'Couldn't sync for a day: the server answered 500'. Pure; the names come from the
 * caller, because a change can outlive what the device knows (a purge leaves no exercise names).
 */
import type { FieldErrors } from '../validation.ts';
import { formatDuration, formatWeight } from '../units.ts';
import type { Mutation } from './mutations.ts';
import type { LoggedSet } from './types.ts';

export interface DescribeContext {
	/** An exercise's name, or undefined when this device no longer holds it. */
	exerciseName(exerciseId: string): string | undefined;
	/** A set this device shows, by its client id: where it sits. */
	set(setId: string): { setIndex: number; exerciseId: string } | undefined;
}

type Values = Pick<LoggedSet, 'reps' | 'seconds' | 'metres' | 'weight' | 'assistance' | 'unit'>;

/** What a set records: '100 kg × 5', '8 reps', '0:45', '400 m', '6 reps · 20 kg assist'. */
export function setValues(s: Values): string {
	const amount =
		s.seconds !== null
			? formatDuration(s.seconds)
			: s.metres !== null
				? `${s.metres} m`
				: `${s.reps ?? 0} reps`;
	if (s.weight !== null) return `${formatWeight(s.weight, s.unit)} × ${s.reps ?? amount}`;
	if (s.assistance !== null) return `${amount} · ${formatWeight(s.assistance, s.unit)} assist`;
	return amount;
}

/** One line per change, naming what it changes. */
export function describeMutation(m: Mutation, context: DescribeContext): string {
	const exercise = (id: string) => context.exerciseName(id) ?? 'an exercise';
	const setOf = (setIndex: number, exerciseId: string) =>
		`Set ${setIndex} of ${exercise(exerciseId)}`;
	const existing = (setId: string) => {
		const at = context.set(setId);
		return at ? setOf(at.setIndex, at.exerciseId) : 'A set';
	};
	switch (m.type) {
		case 'workout.start':
			return `Workout started · ${m.payload.title}`;
		case 'workout.update':
			return 'Workout notes and effort';
		case 'workout.finish':
			return 'Workout finished';
		case 'workout.abandon':
			return 'Workout abandoned';
		case 'set.log':
			return `${setOf(m.payload.setIndex, m.payload.exerciseId)} · ${setValues(m.payload)}`;
		case 'set.skip':
			return `${setOf(m.payload.setIndex, m.payload.exerciseId)} · Skipped`;
		case 'set.edit':
			return `${existing(m.entityId)} · changed to ${setValues(m.payload)}`;
		case 'set.delete':
			return `${existing(m.entityId)} · Deleted`;
		case 'exercise.skip':
			return `${exercise(m.payload.exerciseId)} · the rest skipped`;
		case 'exercise.substitute':
			return `${exercise(m.payload.fromExerciseId)} swapped for ${exercise(m.payload.toExerciseId)}`;
		case 'exercise.dislike':
			return `${exercise(m.payload.fromExerciseId)} disliked · swapped for ${exercise(m.payload.toExerciseId)}`;
		case 'exercise.create':
			return `New exercise · ${m.payload.name}`;
		case 'pain.report':
			return `Pain during ${exercise(m.payload.exerciseId)}`;
		case 'run.log':
			return 'Run details';
		case 'run.segment':
			return `Run segment ${m.payload.position}`;
		case 'other.log':
			return 'Session details';
	}
}

/** A refusal's field, as the owner calls it: 'payload.weight' is Weight. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
	rpe: 'RPE',
	missedReps: 'Missed reps',
	seconds: 'Time',
	metres: 'Distance',
	plannedSessionId: 'Planned session'
};

const fieldOf = (path: string) => {
	const last = path.split('.').at(-1) ?? path;
	return FIELD_WORDS[last] ?? `${last.charAt(0).toUpperCase()}${last.slice(1)}`;
};

/** Why a change needs the owner: what was refused, or what kept failing. */
export interface Problem {
	reason: 'refused' | 'stuck';
	errors: FieldErrors;
	message: string;
}

/**
 * The refusal's fields in words ('Weight: Up to 1000 kg'), else its reason; a stuck change says
 * how long it kept failing: after `tries` failures, or (null) for a day, then its last error.
 */
export function problemText(problem: Problem, tries: number | null): string {
	if (problem.reason === 'stuck') {
		const error = `${problem.message.charAt(0).toLowerCase()}${problem.message.slice(1)}`;
		const how = tries === null ? 'for a day' : `after ${tries} tries`;
		return `Couldn't sync ${how}: ${error}`;
	}
	const fields = Object.entries(problem.errors).map(([path, text]) => `${fieldOf(path)}: ${text}`);
	return fields.length > 0 ? fields.join(' · ') : problem.message;
}
