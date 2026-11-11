/**
 * Training profile (M2, PRD §2–3): the athlete, their goals (ranked), experience per discipline,
 * optional strength baselines, running and Muay Thai specifics, equipment, injuries, exercise
 * likes/dislikes and schedule. One owner today; every table is keyed by `owner_id` anyway.
 *
 * History is kept where later milestones reason about change:
 * - `body_weight_entries` is a dated series (the latest row is the current weight).
 * - `training_goal_events` records every goal change and re-ranking as a JSON snapshot.
 * - `strength_baselines` rows are superseded, never overwritten (`superseded_at`).
 * Everything else carries `created_at` / `updated_at`.
 *
 * Vocabulary (discipline, lift, equipment keys) lives in src/lib/domain/profile/catalog.ts.
 * Only small, stable enums are CHECKed here; catalog lists are validated by the services so a
 * new key never needs a migration.
 */
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import {
	BASELINE_KINDS,
	BASELINE_SOURCES,
	EXPERIENCE_LEVELS,
	GOAL_KINDS,
	HEART_RATE_BOUNDS,
	GOAL_STATUSES,
	INTENSITIES,
	NUTRITION_PHASES,
	SENTIMENTS,
	SEVERITIES,
	SIDES,
	type BaselineKind,
	type BaselineSource,
	type BodyArea,
	type Discipline,
	type Equipment,
	type ExperienceLevel,
	type GoalKind,
	type GoalStatus,
	type GymType,
	type Intensity,
	type Lift,
	type NutritionPhase,
	type RaceDistance,
	type Sentiment,
	type Severity,
	type Side,
	type TimeOfDay,
	type Weekday
} from '../../../domain/profile/catalog';
import type { OnboardingStep } from '../../../domain/profile/onboarding';
import { PREFERENCE_SOURCES, type PreferenceSource } from '../../../domain/training/vocabulary';
import { owners } from './auth';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { exercises } from './exercises';

/** Weights: up to 9999.99 in the unit the owner entered (never converted, so never rounded). */
const weight = (name: string) => numeric(name, { precision: 6, scale: 2, mode: 'number' });
/** Counts per week, years: one decimal (e.g. 2.5 sessions, 1.5 years). */
const tenths = (name: string) => numeric(name, { precision: 4, scale: 1, mode: 'number' });

export const WEIGHT_UNIT_VALUES = ['kg', 'lb'] as const;
export const DISTANCE_UNIT_VALUES = ['km', 'mi'] as const;

export const athleteProfiles = pgTable(
	'athlete_profiles',
	{
		ownerId: uuid('owner_id')
			.primaryKey()
			.references(() => owners.id, { onDelete: 'cascade' }),
		/** What the coach calls the athlete. */
		name: text('name').notNull(),
		weightUnit: text('weight_unit').$type<'kg' | 'lb'>().notNull().default('kg'),
		distanceUnit: text('distance_unit').$type<'km' | 'mi'>().notNull().default('km'),
		/** IANA time zone (validated by the services): the owner's calendar day for weigh-ins. */
		timeZone: text('time_zone').notNull().default('UTC'),
		birthYear: integer('birth_year'),
		nutritionPhase: text('nutrition_phase').$type<NutritionPhase>(),
		targetWeight: weight('target_weight'),
		targetWeightUnit: text('target_weight_unit').$type<'kg' | 'lb'>(),
		targetDate: date('target_date', { mode: 'string' }),
		/** "I don't know my 1RMs": week 1 establishes them with RPE-based sets (PRD §3). */
		baselinesUnknown: boolean('baselines_unknown').notNull().default(false),
		onboardingStep: text('onboarding_step').$type<OnboardingStep>(),
		onboardingCompleted: text('onboarding_completed')
			.array()
			.$type<OnboardingStep[]>()
			.notNull()
			.default(sql`'{}'::text[]`),
		onboardingSkipped: text('onboarding_skipped')
			.array()
			.$type<OnboardingStep[]>()
			.notNull()
			.default(sql`'{}'::text[]`),
		onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		check('athlete_profiles_name_ck', sql`char_length(${t.name}) between 1 and 64`),
		check('athlete_profiles_weight_unit_ck', inList('weight_unit', WEIGHT_UNIT_VALUES)),
		check('athlete_profiles_distance_unit_ck', inList('distance_unit', DISTANCE_UNIT_VALUES)),
		check('athlete_profiles_birth_year_ck', sql`${t.birthYear} between 1900 and 2100`),
		check('athlete_profiles_nutrition_phase_ck', inList('nutrition_phase', NUTRITION_PHASES)),
		check(
			'athlete_profiles_target_weight_ck',
			sql`(${t.targetWeight} is null) = (${t.targetWeightUnit} is null) and (${t.targetWeight} is null or ${t.targetWeight} > 0)`
		)
	]
);

