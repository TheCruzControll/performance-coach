/**
 * What each set shows before it is touched (PRD §8): the next set's values, so logging it is one
 * tap. A weight is prefilled only when it can be computed, or was logged for that very exercise.
 *
 * - The load, by the prescription's load kind:
 *   - absolute: as prescribed
 *   - percent_1rm: as the kit computed it
 *   - from_e1rm: from today's top set once it is logged (M3's setE1rm, through logging-rules'
 *     e1rmOf, and M3's prescribedLoad), else the kit's load from the latest estimate
 *   - rpe_based: the exercise's previous set today, else the previous session's matching set
 *     (working sets match working sets, warm-ups warm-ups), else nothing: the set's own
 *     instruction (the baseline one) shows instead, or the RPE to pick a load by
 * - The field, by the performed exercise's load type (logging-rules' setFields): bodyweight
 *   prefills its last set's added weight, else nothing (bodyweight only); assisted its last
 *   assistance, never a weight; none no load at all.
 * - A substitute never inherits the original's absolute, percent_1rm or from_e1rm load: as in
 *   M3's swap, its load is rpe_based at the same target RPE. Its weight comes from its own sets:
 *   today's, else its last top set (its previous sets once attached, else the kit alternative's),
 *   else nothing, with the RPE instruction.
 * - A load in another unit is converted with M1's convertWeight and rounded to M1's
 *   DEFAULT_LOAD_INCREMENT; one in the owner's unit stays exactly as prescribed or logged.
 * - The amount is the prescription's: reps from the range's lower bound, or seconds, or metres;
 *   with none (an added exercise), the same set the load comes from gives it.
 * - The target RPE is preselected when it is one of RPE_CHIPS.
 *
 * Every number is M1's or M3's, called and never redefined.
 */
import { RPE_MAX, RPE_MIN } from '../rpe.ts';
import { prescribedLoad } from '../training/describe.ts';
import { NON_WORKING_ROLES } from '../training/metrics.ts';
import type { SetPrescription } from '../training/types.ts';
import type { LoadKind, LoadType, Measure } from '../training/vocabulary.ts';
import { convertWeight, DEFAULT_LOAD_INCREMENT, roundToIncrement } from '../units.ts';
import type { WeightUnit } from '../units.ts';
import { e1rmOf, LOAD_RULES, setFields } from './logging.ts';
import type { RuledSet, SetFields } from './logging.ts';
import type { CanonicalSet } from './protocol.ts';
import type { KitExercise, KitSet, LoggedSet, PreviousPerformance } from './types.ts';

/** The RPE chips the logger offers: M1's RPE_MIN to RPE_MAX in half steps, 6 to 10. */
export const RPE_CHIPS: readonly number[] = Array.from(
	{ length: (RPE_MAX - RPE_MIN) * 2 + 1 },
	(_, i) => RPE_MIN + i / 2
);

/** What an RPE-picked load left blank asks for, when its set has no instruction of its own. */
export const rpeInstruction = (rpe: number) => `Pick a load that feels like RPE ${rpe}`;

/** The exercise a slot performs, the planned one or a substitute, with the rules it logs by. */
export interface PerformedExercise {
	/** SlotView.exerciseId. */
	exerciseId: string;
	measure: Measure;
	loadType: LoadType;
	/**
	 * Its own previous sets attached on this device (DeviceState.attached, through kit.attach):
	 * undefined until attached, null when it has none.
	 */
	attached?: PreviousPerformance | null;
}

/** A set logged or skipped in the slot today, as the view holds it (CanonicalSet fits). */
export type SlotSet = RuledSet & Pick<CanonicalSet, 'setIndex' | 'exerciseId'>;

/**
 * Where a prefilled load comes from:
 * - prescribed: the kit's computed load (absolute, percent_1rm, or from_e1rm's latest estimate)
 * - top_set_today: a from_e1rm load worked out from today's top set
 * - previous_set: the exercise's previous set today
 * - last_session: the previous session's matching set
 * - last_top_set: a substitute's own last top set
 */
export type LoadSource =
	'prescribed' | 'top_set_today' | 'previous_set' | 'last_session' | 'last_top_set';

