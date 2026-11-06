/**
 * Editing state for Profile → Exercises: the exercises the owner enjoys and the ones they’d
 * rather swap out, as two lists of names, built from the preferences the services return.
 *
 * A save replaces the whole list, so the draft also keeps what was saved with each preference
 * (the coach’s note on why) and the payload sends it back. A reason belongs to its sentiment:
 * an exercise moved to the other list starts without one.
 */
import type { Sentiment } from '#lib/domain/profile/catalog.ts';
import type { ExercisePreferencesInput, FieldErrors } from '#lib/domain/profile/schemas.ts';
import type { ExercisePreference } from '#lib/domain/profile/types.ts';

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
