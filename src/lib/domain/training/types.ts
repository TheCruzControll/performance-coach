/**
 * The program-plan contract (PRD §5, §9) shared by the generator, the program store, the screens
 * and the coach (M5):
 * - the plan tree the generator emits and createProgramFromPlan stores as a program version:
 *   ProgramPlan → BlockPlan → WeekPlan → SessionPlan (strength | run | other) → exercises and
 *   their set prescriptions, run segments, or other-session details
 * - the read models that program reads return to Train, Today, History and the coach
 *
 * ./schemas.ts validates the plan, and each schema's output type is exactly its type here
 * (schemas.test.ts). After merge, fields are only ever added, and only as optional ones.
 *
 * Units: calendar days are `YYYY-MM-DD` (../calendar.ts), timestamps are `Date`s, weights carry
 * their unit, distances are metres, paces are seconds per km, RPE is the 1–10 scale.
 */
import type { IsoDate } from '../calendar.ts';
import type { CatalogueExercise } from '../exercises/format.ts';
import type { Discipline, Lift, TimeOfDay, Weekday } from '../profile/catalog.ts';
import type { WeightUnit } from '../units.ts';
import type * as v from './vocabulary.ts';

// ---- Exercises ------------------------------------------------------------------------------

/**
 * A catalogue exercise by its permanent key, or one of the owner's own by id; never a catalogue
 * row's id. Keys resolve to rows when a plan is stored (retired rows included), so a re-seeded
 * library cannot change or break a build. Narrow with `'key' in ref`.
 */
export type ExerciseRef = { key: string } | { customId: string };

/** An M2 lift whose 1RM can anchor percentage loads (a custom lift has no single baseline). */
export type BaselineLift = Exclude<Lift, 'custom'>;

/** An exercise the owner adds to their library: a catalogue entry without a key or lift. */
export type CustomExercise = Omit<CatalogueExercise, 'key' | 'baselineLift'>;

// ---- Prescriptions --------------------------------------------------------------------------

/**
 * One line of an exercise's prescription: `sets` sets with the same target, measured by a reps
 * range (repsMin = repsMax for a fixed count), seconds or metres: exactly one of them.
 *
 * The load, by loadKind; the fields a kind does not use are null:
 * - absolute: loadValue in loadUnit.
 * - percent_1rm: loadValue is a fraction of the baseline lift's 1RM, which loadBasis says was
 *   measured or estimated, and which reference1rm (in reference1rmUnit) snapshots.
 * - from_e1rm: loadValue is a fraction of the baseline lift's latest estimated 1RM. Only logged
 *   sets give one (week 1's top set onward), so the load is worked out when the session is done.
 * - rpe_based: no load; the lifter picks one that lands on targetRpe.
 */
export interface SetPrescription {
	role: v.SetRole;
	sets: number;
	repsMin: number | null;
	repsMax: number | null;
	seconds: number | null;
	metres: number | null;
	/** 5–10 in half steps; rpe_based needs one. */
	targetRpe: number | null;
	loadKind: v.LoadKind;
	loadValue: number | null;
	loadUnit: WeightUnit | null;
	loadBasis: v.LoadBasis | null;
	reference1rm: number | null;
	reference1rmUnit: WeightUnit | null;
	restSeconds: number | null;
	/** Seconds down, pause, up, pause: `3010`, or `31X0` with X for explosive. */
	tempo: string | null;
	notes: string | null;
}

export interface PlannedExercisePlan {
	exercise: ExerciseRef;
	/** The lift a percent_1rm or from_e1rm set is a fraction of. */
	baselineLift: BaselineLift | null;
	/** Exercises with the same superset number alternate (A1, A2); null for straight sets. */
	superset: number | null;
	/** The exercise this one replaced, and why; both null when nothing was replaced. */
	substitutedFrom: ExerciseRef | null;
	substitutionReason: v.SubstitutionReason | null;
	instructions: string | null;
	notes: string | null;
	sets: SetPrescription[];
}

/**
 * One segment of a structured run, with a distance, a duration or both. Consecutive segments
 * that share a repeat group run `repeats` times: 6 × (400 m interval + 90 s recovery).
 */
export interface RunSegment {
	kind: v.RunSegmentKind;
	repeatGroup: number | null;
	repeats: number | null;
	distanceMetres: number | null;
	durationSeconds: number | null;
	/** The target pace range in seconds per km, fastest first; shown in the owner's unit. */
	paceMinSecondsPerKm: number | null;
	paceMaxSecondsPerKm: number | null;
	hrZone: 1 | 2 | 3 | 4 | 5 | null;
	targetRpe: number | null;
}

/** Something the owner tracks in a number, a short text or a yes/no: rounds, sparred. */
export interface CustomMetric {
	key: string;
	label: string;
	unit: string | null;
	value: number | string | boolean;
}

/** What a Muay Thai, mobility, S&C or custom session prescribes. */
export interface OtherDetails {
	kind: v.OtherSessionKind;
	durationMinutes: number;
	targetRpe: number | null;
	metrics: CustomMetric[];
	notes: string | null;
}

// ---- The plan tree --------------------------------------------------------------------------

/** What a session is made of; logged workouts (M4) use the same three kinds. */
export type SessionKind = 'strength' | 'run' | 'other';

/** Who put a session in the plan: the generator, or one of the owner's fixed commitments. */
export type SessionSource = 'generator' | 'commitment';