export const bodyWeightEntries = pgTable(
	'body_weight_entries',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: ownerRef(),
		value: weight('value').notNull(),
		unit: text('unit').$type<'kg' | 'lb'>().notNull(),
		measuredOn: date('measured_on', { mode: 'string' }).notNull(),
		/** Where it came from: onboarding, profile, coach, … */
		source: text('source').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		index('body_weight_entries_owner_idx').on(t.ownerId, t.measuredOn.desc(), t.id.desc()),
		check('body_weight_entries_value_ck', sql`${t.value} > 0`),
		check('body_weight_entries_unit_ck', inList('unit', WEIGHT_UNIT_VALUES))
	]
);

export const trainingGoals = pgTable(
	'training_goals',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		kind: text('kind').$type<GoalKind>().notNull(),
		title: text('title').notNull(),
		disciplines: text('disciplines').array().$type<Discipline[]>().notNull(),
		customDiscipline: text('custom_discipline'),
		status: text('status').$type<GoalStatus>().notNull().default('active'),
		/** Rank among open (active/paused) goals: 1 wins when goals compete. */
		priority: integer('priority'),
		// event goals
		eventType: text('event_type'),
		eventDate: date('event_date', { mode: 'string' }),
		weightClass: text('weight_class'),
		targetPerformance: text('target_performance'),
		requirements: text('requirements'),
		// general goals
		focus: text('focus'),
		measure: text('measure'),
		targetDate: date('target_date', { mode: 'string' }),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		/** When the goal was achieved or dropped. */
		closedAt: timestamp('closed_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('training_goals_owner_priority_uq')
			.on(t.ownerId, t.priority)
			.where(sql`${t.priority} is not null`),
		index('training_goals_owner_status_idx').on(t.ownerId, t.status),
		check('training_goals_kind_ck', inList('kind', GOAL_KINDS)),
		check('training_goals_status_ck', inList('status', GOAL_STATUSES)),
		check('training_goals_title_ck', sql`char_length(${t.title}) between 1 and 80`),
		check('training_goals_disciplines_ck', sql`cardinality(${t.disciplines}) >= 1`),
		check(
			'training_goals_priority_ck',
			sql`(${t.status} in ('active', 'paused')) = (${t.priority} is not null) and (${t.priority} is null or ${t.priority} >= 1)`
		),
		check(
			'training_goals_event_ck',
			sql`${t.kind} <> 'event' or (${t.eventType} is not null and ${t.eventDate} is not null)`
		),
		check('training_goals_general_ck', sql`${t.kind} <> 'general' or ${t.focus} is not null`)
	]
);

export const GOAL_CHANGES = [
	'created',
	'updated',
	'reprioritized',
	'status_changed',
	'deleted'
] as const;
export type GoalChange = (typeof GOAL_CHANGES)[number];

/** Append-only history of goals and their ranking (the coach reasons about how goals moved). */
export const trainingGoalEvents = pgTable(
	'training_goal_events',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: ownerRef(),
		/** No foreign key: the history outlives a deleted goal. */
		goalId: uuid('goal_id').notNull(),
		change: text('change').$type<GoalChange>().notNull(),
		/** The goal as it was right after the change (before it, for `deleted`). */
		snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
		/** Who made the change: onboarding, profile, coach. */
		source: text('source').notNull(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('training_goal_events_owner_idx').on(t.ownerId, t.occurredAt.desc()),
		index('training_goal_events_goal_idx').on(t.goalId, t.occurredAt),
		check('training_goal_events_change_ck', inList('change', GOAL_CHANGES))
	]
);

export const disciplineExperience = pgTable(
	'discipline_experience',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		discipline: text('discipline').$type<Discipline>().notNull(),
		/** Name of a `custom` discipline; empty for catalog disciplines. */
		customLabel: text('custom_label').notNull().default(''),
		level: text('level').$type<ExperienceLevel>().notNull(),
		years: tenths('years'),
		sessionsPerWeek: tenths('sessions_per_week'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('discipline_experience_owner_discipline_uq').on(
			t.ownerId,
			t.discipline,
			t.customLabel
		),
		check('discipline_experience_level_ck', inList('level', EXPERIENCE_LEVELS)),
		check('discipline_experience_years_ck', sql`${t.years} is null or ${t.years} >= 0`),
		check(
			'discipline_experience_sessions_ck',
			sql`${t.sessionsPerWeek} is null or ${t.sessionsPerWeek} >= 0`
		)
	]
);

/**
 * Strength baselines: OPTIONAL 1RMs (PRD §3). `kind` says whether the max was lifted
 * (`measured`) or calculated/judged (`estimated`); the database refuses a measured row from an
 * estimating source. A changed baseline supersedes the old row (history is kept).
 */
