/**
 * The training vocabulary (PRD §5, §9, §11): the keys M3–M7 store, validate, generate from and
 * show. It sits beside M2's profile catalogue and reuses its DISCIPLINES, EQUIPMENT,
 * EXPERIENCE_LEVELS, WEEKDAYS, TIMES_OF_DAY and INTENSITIES, never redefining them.
 *
 * Keys are stored in Postgres: never rename or remove one, add a new key instead.
 * - Closed lists (lifecycles, structure) are CHECKed by Postgres: a new key is a migration.
 * - Open lists grow in later milestones with no migration. Services validate them with these
 *   types and zod, and the catalogue through parseTable.
 *
 * Each list is the keys of its label table, so no key lacks a label. Runtime imports use .ts
 * specifiers: the seed loads this file under plain Node (scripts/catalogue-node.test.ts).
 */
import { BASELINE_KINDS } from '../profile/catalog.ts';
import type {
	BaselineKind,
	DisciplineTone,
	ExperienceLevel,
	Intensity
} from '../profile/catalog.ts';

type Labels = Readonly<Record<string, string>>;

/** The keys of a label table, in their written order. */
const keysOf = <L extends Labels>(labels: L) =>
	Object.keys(labels) as readonly (keyof L & string)[];

// ---- Exercises ------------------------------------------------------------------------------

/** Open. How an exercise moves; the generator balances a week by pattern. */
export const MOVEMENT_PATTERN_LABEL = {
	squat: 'Squat',
	hinge: 'Hinge',
	lunge: 'Lunge',
	horizontal_push: 'Horizontal push',
	vertical_push: 'Vertical push',
	horizontal_pull: 'Horizontal pull',
	vertical_pull: 'Vertical pull',
	carry: 'Carry',
	rotation: 'Rotation',
	anti_rotation: 'Anti-rotation',
	anti_extension: 'Anti-extension',
	trunk_flexion: 'Trunk flexion',
	olympic: 'Olympic lift',
	plyometric: 'Plyometric',
	conditioning: 'Conditioning',
	isolation: 'Isolation',
	mobility: 'Mobility'
};
export type MovementPattern = keyof typeof MOVEMENT_PATTERN_LABEL;
export const MOVEMENT_PATTERNS = keysOf(MOVEMENT_PATTERN_LABEL);

/** Open. The groups weekly hard sets are counted in. */
export const MUSCLE_GROUP_LABEL = {
	chest: 'Chest',
	back: 'Back',
	shoulders: 'Shoulders',
	biceps: 'Biceps',
	triceps: 'Triceps',
	forearms: 'Forearms',
	core: 'Core',
	hips: 'Glutes & hips',
	quads: 'Quads',
	hamstrings: 'Hamstrings',
	calves: 'Calves',
	neck: 'Neck'
};
export type MuscleGroup = keyof typeof MUSCLE_GROUP_LABEL;
export const MUSCLE_GROUPS = keysOf(MUSCLE_GROUP_LABEL);

/** Open. The muscles an exercise names as primary or secondary. */
export const MUSCLE_LABEL = {
	chest: 'Chest',
	front_delts: 'Front delts',
	side_delts: 'Side delts',
	rear_delts: 'Rear delts',
	lats: 'Lats',
	upper_back: 'Upper back',
	traps: 'Traps',
	lower_back: 'Lower back',
	biceps: 'Biceps',
	triceps: 'Triceps',
	forearms: 'Forearms & grip',
	abs: 'Abs',
	obliques: 'Obliques',
	glutes: 'Glutes',
	adductors: 'Adductors',
	hip_flexors: 'Hip flexors',
	quads: 'Quads',
	hamstrings: 'Hamstrings',
	calves: 'Calves',
	neck: 'Neck'
};
export type Muscle = keyof typeof MUSCLE_LABEL;
export const MUSCLES = keysOf(MUSCLE_LABEL);

/** The one group each muscle's hard sets count toward. */
export const MUSCLE_GROUP: Readonly<Record<Muscle, MuscleGroup>> = {
	chest: 'chest',
	front_delts: 'shoulders',
	side_delts: 'shoulders',
	rear_delts: 'shoulders',
	lats: 'back',
	upper_back: 'back',
	traps: 'back',
	lower_back: 'back',
	biceps: 'biceps',
	triceps: 'triceps',
	forearms: 'forearms',
	abs: 'core',
	obliques: 'core',
	glutes: 'hips',
	adductors: 'hips',
	hip_flexors: 'hips',
	quads: 'quads',
	hamstrings: 'hamstrings',
	calves: 'calves',
	neck: 'neck'
};