interface SessionPlanBase {
	date: IsoDate;
	/** Null when not known; 'varies' only for a commitment whose time varies. */
	timeOfDay: TimeOfDay | null;
	/** 1 for the day's first session. */
	orderInDay: number;
	type: v.SessionType;
	title: string;
	discipline: Discipline;
	customDiscipline: string | null;
	intensity: v.SessionIntensity;
	estMinutes: number;
	/** Target RPE × minutes (M1's sessionLoad). */
	estLoad: number;
	targetRpe: number;
	source: SessionSource;
	/** The M2 commitment a commitment session comes from (a uuid with no foreign key). */
	commitmentRef: string | null;
	instructions: string | null;
	notes: string | null;
}

export interface StrengthSessionPlan extends SessionPlanBase {
	kind: 'strength';
	exercises: PlannedExercisePlan[];
}

export interface RunSessionPlan extends SessionPlanBase {
	kind: 'run';
	segments: RunSegment[];
}

export interface OtherSessionPlan extends SessionPlanBase {
	kind: 'other';
	details: OtherDetails;
}

export type SessionPlan = StrengthSessionPlan | RunSessionPlan | OtherSessionPlan;

/** A week's progression targets, as data that later stages and M4/M6 read. */
export interface WeekTargets {
	/** No set this week is prescribed above it. */
	rpeCap: number;
	/** Strength volume against the block's base (1 = base, 0.6 = a deload). */
	volumeFactor: number;
	/** Load change on the week before, as a fraction (0.025 = +2.5 %). */
	loadStep: number;
	/** Running volume against week 1. */
	runVolumeFactor: number;
}

/** Monday to Sunday. */
export interface WeekPlan {
	kind: v.WeekKind;
	startsOn: IsoDate;
	endsOn: IsoDate;
	targets: WeekTargets;
	sessions: SessionPlan[];
}

export interface BlockPlan {
	phase: v.Phase;
	name: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
	/** The road ahead (a marathon's build, peak, taper): dated, no sessions until M6 plans it. */
	outline: boolean;
	/** The M2 goals the block serves (uuids with no foreign key). */
	goalRefs: string[];
	/** The block's progression rules as named numbers, so M4 and M6 can adapt them. */
	progression: Record<string, number>;
	weeks: WeekPlan[];
}

/**
 * What a decision is about, as a path into the plan: `blocks.0`, `blocks.0.weeks.1`,
 * `blocks.0.weeks.1.sessions.2` or `blocks.0.weeks.1.sessions.2.exercises.0`. The store
 * resolves it to that node's lineage id.
 */
export type PlanPath = string;

/** A programming decision: what was decided, why (never empty) and by whom. */
export interface DecisionPlan {
	kind: v.DecisionKind;
	/** The rule that decided it, e.g. `days.free_days`. */
	ruleKey: string;
	summary: string;
	why: string;
	decidedBy: v.Decider;
	refs: PlanPath[];
	/** The facts it rests on, e.g. `{ squat1rmKg: 180 }`. */
	evidence: Record<string, number | string | boolean>;
}

export interface ProgramPlan {
	title: string;
	/** The Monday of week 1. */
	startsOn: IsoDate;
	/** The first day with sessions, in week 1 (a 'This week' start is mid-week). */
	firstPlannedDay: IsoDate;
	blocks: BlockPlan[];
	decisions: DecisionPlan[];
}

// ---- Read models ----------------------------------------------------------------------------

export interface VersionInfo {
	number: number;
	createdAt: Date;
	createdBy: v.Decider;
	summary: string;
	/** False for an older version, which screens show read-only. */
	current: boolean;
}

/** The current program, as Train's header, Today and the coach's get_current_program show it. */
export interface ProgramSummary extends Pick<
	ProgramPlan,
	'title' | 'startsOn' | 'firstPlannedDay'
> {
	id: string;
	version: VersionInfo;
	/** The last planned week's Sunday: after it, the first block is complete. */
	lastPlannedDay: IsoDate;
	plannedWeeks: number;
	blocks: (Omit<BlockPlan, 'progression' | 'weeks'> & { lineage: string; plannedWeeks: number })[];
}

/** A planned session as a card or a list row shows it. */
export interface SessionView extends Omit<
	SessionPlanBase,
	'estLoad' | 'commitmentRef' | 'instructions' | 'notes'
> {
	lineage: string;
	kind: SessionKind;
	/** Stored planned, skipped or moved; or 'completed', when a logged workout matches it. */
	status: v.SessionStatus;
	/** The date it was first planned on, once moved. */
	movedFrom: IsoDate | null;
	/** The session in one line of words (describe.ts): 'Squat · Bench · Row'. */
	line: string;
}

export interface DayView {
	date: IsoDate;
	weekday: Weekday;
	sessions: SessionView[];
}

/** A Monday-to-Sunday week; beyond the planned weeks, only its outline phase, if any. */
export type WeekView =
	| (Omit<WeekPlan, 'sessions'> & {
			planned: true;
			lineage: string;
			phase: v.Phase;
			blockName: string;
			/** Its number among the program's planned weeks, from 1. */
			number: number;
			/** Always seven, Monday first. */
			days: DayView[];
	  })
	| { planned: false; phase: v.Phase | null; startsOn: IsoDate; endsOn: IsoDate };

/** A decision as History and the coach show it, with what it touched resolved for display. */
export interface DecisionView extends Omit<DecisionPlan, 'refs' | 'evidence' | 'ruleKey'> {
	id: string;
	/** Null for an owner's edit that no rule made. */
	ruleKey: string | null;
	version: number;
	createdAt: Date;
	affected: { lineage: string; title: string; date: IsoDate | null }[];
}