export interface Prefill {
	/** 1-based: the slot's first planned set not yet logged or skipped, else one beyond the plan. */
	setIndex: number;
	/** The planned set it performs; null beyond the plan and on an added exercise. */
	planned: KitSet | null;
	/** The fields the logger asks for, by the performed exercise's measure and load type. */
	fields: SetFields;
	/** How the load is worked out: the prescription's kind, rpe_based for a substitute. */
	loadKind: LoadKind | null;
	/** The logger's starting values, in the owner's unit; what the exercise does not record is null. */
	values: LoggedSet;
	loadFrom: LoadSource | null;
	/** What shows in place of a weight that cannot be prefilled. */
	instruction: string | null;
}

/** A from_e1rm line as M3's prescribedLoad reads it: only its kind and fraction matter. */
const fromE1rm = (fraction: number): SetPrescription => ({
	role: 'back_off',
	sets: 1,
	repsMin: null,
	repsMax: null,
	seconds: null,
	metres: null,
	targetRpe: null,
	loadKind: 'from_e1rm',
	loadValue: fraction,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: null,
	tempo: null,
	notes: null
});

const isWarmUp = (set: KitSet) => NON_WORKING_ROLES.includes(set.role);

/** `value` in the owner's unit: exact when it already is, else converted and rounded. */
const inUnit = (value: number, from: WeightUnit, unit: WeightUnit) =>
	from === unit
		? value
		: roundToIncrement(convertWeight(value, from, unit), DEFAULT_LOAD_INCREMENT[unit]);

/** A planned set's load kind; a kit without one reads it off the computed load. */
function kindOf({ load, prescribedWeight }: KitSet): LoadKind {
	if (load) return load.kind;
	if (!prescribedWeight) return 'rpe_based';
	return prescribedWeight.basis === 'absolute' ? 'absolute' : 'percent_1rm';
}

/** The most load in kg, or on an assisted exercise the least assistance (lower is harder). */
function loadScore(set: LoggedSet, loadType: LoadType): number {
	if (loadType !== 'assisted') return convertWeight(set.weight ?? 0, set.unit, 'kg');
	return set.assistance === null ? -Infinity : -convertWeight(set.assistance, set.unit, 'kg');
}

/**
 * A session's top set: the working set with the most load (the least assistance on an assisted
 * exercise), then the most reps, seconds or metres; the first of equals. Null with none.
 */
export function topSetOf<S extends LoggedSet>(sets: readonly S[], loadType: LoadType): S | null {
	const amount = (set: LoggedSet) => set.reps ?? set.seconds ?? set.metres ?? 0;
	let top: S | null = null;
	for (const set of sets) {
		if (set.isWarmup) continue;
		if (top === null) {
			top = set;
			continue;
		}
		const [score, best] = [loadScore(set, loadType), loadScore(top, loadType)];
		if (score > best || (score === best && amount(set) > amount(top))) top = set;
	}
	return top;
}

/** The first planned index with no set logged or skipped, else the one after the last set. */
function nextIndex(planned: number, logged: readonly SlotSet[]): number {
	const taken = new Set(logged.map((set) => set.setIndex));
	for (let i = 1; i <= planned; i++) if (!taken.has(i)) return i;
	return Math.max(planned, ...taken) + 1;
}

/** The latest e1RM of the planned exercise's top sets logged today, in kg. */
function topSetToday(kit: KitExercise, logged: readonly SlotSet[]): number | null {
	let e1rm: number | null = null;
	for (const set of logged) {
		const top = kit.sets[set.setIndex - 1]?.role === 'top';
		if (top && set.exerciseId === kit.exercise.id) e1rm = e1rmOf(set, kit.exercise)?.value ?? e1rm;
	}
	return e1rm;
}

interface Source {
	set: LoggedSet;
	from: LoadSource;
}

