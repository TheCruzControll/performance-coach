/**
 * Which exercises may be prescribed (PRD §2, §5). The generator's selection, the swap sheet and
 * M4's in-workout substitutions all ask here, so one rule set explains every exclusion.
 *
 * - An exercise is eligible when the owner has all of its equipment, no injury or movement to
 *   avoid rules it out (./avoidance.ts) and it is not disliked. A dislike is absolute: a
 *   disliked exercise is never eligible, even as a slot's only option, and the slot then says
 *   why it is empty.
 * - Likes and skill only rank: candidates puts liked exercises first, then those within the
 *   owner's experience, then breaks ties with a generator seeded by the slot's key.
 * - The library is CATALOGUE and the owner's own exercises, by key.
 *
 * Pure. The library and the exclusions are worked out once per input object, so never change an
 * input after passing it.
 */
import { CATALOGUE } from '../exercises/index.ts';
import { EQUIPMENT, EXPERIENCE_LEVELS } from '../profile/catalog.ts';
import type { Discipline, Equipment } from '../profile/catalog.ts';
import { SKILL_LEVELS, skillForExperience } from '../training/vocabulary.ts';
import type { MovementPattern } from '../training/vocabulary.ts';
import { avoidanceOf, matchesExercise } from './avoidance.ts';
import type { Avoidance, LibraryExercise, Reason } from './avoidance.ts';
import type { ExerciseKey, ProgrammingInput } from './input.ts';
import { compareText, seededRandom } from './random.ts';
import { DEFAULTS } from './rules/defaults.ts';

export type { LibraryExercise, Reason } from './avoidance.ts';

export type Eligibility = { ok: true } | { ok: false; reasons: Reason[] };

/** An exercise that may not be prescribed, and why. */
export interface Excluded {
	key: ExerciseKey;
	reasons: Reason[];
}

/** A place in a session that one exercise fills. */
export interface Slot {
	/** Stable and unique in the program: it seeds the tie-break. */
	key: string;
	/** The movement patterns that fill it. */
	patterns: readonly MovementPattern[];
	/** The discipline whose experience the skill level is held to; the highest told when unset. */
	discipline?: Discipline;
}

export interface SlotCandidates {
	/** The eligible exercises that fit, best first. */
	keys: ExerciseKey[];
	/** The ones that fit but may not be prescribed, by key. */
	excluded: Excluded[];
	/** Why nothing fits, when `keys` is empty (whyNothingFits); otherwise null. */
	why: string | null;
}

/** Each M2 equipment key as 'Needs …' reads it. */
export const EQUIPMENT_NEEDED: Readonly<Record<Equipment, string>> = {
	barbell: 'a barbell',
	squat_rack: 'a squat rack',
	bench: 'a bench',
	platform: 'a lifting platform',
	dumbbells: 'dumbbells',
	kettlebells: 'kettlebells',
	cables: 'a cable station',
	machines: 'a machine',
	pull_up_bar: 'a pull-up bar',
	rings: 'rings',
	bands: 'bands',
	specialty_bars: 'a specialty bar',
	sled: 'a sled',
	plyo_box: 'a plyo box',
	treadmill: 'a treadmill',
	rower: 'a rower',
	bike: 'an air or spin bike',
	ski_erg: 'a SkiErg',
	heavy_bag: 'a heavy bag',
	pads: 'Thai pads'
};

export const DISLIKED = 'You said you don’t like it';
export const NOTHING_IN_LIBRARY = 'No exercise in the library moves this way';

