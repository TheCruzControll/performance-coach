/**
 * Shared plumbing for the training-profile services: dependencies, validation errors and the
 * row → read-model mapping (src/lib/domain/profile/types.ts).
 */
import type {
	AthleteProfile,
	Commitment,
	ExercisePreference,
	ExperienceEntry,
	Goal,
	Injury,
	RaceResult,
	StrengthBaseline
} from '../../../domain/profile/types';
import type * as z from 'zod/mini';
import { DISCIPLINES } from '../../../domain/profile/catalog';
import { validate, type FieldErrors } from '../../../domain/profile/schemas';
import {
	getDb,
	type AthleteProfileRow,
	type BaselineRow,
	type CommitmentRow,
	type ExercisePreferenceRow,
	type ExperienceRow,
	type Executor,
	type GoalRow,
	type InjuryRow,
	type RaceRow
} from '../../db';

/** Who made a change (stored with goal history; the coach uses `coach` from M5). */
export type ChangeSource = 'onboarding' | 'profile' | 'coach';

export interface ProfileDeps {
	db?: Executor;
	now?: () => Date;
	source?: ChangeSource;
}

export interface ResolvedProfileDeps {
	db: Executor;
	now: () => Date;
	source: ChangeSource;
}

export function resolveDeps(deps: ProfileDeps = {}): ResolvedProfileDeps {
	return {
		db: deps.db ?? getDb(),
		now: deps.now ?? (() => new Date()),
		source: deps.source ?? 'profile'
	};
}

/** Input the owner can fix: field path → message (shown next to the field). */
export class ProfileInputError extends Error {
	readonly errors: FieldErrors;

	constructor(errors: FieldErrors) {
		super(`invalid profile input: ${Object.keys(errors).join(', ') || '(root)'}`);
		this.name = 'ProfileInputError';
		this.errors = errors;
	}
}

export class ProfileNotFoundError extends Error {
	constructor(what: string) {
		super(`${what} not found`);
		this.name = 'ProfileNotFoundError';
	}
}

export function isProfileInputError(error: unknown): error is ProfileInputError {
	return error instanceof ProfileInputError;
}

/** Validate with a shared schema or throw a ProfileInputError. */
export function parseWith<S extends z.ZodMiniType>(schema: S, input: unknown): z.output<S> {
	const result = validate(schema, input);
	if (!result.ok) throw new ProfileInputError(result.errors);
	return result.data;
}

/** ISO date (YYYY-MM-DD) of `now` in UTC. */
export const isoDay = (now: Date) => now.toISOString().slice(0, 10);

// ---- mapping -----------------------------------------------------------------------------------

export function toProfile(row: AthleteProfileRow): AthleteProfile {
	return {
		name: row.name,
		weightUnit: row.weightUnit,
		distanceUnit: row.distanceUnit,
		birthYear: row.birthYear,
		nutritionPhase: row.nutritionPhase,
		targetWeight: row.targetWeight,
		targetDate: row.targetDate,
		baselinesUnknown: row.baselinesUnknown,
		onboarding: {
			current: row.onboardingStep,
			completed: row.onboardingCompleted,
			skipped: row.onboardingSkipped,
			completedAt: row.onboardingCompletedAt
		},
		updatedAt: row.updatedAt
	};
}

export function toGoal(row: GoalRow): Goal {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		disciplines: row.disciplines,
		customDiscipline: row.customDiscipline,
		status: row.status,
		priority: row.priority,
		eventType: row.eventType,
		eventDate: row.eventDate,
		weightClass: row.weightClass,
		targetPerformance: row.targetPerformance,
		requirements: row.requirements,
		focus: row.focus,
		measure: row.measure,
		targetDate: row.targetDate,
		notes: row.notes,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export function toExperience(row: ExperienceRow): ExperienceEntry {
	return {
		id: row.id,
		discipline: row.discipline,
		customLabel: row.customLabel || null,
		level: row.level,
		years: row.years,
		sessionsPerWeek: row.sessionsPerWeek,
		notes: row.notes,
		updatedAt: row.updatedAt
	};
}

/** Experience in catalog order (custom disciplines last, by name). */
export function toExperienceList(rows: ExperienceRow[]): ExperienceEntry[] {
	const order = (d: string) => DISCIPLINES.indexOf(d as (typeof DISCIPLINES)[number]);
	return rows
		.map(toExperience)
		.sort(
			(a, b) =>
				order(a.discipline) - order(b.discipline) ||
				(a.customLabel ?? '').localeCompare(b.customLabel ?? '')
		);
}

export function toBaseline(row: BaselineRow): StrengthBaseline {
	return {
		id: row.id,
		lift: row.lift,
		customLabel: row.customLabel || null,
		kind: row.kind,
		source: row.source,
		value: row.value,
		unit: row.unit,
		achievedOn: row.achievedOn,
		setWeight: row.setWeight,
		setReps: row.setReps,
		setRpe: row.setRpe,
		method: row.method,
		confidence: row.confidence,
		notes: row.notes,
		recordedAt: row.recordedAt
	};
}

export function toRace(row: RaceRow): RaceResult {
	return {
		id: row.id,
		distance: row.distance,
		customDistance: row.customDistance,
		distanceMetres: row.distanceMetres,
		timeSeconds: row.timeSeconds,
		racedOn: row.racedOn,
		eventName: row.eventName
	};
}

export function toInjury(row: InjuryRow): Injury {
	return {
		id: row.id,
		bodyArea: row.bodyArea,
		side: row.side,
		severity: row.severity,
		notes: row.notes,
		avoid: row.avoid,
		active: row.active,
		since: row.since,
		updatedAt: row.updatedAt
	};
}

export function toExercisePreference(row: ExercisePreferenceRow): ExercisePreference {
	return { id: row.id, exercise: row.exercise, sentiment: row.sentiment, reason: row.reason };
}

export function toCommitment(row: CommitmentRow): Commitment {
	return {
		id: row.id,
		discipline: row.discipline,
		label: row.label,
		days: row.days,
		timeOfDay: row.timeOfDay,
		durationMinutes: row.durationMinutes,
		intensity: row.intensity,
		notes: row.notes
	};
}
