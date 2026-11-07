/**
 * What a planned exercise can be swapped for (PRD §5): the domain's alternatives
 * (domain/programming/alternatives.ts) over the owner's profile as the generator reads it, so the
 * swap sheet, the swap itself and the generator agree on what may be prescribed.
 *
 * - The library is the code catalogue (CATALOGUE) plus the owner's custom exercises, by key; ids
 *   are resolved by key only for what is offered.
 * - Each alternative comes with a short reason: it does the same job (its substitution group),
 *   or it moves the same way for the same muscles; one the owner likes says so.
 * - When nothing is eligible, `blocked` says why (whyNothingFits: 'Needs a barbell or
 *   dumbbells'), for the sheet's empty state; otherwise it is null.
 */
import { CATALOGUE } from '../../../domain/exercises/index';
import { alternativesFor as rank } from '../../../domain/programming/alternatives';
import { libraryOf, whyNothingFits, type Excluded } from '../../../domain/programming/eligibility';
import {
	buildProgrammingInput,
	toExerciseKey,
	type ExerciseKey,
	type LinkedPreference,
	type ProgrammingInput
} from '../../../domain/programming/input';
import { MOVEMENT_PATTERN_LABEL } from '../../../domain/training/vocabulary';
import type { ExerciseRef } from '../../../domain/training/types';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { getExercisesByIds, listCustomExercises, resolveKeys } from '../exercises/index';
import { isUuid } from '../ids';
import { getTrainingProfile } from '../profile/index';
import { listExercisePreferences } from '../training/preferences';
import { resolveDeps, TrainingNotFoundError, type TrainingDeps } from '../training/shared';

/** A library exercise the planned one can be swapped for. */
export interface ExerciseAlternative {
	/** The library row: what a swap sends as toExerciseId. */
	id: string;
	key: ExerciseKey;
	name: string;
	/** Why it keeps the exercise's purpose, in a few words. */
	reason: string;
}

export interface ExerciseAlternatives {
	/** Best first. */
	alternatives: ExerciseAlternative[];
	/** Why none is eligible, when there is none; otherwise null. */
	blocked: string | null;
}

/** The alternatives of one library exercise, and the ones it may not have, with their reasons. */
export interface RankedAlternatives extends ExerciseAlternatives {
	excluded: Excluded[];
}

/** Where the planned exercise is: in a session of the active program's current version. */
export interface PlannedExerciseAt {
	sessionLineage: string;
	plannedExerciseLineage: string;
}

/**
 * The owner's profile as the generator's input, read against CATALOGUE and their own exercises,
 * with their likes and dislikes linked (m3/31). Eligibility never reads the training days, so a
 * profile whose days per week were cleared after onboarding still gives an input.
 */
export async function programmingInputFor(
	ownerId: string,
	deps: TrainingDeps = {}
): Promise<ProgrammingInput> {
	const { db } = resolveDeps(deps);
	const profile = await getTrainingProfile(ownerId, { db });
	const customExercises = await listCustomExercises(ownerId, { db });
	const preferences = await listExercisePreferences(ownerId, { db });
	const ids = preferences.flatMap((p) => (p.exerciseId ? [p.exerciseId] : []));
	const links = await getExercisesByIds(ownerId, ids, { db });
	const linked = preferences.map((p): LinkedPreference => {
		const row = p.exerciseId ? links.get(p.exerciseId) : undefined;
		return {
			exercise: p.exercise,
			sentiment: p.sentiment,
			linked: !row ? null : row.key !== null ? { key: row.key } : { customId: row.id }
		};
	});
	const schedule = { ...profile.schedule, daysPerWeek: profile.schedule.daysPerWeek ?? 1 };
	return buildProgrammingInput(
		{ ...profile, schedule },
		{ catalogue: CATALOGUE, customExercises, preferences: linked }
	);
}

const CUSTOM = 'custom:';

/**
 * The alternatives of the library exercise `key` for the owner, ids resolved; `input` is the
 * owner's programmingInputFor, read here unless given.
 */
export async function rankAlternatives(
	ownerId: string,
	key: ExerciseKey,
	deps: TrainingDeps = {},
	input?: ProgrammingInput
): Promise<RankedAlternatives> {
	input ??= await programmingInputFor(ownerId, deps);
	const library = new Map(libraryOf(input).map((e) => [e.key, e]));
	const original = library.get(key);
	// A retired catalogue exercise a stored program still names is no longer in the library.
	if (!original) return { alternatives: [], blocked: whyNothingFits([], input), excluded: [] };
	const ranked = rank(key, input);
	const catalogue = ranked.alternatives.map((a) => a.key).filter((k) => !k.startsWith(CUSTOM));
	const rows = await resolveKeys(catalogue, deps);
	const alternatives = ranked.alternatives.flatMap(({ key: k, via }): ExerciseAlternative[] => {
		const id = k.startsWith(CUSTOM) ? k.slice(CUSTOM.length) : rows.get(k)?.id;
		const exercise = library.get(k)!;
		if (!id) return [];
		const why =
			via === 'group'
				? `Does the same job as ${original.name.toLowerCase()}`
				: `${MOVEMENT_PATTERN_LABEL[exercise.pattern]}, for the same muscles`;
		const reason = input.likes.includes(k) ? `${why} · one you like` : why;
		return [{ id, key: k, name: exercise.name, reason }];
	});
	const blocked = alternatives.length ? null : whyNothingFits(ranked.blocked, input);
	return { alternatives, blocked, excluded: ranked.blocked };
}

/**
 * What the planned exercise `at` names, in the active program's current version, can be
 * swapped for: TrainingNotFoundError for no program, session or planned exercise.
 */
export async function alternativesFor(
	ownerId: string,
	at: PlannedExerciseAt,
	deps: TrainingDeps = {}
): Promise<ExerciseAlternatives> {
	const { sessionLineage, plannedExerciseLineage } = at;
	if (!isUuid(sessionLineage) || !isUuid(plannedExerciseLineage)) {
		throw new TrainingNotFoundError('planned exercise');
	}
	const { db } = resolveDeps(deps);
	const planned = await measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId);
		if (!found) throw new TrainingNotFoundError('program');
		const hit = await repo.sessionByLineage(found.version.id, sessionLineage);
		if (!hit) throw new TrainingNotFoundError('planned session');
		const { exercises } = await repo.lineChildren([hit.session.id]);
		return exercises.find((row) => row.lineageId === plannedExerciseLineage);
	});
	if (!planned) throw new TrainingNotFoundError('planned exercise');
	const key = planned.exerciseKey ?? `${CUSTOM}${planned.exerciseId}`;
	const { alternatives, blocked } = await rankAlternatives(ownerId, key, deps);
	return { alternatives, blocked };
}

/**
 * What each of a session's planned exercises (as read: their lineage and exercise) can be
 * swapped for, by lineage, with one read of the owner's profile for them all. The session
 * screen streams it; the caller has already read the session.
 */
export async function alternativesForExercises(
	ownerId: string,
	exercises: readonly { lineage: string; exercise: ExerciseRef }[],
	deps: TrainingDeps = {}
): Promise<Map<string, ExerciseAlternatives>> {
	const input = await programmingInputFor(ownerId, deps);
	const found = new Map<string, ExerciseAlternatives>();
	// One at a time: the queries share one executor (docs/architecture.md).
	for (const { lineage, exercise } of exercises) {
		const ranked = await rankAlternatives(ownerId, toExerciseKey(exercise), deps, input);
		found.set(lineage, { alternatives: ranked.alternatives, blocked: ranked.blocked });
	}
	return found;
}
