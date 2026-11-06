/**
 * What each in-workout quick action does (PRD §8; the brief's substitution rules), as one pure
 * table the actions sheet, the projection's structure reducers and the server's handlers share.
 * copy.ts holds every word they show.
 *
 * - Machine unavailable: today's substitution only (equipment_unavailable), never a preference
 *   or a program change. Alternatives that need none of the slot's equipment rank first.
 * - Suggest an alternative: the kit's ranked alternatives as they are (owner_choice).
 * - I don't like this exercise: after an explicit confirmation, a lasting dislike (M3's exercise
 *   preference), today's substitution (dislike) and, when the slot performs its planned exercise,
 *   the program's swap from today. The server decides whether the program still holds it.
 * - This hurts: a pain report, never a preference. Stop this exercise comes first, then the
 *   kit's gentler options for the chosen area, then End the workout here when it is severe.
 * - Skip exercise: a skipped set for each planned set not done yet.
 */
import type { BodyArea, Equipment, Severity } from '../profile/catalog.ts';
import type { SubstitutionReason } from '../training/vocabulary.ts';
import type { MutationType, PainAction } from './mutations.ts';
import type { KitAlternative, SlotView } from './types.ts';

/**
 * The reason only a confirmed dislike's substitution carries: a slot whose latest substitution
 * has it reads "Won't be prescribed again". The rows hold only the reason, so no swap made
 * without the preference may carry it.
 */
export const DISLIKE_REASON = 'dislike' satisfies SubstitutionReason;

/**
 * 'Just swap it today', the Fix for a refused dislike, re-sends it under its id as
 * exercise.substitute with this reason and no preference, so it reads Swapped for this session.
 * (A plan amendment: the plan re-sent it with reason dislike.)
 */
export const JUST_SWAP_REASON = 'situational' satisfies SubstitutionReason;

export interface QuickActionRule {
	/** The mutation it ends in. */
	sends: Extract<
		MutationType,
		'exercise.substitute' | 'exercise.dislike' | 'pain.report' | 'exercise.skip'
	>;
	/** The reason of the substitution it records; null when it records none. */
	reason: SubstitutionReason | null;
	/** What the owner picks before anything is sent. */
	picks: 'alternative' | 'pain_choice' | null;
	/** Whether it writes an exercise preference, which outlives the workout. */
	preference: boolean;
	/**
	 * When it replaces the exercise in the program from today: never, or when the slot performs
	 * its planned exercise. 'never' on the dislike would only keep it out of generated weeks
	 * (the owner's open question on dislikes).
	 */
	program: 'never' | 'planned_exercise';
	/** Whether the owner confirms it explicitly before anything is sent. */
	confirms: boolean;
}

/** The quick actions, in the order the sheet offers them. */
export const QUICK_ACTIONS = {
	machine_unavailable: {
		sends: 'exercise.substitute',
		reason: 'equipment_unavailable',
		picks: 'alternative',
		preference: false,
		program: 'never',
		confirms: false
	},
	suggest_alternative: {
		sends: 'exercise.substitute',
		reason: 'owner_choice',
		picks: 'alternative',
		preference: false,
		program: 'never',
		confirms: false
	},
	dislike: {
		sends: 'exercise.dislike',
		reason: DISLIKE_REASON,
		picks: 'alternative',
		preference: true,
		program: 'planned_exercise',
		confirms: true
	},
	pain: {
		sends: 'pain.report',
		reason: 'pain',
		picks: 'pain_choice',
		preference: false,
		program: 'never',
		confirms: false
	},
	skip: {
		sends: 'exercise.skip',
		reason: null,
		picks: null,
		preference: false,
		program: 'never',
		confirms: false
	}
} as const satisfies Record<string, QuickActionRule>;

export type QuickAction = keyof typeof QUICK_ACTIONS;

export interface Effects {
	writesPreference: boolean;
	changesProgram: boolean;
	needsConfirmation: boolean;
}

/** The slot an action is taken on, as the projection shows it. */
type Target = Pick<SlotView, 'plannedLineage' | 'exerciseId' | 'kit'>;

/** What an action does beyond this session, for the slot it is taken on. */
export function effectsOf(action: QuickAction, slot: Target): Effects {
	const rule: QuickActionRule = QUICK_ACTIONS[action];
	const performsPlanned = slot.plannedLineage !== null && slot.kit?.exercise.id === slot.exerciseId;
	return {
		writesPreference: rule.preference,
		changesProgram: rule.program === 'planned_exercise' && performsPlanned,
		needsConfirmation: rule.confirms
	};
}

/** What the slot's exercise needs: the planned one's kit entry, or its substitute's alternative. */
function equipmentOf({ kit, exerciseId }: Target): readonly Equipment[] {
	if (kit?.exercise.id === exerciseId) return kit.exercise.equipment ?? [];
	return kit?.alternatives?.find((a) => a.exercise.id === exerciseId)?.equipment ?? [];
}

/**
 * The kit's alternatives in the order a reason offers them. Equipment unavailable puts those that
 * need none of the slot's equipment first; each part, every other reason, and a slot whose needs
 * the kit does not say (an added exercise) keep the kit's (M3's) ranking.
 */
export function rankFor(
	reason: SubstitutionReason,
	alternatives: readonly KitAlternative[],
	slot: Target
): KitAlternative[] {
	if (reason !== 'equipment_unavailable') return [...alternatives];
	const taken = equipmentOf(slot);
	const free = alternatives.filter((a) => !a.equipment.some((e) => taken.includes(e)));
	return [...free, ...alternatives.filter((a) => !free.includes(a))];
}

/** The severities at which This hurts also offers End the workout here. */
export const END_WORKOUT_SEVERITIES: readonly Severity[] = ['severe'];

/**
 * A pain report's choices, each its own report action: Stop (with an exercise.skip of what is
 * left), a gentler option (with its exercise.substitute, reason pain) or End the workout (then
 * the finish).
 */
export type PainChoice =
	| { action: Extract<PainAction, 'stopped'> }
	| { action: Extract<PainAction, 'substituted'>; option: KitAlternative }
	| { action: Extract<PainAction, 'ended_workout'> };

/**
 * What This hurts offers, in order: Stop this exercise always first; then, once an area is
 * chosen, the kit's gentler options for it (server-computed, never the original), leaving out the
 * exercise being performed; then End the workout here when the pain is severe.
 */
export function painChoices(
	slot: Pick<SlotView, 'kit' | 'exerciseId'>,
	area: BodyArea | null,
	severity: Severity | null
): PainChoice[] {
	const options = (area === null ? [] : (slot.kit?.gentler?.[area] ?? [])).filter(
		(o) => o.exercise.id !== slot.exerciseId
	);
	const ends = severity !== null && END_WORKOUT_SEVERITIES.includes(severity);
	return [
		{ action: 'stopped' },
		...options.map((option) => ({ action: 'substituted' as const, option })),
		...(ends ? [{ action: 'ended_workout' as const }] : [])
	];
}

/** The pain report actions after which nothing more is done in the slot: it reads Stopped. */
export const STOPPING_PAIN_ACTIONS: readonly PainAction[] = ['stopped', 'ended_workout'];

/** A slot's planned sets with no row yet, logged or skipped: what Skip exercise and Stop skip. */
export function unfinishedSets(slot: Pick<SlotView, 'kit' | 'sets'>): number[] {
	const filled = new Set(slot.sets.map((s) => s.setIndex));
	return (slot.kit?.sets ?? []).map((_, i) => i + 1).filter((index) => !filled.has(index));
}
