/**
 * The training profile as the services return it (read model). Field names match the write
 * schemas (./schemas.ts) wherever they overlap, so a screen can edit what it loaded and send it
 * straight back. Dates are ISO `YYYY-MM-DD` strings; timestamps are `Date`s.
 */
import type { DistanceUnit, WeightUnit } from '../units';
import type {
	BaselineKind,
	BaselineSource,
	BodyArea,
	Discipline,
	Equipment,
	ExperienceLevel,
	GoalKind,
	GoalStatus,
	GymType,
	Intensity,
	Lift,
	NutritionPhase,
	RaceDistance,
	Sentiment,
	Severity,
	Side,
	TimeOfDay,
	Weekday
} from './catalog';
import type { OnboardingProgress } from './onboarding';

export type ProfileDistanceUnit = Exclude<DistanceUnit, 'm'>;

export interface AthleteProfile {
	name: string;
	weightUnit: WeightUnit;
	distanceUnit: ProfileDistanceUnit;
	birthYear: number | null;
	nutritionPhase: NutritionPhase | null;
	targetWeight: number | null;
	targetDate: string | null;
	/** The owner said they don't know their 1RMs: week 1 establishes them (RPE-based). */
	baselinesUnknown: boolean;
	onboarding: OnboardingProgress;
	updatedAt: Date;
}

export interface BodyWeightEntry {
	id: number;
	value: number;
	unit: WeightUnit;
	measuredOn: string;
	source: string;
}

export interface Goal {
	id: string;
	kind: GoalKind;
	title: string;
	disciplines: Discipline[];
	customDiscipline: string | null;
	status: GoalStatus;
	/** 1 = top priority (wins when goals compete). Null for achieved or dropped goals. */
	priority: number | null;
	eventType: string | null;
	eventDate: string | null;
	weightClass: string | null;
	targetPerformance: string | null;
	requirements: string | null;
	focus: string | null;
	measure: string | null;
	targetDate: string | null;
	notes: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ExperienceEntry {
	id: string;
	discipline: Discipline;
	customLabel: string | null;
	level: ExperienceLevel;
	years: number | null;
	sessionsPerWeek: number | null;
	notes: string | null;
	updatedAt: Date;
}

export interface StrengthBaseline {
	id: string;
	lift: Lift;
	customLabel: string | null;
	/** Derived from the source on the server: an estimate is never stored as measured. */
	kind: BaselineKind;
	source: BaselineSource;
	/** The 1RM: lifted (measured) or calculated / judged (estimated). */
	value: number;
	unit: WeightUnit;
	achievedOn: string | null;
	setWeight: number | null;
	setReps: number | null;
	setRpe: number | null;
	/** e1RM method and confidence for estimates from a set (src/lib/domain/e1rm.ts). */
	method: string | null;
	confidence: 'high' | 'medium' | 'low' | null;
	notes: string | null;
	recordedAt: Date;
}

export interface RaceResult {
	id: string;
	distance: RaceDistance;
	/** For `other`: in the running profile's unit. */
	customDistance: number | null;
	distanceMetres: number;
	timeSeconds: number;
	racedOn: string | null;
	eventName: string | null;
}

export interface RunningProfile {
	unit: ProfileDistanceUnit;
	weeklyDistance: number | null;
	runsPerWeek: number | null;
	longestRun: number | null;
	easyPaceSeconds: number | null;
	races: RaceResult[];
	notes: string | null;
	updatedAt: Date;
}

export interface MuayThaiProfile {
	sessionsPerWeek: number | null;
	sparringPerWeek: number | null;
	fights: number | null;
	notes: string | null;
	updatedAt: Date;
}

export interface EquipmentProfile {
	gymType: GymType | null;
	equipment: Equipment[];
	homeEquipment: Equipment[];
	notes: string | null;
	updatedAt: Date;
}

export interface Injury {
	id: string;
	bodyArea: BodyArea;
	side: Side | null;
	severity: Severity;
	notes: string | null;
	avoid: string[];
	active: boolean;
	since: string | null;
	updatedAt: Date;
}

export interface ExercisePreference {
	id: string;
	exercise: string;
	sentiment: Sentiment;
	reason: string | null;
}

export interface Commitment {
	id: string;
	discipline: Discipline;
	label: string;
	days: Weekday[];
	timeOfDay: TimeOfDay | null;
	durationMinutes: number | null;
	intensity: Intensity | null;
	notes: string | null;
}

export interface Schedule {
	daysPerWeek: number | null;
	availableDays: Weekday[];
	preferredTimes: TimeOfDay[];
	sessionMinutes: number | null;
	constraints: string | null;
	commitments: Commitment[];
	updatedAt: Date | null;
}

export interface TrainingProfile {
	profile: AthleteProfile;
	bodyWeight: BodyWeightEntry[];
	goals: Goal[];
	experience: ExperienceEntry[];
	baselines: StrengthBaseline[];
	running: RunningProfile | null;
	muayThai: MuayThaiProfile | null;
	equipment: EquipmentProfile | null;
	injuries: Injury[];
	exercises: ExercisePreference[];
	schedule: Schedule;
}
