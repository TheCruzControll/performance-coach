/**
 * Kept and rotated exercises (M6), once M3's strength and volume stages have filled the strength
 * days, when generateNextBlock runs the stage list (next-block/generate.ts CARRYOVER_AFTER). The next block's input already likes the kept exercises and excludes the rotated ones
 * (next-block/input.ts), so selection mostly carries them; this stage makes sure of it and says so.
 *
 * A slot is a place in a strength day: the day's title and the exercise's position in it, the same
 * in every week of a block.
 *
 * - A kept exercise of the last block that selection did not place takes the slots of the first
 *   accessory with its pattern, measure and a primary muscle in common, unless it may no longer be
 *   prescribed (equipment, an injury, a dislike). Each kept exercise in the block gets an
 *   exercise_kept decision.
 * - A rotated exercise's slots, the places it held in the last block, take M3's top-ranked
 *   eligible alternative (alternatives.ts), never a disliked or ineligible one, a kept one or one
 *   the block plans elsewhere; a day that already holds it keeps its own choice, and a kept
 *   exercise keeps its slot, and a liked exercise is not rotated. Each rotation gets an
 *   exercise_rotated decision naming the accessory that holds the old slot now, pointing at it.
 * - A main lift (one with a top set) is never displaced: directives never rotate one.
 */
import type { BlockPlan, DecisionPlan, StrengthSessionPlan } from '../../training/types.ts';
import { MOVEMENT_PATTERN_LABEL } from '../../training/vocabulary.ts';
import { alternativesFor, RELATED_PATTERNS } from '../alternatives.ts';
import { isEligible } from '../eligibility.ts';
import type { LibraryExercise } from '../eligibility.ts';
import { toExerciseKey, toExerciseRef } from '../input.ts';
import type { ExerciseKey, ProgrammingInput } from '../input.ts';
import type { Reasoned } from '../review/directives.ts';
import { exerciseOf } from '../selection.ts';
import type { Stage } from '../stage.ts';

export interface Carryover {
	/** The reviewed block as it was planned. */
	previous: BlockPlan;
	keep: readonly Reasoned[];
	rotate: readonly Reasoned[];
}

interface Placed {
	/** Its first plan path in the block. */
	path: string;
	main: boolean;
	/** Its slots: `title#position`. */
	slots: Set<string>;
}

const slotKey = (session: StrengthSessionPlan, position: number) => `${session.title}#${position}`;

/** Each strength exercise of `block`, in plan order, with where it sits; `holders` by slot. */
function exercisesIn(block: BlockPlan) {
	const found = new Map<ExerciseKey, Placed>();
	const holders = new Map<string, { key: ExerciseKey; path: string }>();
	block.weeks.forEach((week, w) =>
		week.sessions.forEach((session, s) => {
			if (session.kind !== 'strength') return;
			session.exercises.forEach((planned, e) => {
				const key = toExerciseKey(planned.exercise);
				const path = `blocks.0.weeks.${w}.sessions.${s}.exercises.${e}`;
				const at = found.get(key) ?? { path, main: false, slots: new Set<string>() };
				at.main ||= planned.sets.some((line) => line.role === 'top');
				const slot = slotKey(session, e);
				at.slots.add(slot);
				found.set(key, at);
				if (!holders.has(slot)) holders.set(slot, { key, path });
			});
		})
	);
	return Object.assign(found, { holders });
}

/** Whether `slot` keeps `of`'s intent: its pattern (or a related one), measure and a primary muscle. */
const keepsIntent = (slot: LibraryExercise, of: LibraryExercise) =>
	[of.pattern, ...(RELATED_PATTERNS[of.pattern] ?? [])].includes(slot.pattern) &&
	slot.measure === of.measure &&
	slot.primaryMuscles.some((m) => of.primaryMuscles.includes(m));

const slotName = (e: LibraryExercise) => MOVEMENT_PATTERN_LABEL[e.pattern].toLowerCase();
const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** `block` with each slot in `into` taken by its exercise, in every week; main and kept lifts stay. */
function filled(
	block: BlockPlan,
	into: ReadonlyMap<string, ExerciseKey>,
	kept: ReadonlySet<ExerciseKey>
): BlockPlan {
	if (!into.size) return block;
	const weeks = block.weeks.map((week) => ({
		...week,
		sessions: week.sessions.map((session) => {
			if (session.kind !== 'strength') return session;
			const keys = new Set(session.exercises.map((p) => toExerciseKey(p.exercise)));
			const exercises = session.exercises.map((planned, e) => {
				const to = into.get(slotKey(session, e));
				const main = planned.sets.some((line) => line.role === 'top');
				if (!to || main || keys.has(to) || kept.has(toExerciseKey(planned.exercise)))
					return planned;
				keys.add(to);
				return { ...planned, exercise: toExerciseRef(to), baselineLift: null };
			});
			return { ...session, exercises };
		})
	}));
	return { ...block, weeks };
}

