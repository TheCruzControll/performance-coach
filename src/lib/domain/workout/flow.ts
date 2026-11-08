/**
 * What comes next after a set (PRD §7–§8; the M4 plan's logging rules): one pure function of the
 * projected workout (project.ts), so the logger, Up next (up-next.ts, which the strength view
 * loads on demand) and the rest timer agree.
 *
 * - A straight exercise stays current until its planned sets are done; then it is done, and Up
 *   next names what follows. An extra set never moves on by itself.
 * - Consecutive exercises with one superset number are a superset, labelled A1, A2, B1… in
 *   workout order (groups.ts). Its members alternate, A1 → A2 → A1, with no rest inside a round; the round's
 *   rest follows its last member: the rest that member prescribes, else (none, or 0) the longest
 *   in the round. A member with more sets than its partners continues as straight sets, with
 *   their own rest.
 * - A skipped set advances like a logged one. The next step is computed from the sets done, never
 *   stored, so going to an exercise by hand never breaks the alternation that follows.
 * - A rest of 0 starts none, and none starts once nothing is left to do.
 */
import { runsOf } from './groups.ts';
import { slotAt } from './selectors.ts';
import { DEFAULT_REST_SECONDS, restFor } from './timers.ts';
import type { RestDefaults } from './timers.ts';
import type { KitExerciseMeta, SlotView, WorkoutView } from './types.ts';

/**
 * How a superset runs, an owner decision (the M4 plan's open question 22): 'alternate' moves
 * A1 → A2 → A1 as above; 'straight' keeps each member current until its sets are done, every set
 * resting the round's rest, since its prescription assumed the partner followed. Labels show
 * either way. Change the default here.
 */
export type SupersetFlow = 'alternate' | 'straight';
export const SUPERSET_FLOW: SupersetFlow = 'alternate';

/** A set to do: its slot's position and its 1-based index there. */
export interface SetStep {
	position: number;
	setIndex: number;
}

/** The set to do next, or nothing left in the exercise (or superset), or in the workout. */
export type NextStep = SetStep | 'exercise-done' | 'workout-done';

export interface AfterSet {
	next: NextStep;
	/** The rest that starts now; null for none. */
	rest: { seconds: number } | null;
}

export interface FlowOptions {
	/** The device's rest per class (its settings), for a set whose prescription names none. */
	defaults?: Partial<RestDefaults>;
	/** SUPERSET_FLOW unless given. */
	supersets?: SupersetFlow;
}

// ---- Sets done and to do --------------------------------------------------------------------
// Exported for up-next.ts and Up next's words, which count sets the same way.

/**
 * The planned set indexes a slot has a set at, logged or skipped, as prefill's nextSet counts
 * them, so the set the flow names is the one the logger prefills. A set past the plan fills none.
 */
export type Filled = (slot: SlotView) => ReadonlySet<number>;

const planned = (slot: SlotView) => slot.kit?.sets.length ?? 0;

/** Skipped or stopped (pain): nothing more is done in it. */
const ended = (slot: SlotView) => slot.state === 'skipped' || slot.state === 'stopped';

export const filledOf: Filled = (slot) =>
	new Set(slot.sets.map((s) => s.setIndex).filter((index) => index <= planned(slot)));

/**
 * The set a slot does next: its first planned set not done, or an added exercise's first; null
 * when nothing is left, as progress() counts it, or the slot was skipped or stopped.
 */
export function toDo(slot: SlotView, filled: Filled = filledOf): number | null {
	if (ended(slot)) return null;
	if (planned(slot) === 0) return slot.sets.length === 0 ? 1 : null;
	const done = filled(slot);
	for (let i = 1; i <= planned(slot); i += 1) if (!done.has(i)) return i;
	return null;
}

/** The member with the lowest set to do, the first of them on a tie; null when none has one. */
export function firstToDo(
	members: readonly SlotView[],
	filled: Filled = filledOf
): SlotView | null {
	let first: { slot: SlotView; index: number } | null = null;
	for (const slot of members) {
		const index = toDo(slot, filled);
		if (index !== null && (first === null || index < first.index)) first = { slot, index };
	}
	return first?.slot ?? null;
}

/**
 * Whom a superset goes to after a set of `member`: the first after it, in turn, that has done
 * fewer sets, inside the round; else, the round over, the member with the lowest set to do.
 */