/** The performed exercise's own set its load (rpe_based) and a missing amount come from. */
function historyOf(
	slot: PerformedExercise,
	logged: readonly SlotSet[],
	kit: KitExercise | null,
	setIndex: number,
	warm: boolean
): Source | null {
	const own = logged.filter((s) => s.exerciseId === slot.exerciseId && !s.isSkipped);
	const previousSet = own.filter((s) => s.isWarmup === warm).at(-1);
	if (previousSet) return { set: previousSet, from: 'previous_set' };

	if (kit && slot.exerciseId !== kit.exercise.id) {
		const alternative = kit.alternatives?.find((a) => a.exercise.id === slot.exerciseId);
		const top = slot.attached ? topSetOf(slot.attached.sets, slot.loadType) : null;
		const last = top ?? alternative?.lastTopSet ?? null;
		return last && { set: last, from: 'last_top_set' };
	}
	const previous = slot.attached !== undefined ? slot.attached : (kit?.previous ?? null);
	const pool = previous?.sets.filter((s) => s.isWarmup === warm) ?? [];
	const before = kit ? kit.sets.slice(0, setIndex - 1).filter((s) => isWarmUp(s) === warm) : null;
	const match = pool[Math.min(before?.length ?? setIndex - 1, pool.length - 1)];
	return match ? { set: match, from: 'last_session' } : null;
}

/**
 * The next set of a slot, prefilled: `slot` is the exercise performed there, `logged` the sets
 * logged or skipped in it today (SlotView.sets), `kit` the planned exercise's kit entry (null for
 * an added exercise), and `unit` the owner's weight unit.
 */
export function nextSet(
	slot: PerformedExercise,
	logged: readonly SlotSet[],
	kit: KitExercise | null,
	unit: WeightUnit
): Prefill {
	const plan = kit?.sets ?? [];
	const setIndex = nextIndex(plan.length, logged);
	const planned = plan[setIndex - 1] ?? null;
	const template = planned ?? plan.at(-1) ?? null;
	const substitute = kit !== null && slot.exerciseId !== kit.exercise.id;
	const warm = template !== null && isWarmUp(template);
	const loadKind = template && (substitute ? 'rpe_based' : kindOf(template));
	const rpe = template?.targetRpe ?? null;
	const fields = setFields(slot.measure, slot.loadType);
	const history = historyOf(slot, logged, kit, setIndex, warm);

	const fromHistory = (column: 'weight' | 'assistance'): (Source & { value: number }) | null => {
		const value = history?.set[column] ?? null;
		return history && value !== null
			? { ...history, value: inUnit(value, history.set.unit, unit) }
			: null;
	};
	const load = (): { value: number; from: LoadSource } | null => {
		if (fields.load === null) return null;
		if (fields.load === 'assistance') return fromHistory('assistance');
		if (template === null || loadKind === 'rpe_based') return fromHistory('weight');
		const fraction = template.load?.fraction ?? null;
		const e1rm = loadKind === 'from_e1rm' && kit ? topSetToday(kit, logged) : null;
		if (e1rm !== null && fraction !== null) {
			const value = prescribedLoad(fromE1rm(fraction), { unit, oneRepMaxKg: e1rm });
			if (value !== null) return { value, from: 'top_set_today' };
		}
		const p = template.prescribedWeight;
		return p && { value: inUnit(p.value, p.unit, unit), from: 'prescribed' };
	};
	const prefilled = load();

	const values: LoggedSet = {
		reps: null,
		seconds: null,
		metres: null,
		weight: fields.load === 'weight' || fields.load === 'added' ? (prefilled?.value ?? null) : null,
		assistance: fields.load === 'assistance' ? (prefilled?.value ?? null) : null,
		unit,
		rpe: rpe !== null && RPE_CHIPS.includes(rpe) ? rpe : null,
		missedReps: 0,
		isWarmup: warm,
		isExtra: kit !== null && planned === null
	};
	const amount = fields.amount;
	const prescribed =
		template && (amount === 'reps' ? (template.repsMin ?? template.repsMax) : template[amount]);
	values[amount] = prescribed ?? history?.set[amount] ?? null;

	const asks = prefilled === null && LOAD_RULES[slot.loadType].required;
	const byRpe = rpe === null ? null : rpeInstruction(rpe);
	return {
		setIndex,
		planned,
		fields,
		loadKind,
		values,
		loadFrom: prefilled?.from ?? null,
		instruction: asks ? (substitute ? byRpe : (template?.instruction ?? byRpe)) : null
	};
}

/** Missed reps, from the target: max(0, repsMin − reps); 0 with no reps target or none entered. */
export function defaultMissedReps(
	set: Pick<KitSet, 'repsMin'> | null,
	reps: number | null
): number {
	if (set === null || set.repsMin === null || reps === null) return 0;
	return Math.max(0, set.repsMin - reps);
}
