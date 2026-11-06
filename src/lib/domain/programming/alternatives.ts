/**
 * Alternatives that keep an exercise's training intent (PRD §5), for the swap sheet, the
 * generator's substitutions and M4's in-workout swaps.
 *
 * - First its substitution group, whose members share its intent and its measure.
 * - Then the same movement pattern, or a related one (RELATED_PATTERNS), counted the same way
 *   and with a primary muscle in common, so the prescription still reads.
 * - Within each, the closest first: liked, the same unilateral flag, the same load type, within
 *   the owner's skill, more primary muscles shared, then by key.
 * - Only eligible exercises are offered, never the exercise itself. `blocked` lists the ones
 *   that would have been offered with why they may not be, so an empty list can be explained
 *   (whyNothingFits words it).
 *
 * Pure and deterministic: no seed is needed, as every tie breaks by key.
 */
import { SKILL_LEVELS } from '../training/vocabulary.ts';
import type { MovementPattern } from '../training/vocabulary.ts';
import { isEligible, libraryOf, skillCap } from './eligibility.ts';
import type { Excluded, LibraryExercise } from './eligibility.ts';
import type { ExerciseKey, ProgrammingInput } from './input.ts';
import { compareText } from './random.ts';

/**
 * Patterns that serve one intent. Squats and single-leg knee work (split squats, lunges, step-ups)
 * both train the knee-dominant lower body; the catalogue keeps them apart so a week can balance
 * the two, but either keeps a squat's purpose when the other cannot be done.
 */
export const RELATED_PATTERNS: Partial<Record<MovementPattern, readonly MovementPattern[]>> = {
	squat: ['lunge'],
	lunge: ['squat']
};

export interface Alternative {
	key: ExerciseKey;
	/** Why it keeps the intent: the same substitution group, or the same kind of movement. */
	via: 'group' | 'pattern';
}

export interface Alternatives {
	/** Best first. */
	alternatives: Alternative[];
	/** The ones that would have been offered, in the same order, with their reasons. */
	blocked: Excluded[];
}

/** What `exerciseKey` can be swapped for. An unknown key throws. */
export function alternativesFor(exerciseKey: ExerciseKey, input: ProgrammingInput): Alternatives {
	const library = libraryOf(input);
	const original = library.find((e) => e.key === exerciseKey);
	if (!original) throw new RangeError(`Unknown exercise '${exerciseKey}'`);
	const patterns = [original.pattern, ...(RELATED_PATTERNS[original.pattern] ?? [])];
	const shared = (e: LibraryExercise) =>
		e.primaryMuscles.filter((muscle) => original.primaryMuscles.includes(muscle)).length;
	const viaOf = (e: LibraryExercise): Alternative['via'] | null => {
		if (e.key === original.key) return null;
		if (original.substitutionGroup && e.substitutionGroup === original.substitutionGroup) {
			return 'group';
		}
		const pattern = patterns.includes(e.pattern) && e.measure === original.measure;
		return pattern && shared(e) > 0 ? 'pattern' : null;
	};

	const cap = skillCap(input);
	const order = (e: LibraryExercise, via: Alternative['via']) => [
		via === 'group' ? 0 : 1,
		input.likes.includes(e.key) ? 0 : 1,
		e.unilateral === original.unilateral ? 0 : 1,
		e.loadType === original.loadType ? 0 : 1,
		SKILL_LEVELS.indexOf(e.skillLevel) <= cap ? 0 : 1,
		-shared(e)
	];
	const ranked = library
		.flatMap((e) => {
			const via = viaOf(e);
			return via ? [{ e, via, rank: order(e, via) }] : [];
		})
		.sort((a, b) => {
			const at = a.rank.findIndex((value, i) => value !== b.rank[i]);
			return at < 0 ? compareText(a.e.key, b.e.key) : a.rank[at]! - b.rank[at]!;
		});

	const alternatives: Alternative[] = [];
	const blocked: Excluded[] = [];
	for (const { e, via } of ranked) {
		const result = isEligible(e, input);
		if (result.ok) alternatives.push({ key: e.key, via });
		else blocked.push({ key: e.key, reasons: result.reasons });
	}
	return { alternatives, blocked };
}
