/**
 * Injuries and movements to avoid, as the exclusions eligibility applies (PRD §2, §5).
 *
 * - An injury rules out its body area's INJURY_EXCLUSIONS rows up to its severity: a mild one
 *   only the riskiest work through the area, a severe one ('rehab first') most loaded work
 *   through it. Its side narrows nothing, as both sides are trained. A resolved injury never
 *   gets here: buildProgrammingInput keeps the active ones only.
 * - A movement to avoid is read left to right, the longest AVOID_PHRASES entry ('overhead
 *   pressing', 'jumping') or exercise name or alias ('Box jumps' leaves out that exercise only)
 *   at a time, a phrase before a name of the same length. Text that holds none of these is
 *   returned unmatched, for an unmapped_avoidance decision, and leaves nothing out; in text that
 *   does, each run of other words but FILLER_WORDS is returned unmatched ('Burpees and tyre
 *   flips' leaves out burpees and returns 'tyre flips').
 * - Every exclusion carries the reason the owner reads for each exercise it leaves out.
 *
 * The tables are reviewable data, so a coaching change is a row, not code. Pure: no clock, no
 * randomness, no I/O.
 */
import type { CatalogueExercise } from '../exercises/format.ts';
import { matchExercise, normaliseExerciseName } from '../exercises/match.ts';
import { BODY_AREA_LABEL, SEVERITIES, SEVERITY_INFO } from '../profile/catalog.ts';
import type { BodyArea, Equipment, Severity } from '../profile/catalog.ts';
import type { CustomExercise } from '../training/types.ts';
import type { ExerciseTag, MovementPattern, Muscle } from '../training/vocabulary.ts';
import type { ExerciseKey, InputInjury } from './input.ts';

/** An exercise as eligibility reads it: a catalogue entry, or one of the owner's own by key. */
export type LibraryExercise = CustomExercise & Pick<CatalogueExercise, 'key'>;

/** Why an exercise may not be prescribed, in words the owner reads. */
export type Reason =
	| { kind: 'equipment'; text: string; missing: Equipment[] }
	| { kind: 'injury' | 'avoid' | 'dislike'; text: string };

/**
 * The exercises a rule matches. Every selector given must hold, and within a selector any one
 * value does, so `{ patterns: ['vertical_push'], tags: ['overhead'] }` is overhead pressing.
 */
export interface ExerciseMatch {
	patterns?: readonly MovementPattern[];
	tags?: readonly ExerciseTag[];
	/** Primary muscles. */
	muscles?: readonly Muscle[];
	keys?: readonly ExerciseKey[];
	/** Never an exercise with one of these tags: the catalogue marks what suits an injury. */
	except?: readonly ExerciseTag[];
}

/** One injury or movement to avoid: its rules in order, the first that matches gives the reason. */
export interface Exclusion {
	kind: 'injury' | 'avoid';
	rules: { match: ExerciseMatch; reason: string }[];
}

export interface Avoidance {
	exclusions: Exclusion[];
	/** The movements to avoid, or the words in one, that matched nothing, once each. */
	unmatched: string[];
}

interface InjuryRow extends ExerciseMatch {
	/** The least severity that rules it out. */
	from: Severity;
	/** What it rules out, read after 'rules out'. */
	what: string;
}

const PUSH_PULL_CARRY: readonly MovementPattern[] = [
	'horizontal_push',
	'vertical_push',
	'horizontal_pull',
	'vertical_pull',
	'carry'
];

/**
 * By body area, mildest first; one row per line, so Prettier leaves the table as written.
 * 'other' says too little to rule anything out by itself.
 */
