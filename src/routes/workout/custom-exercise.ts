/**
 * Add my own exercise (PRD §7; the M4 plan's open question on custom exercises from a workout):
 * the short form's defaults and checks, pure, loaded with CustomExerciseSheet, never before.
 * - Asked: the name, how it is measured and how it is loaded. Everything else has a default:
 *   - a time-measured exercise's bout or hold, from the exercise being replaced, else
 *     DEFAULT_BOUT_SECONDS (the schema requires one)
 *   - the movement pattern, from the exercise being replaced; from the picker, with nothing
 *     replaced, it is asked too, because no pattern is an honest guess
 *   - the main muscles, from the pattern (PATTERN_MUSCLES); an isolation exercise names its own
 *   - equipment: none, optional
 * - Aliases, secondary muscles and the unilateral flag are left for Profile → Exercises.
 * - checkDraft checks what the server's schema would, and the name against the cached library as
 *   the server does (library.ts nameClash), so a clash shows before anything is sent. A name the
 *   owner retired is not in the library: the server refuses it, and Fix reopens this form.
 */
import { nameClash } from '#lib/client/workout/library.ts';
import type { Equipment } from '#lib/domain/profile/catalog.ts';
import type { CustomExercise } from '#lib/domain/training/types.ts';
import type {
	LoadType,
	Measure,
	MovementPattern,
	Muscle
} from '#lib/domain/training/vocabulary.ts';
import type { LibraryExercise } from '#lib/domain/workout/index.ts';

/** Owner decision: a time-measured exercise's bout or hold when nothing replaced gives one. */
export const DEFAULT_BOUT_SECONDS = 30;

/** The schema's bounds: a name of up to 80 characters, a bout of up to an hour. */
export const NAME_MAX = 80;
const SECONDS_MAX = 3600;
const MUSCLES_MAX = 6;
const EQUIPMENT_MAX = 10;

/**
 * Owner decision: the main muscles a pattern works, which the form starts from. Isolation has
 * none: the owner names the muscle.
 */
export const PATTERN_MUSCLES: Readonly<Record<MovementPattern, readonly Muscle[]>> = {
	squat: ['quads', 'glutes'],
	hinge: ['glutes', 'hamstrings'],
	lunge: ['quads', 'glutes'],
	horizontal_push: ['chest', 'triceps'],
	vertical_push: ['front_delts', 'triceps'],
	horizontal_pull: ['upper_back', 'lats'],
	vertical_pull: ['lats', 'biceps'],
	carry: ['forearms', 'traps'],
	rotation: ['obliques'],
	anti_rotation: ['obliques'],
	anti_extension: ['abs'],
	trunk_flexion: ['abs'],
	olympic: ['glutes', 'quads'],
	plyometric: ['quads', 'calves'],
	conditioning: ['quads', 'glutes'],
	isolation: [],
	mobility: ['hip_flexors']
};

/** The form's values; the choices start empty. */
export interface CustomDraft {
	name: string;
	measure: Measure | null;
	loadType: LoadType | null;
	seconds: number | null;
	pattern: MovementPattern | null;
	muscles: Muscle[];
	equipment: Equipment[];
}

/** What the form starts from: the exercise being replaced, if any. */
export interface Replaced {
	pattern: MovementPattern;
	defaultSeconds?: number | null;
}

export function draftFor(replaced: Replaced | null): CustomDraft {
	return {
		name: '',
		measure: null,
		loadType: null,
		seconds: replaced?.defaultSeconds ?? DEFAULT_BOUT_SECONDS,
		pattern: replaced?.pattern ?? null,
		muscles: replaced ? [...PATTERN_MUSCLES[replaced.pattern]] : [],
		equipment: []
	};
}

/** A refused exercise.create's payload as the form shows it again (Fix). */
export function draftOf(exercise: CustomExercise): CustomDraft {
	return {
		name: exercise.name,
		measure: exercise.measure,
		loadType: exercise.loadType,
		seconds: exercise.defaultSeconds ?? DEFAULT_BOUT_SECONDS,
		pattern: exercise.pattern,
		muscles: [...exercise.primaryMuscles],
		equipment: [...exercise.equipment]
	};
}

/** The form's fields that can be wrong, as the server's payload paths name them. */
export type DraftField =
	'name' | 'measure' | 'loadType' | 'defaultSeconds' | 'pattern' | 'primaryMuscles' | 'equipment';

export type DraftCheck =
	| { ok: true; exercise: CustomExercise }
	| { ok: false; errors: Partial<Record<DraftField, string>> };

/**
 * The draft as exercise.create's payload, or what is wrong with it. `base` is a refused payload
 * whose other fields Fix keeps; `except` its id, which the cached library may list already.
 */
export function checkDraft(
	draft: CustomDraft,
	exercises: readonly LibraryExercise[],
	{ base, except }: { base?: CustomExercise; except?: string } = {}
): DraftCheck {
	const errors: Partial<Record<DraftField, string>> = {};
	const name = draft.name.trim().replace(/\s+/g, ' ');
	if (!name) errors.name = 'Name it';
	else if (name.length > NAME_MAX) errors.name = `Up to ${NAME_MAX} characters`;
	else {
		const clash = nameClash(exercises, name, except);
		if (clash) errors.name = clash;
	}
	if (!draft.measure) errors.measure = 'Reps, time or distance?';
	if (!draft.loadType) errors.loadType = 'Pick how it is loaded';
	const timed = draft.measure === 'time';
	const seconds = draft.seconds;
	if (
		timed &&
		(seconds === null || !Number.isInteger(seconds) || seconds < 1 || seconds > SECONDS_MAX)
	) {
		errors.defaultSeconds = 'How long is one bout or hold? Up to an hour';
	}
	if (!draft.pattern) errors.pattern = 'Pick a movement pattern';
	if (draft.muscles.length === 0) errors.primaryMuscles = 'Pick a muscle';
	if (draft.muscles.length > MUSCLES_MAX)
		errors.primaryMuscles = `Up to ${MUSCLES_MAX} main muscles`;
	if (draft.equipment.length > EQUIPMENT_MAX) errors.equipment = `Up to ${EQUIPMENT_MAX}`;
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	const exercise: CustomExercise = {
		aliases: [],
		secondaryMuscles: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: null,
		repMax: null,
		unilateral: false,
		tags: [],
		disciplines: [],
		...base,
		name,
		measure: draft.measure!,
		loadType: draft.loadType!,
		defaultSeconds: timed ? seconds : null,
		pattern: draft.pattern!,
		primaryMuscles: [...draft.muscles],
		equipment: [...draft.equipment]
	};
	// The schema's rules: reps ranges only for reps, a muscle primary or secondary, not both.
	if (exercise.measure !== 'reps') [exercise.repMin, exercise.repMax] = [null, null];
	exercise.secondaryMuscles = exercise.secondaryMuscles.filter((m) => !draft.muscles.includes(m));
	return { ok: true, exercise };
}
