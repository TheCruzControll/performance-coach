/**
 * What the session screen says (Train → a session): when it is, what kind of session it is, the
 * facts SessionDetails lays out, each exercise's prescriptions in describe.ts's words, and the
 * baseline callout. Like words.ts, these are composed where the session is read (the session
 * route's load, on the server), so the screen's JavaScript carries none of the vocabulary and
 * no describe.ts (docs/performance.md); the components only lay the words out.
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { TIME_OF_DAY_LABEL, WEEKDAY_INFO, type TimeOfDay } from '#lib/domain/profile/catalog.ts';
import type { ProfileDistanceUnit } from '#lib/domain/profile/types.ts';
import {
	BASELINE_INSTRUCTION,
	describePrescription,
	describeSegment,
	type PrescriptionOptions,
	type PrescriptionWords,
	type RunStep
} from '#lib/domain/training/describe.ts';
import type {
	CustomMetric,
	OtherDetails,
	PlannedExercisePlan,
	RunSegment,
	SessionKind,
	SetPrescription
} from '#lib/domain/training/types.ts';
import {
	OTHER_SESSION_KIND_LABEL,
	SET_ROLE_LABEL,
	SESSION_INTENSITY_LABEL,
	SESSION_TYPE_LABEL,
	type SessionIntensity,
	type SessionType
} from '#lib/domain/training/vocabulary.ts';
import { longDate, shortDate } from './words.ts';

/** Heart-rate zones 1 to 5 in bpm, [low, high], as heartRateZones (programming/paces.ts) gives them. */
export type ZoneBands = readonly (readonly [low: number, high: number])[];

/**
 * A run segment's effort on the session screen: 'Zone 2 · 134–148 bpm' with the owner's zones,
 * 'Zone 2' without them, then its RPE; none when it has neither.
 */
export function effortWords(
	{ hrZone, targetRpe }: Pick<RunSegment, 'hrZone' | 'targetRpe'>,
	zones: ZoneBands | null
): string | null {
	const band = hrZone === null ? undefined : zones?.[hrZone - 1];
	const zone = band ? `Zone ${hrZone} · ${band[0]}–${band[1]} bpm` : hrZone && `Zone ${hrZone}`;
	const rpe = targetRpe === null ? null : `RPE ${targetRpe}`;
	return [zone, rpe].filter(Boolean).join(' · ') || null;
}

/**
 * A run's steps (describeSegments, which keeps the segments in order) with each segment's effort
 * in effortWords.
 */
export function stepsInZones(
	steps: readonly RunStep[],
	segments: readonly Pick<RunSegment, 'hrZone' | 'targetRpe'>[],
	zones: ZoneBands | null
): RunStep[] {
	let i = 0;
	return steps.map((step) => ({
		...step,
		segments: step.segments.map((words) => ({
			...words,
			target: effortWords(segments[i++]!, zones)
		}))
	}));
}

/** 'Tuesday 10 November · Evening'; the time of day only when known (never 'varies'). */
export function whenWords(date: IsoDate, timeOfDay: TimeOfDay | null): string {
	const time = timeOfDay === null || timeOfDay === 'varies' ? null : TIME_OF_DAY_LABEL[timeOfDay];
	return time ? `${longDate(date)} · ${time}` : longDate(date);
}

/** What disciplineWords and detailsView read: a planned session, or its fields. */
type KindSource =
	| { kind: Exclude<SessionKind, 'other'>; details?: undefined }
	| { kind: 'other'; details: OtherDetails };

/**
 * The session's type ('Strength', 'Intervals'), its own discipline for a custom one, and an
 * other session's format after it ('Muay Thai · Pad work') unless the type already says it.
 */
export function disciplineWords(
	session: KindSource & { type: SessionType; customDiscipline: string | null }
): string {
	const type =
		(session.type === 'custom' && session.customDiscipline) || SESSION_TYPE_LABEL[session.type];
	if (session.kind !== 'other' || session.details.kind === 'custom') return type;
	const format = OTHER_SESSION_KIND_LABEL[session.details.kind];
	return type.toLowerCase() === format.toLowerCase() ? type : `${type} · ${format}`;
}

/** One number SessionDetails shows as a stat: '90' and 'min', with a word under it. */
export interface Fact {
	label: string;
	value: string;
	unit: string | null;
	caption: string | null;
}

/** One of an other session's metrics in words: 'Round length', '3 min'. */
export interface MetricWords {
	label: string;
	value: string;
}

/** What SessionDetails lays out. */
export interface DetailsView {
	/** The duration, then the target RPE with the session's intensity under it. */
	facts: Fact[];
	/** An other session's metrics (rounds, sparring, focus); none for strength and runs. */
	metrics: MetricWords[];
}

/** A metric's value: a number with its unit, a yes/no in words, a text as written. */
export function metricValue({ value, unit }: CustomMetric): string {
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	return unit === null || typeof value === 'string' ? `${value}` : `${value} ${unit}`;
}

