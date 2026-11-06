/**
 * Links free text, such as an M2 exercise preference ('Box jumps', 'RDL'), to one exercise key.
 *
 * Both sides are normalised the same way: case, accents, punctuation, spacing and plurals are
 * ignored, and `&` reads as `and`. A text matches when it equals a name or an alias after that,
 * and only then: no substrings, no word order, no fuzzy scores. When two exercises share the
 * normalised text, it matches neither, so the matcher never guesses between two. Text that
 * matches nothing stays free text for its caller to explain.
 *
 * The catalogue's integrity test keeps every name and alias distinct after normalising, so each
 * of them matches its own entry. A library that adds the owner's custom exercises can still share
 * a name with the catalogue: that name then gives null.
 */
import type { CatalogueExercise } from './format.ts';

/** What the matcher reads of an exercise: a catalogue entry, or a custom one under its own key. */
export type MatchableExercise = Pick<CatalogueExercise, 'key' | 'name' | 'aliases'>;

/** -es is the plural ending after a sibilant (presses, snatches), otherwise -s is (lunges). */
const SIBILANT_PLURAL = /(?:ch|sh|ss|x|z)es$/;
/** Words that end in s without being plurals: press, plus, axis. */
const NOT_PLURAL = /(?:ss|us|is)$/;

function singular(word: string): string {
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
	if (SIBILANT_PLURAL.test(word)) return word.slice(0, -2);
	if (word.length >= 3 && word.endsWith('s') && !NOT_PLURAL.test(word)) return word.slice(0, -1);
	return word;
}

/**
 * The form names are compared in: lower case, accents and apostrophes dropped, `&` as `and`,
 * every word made singular, and the words joined with nothing between them, so 'Pull-ups',
 * 'pull ups' and 'Pullup' are one name.
 */
export function normaliseExerciseName(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/&/g, ' and ')
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map(singular)
		.join('');
}

/** Normalised name → key, or null where two exercises share it. Cached per library array. */
const indexes = new WeakMap<readonly MatchableExercise[], ReadonlyMap<string, string | null>>();

function indexOf(library: readonly MatchableExercise[]): ReadonlyMap<string, string | null> {
	const cached = indexes.get(library);
	if (cached) return cached;
	const index = new Map<string, string | null>();
	for (const { key, name, aliases } of library) {
		for (const term of [name, ...aliases]) {
			const normal = normaliseExerciseName(term);
			if (!normal) continue;
			const seen = index.get(normal);
			index.set(normal, seen === undefined || seen === key ? key : null);
		}
	}
	indexes.set(library, index);
	return index;
}

/**
 * The key of the one exercise in `library` whose name or alias is `text` (see above), or null
 * when none is, or more than one is. Pass CATALOGUE, or a new array of it plus custom exercises:
 * each array's index is built once, so never change an array after passing it.
 */
export function matchExercise(text: string, library: readonly MatchableExercise[]): string | null {
	return indexOf(library).get(normaliseExerciseName(text)) ?? null;
}
