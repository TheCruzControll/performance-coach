/**
 * The exercises of each strength day (PRD §5): every slot of the split filled from the eligible
 * candidates, by key (eligibility.ts), so equipment, injuries, movements to avoid and dislikes
 * hold everywhere and likes come first.
 *
 * - A slot's usual choice is the baseline lift it prefers, when the discipline calls for lifts;
 *   otherwise its best candidate as if no injury applied: work of the slot's kind (a compound or
 *   explosive lift, or an accessory), then liked, then within the owner's skill, then tagged for
 *   the discipline, then a tie-break seeded by the slot's key. The usual choice takes the slot
 *   when it may be prescribed, so an injury changes only the slots it rules out.
 * - Otherwise its best eligible alternative (alternatives.ts) takes it, or else the slot's best
 *   eligible candidate, with an exercise_substituted decision. When nothing can, the slot stays
 *   empty with a slot_empty decision that says why.
 * - An exercise appears once a day; across the week, a slot prefers one not used yet, but a
 *   baseline lift and its stand-in repeat as often as the split asks.
 * - exercise_selected records each main and power lift not substituted, exercise_excluded each
 *   dislike and unmapped_avoidance each movement to avoid the coach could not read.
 * - Sets follow the split's style (rules/strength.ts), RPE-based until loads (m3/21) set them.
 *
 * Pure and deterministic.
 */
import { catalogueByKey, SUBSTITUTION_GROUPS } from '../exercises/index.ts';
import type { PlannedExercisePlan, SetPrescription } from '../training/types.ts';
import { SKILL_LEVELS } from '../training/vocabulary.ts';
import { alternativesFor } from './alternatives.ts';
import type { DecisionLog } from './decisions.ts';
import { clip } from './demand.ts';
import {
	avoidanceFor,
	candidates,
	DISLIKED,
	isEligible,
	libraryOf,
	skillCap,
	whyNothingFits
} from './eligibility.ts';
import type { LibraryExercise, Reason } from './eligibility.ts';
import { toExerciseRef } from './input.ts';
import type { ExerciseKey, ProgrammingInput } from './input.ts';
import {
	COMPETITION_SLOTS,
	DEFAULT_METRES,
	isAccessory,
	SELECTED_BECAUSE,
	SLOT_KINDS,
	WORKING_RPE
} from './rules/strength.ts';
import type { SlotKind, SlotKindKey, SlotRole } from './rules/strength.ts';
import type { Split, SplitDay } from './splits.ts';

export interface Selected {
	role: SlotRole;
	kind: SlotKindKey;
	exercise: LibraryExercise;
}

export interface DaySelection {
	day: SplitDay;
	/** In the day's slot order; an empty slot is left out. */
	exercises: Selected[];
}

/** The strength stage's decisions are about every session of the first block. */
const FIRST_BLOCK = ['blocks.0'];

const libraries = new WeakMap<ProgrammingInput, ReadonlyMap<ExerciseKey, LibraryExercise>>();
const uninjured = new WeakMap<ProgrammingInput, ProgrammingInput>();

/** The library exercise `key` names for `input`: a catalogue entry or one of the owner's own. */
export function exerciseOf(input: ProgrammingInput, key: ExerciseKey): LibraryExercise | undefined {
	let library = libraries.get(input);
	if (!library) {
		library = new Map(libraryOf(input).map((e) => [e.key, e]));
		libraries.set(input, library);
	}
	return library.get(key);
}

/** `input` without its injuries, for a slot's usual choice. */
function withoutInjuries(input: ProgrammingInput): ProgrammingInput {
	let open = uninjured.get(input);
	if (!open) {
		open = { ...input, injuries: [] };
		uninjured.set(input, open);
	}
	return open;
}

/** 'a', 'a and b', 'a, b and c'. */
export const listing = (items: readonly string[]) =>
	items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** A reason as it reads after 'but': 'it needs a barbell', 'your … injury rules out …'. */
const reasonWords = (reason: Reason) =>
	reason.kind === 'equipment' ? `it ${lowerFirst(reason.text)}` : lowerFirst(reason.text);

