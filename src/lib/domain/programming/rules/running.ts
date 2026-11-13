/**
 * The concurrent-training numbers (PRD §5; m3-plan 'Not told yet' defaults and 'Session
 * length'): fixed commitments, the running week and the other sessions. commitments.ts,
 * running.ts and other.ts apply them, and each number lives here and nowhere else, so changing
 * one, such as whether the long run may outrun the session length (an open question), is a
 * one-line edit.
 */
import type { Discipline, Equipment, ExperienceLevel, Intensity } from '../../profile/catalog.ts';
import type { RunSegment } from '../../training/types.ts';
import type {
	OtherSessionKind,
	Phase,
	RunSegmentKind,
	SessionIntensity,
	SessionType,
	WeekKind
} from '../../training/vocabulary.ts';

type HrZone = NonNullable<RunSegment['hrZone']>;

// ---- Commitments ----------------------------------------------------------------------------

/** A commitment's target RPE by its intensity, moderate when the owner gave none. */
export const COMMITMENT_RPE: Readonly<Record<Intensity, number>> = {
	light: 4,
	moderate: 6,
	hard: 8
};

/**
 * A running commitment is one timed segment: the club sets the pace, and its intensity sets the
 * effort, the heart-rate zone and the session type.
 */
export const COMMITMENT_RUN: Readonly<
	Record<Intensity, { type: SessionType; segment: RunSegmentKind; hrZone: HrZone }>
> = {
	light: { type: 'easy_run', segment: 'easy', hrZone: 2 },
	moderate: { type: 'easy_run', segment: 'steady', hrZone: 3 },
	hard: { type: 'tempo_run', segment: 'tempo', hrZone: 4 }
};

/**
 * The session type of any other commitment, a class whose content is its own: a strength or
 * CrossFit-style class is a strength_class (m3-plan open question 'Commitments by discipline'),
 * an athletic one is S&C.
 */
export const COMMITMENT_TYPE: Readonly<
	Record<Exclude<Discipline, 'running' | 'distance_running'>, SessionType>
> = {
	powerlifting: 'strength_class',
	weightlifting: 'strength_class',
	strength: 'strength_class',
	hypertrophy: 'strength_class',
	muay_thai: 'muay_thai',
	athletic: 'strength_conditioning',
	custom: 'custom'
};

// ---- The running week -----------------------------------------------------------------------

/** Each week runs at most this much more than the biggest week before it: the 10 % rule. */
export const RUN_WEEKLY_INCREASE_MAX = 0.1;

/** The long run is at most this share of the week's running… */
export const LONG_RUN_SHARE_MAX = 0.3;

/** …and at most this much longer than the longest run so far, told or planned. */
export const LONG_RUN_STEP_MAX = 0.1;

/**
 * The long run may run longer than the owner's session length, with a priority_tradeoff
 * decision saying so; every other run keeps to it (m3-plan open question 'Session length').
 * False caps the long run at the session length too.
 */
export const LONG_RUN_EXCEEDS_SESSION = true;

/** A week planned under this share of its volume says why in its run_volume decision. */
export const UNDER_VOLUME = 0.95;

/**
 * The shortest run worth planning, by distance and by time. A week too small for each of its
 * runs to reach it has fewer runs, all easy, rather than runs raised over its volume, and one too
 * small for its quality session and one such run besides has an easy run in its place.
 */
export const MIN_RUN = { metres: 2000, minutes: 20 } as const;

/** Distances are planned in whole steps of this many metres, rounded down. */
export const RUN_DISTANCE_STEP = 100;

/**
 * With no current volume told, week 1 is set by time (DEFAULTS.running_volume): easy runs of
 * 30 minutes and, for a runner who is not new, a 45-minute long run. Later weeks scale both.
 * The long run's share of the week guards a weekly mileage, so a time-based week leaves it out.
 */
export const TIME_BASED_WEEK = { easyMinutes: 30, longMinutes: 45 } as const;

/**
 * An easy pace in seconds per km, only to estimate a distance run's minutes, and to count a
 * timed run in a distance week, when no pace or race is known. It is never a target.
 */
export const ASSUMED_EASY_PACE = 390;

/** Riegel's exponent, to carry a race time to the 10K: T₂ = T₁ × (D₂ / D₁)^1.06. */
export const RIEGEL_EXPONENT = 1.06;

/**
 * Each segment's effort: its RPE, its heart-rate zone and its pace as a range of 10K race pace,
 * fastest first (null for a jog with no pace). A told easy pace stands for the middle of the
 * easy range, so it implies a 10K pace too.
 */
export const EFFORTS = {
	easy: { rpe: 4.5, hrZone: 2, of10k: [1.2, 1.35] },
	long: { rpe: 5, hrZone: 2, of10k: [1.2, 1.35] },
	warm_up: { rpe: 3, hrZone: 2, of10k: [1.25, 1.4] },
	cool_down: { rpe: 3, hrZone: 2, of10k: [1.25, 1.4] },
	tempo: { rpe: 7, hrZone: 4, of10k: [1.03, 1.07] },
	interval: { rpe: 8, hrZone: 5, of10k: [0.94, 0.98] },
	recovery: { rpe: 3, hrZone: 1, of10k: null }
} as const satisfies Partial<
	Record<RunSegmentKind, { rpe: number; hrZone: HrZone; of10k: readonly [number, number] | null }>
