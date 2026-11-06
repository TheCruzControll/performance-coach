/**
 * The workout contract, wire format v1 (PRD §7–§9, §15; the offline workout sync ADR): the start
 * kit a workout runs from offline, the state only the device keeps, and what the screens render.
 * mutations.ts holds what the outbox sends and protocol.ts what the server answers. The store,
 * the sync engine, the server and every screen build against these types.
 *
 * - Rows are named by their client ids (crypto.randomUUID on the device), never by server ids.
 * - Instants on the wire are ISO 8601 strings; the timers' epoch milliseconds never leave the
 *   device. Calendar days are IsoDates.
 * - Weights keep the unit they were entered in; distances are metres (the device converts with
 *   M1's toMetres), durations seconds, RPE the 1–10 scale.
 * - After merge, fields are only added, and only as optional ones.
 */
import type { IsoDate } from '../calendar.ts';
import type { BodyArea, Discipline, Equipment } from '../profile/catalog.ts';
import type { ProfileDistanceUnit } from '../profile/types.ts';
import type { OtherDetails, RunSegment, SessionKind } from '../training/types.ts';
import type * as v from '../training/vocabulary.ts';
import type { WeightUnit } from '../units.ts';
import type {
	CanonicalOther,
	CanonicalRun,
	CanonicalSegment,
	CanonicalSet,
	CanonicalSubstitution,
	CanonicalWorkoutRow
} from './protocol.ts';

/** An instant on the wire, as `new Date().toISOString()` writes it. */
export type Instant = string;

/** A workout's lifecycle: the training log's WORKOUT_STATUSES. */
export type WorkoutStatus = 'in_progress' | 'completed' | 'abandoned';

// ---- Exercises ------------------------------------------------------------------------------

/**
 * Which default rest an exercise gets when its prescription names none. The seconds for each are
 * the rest timer's defaults and the device's settings, never the kit's (timers.ts).
 */
export type RestClass = 'main' | 'compound' | 'isolation' | 'timed';

/** What any screen needs to name an exercise and ask for its set: the canonical exercises map. */
export interface ExerciseSummary {
	name: string;
	measure: v.Measure;
	loadType: v.LoadType;
	unilateral: boolean;
}

/** A library exercise as a kit carries it. */
export interface KitExerciseMeta extends ExerciseSummary {
	id: string;
	/** Its catalogue key; null for one of the owner's own. */
	key: string | null;
	pattern: v.MovementPattern;
	tags: v.ExerciseTag[];
	restClass: RestClass;
	/** The smallest load step, in the kit's weight unit. */
	increment: number;
}

// ---- Sets -----------------------------------------------------------------------------------

/**
 * A set as the owner did it: what set.log sends and set.edit replaces. (M3's metrics LoggedSet is
 * a stored row as the metrics read it; this is what the device records.)
 * - One amount, by the exercise's measure: reps, seconds, or whole metres.
 * - The load, by its load type, in `unit`: `weight` is the load (external) or the added weight
 *   (bodyweight; null for bodyweight only); `assistance` is an assisted exercise's help, never
 *   beside a weight; an unloaded exercise has neither.
 * - missedReps are attempts that failed, beside the reps completed: a 1-of-5 set is 1 and 4.
 */
export interface LoggedSet {
	reps: number | null;
	seconds: number | null;
	metres: number | null;
	weight: number | null;
	assistance: number | null;
	unit: WeightUnit;
	rpe: number | null;
	missedReps: number;
	isWarmup: boolean;
	isExtra: boolean;
}

/** A load that can be computed, in the kit's unit, and what it rests on. */
export interface PrescribedWeight {
	value: number;
	unit: WeightUnit;
	/** absolute as prescribed, or a fraction of a measured or an estimated 1RM. */
	basis: 'absolute' | 'measured' | 'estimated';
}

/** One set to perform, in order: a 3 × 5 prescription gives three. */
export interface KitSet {
	role: v.SetRole;
	repsMin: number | null;
	repsMax: number | null;
	seconds: number | null;
	metres: number | null;
	targetRpe: number | null;
	/** Only a load describe's prescribedLoad can compute; null for RPE-based and unknown loads. */
	prescribedWeight: PrescribedWeight | null;
	restSeconds: number | null;
	/** Its prescription in M3's words: describePrescription's headline, '3 × 5 @ RPE 7'. */
	line: string;
	/** describePrescription's instruction: BASELINE_INSTRUCTION on a baseline set. */
	instruction: string | null;
}

/** The last completed session of an exercise, planned or ad-hoc: its sets, skipped ones left out. */
export interface PreviousPerformance {
	date: IsoDate;
	sets: LoggedSet[];
}

/** The heaviest load lifted for a rep count (M3's personalRecords). */
export interface PriorBest {
	reps: number;
	weightKg: number;
	date: IsoDate;
}

/** An exercise that can stand in for a slot's, with why and what it needs. */
export interface KitAlternative {
	exercise: KitExerciseMeta;
	reasons: string[];
	equipment: Equipment[];
	/** Its own last top set, which a substitute's first set starts from. */
	lastTopSet: (LoggedSet & { date: IsoDate }) | null;
}