/** Open. Traits that exclusions (injuries, movements to avoid) and selection read. */
export const EXERCISE_TAG_LABEL = {
	compound: 'Compound',
	explosive: 'Explosive',
	technical: 'Technical',
	competition: 'Competition lift',
	overhead: 'Overhead',
	spinal_loading: 'Loads the spine',
	high_impact: 'High impact',
	low_impact: 'Low impact',
	grip_demanding: 'Grip demanding',
	deep_knee_flexion: 'Deep knee bend',
	wrist_loading: 'Loads the wrists',
	shoulder_friendly: 'Shoulder friendly',
	knee_friendly: 'Knee friendly',
	back_friendly: 'Back friendly'
};
export type ExerciseTag = keyof typeof EXERCISE_TAG_LABEL;
export const EXERCISE_TAGS = keysOf(EXERCISE_TAG_LABEL);

/** Closed. The technical demand of an exercise. */
export const SKILL_LEVEL_LABEL = {
	beginner: 'Beginner',
	intermediate: 'Intermediate',
	advanced: 'Advanced'
};
export type SkillLevel = keyof typeof SKILL_LEVEL_LABEL;
export const SKILL_LEVELS = keysOf(SKILL_LEVEL_LABEL);

const SKILL_FOR_EXPERIENCE: Readonly<Record<ExperienceLevel, SkillLevel>> = {
	new: 'beginner',
	novice: 'beginner',
	intermediate: 'intermediate',
	advanced: 'advanced'
};

/** The highest exercise skill level the generator prescribes at an M2 experience level. */
export function skillForExperience(level: ExperienceLevel): SkillLevel {
	return SKILL_FOR_EXPERIENCE[level];
}

/** Closed. What a set of the exercise counts. */
export const MEASURE_LABEL = { reps: 'Reps', time: 'Time', distance: 'Distance' };
export type Measure = keyof typeof MEASURE_LABEL;
export const MEASURES = keysOf(MEASURE_LABEL);

/** Closed. Where the load comes from, so logging knows whether to ask for a weight. */
export const LOAD_TYPE_LABEL = {
	external: 'Added weight',
	bodyweight: 'Bodyweight',
	assisted: 'Assisted',
	none: 'Unloaded'
};
export type LoadType = keyof typeof LOAD_TYPE_LABEL;
export const LOAD_TYPES = keysOf(LOAD_TYPE_LABEL);

// ---- Program structure ----------------------------------------------------------------------

/** Open. The phase of a block (cycle). */
export const PHASE_LABEL = {
	baseline: 'Baseline',
	accumulation: 'Accumulation',
	intensification: 'Intensification',
	realization: 'Realization / peak',
	deload: 'Deload',
	taper: 'Taper',
	hypertrophy: 'Hypertrophy',
	maintenance: 'Maintenance',
	marathon_base: 'Marathon base',
	marathon_build: 'Marathon build',
	marathon_peak: 'Marathon peak',
	marathon_taper: 'Marathon taper'
};
export type Phase = keyof typeof PHASE_LABEL;
export const PHASES = keysOf(PHASE_LABEL);

/** Open. What one week of a block is for. */
export const WEEK_KIND_LABEL = {
	baseline: 'Baseline',
	accumulation: 'Accumulation',
	intensification: 'Intensification',
	build: 'Build',
	peak: 'Peak',
	deload: 'Deload',
	taper: 'Taper',
	event: 'Event week'
};
export type WeekKind = keyof typeof WEEK_KIND_LABEL;
export const WEEK_KINDS = keysOf(WEEK_KIND_LABEL);

/** Open. What a planned or logged session is; its tone colours it (sessionTone). */
export const SESSION_TYPE_LABEL = {
	strength: 'Strength',
	hypertrophy: 'Hypertrophy',
	power: 'Power',
	easy_run: 'Easy run',
	long_run: 'Long run',
	tempo_run: 'Tempo run',
	interval_run: 'Intervals',
	recovery_run: 'Recovery run',
	muay_thai: 'Muay Thai',
	strength_class: 'Strength class',
	conditioning: 'Conditioning',
	mobility: 'Mobility',
	strength_conditioning: 'S&C',
	custom: 'Custom'
};
export type SessionType = keyof typeof SESSION_TYPE_LABEL;
export const SESSION_TYPES = keysOf(SESSION_TYPE_LABEL);