>;

/**
 * A quality session (tempo or intervals) is planned only for an intermediate or advanced
 * runner, or for one with a race ahead, and never in week 1 for a new runner or a time-based
 * week 1. It needs `minRuns` runs in the week, commitments included, a run besides the long
 * run, and a session length that fits its warm-up, cool-down and at least `minMainMinutes`. A
 * hard running commitment is the week's quality session already.
 */
export const QUALITY = {
	levels: ['intermediate', 'advanced'] as readonly ExperienceLevel[],
	minRuns: 3,
	weeks: [
		'baseline',
		'accumulation',
		'intensification',
		'build',
		'peak',
		'taper'
	] as readonly WeekKind[],
	warmUpMinutes: 10,
	coolDownMinutes: 10,
	minMainMinutes: 10,
	/** For a half or full marathon: continuous running at threshold. */
	tempo: { type: 'tempo_run', minutes: 20, sessionRpe: 6.5 },
	/** For shorter races and general running: VO2max repeats with jogged recoveries. */
	intervals: { type: 'interval_run', reps: 5, workMinutes: 3, recoveryMinutes: 2, sessionRpe: 7 }
} as const;

/** The session RPE and intensity of an easy run and the long run. */
export const RUNS = {
	easy_run: { sessionRpe: 4.5, intensity: 'easy' },
	long_run: { sessionRpe: 5, intensity: 'moderate' },
	tempo_run: { sessionRpe: QUALITY.tempo.sessionRpe, intensity: 'hard' },
	interval_run: { sessionRpe: QUALITY.intervals.sessionRpe, intensity: 'hard' }
} as const satisfies Partial<
	Record<SessionType, { sessionRpe: number; intensity: SessionIntensity }>
>;

/**
 * The hooks later periodisation (M7) reads, as each marathon phase's progression numbers: how
 * fast running may grow, quality sessions a week and the long run's share of the week.
 */
export const MARATHON_HOOKS: Readonly<Partial<Record<Phase, Record<string, number>>>> = {
	// Base: easy volume climbs, with one quality session a week.
	marathon_base: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 1, longRunShareMax: 0.3 },
	// Build: volume and the long run keep climbing, with a second session at goal pace.
	marathon_build: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 2, longRunShareMax: 0.3 },
	// Peak: the biggest weeks are held rather than grown, with the longest long runs.
	marathon_peak: { runWeeklyIncreaseMax: 0, qualityPerWeek: 2, longRunShareMax: 0.35 },
	// Taper: volume falls to race day while the quality stays.
	marathon_taper: { runVolumeFactor: 0.6, qualityPerWeek: 1, longRunShareMax: 0.3 }
};

// ---- Other sessions -------------------------------------------------------------------------

/**
 * Generated Muay Thai sessions, by their format: technical by default (DEFAULTS
 * .muay_thai_sessions). With the Muay Thai profile told, they alternate technique and pad work,
 * and one a week is sparring if the owner spars, in the `sparringWeeks` only.
 */
export const MUAY_THAI = {
	technical: { title: 'Muay Thai technique', rpe: 6, intensity: 'moderate', rounds: 8 },
	pad_work: { title: 'Muay Thai pad work', rpe: 7, intensity: 'hard', rounds: 6 },
	sparring: { title: 'Muay Thai sparring', rpe: 8, intensity: 'very_hard', rounds: 4 },
	roundMinutes: 3,
	sparringWeeks: ['accumulation', 'intensification', 'build', 'peak'] as readonly WeekKind[]
} as const satisfies Record<
	Extract<OtherSessionKind, 'technical' | 'pad_work' | 'sparring'>,
	{ title: string; rpe: number; intensity: SessionIntensity; rounds: number }
> & { roundMinutes: number; sparringWeeks: readonly WeekKind[] };

/**
 * Zone 2 on the bike instead of some easy runs (cross-training.ts). With a bike in the owner's
 * kit, and runs that serve a goal training more than running (general fitness beside Muay Thai or
 * lifting), `share` of the week's generated easy runs, rounded up and the latest first, become a
 * steady zone 2 bike session of the same length: the same aerobic work, without the impact, so
 * the legs stay fresher for the rest of the week. The week always keeps `keepRuns` actual runs,
 * a running commitment counting. A goal about running itself, or one with a race ahead, keeps
 * its easy runs: there only recovery runs may move to the bike. Long, tempo and interval runs
 * always stay runs. Zone 2 is `hrMaxShare` of max heart rate, conversational.
 */
export const ZONE2_BIKE = {
	equipment: 'bike',
	exercise: 'stationary_bike',
	title: 'Zone 2 bike',
	convert: ['easy_run', 'recovery_run'],
	convertWithRace: ['recovery_run'],
	share: 0.5,
	keepRuns: 1,
	hrMaxShare: [0.6, 0.7]
} as const satisfies {
	equipment: Equipment;
	exercise: string;
	title: string;
	convert: readonly SessionType[];
	convertWithRace: readonly SessionType[];
	share: number;
	keepRuns: number;
	hrMaxShare: readonly [number, number];
};

/** A mobility session on a free day no goal asks for: short and easy, within the session length. */
export const MOBILITY = { minutes: 30, rpe: 3 } as const;

/** A custom-discipline goal with no commitment: sessions of the session length at this RPE. */
export const CUSTOM_SESSION_RPE = 6;