/** 'a, b and c', or with 'or'. */
const listing = (items: readonly string[], last: 'and' | 'or') =>
	items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`;

const byKey = (a: LibraryExercise, b: LibraryExercise) => compareText(a.key, b.key);

const libraries = new WeakMap<ProgrammingInput, readonly LibraryExercise[]>();
const avoidances = new WeakMap<ProgrammingInput, Avoidance>();

/** CATALOGUE and the owner's own exercises, in key order. */
export function libraryOf(input: ProgrammingInput): readonly LibraryExercise[] {
	let library = libraries.get(input);
	if (!library) {
		library = [...CATALOGUE, ...input.customExercises].sort(byKey);
		libraries.set(input, library);
	}
	return library;
}

/** What the input's injuries rule out, and the movements to avoid the coach could not read. */
export function avoidanceFor(input: ProgrammingInput): Avoidance {
	let avoidance = avoidances.get(input);
	if (!avoidance) {
		avoidance = avoidanceOf(input.injuries, libraryOf(input));
		avoidances.set(input, avoidance);
	}
	return avoidance;
}

/** Whether `exercise` may be prescribed for `input`, or every reason it may not, in that order. */
export function isEligible(exercise: LibraryExercise, input: ProgrammingInput): Eligibility {
	const reasons: Reason[] = [];
	const missing = exercise.equipment.filter((item) => !input.equipment.includes(item));
	if (missing.length) {
		const needs = missing.map((item) => EQUIPMENT_NEEDED[item]);
		reasons.push({ kind: 'equipment', text: `Needs ${listing(needs, 'and')}`, missing });
	}
	for (const { kind, rules } of avoidanceFor(input).exclusions) {
		const rule = rules.find(({ match }) => matchesExercise(exercise, match));
		if (rule && !reasons.some(({ text }) => text === rule.reason)) {
			reasons.push({ kind, text: rule.reason });
		}
	}
	if (input.dislikes.includes(exercise.key)) reasons.push({ kind: 'dislike', text: DISLIKED });
	return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * The SKILL_LEVELS index of the hardest skill within the owner's experience: in `discipline` when
 * told, otherwise the highest level told, otherwise the 'not told yet' default.
 */
export function skillCap(input: ProgrammingInput, discipline?: Discipline): number {
	const told = discipline && input.experience[discipline];
	const levels = told ? [told] : Object.values(input.experience);
	const best = [...EXPERIENCE_LEVELS].reverse().find((level) => levels.includes(level));
	return SKILL_LEVELS.indexOf(skillForExperience(best ?? DEFAULTS.experience.value));
}

/**
 * Why none of `excluded` may be prescribed, as sentences: the equipment they need, each injury
 * or movement to avoid, then the disliked ones by name. With nothing excluded, the library has
 * nothing of the kind at all.
 */
export function whyNothingFits(excluded: readonly Excluded[], input: ProgrammingInput): string {
	if (!excluded.length) return NOTHING_IN_LIBRARY;
	const missing = new Set<Equipment>();
	const texts: string[] = [];
	const disliked: string[] = [];
	const nameOf = (key: ExerciseKey) => libraryOf(input).find((e) => e.key === key)?.name ?? key;
	for (const { key, reasons } of excluded) {
		for (const reason of reasons) {
			if (reason.kind === 'equipment') reason.missing.forEach((item) => missing.add(item));
			else if (reason.kind === 'dislike') disliked.push(nameOf(key));
			else if (!texts.includes(reason.text)) texts.push(reason.text);
		}
	}
	const needs = EQUIPMENT.filter((item) => missing.has(item)).map((item) => EQUIPMENT_NEEDED[item]);
	return [
		...(needs.length ? [`Needs ${listing(needs, 'or')}`] : []),
		...texts,
		...(disliked.length ? [`You said you don’t like ${listing(disliked, 'and')}`] : [])
	].join('. ');
}

/**
 * The exercises that can fill `slot`: the eligible ones liked first, then those within the
 * owner's skill, ties broken by a shuffle seeded with the slot's key; the rest with their
 * reasons. The same slot and input always give the same order.
 */
export function candidates(slot: Slot, input: ProgrammingInput): SlotCandidates {
	const eligible: LibraryExercise[] = [];
	const excluded: Excluded[] = [];
	for (const exercise of libraryOf(input)) {
		if (!slot.patterns.includes(exercise.pattern)) continue;
		const result = isEligible(exercise, input);
		if (result.ok) eligible.push(exercise);
		else excluded.push({ key: exercise.key, reasons: result.reasons });
	}
	const cap = skillCap(input, slot.discipline);
	const rank = (e: LibraryExercise) =>
		(input.likes.includes(e.key) ? 0 : 2) + (SKILL_LEVELS.indexOf(e.skillLevel) <= cap ? 0 : 1);
	const keys = seededRandom(slot.key)
		.shuffle(eligible)
		.sort((a, b) => rank(a) - rank(b))
		.map((e) => e.key);
	return { keys, excluded, why: keys.length ? null : whyNothingFits(excluded, input) };
}
