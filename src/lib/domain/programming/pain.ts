/**
 * The gentler options 'This hurts' offers for one body area (PRD §8), which the start kit carries
 * per area so they work offline (services/workouts/kit.ts).
 *
 * - The pool is the exercise's alternatives (./alternatives.ts): the same intent, and only what
 *   the owner's equipment, injuries and dislikes allow.
 * - The area is then treated as an injury of PAIN_RULES' severity: whatever M3's
 *   INJURY_EXCLUSIONS rule out for it up to there is left out, and so is anything harder to do
 *   than the original. The original is never offered.
 * - The rest rank toward lower skill, then fewer load tags (axial load, impact), then a machine
 *   or cable, each keeping the alternatives' order among equals; the first PAIN_RULES.limit are
 *   offered. With none, `why` says what ruled each out.
 *
 * Pure and deterministic, like alternativesFor.
 */
import { BODY_AREA_LABEL, SEVERITIES } from '../profile/catalog.ts';
import type { BodyArea } from '../profile/catalog.ts';
import { SKILL_LEVELS } from '../training/vocabulary.ts';
import { alternativesFor } from './alternatives.ts';
import type { Alternative } from './alternatives.ts';
import { INJURY_EXCLUSIONS, matchesExercise } from './avoidance.ts';
import type { LibraryExercise } from './avoidance.ts';
import { libraryOf, whyNothingFits } from './eligibility.ts';
import type { ExerciseKey, ProgrammingInput } from './input.ts';
import { GENTLER_WORDS, PAIN_RULES } from './rules/pain.ts';

export type GentlerBy = keyof typeof GENTLER_WORDS;

export interface GentlerOption extends Alternative {
	/** What it is gentler by than the original, in GENTLER_WORDS' order; may be none. */
	gentler: GentlerBy[];
}

export interface Gentler {
	/** Best first, at most PAIN_RULES.limit. */
	options: GentlerOption[];
	/** The alternatives the area rules out, with why. */
	blocked: { key: ExerciseKey; reasons: string[] }[];
	/** Why there is no option, when there is none; otherwise null. */
	why: string | null;
}

const skillOf = (e: LibraryExercise) => SKILL_LEVELS.indexOf(e.skillLevel);
const loadOf = (e: LibraryExercise) =>
	e.tags.filter((tag) => PAIN_RULES.loadTags.value.includes(tag)).length;
const supported = (e: LibraryExercise) =>
	e.equipment.some((item) => PAIN_RULES.supportedEquipment.value.includes(item));

/** INJURY_EXCLUSIONS' rows for `area` up to PAIN_RULES' severity. */
function rowsFor(area: BodyArea) {
	const upTo = SEVERITIES.indexOf(PAIN_RULES.severity.value);
	return INJURY_EXCLUSIONS[area].filter((row) => SEVERITIES.indexOf(row.from) <= upTo);
}

/** What `exerciseKey` can become when `area` hurts. An unknown key throws. */
export function gentlerFor(
	exerciseKey: ExerciseKey,
	input: ProgrammingInput,
	area: BodyArea
): Gentler {
	const ranked = alternativesFor(exerciseKey, input);
	const library = new Map(libraryOf(input).map((e) => [e.key, e]));
	const original = library.get(exerciseKey)!;
	const rows = rowsFor(area);
	const where = BODY_AREA_LABEL[area].toLowerCase();

	const kept: { alternative: Alternative; e: LibraryExercise }[] = [];
	const blocked: Gentler['blocked'] = [];
	for (const alternative of ranked.alternatives) {
		const e = library.get(alternative.key)!;
		const reasons: string[] = [];
		const row = rows.find((r) => matchesExercise(e, r));
		if (row) reasons.push(`Pain in your ${where} rules out ${row.what}`);
		if (PAIN_RULES.noHarder.value && skillOf(e) > skillOf(original)) {
			reasons.push(`Harder to do than ${original.name.toLowerCase()}`);
		}
		if (reasons.length) blocked.push({ key: e.key, reasons });
		else kept.push({ alternative, e });
	}

	const rank = (e: LibraryExercise) => [skillOf(e), loadOf(e), supported(e) ? 0 : 1];
	const options = kept
		.map((entry, i) => ({ ...entry, rank: [...rank(entry.e), i] }))
		.sort((a, b) => {
			const at = a.rank.findIndex((value, i) => value !== b.rank[i]);
			return a.rank[at]! - b.rank[at]!;
		})
		.slice(0, PAIN_RULES.limit.value)
		.map(({ alternative, e }): GentlerOption => {
			const by: Record<GentlerBy, boolean> = {
				simpler: skillOf(e) < skillOf(original),
				lessLoad: loadOf(e) < loadOf(original),
				supported: supported(e) && !supported(original)
			};
			const gentler = (Object.keys(GENTLER_WORDS) as GentlerBy[]).filter((key) => by[key]);
			return { ...alternative, gentler };
		});

	const why = options.length
		? null
		: ranked.alternatives.length
			? [...new Set(blocked.flatMap((b) => b.reasons))].join('. ')
			: whyNothingFits(ranked.blocked, input);
	return { options, blocked, why };
}