const SESSION_TONE: Readonly<Record<SessionType, DisciplineTone>> = {
	strength: 'strength',
	hypertrophy: 'hypertrophy',
	power: 'strength',
	easy_run: 'running',
	long_run: 'running',
	tempo_run: 'running',
	interval_run: 'running',
	recovery_run: 'running',
	muay_thai: 'combat',
	// A strength class (a commitment) is strength training whose content the class sets.
	strength_class: 'strength',
	conditioning: 'conditioning',
	mobility: 'conditioning',
	strength_conditioning: 'conditioning',
	custom: 'conditioning'
};

/** The M2 discipline colour a session type is shown in (docs/design-system.md). */
export function sessionTone(type: SessionType): DisciplineTone {
	return SESSION_TONE[type];
}

/** Open. The format of a non-strength, non-run session (Muay Thai, mobility, S&C, custom). */
export const OTHER_SESSION_KIND_LABEL = {
	pad_work: 'Pad work',
	sparring: 'Sparring',
	technical: 'Technical',
	conditioning: 'Conditioning',
	class: 'Class',
	mobility: 'Mobility',
	strength_conditioning: 'S&C',
	custom: 'Custom'
};
export type OtherSessionKind = keyof typeof OTHER_SESSION_KIND_LABEL;
export const OTHER_SESSION_KINDS = keysOf(OTHER_SESSION_KIND_LABEL);

/** Open. A set prescription's job in its exercise. */
export const SET_ROLE_LABEL = {
	warm_up: 'Warm-up',
	ramp: 'Work up',
	top: 'Top set',
	working: 'Working',
	back_off: 'Back-off'
};
export type SetRole = keyof typeof SET_ROLE_LABEL;
export const SET_ROLES = keysOf(SET_ROLE_LABEL);

/** Open. A planned or logged run segment. */
export const RUN_SEGMENT_KIND_LABEL = {
	warm_up: 'Warm-up',
	easy: 'Easy',
	steady: 'Steady',
	tempo: 'Tempo',
	interval: 'Interval',
	recovery: 'Recovery',
	long: 'Long',
	cool_down: 'Cool-down'
};
export type RunSegmentKind = keyof typeof RUN_SEGMENT_KIND_LABEL;
export const RUN_SEGMENT_KINDS = keysOf(RUN_SEGMENT_KIND_LABEL);

/**
 * Closed. A planned session's stored status. 'Completed' is never stored: program reads derive it
 * from a completed workout, so logging training never creates a program version.
 */
export const PLAN_STATUS_LABEL = { planned: 'Planned', skipped: 'Skipped', moved: 'Moved' };
export type PlanStatus = keyof typeof PLAN_STATUS_LABEL;
export const PLAN_STATUSES = keysOf(PLAN_STATUS_LABEL);

/** A session's status as screens show it: the stored status, or the derived 'completed'. */
export const SESSION_STATUS_LABEL = { ...PLAN_STATUS_LABEL, completed: 'Completed' };
export type SessionStatus = keyof typeof SESSION_STATUS_LABEL;
export const SESSION_STATUSES = keysOf(SESSION_STATUS_LABEL);

/** Closed. How hard a planned session is meant to be. */
export const SESSION_INTENSITY_LABEL = {
	easy: 'Easy',
	moderate: 'Moderate',
	hard: 'Hard',
	very_hard: 'Very hard'
};
export type SessionIntensity = keyof typeof SESSION_INTENSITY_LABEL;
export const SESSION_INTENSITIES = keysOf(SESSION_INTENSITY_LABEL);

const INTENSITY_OF_COMMITMENT: Readonly<Record<Intensity, SessionIntensity>> = {
	light: 'easy',
	moderate: 'moderate',
	hard: 'hard'
};

/** The intensity of the session an M2 commitment (say, a Muay Thai class) becomes. */
export function fromCommitmentIntensity(intensity: Intensity): SessionIntensity {
	return INTENSITY_OF_COMMITMENT[intensity];
}

// ---- Prescriptions --------------------------------------------------------------------------

