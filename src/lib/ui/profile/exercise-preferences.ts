/**
 * Editing state for Profile → Exercises: the exercises the owner enjoys and the ones they’d
 * rather swap out, as two lists of names, built from the preferences the services return.
 *
 * A save replaces the whole list, so the draft also keeps what was saved with each preference
 * (the coach’s note on why) and the payload sends it back. A reason belongs to its sentiment:
 * an exercise moved to the other list starts without one.
 *
 * Adding one searches the exercise library (the workout's `searchLibrary`), or the device's
 * suggestions when the library could not load; what is stored is still the name, as words.
 */
import { searchLibrary } from '#lib/client/workout/library.ts';
import { EXERCISE_SUGGESTIONS, type Sentiment } from '#lib/domain/profile/catalog.ts';
import type { ExercisePreferencesInput, FieldErrors } from '#lib/domain/profile/schemas.ts';
import type { ExercisePreference } from '#lib/domain/profile/types.ts';
import type { LibraryExercise } from '#lib/domain/workout/index.ts';

export interface ExercisesDraft {
	likes: string[];
	dislikes: string[];
	/** The saved reasons by sentiment and name, posted back with their exercise; never edited. */
	reasons: Record<string, string>;
}

/** Names match as the database matches them: trimmed, in any case. */
const reasonKey = (sentiment: Sentiment, exercise: string) =>
	`${sentiment}:${exercise.trim().toLowerCase()}`;

export function exercisesDraft(saved: ExercisePreference[]): ExercisesDraft {
	const named = (sentiment: Sentiment) =>
		saved.filter((p) => p.sentiment === sentiment).map((p) => p.exercise);
	const reasons: Record<string, string> = {};
	for (const p of saved) if (p.reason) reasons[reasonKey(p.sentiment, p.exercise)] = p.reason;
	return { likes: named('like'), dislikes: named('dislike'), reasons };
}

/** What Save posts: the likes, then the dislikes, each with the reason it was saved with. */
export function exercisesPayload(draft: ExercisesDraft): ExercisePreferencesInput {
	const items = (sentiment: Sentiment, names: string[]) =>
		names.map((exercise) => ({
			exercise,
			sentiment,
			reason: draft.reasons[reasonKey(sentiment, exercise)] ?? null
		}));
	return { items: [...items('like', draft.likes), ...items('dislike', draft.dislikes)] };
}

/**
 * Where a save’s errors show: an exercise’s own error on the list it is in (the payload holds
 * `likes` likes first), and one about the whole list (an exercise in both) on the list to swap
 * out.
 */
export function listErrors(
	errors: FieldErrors,
	likes: number
): { likes: string | undefined; dislikes: string | undefined } {
	const shown = { likes: undefined as string | undefined, dislikes: errors.items };
	for (const [path, message] of Object.entries(errors)) {
		const index = /^items\.(\d+)\./.exec(path)?.[1];
		if (index !== undefined) shown[Number(index) < likes ? 'likes' : 'dislikes'] ??= message;
	}
	return shown;
}

/** How many results the search shows: few enough to sit above the phone's keyboard. */
export const SEARCH_LIMIT = 8;

/** A search result: the exercise's name, and whether either list already holds it. */
export interface SearchResult {
	name: string;
	added: boolean;
}

/**
 * The exercises `query` names, best first, at most eight: from the library through the
 * workout's search (names and aliases, 'RDL'), or, with no library (`null`), the suggestions
 * that start with it, then the ones that contain it. `added` when `taken` holds the name in any
 * case. A blank query gives none.
 */
export function searchExercises(
	library: readonly LibraryExercise[] | null,
	query: string,
	taken: readonly string[]
): SearchResult[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const names = library
		? searchLibrary(library, q, SEARCH_LIMIT).results.map((e) => e.name)
		: [
				...EXERCISE_SUGGESTIONS.filter((e) => e.toLowerCase().startsWith(q)),
				...EXERCISE_SUGGESTIONS.filter(
					(e) => !e.toLowerCase().startsWith(q) && e.toLowerCase().includes(q)
				)
			].slice(0, SEARCH_LIMIT);
	const held = new Set(taken.map((name) => name.trim().toLowerCase()));
	return names.map((name) => ({ name, added: held.has(name.toLowerCase()) }));
}