/** One planned exercise of a strength kit. */
export interface KitExercise {
	/** 1-based: its place in the workout, which every set and slot change names. */
	position: number;
	plannedLineage: string | null;
	/** Consecutive exercises with the same number alternate (A1, A2); null for straight sets. */
	superset: number | null;
	exercise: KitExerciseMeta;
	sets: KitSet[];
	instructions: string | null;
	previous: PreviousPerformance | null;
	/** Always an estimate, labelled as one. */
	bestE1rm: { kg: number; estimated: true } | null;
	priorBests: PriorBest[];
	/**
	 * A bodyweight exercise's most reps in one set with no weight added (summary.ts's bestsOf), which
	 * 'Most reps' beats; null when there is none.
	 */
	mostReps: number | null;
	/** kit-alternatives: M3's ranked alternatives, best first. */
	alternatives?: KitAlternative[];
	/** Why nothing fits, when no alternative does. */
	blocked?: string[];
	/** Gentler options for each body area, from M3's avoidance rules. */
	gentler?: Partial<Record<BodyArea, KitAlternative[]>>;
}

// ---- The start kit --------------------------------------------------------------------------

/** The owner's training-profile units when the kit was built: every load and pace reads in them. */
export interface KitUnits {
	weight: WeightUnit;
	distance: ProfileDistanceUnit;
}

interface KitBase {
	v: 1;
	kind: SessionKind;
	title: string;
	sessionType: v.SessionType;
	discipline: Discipline;
	date: IsoDate;
	/** The planned session it runs, pinned to its immutable row; all four null for ad-hoc. */
	plannedLineage: string | null;
	plannedSessionId: string | null;
	programId: string | null;
	versionNumber: number | null;
	units: KitUnits;
}

export interface StrengthKit extends KitBase {
	kind: 'strength';
	exercises: KitExercise[];
}

export interface RunKit extends KitBase {
	kind: 'run';
	/** As planned: a repeat group's segments appear once, with their repeats. */
	run: { segments: RunSegment[] };
}

export interface OtherKit extends KitBase {
	kind: 'other';
	/** The metrics' values are the plan's, and the logger's starting values. */
	other: Pick<OtherDetails, 'kind' | 'durationMinutes' | 'targetRpe' | 'metrics'>;
}

/** Everything a started workout needs, so it never waits for the network. */
export type StartKit = StrengthKit | RunKit | OtherKit;

// ---- Device-only state ----------------------------------------------------------------------

/** A rest in epoch ms on this device's clock; timers.ts reads and changes it. */
export interface RestState {
	startedAt: number;
	durationMs: number;
	pausedAt: number | null;
	addedMs: number;
}

/** The workout's running time in epoch ms, pauses left out. */
export interface StopwatchState {
	startedAt: number | null;
	accumulatedMs: number;
	runningSince: number | null;
}

/** An exercise added on this device: device state until its first set syncs. */
export interface AddedExercise {
	position: number;
	exercise: KitExerciseMeta;
	addedAt: Instant;
}

/** What only this device knows. Nothing here is ever sent. */
export interface DeviceState {
	/** The exercise (strength) or segment (run) on screen, 1-based. */
	position: number;
	/** Values typed but not confirmed, by `${position}:${setIndex}`. */
	drafts: Record<string, Partial<LoggedSet>>;
	rest: RestState | null;
	stopwatch: StopwatchState;
	added: AddedExercise[];
	/** A substitute's or an added exercise's previous sets, by exercise id (kit.attach). */
	attached: Record<string, PreviousPerformance | null>;
}

// ---- What the screens render ----------------------------------------------------------------

/** A row with whether a mutation that touches it is still in the outbox. */
export type Viewed<R> = R & { pending: boolean };

/**
 * A strength slot's state: as planned, added on a device, swapped for today, swapped and never
 * to be prescribed again (a dislike), skipped, or stopped because it hurt.
 */
export type SlotState = 'planned' | 'added' | 'swapped' | 'wont_prescribe' | 'skipped' | 'stopped';

export interface SlotView {
	position: number;
	plannedLineage: string | null;
	superset: number | null;
	/** What is performed: the planned exercise or its substitute. */
	exerciseId: string;
	/** The prescription; null for an added exercise. */
	kit: KitExercise | null;
	state: SlotState;
	substitution: Viewed<CanonicalSubstitution> | null;
	/** In order, deleted sets left out. */
	sets: Viewed<CanonicalSet>[];
}

/** project()'s answer: the server's rows with the pending mutations and the device state applied. */
export interface WorkoutView {
	workout: Viewed<CanonicalWorkoutRow>;
	/** Null until a workout from another device has its kit. */
	kit: StartKit | null;
	slots: SlotView[];
	run: (Viewed<Omit<CanonicalRun, 'segments'>> & { segments: Viewed<CanonicalSegment>[] }) | null;
	other: Viewed<CanonicalOther> | null;
	exercises: Record<string, ExerciseSummary>;
	device: DeviceState;
}