// prettier-ignore
export const INJURY_EXCLUSIONS: Readonly<Record<BodyArea, readonly InjuryRow[]>> = {
	neck: [
		{ from: 'mild', what: 'direct neck work', muscles: ['neck'] },
		{ from: 'moderate', what: 'overhead work', tags: ['overhead'] },
		{ from: 'moderate', what: 'heavy loading through the spine', tags: ['spinal_loading'] },
		{ from: 'severe', what: 'Olympic lifts and jumps', patterns: ['olympic', 'plyometric'] }
	],
	shoulder: [
		{ from: 'mild', what: 'catching a bar overhead', patterns: ['olympic'], tags: ['overhead'] },
		{ from: 'moderate', what: 'overhead work', tags: ['overhead'] },
		{ from: 'moderate', what: 'Olympic lifts', patterns: ['olympic'] },
		{ from: 'severe', what: 'pressing, pulling up and carrying', patterns: ['horizontal_push', 'vertical_push', 'vertical_pull', 'carry'], except: ['shoulder_friendly'] }
	],
	elbow: [
		{ from: 'mild', what: 'Olympic lifts', patterns: ['olympic'] },
		{ from: 'moderate', what: 'direct arm work', patterns: ['isolation'], muscles: ['biceps', 'triceps'] },
		{ from: 'moderate', what: 'heavy gripping', tags: ['grip_demanding'] },
		{ from: 'severe', what: 'pressing, pulling and carrying', patterns: PUSH_PULL_CARRY }
	],
	wrist_hand: [
		{ from: 'mild', what: 'work that loads the wrists', tags: ['wrist_loading'] },
		{ from: 'moderate', what: 'Olympic lifts', patterns: ['olympic'] },
		{ from: 'moderate', what: 'heavy gripping', tags: ['grip_demanding'] },
		{ from: 'severe', what: 'pressing, pulling and carrying', patterns: PUSH_PULL_CARRY }
	],
	upper_back: [
		{ from: 'mild', what: 'Olympic lifts', patterns: ['olympic'] },
		{ from: 'moderate', what: 'heavy loading through the spine', tags: ['spinal_loading'] },
		{ from: 'severe', what: 'pulling, carrying and twisting', patterns: ['horizontal_pull', 'vertical_pull', 'carry', 'rotation'] }
	],
	lower_back: [
		{ from: 'mild', what: 'Olympic lifts', patterns: ['olympic'] },
		{ from: 'moderate', what: 'heavy loading through the spine', tags: ['spinal_loading'], except: ['back_friendly'] },
		{ from: 'moderate', what: 'twisting under load', patterns: ['rotation'] },
		{ from: 'severe', what: 'squats, hinges, lunges, carries and jumps', patterns: ['squat', 'hinge', 'lunge', 'carry', 'plyometric'], except: ['back_friendly'] }
	],
	hip: [
		{ from: 'mild', what: 'hard landings', tags: ['high_impact'] },
		{ from: 'moderate', what: 'deep squatting', tags: ['deep_knee_flexion'] },
		{ from: 'moderate', what: 'Olympic lifts and jumps', patterns: ['olympic', 'plyometric'] },
		{ from: 'severe', what: 'squats, hinges and lunges', patterns: ['squat', 'hinge', 'lunge'] }
	],
	groin: [
		{ from: 'mild', what: 'hard landings', tags: ['high_impact'] },
		{ from: 'moderate', what: 'work that loads the groin', muscles: ['adductors'] },
		{ from: 'severe', what: 'squats, lunges, jumps and Olympic lifts', patterns: ['squat', 'lunge', 'plyometric', 'olympic'] }
	],
	hamstring: [
		{ from: 'mild', what: 'explosive work', tags: ['explosive'] },
		{ from: 'moderate', what: 'work that loads the hamstrings', muscles: ['hamstrings'] },
		{ from: 'severe', what: 'hinges, lunges, jumps and Olympic lifts', patterns: ['hinge', 'lunge', 'plyometric', 'olympic'] }
	],
	knee: [
		{ from: 'mild', what: 'hard landings', tags: ['high_impact'] },
		{ from: 'moderate', what: 'deep knee bends', tags: ['deep_knee_flexion'], except: ['knee_friendly'] },
		{ from: 'moderate', what: 'jumps', patterns: ['plyometric'] },
		{ from: 'severe', what: 'squats, lunges and Olympic lifts', patterns: ['squat', 'lunge', 'olympic'], except: ['knee_friendly'] },
		{ from: 'severe', what: 'loaded knee extension', patterns: ['isolation'], muscles: ['quads'] }
	],
	shin_calf: [
		{ from: 'mild', what: 'hard landings', tags: ['high_impact'] },
		{ from: 'moderate', what: 'jumps', patterns: ['plyometric'] },
		{ from: 'moderate', what: 'direct calf work', patterns: ['isolation'], muscles: ['calves'] },
		{ from: 'severe', what: 'lunges and Olympic lifts', patterns: ['lunge', 'olympic'] },
		{ from: 'severe', what: 'impact conditioning', patterns: ['conditioning'], except: ['low_impact'] }
	],
	ankle_foot: [
		{ from: 'mild', what: 'hard landings', tags: ['high_impact'] },
		{ from: 'moderate', what: 'jumps and Olympic lifts', patterns: ['plyometric', 'olympic'] },
		{ from: 'severe', what: 'squats, lunges and carries', patterns: ['squat', 'lunge', 'carry'] },
		{ from: 'severe', what: 'impact conditioning', patterns: ['conditioning'], except: ['low_impact'] }
	],
	other: []
};