export const strengthBaselines = pgTable(
	'strength_baselines',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		lift: text('lift').$type<Lift>().notNull(),
		customLabel: text('custom_label').notNull().default(''),
		kind: text('kind').$type<BaselineKind>().notNull(),
		source: text('source').$type<BaselineSource>().notNull(),
		value: weight('value').notNull(),
		unit: text('unit').$type<'kg' | 'lb'>().notNull(),
		achievedOn: date('achieved_on', { mode: 'string' }),
		setWeight: weight('set_weight'),
		setReps: integer('set_reps'),
		setRpe: numeric('set_rpe', { precision: 3, scale: 1, mode: 'number' }),
		method: text('method'),
		confidence: text('confidence').$type<'high' | 'medium' | 'low'>(),
		notes: text('notes'),
		recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
		supersededAt: timestamp('superseded_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('strength_baselines_current_uq')
			.on(t.ownerId, t.lift, t.customLabel)
			.where(sql`${t.supersededAt} is null`),
		index('strength_baselines_owner_idx').on(t.ownerId, t.lift, t.recordedAt.desc()),
		check('strength_baselines_kind_ck', inList('kind', BASELINE_KINDS)),
		check('strength_baselines_source_ck', inList('source', BASELINE_SOURCES)),
		check(
			'strength_baselines_kind_source_ck',
			sql`(${t.kind} = 'measured') = (${t.source} in ('tested', 'competition'))`
		),
		check(
			'strength_baselines_set_ck',
			sql`${t.source} <> 'set' or (${t.setWeight} is not null and ${t.setReps} is not null)`
		),
		check('strength_baselines_value_ck', sql`${t.value} > 0`),
		check('strength_baselines_unit_ck', inList('unit', WEIGHT_UNIT_VALUES))
	]
);

/** A heart-rate CHECK body: `column` within its HEART_RATE_BOUNDS range, inclusive. */
const hrBetween = (column: string, kind: keyof typeof HEART_RATE_BOUNDS) =>
	sql.raw(`${column} between ${HEART_RATE_BOUNDS[kind].min} and ${HEART_RATE_BOUNDS[kind].max}`);

