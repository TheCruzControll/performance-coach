/**
 * The training-profile vocabulary (PRD §2, §3): disciplines, experience levels, lifts, equipment,
 * body areas, schedule terms. Shared by the database layer (stored keys), the services
 * (validation), the UI (labels) and the coach (M5, reasoning).
 *
 * Keys are stable identifiers stored in Postgres: never rename one, add a new key instead.
 * The model is deliberately not weightlifting-only — every discipline is a peer, and `custom`
 * covers anything the catalog does not name.
 */

/** Discipline-colour signal used by the UI (docs/design-system.md). */
export type DisciplineTone = 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';

export const DISCIPLINES = [
	'powerlifting',
	'weightlifting',
	'strength',
	'hypertrophy',
	'running',
	'distance_running',
	'muay_thai',
	'athletic',
	'custom'
] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export interface DisciplineInfo {
	label: string;
	/** Short form for chips. */
	short: string;
	tone: DisciplineTone;
	/** What kind of training it mostly is (the coach reasons about interference with this). */
	quality: 'strength' | 'hypertrophy' | 'endurance' | 'skill' | 'mixed';
}

export const DISCIPLINE_INFO: Record<Discipline, DisciplineInfo> = {
	powerlifting: {
		label: 'Powerlifting',
		short: 'Powerlifting',
		tone: 'strength',
		quality: 'strength'
	},
	weightlifting: {
		label: 'Olympic weightlifting',
		short: 'Weightlifting',
		tone: 'strength',
		quality: 'skill'
	},
	strength: { label: 'General strength', short: 'Strength', tone: 'strength', quality: 'strength' },
	hypertrophy: {
		label: 'Hypertrophy / bodybuilding',
		short: 'Hypertrophy',
		tone: 'hypertrophy',
		quality: 'hypertrophy'
	},
	running: { label: 'Running', short: 'Running', tone: 'running', quality: 'endurance' },
	distance_running: {
		label: 'Half-marathon / marathon prep',
		short: 'Half / marathon',
		tone: 'running',
		quality: 'endurance'
	},
	muay_thai: { label: 'Muay Thai', short: 'Muay Thai', tone: 'combat', quality: 'skill' },
	athletic: {
		label: 'General athletic performance',
		short: 'Athletic',
		tone: 'conditioning',
		quality: 'mixed'
	},
	custom: { label: 'Something else', short: 'Custom', tone: 'conditioning', quality: 'mixed' }
};

export const RUNNING_DISCIPLINES: readonly Discipline[] = ['running', 'distance_running'];
export const STRENGTH_DISCIPLINES: readonly Discipline[] = [
	'powerlifting',
	'weightlifting',
	'strength',
	'hypertrophy',
	'athletic'
];

// ---- Goals ---------------------------------------------------------------------------------

export const GOAL_KINDS = ['event', 'general'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/**
 * `active` and `paused` goals are *open*: they hold a priority rank (1 = wins conflicts).
 * `achieved` and `dropped` goals are closed: kept for history, outside the ranking.
 */
export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = ['active', 'paused'];

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
	active: 'Active',
	paused: 'Paused',
	achieved: 'Achieved',
	dropped: 'Dropped'
};

/** Suggested event types (free text is allowed too). */
export const EVENT_TYPE_SUGGESTIONS: Record<Discipline, readonly string[]> = {
	powerlifting: ['Powerlifting meet'],
	weightlifting: ['Weightlifting meet'],
	strength: ['Strength test day'],
	hypertrophy: ['Physique show', 'Photoshoot'],
	running: ['5K race', '10K race', 'Trail race'],
	distance_running: ['Half marathon', 'Marathon'],
	muay_thai: ['Muay Thai fight', 'Grading'],
	athletic: ['Fitness test', 'Hyrox', 'Season start'],
	custom: ['Event']
};

// ---- Experience ----------------------------------------------------------------------------