/**
 * The session's facts: an other session's own duration and target RPE come from its details
 * (the class, not the estimate), with the session's target RPE when the details set none.
 */
export function detailsView(
	session: KindSource & { estMinutes: number; targetRpe: number; intensity: SessionIntensity }
): DetailsView {
	const own = session.kind === 'other' ? session.details : null;
	return {
		facts: [
			{
				label: 'Duration',
				value: `${own?.durationMinutes ?? session.estMinutes}`,
				unit: 'min',
				caption: null
			},
			{
				label: 'Target RPE',
				value: `${own?.targetRpe ?? session.targetRpe}`,
				unit: null,
				caption: SESSION_INTENSITY_LABEL[session.intensity]
			}
		],
		metrics: (own?.metrics ?? []).map((m) => ({ label: m.label, value: metricValue(m) }))
	};
}

/** A planned exercise with its name in the owner's library: what exerciseViews reads. */
export type ExerciseSource = Pick<
	PlannedExercisePlan,
	'superset' | 'instructions' | 'notes' | 'sets'
> & { name: string };

/** One exercise as ExerciseBlock lays it out. */
export interface ExerciseView {
	/** 'A1', 'A2' in a superset; null for straight sets. */
	label: string | null;
	name: string;
	instructions: string | null;
	notes: string | null;
	/** describePrescription's words, one per set prescription. */
	sets: PrescriptionWords[];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The session's exercises in order, each set prescription in the owner's unit. Supersets are
 * lettered in the order they first appear and numbered within (A1, A2, then B1).
 */
export function exerciseViews(
	exercises: readonly ExerciseSource[],
	options: PrescriptionOptions
): ExerciseView[] {
	const groups: number[] = [];
	const seen = new Map<number, number>();
	return exercises.map((e) => {
		let label: string | null = null;
		if (e.superset !== null) {
			if (!groups.includes(e.superset)) groups.push(e.superset);
			const n = (seen.get(e.superset) ?? 0) + 1;
			seen.set(e.superset, n);
			label = `${LETTERS[groups.indexOf(e.superset) % LETTERS.length]}${n}`;
		}
		return {
			label,
			name: e.name,
			instructions: e.instructions,
			notes: e.notes,
			sets: e.sets.map((p) => describePrescription(p, options))
		};
	});
}

/**
 * A baseline week's strength session (week 1): how to find each lift's starting point. It ends
 * with what every baseline set asks the owner to record (BASELINE_INSTRUCTION).
 */
export const BASELINE_CALLOUT = {
	eyebrow: 'Baseline session',
	title: 'Find your starting weights',
	lead: 'This session sets the loads for the weeks ahead: each main lift works up to a target effort, not a set weight.',
	points: [
		'Warm up, then add weight set by set until the reps land on the target RPE.',
		'Stop at the target, never at failure: at RPE 7 you could still do about three more reps.',
		BASELINE_INSTRUCTION
	]
} as const;

export type BaselineCallout = typeof BASELINE_CALLOUT;

/** A day the Move sheet offers, as a card: 'Wed 11 Nov', with what is planned there under it. */
export interface MoveOption {
	date: IsoDate;
	/** 'Wed 11 Nov'. */
	label: string;
	/** 'Wednesday': where the toast says it moved. */
	day: string;
	/** 'Easy run · Muay Thai class', or 'Rest day'. */
	planned: string;
}

/** A day a session can move to (the program services' getMoveTargets), in the sheet's words. */
export function moveOption({ date, planned }: { date: IsoDate; planned: string }): MoveOption {
	return { date, label: shortDate(date), day: WEEKDAY_INFO[weekdayOf(date)].label, planned };
}

/** A planned exercise on the session screen: its words, and what Swap names. */
export interface SessionExerciseView extends ExerciseView {
	/** Its planned exercise's lineage, which a swap names. */
	lineage: string;
	/** SWAPPED_ONCE after a one-off swap; null otherwise, a 'never again' swap included. */
	swapped: string | null;
}

/** What an exercise swapped for this session only says, under its name. */
export const SWAPPED_ONCE = 'This session only';

/** An exercise Swap offers: the library row a swap posts, and why it keeps the purpose. */
export interface SwapChoice {
	id: string;
	name: string;
	reason: string;
}

/** What one planned exercise can be swapped for, best first, or why nothing fits. */
export interface SwapChoices {
	alternatives: SwapChoice[];
	/** Why none fits the owner's equipment and injuries, when none does; otherwise null. */
	blocked: string | null;
}

/** Each exercise's swaps, by its lineage: what the session screen streams. */
export type SwapOptions = Record<string, SwapChoices>;

/** The planned exercise a Swap sheet opens on. */
export interface SwapTarget {
	lineage: string;
	name: string;
	/** Undefined while the session screen streams them; null if they could not be read. */
	choices: SwapChoices | null | undefined;
}

/** What the session's edit row offers, on the version shown. */
export interface SessionEdits {
	/** The version shown: an edit names it, so one made from a page left open conflicts. */
	version: number;
	/** Why the session can no longer change (EDITS_LOCKED); null while it can. */
	locked: string | null;
	/** The days Move offers, earliest first; none when no day of its week is left. */
	moveTo: MoveOption[];
}

/** What an edit sheet opens on: the session screen's session, with its edits. */
export interface EditTarget {
	lineage: string;
	title: string;
	/** 'Monday 9 November · Morning'. */
	when: string;
	/** None on an older version, which is read-only. */
	edits: SessionEdits | null;
	/** What Adjust steps; null once the session can no longer change. */
	adjust: AdjustValues | null;
}

/** Why a session's edits are off, as the line under its disabled edit row says. */
export const EDITS_LOCKED = {
	completed: 'You’ve logged it, so it stays as it was.',
	skipped: 'It’s skipped, so it stays off your week.',
	passed: 'Its day has passed, so it stays as it was planned.'
} as const;

// ---- Adjust ---------------------------------------------------------------------------------

/**
 * A strength set prescription as the Adjust sheet steps it. A value it does not have is null and
 * gets no stepper: Adjust changes values, never what the set is measured in or how its load is set.
 */
export interface AdjustSet {
	/** Its place among the exercise's prescriptions, from 1: what an adjustment names. */
	position: number;
	/** 'Top set · 1 × 5 @ RPE 7': which of the exercise's prescriptions it is. */
	label: string;
	sets: number;
	/** Null for a set held for seconds or metres. */
	repsMin: number | null;
	repsMax: number | null;
	targetRpe: number | null;
	/** An absolute load in its unit, or a fraction of a 1RM ('%'); null when RPE sets it. */
	load: { value: number; unit: 'kg' | 'lb' | '%' } | null;
	restSeconds: number | null;
}

/** A run segment as the Adjust sheet steps it; a value it does not have is null. */
export interface AdjustSegment {
	position: number;
	/** '6 × Interval 400 m': the segment in describe.ts's words. */
	label: string;
	distanceMetres: number | null;
	durationSeconds: number | null;
	paceMinSecondsPerKm: number | null;
	paceMaxSecondsPerKm: number | null;
	targetRpe: number | null;
	/** Its repeat group's repeats, which every segment of the group shares. */
	repeats: number | null;
}

/** What Adjust offers on a session that can still change, by its kind. */
export type AdjustValues =
	| { kind: 'strength'; exercises: Record<string, AdjustSet[]> }
	| { kind: 'run'; paceUnit: ProfileDistanceUnit; segments: AdjustSegment[] }
	| { kind: 'other'; durationMinutes: number; targetRpe: number | null };

/** What adjustValues reads: a planned session's prescriptions. */
export type AdjustSource =
	| { kind: 'strength'; exercises: readonly { lineage: string; sets: SetPrescription[] }[] }
	| { kind: 'run'; segments: readonly RunSegment[] }
	| { kind: 'other'; details: OtherDetails };

function adjustSet(set: SetPrescription, k: number): AdjustSet {
	const unit = set.loadUnit ?? set.reference1rmUnit ?? 'kg';
	const words = describePrescription(set, { unit, oneRepMaxKg: null });
	const relative = set.loadKind === 'percent_1rm' || set.loadKind === 'from_e1rm';
	return {
		position: k + 1,
		label: `${SET_ROLE_LABEL[set.role]} · ${words.headline}`,
		sets: set.sets,
		repsMin: set.repsMin,
		repsMax: set.repsMax,
		targetRpe: set.targetRpe,
		load:
			set.loadValue === null || set.loadKind === 'rpe_based'
				? null
				: { value: set.loadValue, unit: relative ? '%' : (set.loadUnit ?? 'kg') },
		restSeconds: set.restSeconds
	};
}

/** The values Adjust steps, in the order the session lists them; paces in the owner's unit. */
export function adjustValues(
	session: AdjustSource,
	{ distanceUnit }: { distanceUnit: ProfileDistanceUnit }
): AdjustValues {
	if (session.kind === 'strength') {
		const exercises = Object.fromEntries(
			session.exercises.map((e) => [e.lineage, e.sets.map(adjustSet)])
		);
		return { kind: 'strength', exercises };
	}
	if (session.kind === 'other') {
		const { durationMinutes, targetRpe } = session.details;
		return { kind: 'other', durationMinutes, targetRpe };
	}
	const segments = session.segments.map((s, k): AdjustSegment => {
		const { headline } = describeSegment(s, { distanceUnit });
		return {
			position: k + 1,
			label: s.repeats === null ? headline : `${s.repeats} × ${headline}`,
			distanceMetres: s.distanceMetres,
			durationSeconds: s.durationSeconds,
			paceMinSecondsPerKm: s.paceMinSecondsPerKm,
			paceMaxSecondsPerKm: s.paceMaxSecondsPerKm,
			targetRpe: s.targetRpe,
			repeats: s.repeats
		};
	});
	return { kind: 'run', paceUnit: distanceUnit, segments };
}
