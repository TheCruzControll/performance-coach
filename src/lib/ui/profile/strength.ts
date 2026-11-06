/**
 * Editing state for Profile → Strength, built from what the services return: every 1RM is
 * optional, and "I don't know my 1RMs" is an answer of its own. Also the one-line summary of a
 * saved lift. No Intl on purpose: formatter construction is hydration cost on phones
 * (docs/performance.md).
 */
import { estimateOneRepMax, type E1rmEstimate } from '#lib/domain/e1rm.ts';
import {
	BASELINE_SOURCE_LABEL,
	LIFTS_FOR_DISCIPLINE,
	LIFT_LABEL,
	type BaselineSource,
	type Discipline,
	type Lift
} from '#lib/domain/profile/catalog.ts';
import type { StrengthBaseline } from '#lib/domain/profile/types.ts';
import type { WeightUnit } from '#lib/domain/units.ts';

/** One lift being edited: every field the baselines schema reads, and the row's key. */
export interface LiftDraft {
	/** Keeps the row's place on screen (the stored id, or one made here). Never posted. */
	key: string;
	lift: Lift;
	customLabel: string | null;
	/** Unset until the owner says how they know the number: measured or estimated is theirs. */
	source: BaselineSource | null;
	value: number | null;
	unit: WeightUnit;
	achievedOn: string | null;
	setWeight: number | null;
	setReps: number | null;
	setRpe: number | null;
	notes: string | null;
}

export interface BaselinesDraft {
	unknown: boolean;
	lifts: LiftDraft[];
}

/** A saved lift, ready to edit. A set's 1RM is computed, so it is not offered as a value. */
export function liftDraft(b: StrengthBaseline): LiftDraft {
	return {
		key: b.id,
		lift: b.lift,
		customLabel: b.customLabel,
		source: b.source,
		value: b.source === 'set' ? null : b.value,
		unit: b.unit,
		achievedOn: b.achievedOn,
		setWeight: b.setWeight,
		setReps: b.setReps,
		setRpe: b.setRpe,
		notes: b.notes
	};
}

let added = 0;

/** A lift the owner just added: blank, in their unit, with its own key. */
export function newLift(lift: Lift, unit: WeightUnit): LiftDraft {
	added += 1;
	return {
		key: `new-${added}`,
		lift,
		customLabel: null,
		source: null,
		value: null,
		unit,
		achievedOn: null,
		setWeight: null,
		setReps: null,
		setRpe: null,
		notes: null
	};
}

export function baselinesDraft(saved: {
	unknown: boolean;
	lifts: StrengthBaseline[];
}): BaselinesDraft {
	return { unknown: saved.unknown, lifts: saved.lifts.map(liftDraft) };
}

/**
 * What the baselines schema validates. "I don't know" sends no lifts (the editor keeps them
 * until then, in case of a mis-tap). A lift sends only the fields its source uses, so a field
 * the owner cannot see never fails, and lifts keep their positions, so errors land on the right
 * row.
 */
export function baselinesPayload(draft: BaselinesDraft) {
	return {
		unknown: draft.unknown,
		lifts: draft.unknown
			? []
			: draft.lifts.map(({ key: _key, ...lift }) =>
					lift.source === 'set'
						? { ...lift, value: null }
						: { ...lift, setWeight: null, setReps: null, setRpe: null }
				)
	};
}

const FALLBACK_LIFTS: readonly Lift[] = ['back_squat', 'bench_press', 'deadlift'];

/** The lifts worth asking about first for these disciplines, each once, in their order. */
export function suggestedLifts(disciplines: readonly Discipline[]): Lift[] {
	const lifts = new Set(disciplines.flatMap((d) => LIFTS_FOR_DISCIPLINE[d] ?? []));
	return [...(lifts.size ? lifts : FALLBACK_LIFTS)];
}

/** A lift's name: what the owner called a lift of their own, otherwise its label. */
export function liftName(lift: Pick<LiftDraft, 'lift' | 'customLabel'>): string {
	return (lift.lift === 'custom' && lift.customLabel?.trim()) || LIFT_LABEL[lift.lift];
}

/** The estimate a set gives, with the function the server stores it with. */
export function liveEstimate(lift: LiftDraft): E1rmEstimate | null {
	if (lift.source !== 'set' || lift.setWeight == null || lift.setReps == null) return null;
	return estimateOneRepMax({ weight: lift.setWeight, reps: lift.setReps, rpe: lift.setRpe });
}

/** A weight as written: at most two decimals, no trailing zeros (82.50 → "82.5"). */
export function trim(n: number): string {
	return String(Math.round(n * 100) / 100);
}

/** One line for a saved lift: "≈ 123.3 kg · Estimated, from 100 × 5 @ RPE 8". */
export function baselineSummary(b: StrengthBaseline): string {
	const value = `${b.kind === 'estimated' ? '≈ ' : ''}${trim(b.value)} ${b.unit}`;
	const how =
		b.source === 'set' && b.setWeight != null && b.setReps != null
			? `from ${trim(b.setWeight)} × ${b.setReps}${b.setRpe != null ? ` @ RPE ${b.setRpe}` : ''}`
			: BASELINE_SOURCE_LABEL[b.source].toLowerCase();
	return `${value} · ${b.kind === 'measured' ? 'Measured' : 'Estimated'}, ${how}`;
}