interface AvoidPhrase extends ExerciseMatch {
	/** The ways an owner writes it, compared word by word as the matcher compares names. */
	says: readonly string[];
}

/**
 * Movements to avoid that name a kind of movement, one per line. Bare 'press' and 'pull' are
 * not here: they mostly come in names ('Leg press', 'Pull-ups'), which leave out one exercise.
 */
// prettier-ignore
export const AVOID_PHRASES: readonly AvoidPhrase[] = [
	{ says: ['overhead pressing', 'overhead press', 'pressing overhead', 'shoulder press', 'military press'], patterns: ['vertical_push', 'olympic'], tags: ['overhead'] },
	{ says: ['overhead', 'overhead work', 'arms overhead', 'above head'], tags: ['overhead'] },
	{ says: ['pressing'], patterns: ['horizontal_push', 'vertical_push'] },
	{ says: ['pulling'], patterns: ['horizontal_pull', 'vertical_pull'] },
	{ says: ['squat', 'squatting'], patterns: ['squat'] },
	{ says: ['deep squat', 'deep squatting', 'deep knee bend', 'deep knee bending', 'deep knee flexion'], tags: ['deep_knee_flexion'] },
	{ says: ['lunge', 'lunging', 'single leg', 'split squat'], patterns: ['lunge'] },
	{ says: ['jump', 'jumping', 'plyometric', 'plyo', 'hop', 'hopping', 'bounding'], patterns: ['plyometric'] },
	{ says: ['impact', 'high impact', 'landing'], tags: ['high_impact'] },
	{ says: ['deadlift', 'deadlifting'], patterns: ['hinge'], tags: ['spinal_loading'] },
	{ says: ['hinge', 'hinging', 'bending over', 'bent over'], patterns: ['hinge'] },
	{ says: ['spinal loading', 'spine loading', 'axial loading', 'bar on back', 'barbell on back'], tags: ['spinal_loading'] },
	{ says: ['twist', 'twisting', 'rotation', 'rotating'], patterns: ['rotation'] },
	{ says: ['olympic', 'olympic lift', 'olympic lifting', 'weightlifting', 'clean', 'snatch', 'jerk'], patterns: ['olympic'] },
	{ says: ['carry', 'carrying'], patterns: ['carry'] },
	{ says: ['grip', 'gripping', 'hanging'], tags: ['grip_demanding'] },
	{ says: ['wrist', 'wrist loading', 'weight on wrist', 'weight on hand'], tags: ['wrist_loading'] }
];

/**
 * Words that name no movement, so a movement to avoid may hold them unread. A qualifier here
 * narrows nothing: 'No heavy deadlifts, please' leaves out every deadlift.
 */
// prettier-ignore
export const FILLER_WORDS: readonly string[] = ['a', 'an', 'the', 'and', 'or', 'no', 'not', 'any', 'all', 'avoid', 'please', 'with', 'heavy', 'too', 'much'];

const filler: ReadonlySet<string> = new Set(FILLER_WORDS.map(normaliseExerciseName));