/**
 * `decisions` with each exercise_kept naming where its exercise sits in the finished `block`.
 * Carryover logs it before timefit, which may then drop that accessory from a session, so the
 * decision moves to the exercise's first place left in the block, or goes when there is none.
 */
export function keptWhereTheyAre(
	block: BlockPlan,
	input: ProgrammingInput,
	decisions: DecisionPlan[]
): DecisionPlan[] {
	const paths = new Map(
		[...exercisesIn(block)].map(([key, at]) => [exerciseOf(input, key)?.name, at.path])
	);
	return decisions.flatMap((d) => {
		if (d.kind !== 'exercise_kept') return [d];
		const path = paths.get(String(d.evidence.exercise));
		return !path ? [] : path === d.refs[0] ? [d] : [{ ...d, refs: [path] }];
	});
}

export function carryover({ previous, keep, rotate }: Carryover): Stage {
	return (draft, { input, log }) => {
		const block = draft.blocks[0];
		if (!block) return draft;
		const before = exercisesIn(previous);
		const placed = exercisesIn(block);
		const known = (key: ExerciseKey) => (before.has(key) ? exerciseOf(input, key) : undefined);
		const kept = new Set(keep.map((k) => k.exercise));
		const into = new Map<string, ExerciseKey>();
		const taken = (key: ExerciseKey) => [...into.values()].includes(key);
		const fill = (slots: Iterable<string>, key: ExerciseKey) => {
			for (const slot of slots) if (!into.has(slot)) into.set(slot, key);
		};
		/** The first accessory now planned that keeps `of`'s intent and is neither kept nor taken. */
		const accessoryFor = (of: LibraryExercise) =>
			[...placed].find(([key, at]) => {
				const there = exerciseOf(input, key);
				return !at.main && !kept.has(key) && !taken(key) && !!there && keepsIntent(there, of);
			});

		type Facts = { exercise: string; slot: string; reason: string };
		const kepts: { key: ExerciseKey; facts: Facts }[] = [];
		const rotations: { old: Set<string>; facts: Omit<Facts, 'exercise'> & { previous: string } }[] =
			[];
		for (const { exercise, reason } of keep) {
			const e = known(exercise);
			if (!e || !isEligible(e, input).ok) continue;
			if (!placed.has(exercise)) {
				const slot = accessoryFor(e);
				if (!slot) continue;
				fill(slot[1].slots, exercise);
			}
			const facts = { exercise: e.name, slot: slotName(e), reason: lower(reason) };
			kepts.push({ key: exercise, facts });
		}
		for (const { exercise, reason } of rotate) {
			const e = known(exercise);
			// A liked exercise is kept, not rotated (next-block/input.ts liked_not_rotated).
			if (!e || input.likes.includes(exercise)) continue;
			const old = before.get(exercise)!.slots;
			// Neither kept nor planned elsewhere in the block (a main lift), unless already in its slot.
			const free = (key: ExerciseKey) =>
				!kept.has(key) && [...(placed.get(key)?.slots ?? old)].some((slot) => old.has(slot));
			const best = alternativesFor(exercise, input).alternatives.find((a) => free(a.key));
			const next = best && exerciseOf(input, best.key);
			if (next) fill(old, next.key);
			rotations.push({
				old,
				facts: { slot: slotName(e), reason: lower(reason), previous: e.name }
			});
		}

		const result = filled(block, into, kept);
		const paths = exercisesIn(result);
		for (const { key, facts } of kepts) {
			const at = paths.get(key);
			if (at) log.add('exercise_kept', 'carryover.kept', [at.path], facts);
		}
		// Each rotation names whatever accessory now holds its old slot: the alternative, or
		// selection's choice. A main lift there replaced nothing (filled() skips main slots).
		for (const { old, facts } of rotations) {
			const at = [...old]
				.map((slot) => paths.holders.get(slot))
				.find((h) => h !== undefined && !paths.get(h.key)!.main);
			const now = at && exerciseOf(input, at.key);
			if (now && now.name !== facts.previous)
				log.add('exercise_rotated', 'carryover.rotated', [at.path], {
					...facts,
					exercise: now.name
				});
		}
		return { ...draft, blocks: [result, ...draft.blocks.slice(1)] };
	};
}