export function turn(members: readonly SlotView[], member: SlotView, filled: Filled) {
	const round = filled(member).size;
	const i = members.indexOf(member);
	const behind = [...members.slice(i + 1), ...members.slice(0, i)].find(
		(m) => toDo(m, filled) !== null && filled(m).size < round
	);
	return behind
		? { slot: behind, inRound: true }
		: { slot: firstToDo(members, filled), inRound: false };
}

// ---- Rest -----------------------------------------------------------------------------------

type Defaults = Partial<RestDefaults>;

/** The exercise a slot performs, as the device knows it: the kit's, an option's or an added one. */
function performed(view: WorkoutView, slot: SlotView): Pick<KitExerciseMeta, 'restClass'> {
	const kit = slot.kit;
	const known = [
		...(kit ? [kit.exercise] : []),
		...(kit?.alternatives ?? []).map((a) => a.exercise),
		...Object.values(kit?.gentler ?? {}).flatMap((options) =>
			(options ?? []).map((a) => a.exercise)
		),
		...view.device.added.map((a) => a.exercise)
	];
	return known.find((e) => e.id === slot.exerciseId) ?? kit?.exercise ?? { restClass: 'compound' };
}

/** The rest after a slot's planned set `setIndex` (restFor), in ms. */
const setRest = (view: WorkoutView, slot: SlotView, setIndex: number, defaults: Defaults) =>
	restFor(slot.kit?.sets[setIndex - 1] ?? null, performed(view, slot), defaults);

/**
 * The rest after a superset's round `round`, in ms: the rest its last member prescribes, else (none,
 * or 0, which leaves the rest to the other end of the round) the longest of its members', each by
 * restFor. A round of one member is a straight set, with that member's own rest.
 */
function roundRest(
	view: WorkoutView,
	members: readonly SlotView[],
	member: SlotView,
	round: number,
	defaults: Defaults
): number {
	const inRound = round < 1 ? [] : members.filter((m) => planned(m) >= round && !ended(m));
	const last = inRound.at(-1);
	if (!last) return setRest(view, member, round, defaults);
	const prescribed = last.kit!.sets[round - 1]!.restSeconds ?? 0;
	if (prescribed > 0) return prescribed * 1000;
	return Math.max(...inRound.map((m) => setRest(view, m, round, defaults)));
}

// ---- After a set ----------------------------------------------------------------------------

/** Nothing left in the workout, or only in this exercise. */
const doneStep = (view: WorkoutView): NextStep =>
	view.slots.every((slot) => toDo(slot) === null) ? 'workout-done' : 'exercise-done';

/** The slot's set to do, as a step; null when it has none. */
function stepOf(slot: SlotView | null): SetStep | null {
	const setIndex = slot ? toDo(slot) : null;
	return slot && setIndex !== null ? { position: slot.position, setIndex } : null;
}

/** The run of the view's slots a slot belongs to: itself alone when straight. */
const runOf = (view: WorkoutView, slot: SlotView) =>
	runsOf(view.slots).find((run) => run.includes(slot)) ?? [slot];

/**
 * What the screen does once a set at `position` is logged or skipped (the view already holds
 * it): the set to do next and the rest that starts now.
 */
export function afterSet(view: WorkoutView, position: number, options: FlowOptions = {}): AfterSet {
	const { defaults = DEFAULT_REST_SECONDS, supersets = SUPERSET_FLOW } = options;
	const slot = slotAt(view, position);
	if (!slot) return { next: doneStep(view), rest: null };
	const done = filledOf(slot).size;
	const members = runOf(view, slot);
	const settle = (next: NextStep | null, ms: number): AfterSet => {
		const step = next ?? doneStep(view);
		return { next: step, rest: step === 'workout-done' || ms <= 0 ? null : { seconds: ms / 1000 } };
	};
	if (members.length < 2) return settle(stepOf(slot), setRest(view, slot, done, defaults));
	const rest = roundRest(view, members, slot, done, defaults);
	if (supersets === 'straight') return settle(stepOf(slot), rest);
	const { slot: next, inRound } = turn(members, slot, filledOf);
	return inRound ? { next: stepOf(next)!, rest: null } : settle(stepOf(next), rest);
}