/** The words of `text` as written, and as the matcher compares names: lower case, singular. */
function wordsOf(text: string) {
	const raw = text.split(/[^\p{L}\p{N}'’&]+/u).filter((word) => normaliseExerciseName(word));
	return { raw, words: raw.map(normaliseExerciseName) };
}

const PHRASES = AVOID_PHRASES.flatMap((phrase) =>
	phrase.says.map((says) => ({ phrase, words: wordsOf(says).words.join(' ') }))
);

/**
 * The longest phrase or exercise name in `text` that starts at word `at`. A phrase wins a tie,
 * so 'Squats' is every squat, while 'Front squats' is the one exercise.
 */
function readAt(
	text: ReturnType<typeof wordsOf>,
	at: number,
	library: readonly LibraryExercise[]
): { match: ExerciseMatch; length: number } | null {
	for (let length = text.words.length - at; length > 0; length--) {
		const span = text.words.slice(at, at + length).join(' ');
		const hit = PHRASES.find(({ words }) => words === span);
		if (hit) return { match: hit.phrase, length };
		const key = matchExercise(text.raw.slice(at, at + length).join(' '), library);
		if (key) return { match: { keys: [key] }, length };
	}
	return null;
}

/**
 * What a movement to avoid leaves out, read left to right a phrase or name at a time, and the
 * runs of other words, filler aside, that the coach could not read.
 */
function readAvoid(text: string, library: readonly LibraryExercise[]) {
	const said = wordsOf(text);
	const matches: ExerciseMatch[] = [];
	const unread: string[][] = [];
	for (let at = 0, inRun = false; at < said.words.length;) {
		const hit = readAt(said, at, library);
		const isUnread = !hit && !filler.has(said.words[at]!);
		if (hit) matches.push(hit.match);
		else if (isUnread && inRun) unread.at(-1)!.push(said.raw[at]!);
		else if (isUnread) unread.push([said.raw[at]!]);
		inRun = isUnread;
		at += hit?.length ?? 1;
	}
	return { matches, unread: unread.map((run) => run.join(' ')) };
}

const injuryWords = ({ bodyArea, side, severity }: InputInjury) =>
	[
		SEVERITY_INFO[severity].label,
		side === 'left' || side === 'right' ? side : '',
		BODY_AREA_LABEL[bodyArea]
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();

/** The exclusions `injuries` make, with `library` to read exercise names from. */
export function avoidanceOf(
	injuries: readonly InputInjury[],
	library: readonly LibraryExercise[]
): Avoidance {
	const exclusions: Exclusion[] = [];
	const unmatched: string[] = [];
	for (const injury of injuries) {
		const upTo = SEVERITIES.indexOf(injury.severity);
		const rows = INJURY_EXCLUSIONS[injury.bodyArea].filter(
			(row) => SEVERITIES.indexOf(row.from) <= upTo
		);
		const rules = rows.map(({ from: _from, what, ...match }) => ({
			match,
			reason: `Your ${injuryWords(injury)} injury rules out ${what}`
		}));
		if (rules.length) exclusions.push({ kind: 'injury', rules });
	}
	const texts = [...new Set(injuries.flatMap((injury) => injury.avoid))];
	for (const text of texts) {
		const { matches, unread } = readAvoid(text, library);
		const reason = `You asked to avoid “${text}”`;
		if (matches.length) {
			exclusions.push({ kind: 'avoid', rules: matches.map((match) => ({ match, reason })) });
		}
		unmatched.push(...(matches.length ? unread : [text]));
	}
	return { exclusions, unmatched: [...new Set(unmatched)] };
}

const anyOf = <T>(wanted: readonly T[] | undefined, has: readonly T[]) =>
	!wanted || wanted.some((value) => has.includes(value));

/** Whether `match` takes in `exercise`. A match with no selector but `except` takes in nothing. */
export function matchesExercise(exercise: LibraryExercise, match: ExerciseMatch): boolean {
	const { patterns, tags, muscles, keys, except = [] } = match;
	if (!patterns && !tags && !muscles && !keys) return false;
	return (
		anyOf(patterns, [exercise.pattern]) &&
		anyOf(tags, exercise.tags) &&
		anyOf(muscles, exercise.primaryMuscles) &&
		anyOf(keys, [exercise.key]) &&
		!except.some((tag) => exercise.tags.includes(tag))
	);
}