export const EXPERIENCE_LEVELS = ['new', 'novice', 'intermediate', 'advanced'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const EXPERIENCE_LEVEL_INFO: Record<ExperienceLevel, { label: string; hint: string }> = {
	new: { label: 'New', hint: 'Just starting out' },
	novice: { label: 'Novice', hint: 'Under ~2 years, still progressing fast' },
	intermediate: { label: 'Intermediate', hint: 'Steady, structured training' },
	advanced: { label: 'Advanced', hint: 'Years in, competing or close to it' }
};

// ---- Strength baselines ---------------------------------------------------------------------

export const LIFTS = [
	'back_squat',
	'front_squat',
	'bench_press',
	'deadlift',
	'overhead_press',
	'snatch',
	'clean_and_jerk',
	'power_clean',
	'weighted_pull_up',
	'custom'
] as const;
export type Lift = (typeof LIFTS)[number];

export const LIFT_LABEL: Record<Lift, string> = {
	back_squat: 'Back squat',
	front_squat: 'Front squat',
	bench_press: 'Bench press',
	deadlift: 'Deadlift',
	overhead_press: 'Overhead press',
	snatch: 'Snatch',
	clean_and_jerk: 'Clean & jerk',
	power_clean: 'Power clean',
	weighted_pull_up: 'Weighted pull-up',
	custom: 'Other lift'
};

/** Lifts worth asking about first, per discipline (others can be added). */
export const LIFTS_FOR_DISCIPLINE: Partial<Record<Discipline, readonly Lift[]>> = {
	powerlifting: ['back_squat', 'bench_press', 'deadlift'],
	weightlifting: ['snatch', 'clean_and_jerk', 'front_squat', 'back_squat'],
	strength: ['back_squat', 'bench_press', 'deadlift', 'overhead_press'],
	hypertrophy: ['back_squat', 'bench_press', 'deadlift'],
	athletic: ['back_squat', 'bench_press', 'deadlift', 'power_clean'],
	muay_thai: ['back_squat', 'deadlift']
};

/** A measured max was lifted; an estimated one was calculated or judged. Never conflated. */
export const BASELINE_KINDS = ['measured', 'estimated'] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

/**
 * - `tested`: a true 1RM tested in training (measured)
 * - `competition`: lifted on a platform (measured)
 * - `set`: estimated from a recent set (weight × reps, ideally with RPE)
 * - `estimate`: the owner's own best guess (estimated)
 */
export const BASELINE_SOURCES = ['tested', 'competition', 'set', 'estimate'] as const;
export type BaselineSource = (typeof BASELINE_SOURCES)[number];

export const BASELINE_SOURCE_KIND: Record<BaselineSource, BaselineKind> = {
	tested: 'measured',
	competition: 'measured',
	set: 'estimated',
	estimate: 'estimated'
};

export const BASELINE_SOURCE_LABEL: Record<BaselineSource, string> = {
	tested: 'Tested max',
	competition: 'Competition lift',
	set: 'From a recent set',
	estimate: 'My best guess'
};

// ---- Running ------------------------------------------------------------------------------

export const RACE_DISTANCES = ['5k', '10k', 'half_marathon', 'marathon', 'other'] as const;
export type RaceDistance = (typeof RACE_DISTANCES)[number];

export const RACE_DISTANCE_INFO: Record<RaceDistance, { label: string; metres: number | null }> = {
	'5k': { label: '5K', metres: 5000 },
	'10k': { label: '10K', metres: 10000 },
	half_marathon: { label: 'Half marathon', metres: 21097.5 },
	marathon: { label: 'Marathon', metres: 42195 },
	other: { label: 'Other', metres: null }
};

// ---- Equipment ----------------------------------------------------------------------------

export const GYM_TYPES = ['commercial', 'strength', 'home', 'minimal', 'none'] as const;
export type GymType = (typeof GYM_TYPES)[number];

export const GYM_TYPE_INFO: Record<GymType, { label: string; hint: string }> = {
	commercial: { label: 'Commercial gym', hint: 'Racks, machines, cables, dumbbells' },
	strength: { label: 'Strength club', hint: 'Platforms, calibrated plates, specialty bars' },
	home: { label: 'Home or garage gym', hint: 'Your own rack and bar' },
	minimal: { label: 'Minimal or travel', hint: 'Dumbbells, bands, a hotel gym' },
	none: { label: 'No gym', hint: 'Bodyweight, outdoors, your Muay Thai gym' }
};

export const EQUIPMENT = [
	'barbell',
	'squat_rack',
	'bench',
	'platform',
	'dumbbells',
	'kettlebells',
	'cables',
	'machines',
	'pull_up_bar',
	'rings',
	'bands',
	'specialty_bars',
	'sled',
	'plyo_box',
	'treadmill',
	'rower',
	'bike',
	'ski_erg',
	'heavy_bag',
	'pads'
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

export const EQUIPMENT_LABEL: Record<Equipment, string> = {
	barbell: 'Barbell & plates',
	squat_rack: 'Squat rack',
	bench: 'Bench',
	platform: 'Lifting platform',
	dumbbells: 'Dumbbells',
	kettlebells: 'Kettlebells',
	cables: 'Cable station',
	machines: 'Machines',
	pull_up_bar: 'Pull-up bar',
	rings: 'Rings',
	bands: 'Bands',
	specialty_bars: 'Specialty bars',
	sled: 'Sled',
	plyo_box: 'Plyo box',
	treadmill: 'Treadmill',
	rower: 'Rower',
	bike: 'Air / spin bike',
	ski_erg: 'SkiErg',
	heavy_bag: 'Heavy bag',
	pads: 'Thai pads'
};

// ---- Injuries -----------------------------------------------------------------------------

export const BODY_AREAS = [
	'neck',
	'shoulder',
	'elbow',
	'wrist_hand',
	'upper_back',
	'lower_back',
	'hip',
	'groin',
	'hamstring',
	'knee',
	'shin_calf',
	'ankle_foot',
	'other'
] as const;
export type BodyArea = (typeof BODY_AREAS)[number];

export const BODY_AREA_LABEL: Record<BodyArea, string> = {
	neck: 'Neck',
	shoulder: 'Shoulder',
	elbow: 'Elbow',
	wrist_hand: 'Wrist / hand',
	upper_back: 'Upper back',
	lower_back: 'Lower back',
	hip: 'Hip',
	groin: 'Groin',
	hamstring: 'Hamstring',
	knee: 'Knee',
	shin_calf: 'Shin / calf',
	ankle_foot: 'Ankle / foot',
	other: 'Other'
};

export const SIDES = ['left', 'right', 'both'] as const;
export type Side = (typeof SIDES)[number];

export const SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_INFO: Record<Severity, { label: string; hint: string }> = {
	mild: { label: 'Mild', hint: 'Niggle — train around it' },
	moderate: { label: 'Moderate', hint: 'Limits some movements' },
	severe: { label: 'Severe', hint: 'Rehab first' }
};

// ---- Exercise preferences -----------------------------------------------------------------

export const SENTIMENTS = ['like', 'dislike'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const EXERCISE_SUGGESTIONS = [
	'Back squat',
	'Front squat',
	'Bench press',
	'Deadlift',
	'Romanian deadlift',
	'Overhead press',
	'Pull-ups',
	'Dips',
	'Lunges',
	'Bulgarian split squat',
	'Leg press',
	'Hip thrust',
	'Burpees',
	'Running intervals',
	'Box jumps',
	'Kettlebell swings'
] as const;

// ---- Schedule -----------------------------------------------------------------------------

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_INFO: Record<Weekday, { short: string; letter: string; label: string }> = {
	mon: { short: 'Mon', letter: 'M', label: 'Monday' },
	tue: { short: 'Tue', letter: 'T', label: 'Tuesday' },
	wed: { short: 'Wed', letter: 'W', label: 'Wednesday' },
	thu: { short: 'Thu', letter: 'T', label: 'Thursday' },
	fri: { short: 'Fri', letter: 'F', label: 'Friday' },
	sat: { short: 'Sat', letter: 'S', label: 'Saturday' },
	sun: { short: 'Sun', letter: 'S', label: 'Sunday' }
};

export const TIMES_OF_DAY = [
	'early_morning',
	'morning',
	'midday',
	'afternoon',
	'evening',
	'varies'
] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
	early_morning: 'Early morning',
	morning: 'Morning',
	midday: 'Midday',
	afternoon: 'Afternoon',
	evening: 'Evening',
	varies: 'It varies'
};

export const INTENSITIES = ['light', 'moderate', 'hard'] as const;
export type Intensity = (typeof INTENSITIES)[number];

// ---- Body & nutrition -----------------------------------------------------------------------

export const NUTRITION_PHASES = ['bulk', 'cut', 'maintenance', 'recomp'] as const;
export type NutritionPhase = (typeof NUTRITION_PHASES)[number];

export const NUTRITION_PHASE_INFO: Record<NutritionPhase, { label: string; hint: string }> = {
	bulk: { label: 'Bulk', hint: 'Eating in a surplus to gain' },
	cut: { label: 'Cut', hint: 'Eating in a deficit to lose fat or make weight' },
	maintenance: { label: 'Maintenance', hint: 'Holding body weight steady' },
	recomp: { label: 'Recomp', hint: 'Lose fat, build muscle, weight roughly steady' }
};

export const WEIGHT_UNITS = ['kg', 'lb'] as const;
export const DISTANCE_UNITS = ['km', 'mi'] as const;

/** Label for a stored discipline (custom ones carry their own name). */
export function disciplineLabel(discipline: Discipline, customLabel?: string | null): string {
	return discipline === 'custom' && customLabel ? customLabel : DISCIPLINE_INFO[discipline].label;
}