/** How decisions name a slot: 'main squat', 'vertical push'. */
export const slotLabel = (role: SlotRole, kind: SlotKindKey) =>
	role === 'main' ? `main ${SLOT_KINDS[kind].label}` : SLOT_KINDS[kind].label;

/**
 * `keys` best first for a `role` slot, keeping their order within a tie: work of the slot's kind
 * (compound or explosive for a lift, an accessory for an accessory slot), then liked, then within
 * the owner's skill, then tagged for the split's discipline.
 */
function ranked(
	keys: readonly ExerciseKey[],
	role: SlotRole,
	split: Split,
	input: ProgrammingInput
) {
	const cap = skillCap(input, split.discipline);
	const score = (e: LibraryExercise) => [
		(role === 'accessory') === isAccessory(e) ? 0 : 1,
		input.likes.includes(e.key) ? 0 : 1,
		SKILL_LEVELS.indexOf(e.skillLevel) <= cap ? 0 : 1,
		e.disciplines.includes(split.discipline) ? 0 : 1
	];
	return keys
		.map((key) => ({ key, rank: score(exerciseOf(input, key)!) }))
		.sort((a, b) => a.rank.reduce((d, n, i) => d || n - b.rank[i]!, 0))
		.map(({ key }) => key);
}

/** Each strength day's exercises, in split order, with their decisions in `log`. */
export function selectWeek(
	split: Split,
	input: ProgrammingInput,
	log: DecisionLog
): DaySelection[] {
	const nameOf = (key: ExerciseKey) => exerciseOf(input, key)?.name ?? key;
	const decisions = new Map<string, () => void>();
	const once = (id: string, write: () => void) => decisions.has(id) || decisions.set(id, write);
	const empty = new Map<string, { slot: string; sessions: string[]; reason: string }>();
	const week = new Set<ExerciseKey>();

	const days = split.days.map((day, d): DaySelection => {
		const today = new Set<ExerciseKey>();
		const notToday = (keys: readonly ExerciseKey[]) => keys.find((k) => !today.has(k));
		const pick = (keys: readonly ExerciseKey[]) =>
			keys.find((k) => !today.has(k) && !week.has(k)) ?? notToday(keys);
		const exercises = day.slots.flatMap(([role, kind, lift], s): Selected[] => {
			const { patterns, label, muscles }: SlotKind = SLOT_KINDS[kind];
			const slot = {
				key: `strength.${split.layout}.${d}.${s}`,
				patterns,
				discipline: split.discipline
			};
			const fits = (key: ExerciseKey) =>
				!muscles || exerciseOf(input, key)!.primaryMuscles.some((m) => muscles.includes(m));
			const best = (from: ProgrammingInput) =>
				ranked(candidates(slot, from).keys.filter(fits), role, split, input);
			const named = slotLabel(role, kind);
			const usual =
				lift && split.lifts && !today.has(lift) ? lift : pick(best(withoutInjuries(input)));
			const verdict = usual === undefined ? null : isEligible(exerciseOf(input, usual)!, input);
			const alternatives = usual && !verdict?.ok ? alternativesFor(usual, input).alternatives : [];
			// A lift's stand-in repeats across the week as the lift would.
			const standIn = lift && split.lifts ? notToday : pick;
			const chosen = verdict?.ok
				? usual
				: (standIn(alternatives.map((a) => a.key)) ?? pick(best(input)));
			if (!chosen) {
				const excluded = candidates(slot, input).excluded.filter((e) => fits(e.key));
				const reason = whyNothingFits(excluded, input);
				const entry = empty.get(`${named}|${reason}`) ?? { slot: named, sessions: [], reason };
				if (!entry.sessions.includes(day.title)) entry.sessions.push(day.title);
				empty.set(`${named}|${reason}`, entry);
				return [];
			}
			if (usual && verdict && !verdict.ok) {
				const group = exerciseOf(input, chosen)!.substitutionGroup;
				once(`substituted:${usual}:${chosen}`, () =>
					log.add('exercise_substituted', 'strength.substituted', FIRST_BLOCK, {
						exercise: nameOf(chosen),
						original: nameOf(usual),
						reason: clip(reasonWords(verdict.reasons[0]!), 200),
						intent: (group && SUBSTITUTION_GROUPS[group]) || `It trains the ${label} as well.`
					})
				);
			} else if (role === 'main' || role === 'power') {
				const baseline = catalogueByKey.get(chosen)?.baselineLift;
				const because =
					chosen === lift && split.lifts
						? COMPETITION_SLOTS[split.layout]?.includes(kind)
							? 'competition'
							: baseline && input.baselines[baseline]
								? 'measured'
								: 'baseline'
						: input.likes.includes(chosen)
							? 'liked'
							: 'best';
				once(`selected:${named}:${chosen}`, () =>
					log.add('exercise_selected', `strength.${because}`, FIRST_BLOCK, {
						exercise: nameOf(chosen),
						slot: named,
						reason: SELECTED_BECAUSE[because]
					})
				);
			}
			today.add(chosen);
			week.add(chosen);
			return [{ role, kind, exercise: exerciseOf(input, chosen)! }];
		});
		return { day, exercises };
	});

	for (const key of input.dislikes) {
		if (!exerciseOf(input, key)) continue;
		log.add('exercise_excluded', 'strength.disliked', FIRST_BLOCK, {
			exercise: nameOf(key),
			reason: lowerFirst(DISLIKED)
		});
	}
	for (const text of avoidanceFor(input).unmatched) {
		log.add('unmapped_avoidance', 'strength.unmapped_avoidance', FIRST_BLOCK, {
			text: clip(text, 200)
		});
	}
	for (const write of decisions.values()) write();
	for (const { slot, sessions, reason } of empty.values()) {
		log.add('slot_empty', 'strength.slot_empty', FIRST_BLOCK, {
			slot,
			sessions: clip(listing(sessions), 200),
			reason: clip(reason, 200)
		});
	}
	return days;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** A set of `e` measured by `reps` clamped into its own range, or by its seconds or metres. */
function measureOf(e: LibraryExercise, [a, b]: readonly [number, number], ownRange: boolean) {
	const none = { repsMin: null, repsMax: null, seconds: null, metres: null };
	if (e.measure === 'time') return { ...none, seconds: e.defaultSeconds };
	if (e.measure === 'distance') return { ...none, metres: DEFAULT_METRES };
	const [lo, hi] = [e.repMin ?? a, e.repMax ?? b];
	return ownRange
		? { ...none, repsMin: lo, repsMax: hi }
		: { ...none, repsMin: clamp(a, lo, hi), repsMax: clamp(b, lo, hi) };
}

const line = (
	role: SetPrescription['role'],
	sets: number,
	measure: ReturnType<typeof measureOf>,
	targetRpe: number,
	restSeconds: number
): SetPrescription => ({
	role,
	sets,
	...measure,
	targetRpe,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds,
	tempo: null,
	notes: null
});

/**
 * A selected exercise as a week prescribes it: a main lift's top set at the week's RPE cap and
 * its back-offs a point under it, any other work at WORKING_RPE or the cap if lower.
 */
export function plannedExercise(
	{ role, exercise }: Selected,
	split: Split,
	rpeCap: number
): PlannedExercisePlan {
	const { sets, reps, rest } = split.prescription[role];
	const measure = measureOf(exercise, reps, role === 'accessory');
	return {
		exercise: toExerciseRef(exercise.key),
		baselineLift: catalogueByKey.get(exercise.key)?.baselineLift ?? null,
		superset: null,
		substitutedFrom: null,
		substitutionReason: null,
		instructions: null,
		notes: null,
		sets:
			role === 'main'
				? [
						line('top', 1, measure, rpeCap, rest),
						line('back_off', sets, measure, Math.max(5, rpeCap - 1), rest)
					]
				: [line('working', sets, measure, Math.min(WORKING_RPE, rpeCap), rest)]
	};
}