export const runningProfiles = pgTable(
	'running_profiles',
	{
		ownerId: uuid('owner_id')
			.primaryKey()
			.references(() => owners.id, { onDelete: 'cascade' }),
		unit: text('unit').$type<'km' | 'mi'>().notNull(),
		weeklyDistance: numeric('weekly_distance', { precision: 5, scale: 1, mode: 'number' }),
		runsPerWeek: tenths('runs_per_week'),
		longestRun: numeric('longest_run', { precision: 5, scale: 1, mode: 'number' }),
		/** Seconds per `unit`. */
		easyPaceSeconds: integer('easy_pace_seconds'),
		/** Heart rates in whole bpm, each optional (M7 zones read them when they are there). */
		maxHr: smallint('max_hr'),
		restingHr: smallint('resting_hr'),
		thresholdHr: smallint('threshold_hr'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	() => [
		check('running_profiles_unit_ck', inList('unit', DISTANCE_UNIT_VALUES)),
		check('running_profiles_max_hr_ck', hrBetween('max_hr', 'max')),
		check('running_profiles_resting_hr_ck', hrBetween('resting_hr', 'resting')),
		check('running_profiles_threshold_hr_ck', hrBetween('threshold_hr', 'threshold')),
		check(
			'running_profiles_hr_order_ck',
			sql.raw(
				[
					['resting_hr', 'threshold_hr'],
					['threshold_hr', 'max_hr'],
					['resting_hr', 'max_hr']
				]
					.map(([low, high]) => `(${low} is null or ${high} is null or ${low} < ${high})`)
					.join(' and ')
			)
		)
	]
);

export const raceResults = pgTable(
	'race_results',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		distance: text('distance').$type<RaceDistance>().notNull(),
		/** For `other`, in the running profile's unit as entered. */
		customDistance: numeric('custom_distance', { precision: 5, scale: 1, mode: 'number' }),
		distanceMetres: numeric('distance_metres', {
			precision: 8,
			scale: 1,
			mode: 'number'
		}).notNull(),
		timeSeconds: integer('time_seconds').notNull(),
		racedOn: date('raced_on', { mode: 'string' }),
		eventName: text('event_name'),
		createdAt: createdAt()
	},
	(t) => [
		index('race_results_owner_idx').on(t.ownerId, t.distanceMetres),
		check('race_results_time_ck', sql`${t.timeSeconds} > 0`),
		check('race_results_distance_ck', sql`${t.distanceMetres} > 0`)
	]
);

export const muayThaiProfiles = pgTable('muay_thai_profiles', {
	ownerId: uuid('owner_id')
		.primaryKey()
		.references(() => owners.id, { onDelete: 'cascade' }),
	sessionsPerWeek: tenths('sessions_per_week'),
	sparringPerWeek: tenths('sparring_per_week'),
	fights: integer('fights'),
	notes: text('notes'),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const equipmentProfiles = pgTable('equipment_profiles', {
	ownerId: uuid('owner_id')
		.primaryKey()
		.references(() => owners.id, { onDelete: 'cascade' }),
	gymType: text('gym_type').$type<GymType>(),
	equipment: text('equipment')
		.array()
		.$type<Equipment[]>()
		.notNull()
		.default(sql`'{}'::text[]`),
	homeEquipment: text('home_equipment')
		.array()
		.$type<Equipment[]>()
		.notNull()
		.default(sql`'{}'::text[]`),
	notes: text('notes'),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const injuries = pgTable(
	'injuries',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		bodyArea: text('body_area').$type<BodyArea>().notNull(),
		side: text('side').$type<Side>(),
		severity: text('severity').$type<Severity>().notNull(),
		notes: text('notes'),
		/** Movements to avoid, in the owner's words. */
		avoid: text('avoid')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		active: boolean('active').notNull().default(true),
		since: date('since', { mode: 'string' }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true })
	},
	(t) => [
		index('injuries_owner_idx').on(t.ownerId, t.active),
		check('injuries_side_ck', inList('side', SIDES)),
		check('injuries_severity_ck', inList('severity', SEVERITIES))
	]
);

/**
 * The source of a preference that names none: M2 recorded no source, so its rows (backfilled by
 * the migration that adds the column) and every Profile save read as Profile edits.
 */
export const PREFERENCE_SOURCE_DEFAULT = 'profile' satisfies PreferenceSource;

/**
 * Exercise likes and dislikes, in the owner's words, linked to the library when the name matches
 * an exercise: one exercise is liked or disliked once, however the owner names it. Deleting a
 * custom exercise unlinks its preference and keeps the words. Only the owner's explicit choices
 * are stored here; a situational swap stays on its session.
 */
export const exercisePreferences = pgTable(
	'exercise_preferences',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		/** The owner's words. */
		exercise: text('exercise').notNull(),
		/** The library exercise they name; null when nothing matched. */
		exerciseId: uuid('exercise_id').references(() => exercises.id, { onDelete: 'set null' }),
		sentiment: text('sentiment').$type<Sentiment>().notNull(),
		reason: text('reason'),
		/** Where it was recorded: onboarding, Profile, a swap, a workout, the coach. */
		source: text('source').$type<PreferenceSource>().notNull().default(PREFERENCE_SOURCE_DEFAULT),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('exercise_preferences_owner_exercise_uq').on(t.ownerId, sql`lower(${t.exercise})`),
		uniqueIndex('exercise_preferences_owner_exercise_id_uq')
			.on(t.ownerId, t.exerciseId)
			.where(sql`${t.exerciseId} is not null`),
		check('exercise_preferences_sentiment_ck', inList('sentiment', SENTIMENTS)),
		check('exercise_preferences_exercise_ck', sql`char_length(${t.exercise}) between 1 and 80`),
		check('exercise_preferences_source_ck', inList('source', PREFERENCE_SOURCES))
	]
);

export const schedules = pgTable(
	'schedules',
	{
		ownerId: uuid('owner_id')
			.primaryKey()
			.references(() => owners.id, { onDelete: 'cascade' }),
		daysPerWeek: integer('days_per_week'),
		availableDays: text('available_days')
			.array()
			.$type<Weekday[]>()
			.notNull()
			.default(sql`'{}'::text[]`),
		preferredTimes: text('preferred_times')
			.array()
			.$type<TimeOfDay[]>()
			.notNull()
			.default(sql`'{}'::text[]`),
		sessionMinutes: integer('session_minutes'),
		constraints: text('constraints'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		check('schedules_days_per_week_ck', sql`${t.daysPerWeek} between 1 and 7`),
		check('schedules_session_minutes_ck', sql`${t.sessionMinutes} between 10 and 300`)
	]
);

/** Fixed commitments the plan must work around, e.g. Muay Thai classes Tue/Thu evenings. */
export const scheduleCommitments = pgTable(
	'schedule_commitments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		discipline: text('discipline').$type<Discipline>().notNull(),
		label: text('label').notNull(),
		days: text('days').array().$type<Weekday[]>().notNull(),
		timeOfDay: text('time_of_day').$type<TimeOfDay>(),
		durationMinutes: integer('duration_minutes'),
		intensity: text('intensity').$type<Intensity>(),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('schedule_commitments_owner_idx').on(t.ownerId),
		check('schedule_commitments_days_ck', sql`cardinality(${t.days}) >= 1`),
		check('schedule_commitments_intensity_ck', inList('intensity', INTENSITIES))
	]
);