/** Closed. How a set's load is prescribed. */
export const LOAD_KIND_LABEL = {
	absolute: 'Weight',
	percent_1rm: '% of 1RM',
	rpe_based: 'By RPE',
	from_e1rm: '% of estimated 1RM'
};
export type LoadKind = keyof typeof LOAD_KIND_LABEL;
export const LOAD_KINDS = keysOf(LOAD_KIND_LABEL);

/**
 * Closed. The M2 baseline a percent_1rm load comes from. It is M2's BASELINE_KINDS itself, so an
 * estimated 1RM can never be labelled measured.
 */
export const LOAD_BASES = BASELINE_KINDS;
export type LoadBasis = BaselineKind;
export const LOAD_BASIS_LABEL: Readonly<Record<LoadBasis, string>> = {
	measured: 'Measured 1RM',
	estimated: 'Estimated 1RM'
};

// ---- Decisions and coaching memory ----------------------------------------------------------

/** Closed. Who made a decision or created a version. */
export const DECIDER_LABEL = { owner: 'You', coach: 'Coach', rules: 'Programming rules' };
export type Decider = keyof typeof DECIDER_LABEL;
export const DECIDERS = keysOf(DECIDER_LABEL);

/**
 * Open. What a programming decision is about. Every kind M3 writes is listed up front:
 * default_assumed records a 'not told yet' default, goal_excluded a paused goal.
 */
export const DECISION_KIND_LABEL = {
	program_purpose: 'Program purpose',
	block_structure: 'Block structure',
	event_taper: 'Event taper',
	default_assumed: 'Assumed default',
	goal_excluded: 'Goal left out',
	commitment_placed: 'Commitment placed',
	day_allocation: 'Training days',
	split_chosen: 'Split',
	exercise_selected: 'Exercise chosen',
	exercise_excluded: 'Exercise excluded',
	exercise_substituted: 'Exercise substituted',
	slot_empty: 'Slot left empty',
	time_trimmed: 'Trimmed to fit',
	load_basis: 'Load basis',
	progression: 'Progression',
	volume_adjusted: 'Volume adjusted',
	run_volume: 'Running volume',
	run_pace_source: 'Pace source',
	quality_session: 'Quality session',
	session_placed: 'Session placed',
	interference_resolved: 'Interference avoided',
	priority_tradeoff: 'Priority trade-off',
	session_dropped: 'Session dropped',
	unmapped_avoidance: 'Avoidance not matched',
	owner_confirmed: 'Confirmed by you',
	session_moved: 'Session moved',
	session_skipped: 'Session skipped',
	exercise_swapped: 'Exercise swapped',
	prescription_adjusted: 'Prescription adjusted',
	preference_recorded: 'Preference recorded'
};
export type DecisionKind = keyof typeof DECISION_KIND_LABEL;
export const DECISION_KINDS = keysOf(DECISION_KIND_LABEL);

/**
 * Open. Why an exercise was replaced, M4's in-workout reasons included. Only a substitution the
 * owner turns into a dislike ever becomes a preference.
 */
export const SUBSTITUTION_REASON_LABEL = {
	situational: 'Just this once',
	equipment_unavailable: 'Equipment busy or missing',
	dislike: "Don't like it",
	pain: 'Pain',
	injury: 'Injury',
	coach_suggestion: 'Coach suggestion',
	owner_choice: 'Your choice'
};
export type SubstitutionReason = keyof typeof SUBSTITUTION_REASON_LABEL;
export const SUBSTITUTION_REASONS = keysOf(SUBSTITUTION_REASON_LABEL);

/** Closed. Where an exercise preference was recorded. */
export const PREFERENCE_SOURCE_LABEL = {
	onboarding: 'Onboarding',
	profile: 'Profile',
	swap: 'Swap',
	workout: 'Workout',
	coach: 'Coach'
};
export type PreferenceSource = keyof typeof PREFERENCE_SOURCE_LABEL;
export const PREFERENCE_SOURCES = keysOf(PREFERENCE_SOURCE_LABEL);

/** Closed. The lifecycle of a coach proposal (M5). */
export const PROPOSAL_STATUS_LABEL = {
	proposed: 'Proposed',
	accepted: 'Accepted',
	rejected: 'Rejected',
	applied: 'Applied'
};
export type ProposalStatus = keyof typeof PROPOSAL_STATUS_LABEL;
export const PROPOSAL_STATUSES = keysOf(PROPOSAL_STATUS_LABEL);
