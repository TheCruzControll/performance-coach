/**
 * Validation for every training-profile write (PRD §2, §3) — ONE set of schemas shared by the
 * client forms (instant, inline errors) and the services (the authority; the coach in M5 calls
 * the same services). Built on `zod/mini`: the functional API tree-shakes to ~9 KB gzip, so the
 * browser can load it on demand without touching any route's initial-JS budget.
 *
 * Conventions: blank text becomes `null`; numbers are numbers or `null` (never strings); dates
 * are ISO `YYYY-MM-DD`; messages are written for the owner, not for developers.
 */
import * as z from 'zod/mini';
import { estimateOneRepMax } from '../e1rm';
import {
	BASELINE_SOURCES,
	BODY_AREAS,
	DISCIPLINES,
	DISTANCE_UNITS,
	EQUIPMENT,
	EXPERIENCE_LEVELS,
	GOAL_STATUSES,
	GYM_TYPES,
	INTENSITIES,
	LIFTS,
	NUTRITION_PHASES,
	RACE_DISTANCES,
	SENTIMENTS,
	SEVERITIES,
	SIDES,
	TIMES_OF_DAY,
	WEEKDAYS,
	WEIGHT_UNITS
} from './catalog';

// ---- building blocks -------------------------------------------------------------------------

/** Required, trimmed text. */
const words = (max: number, required: string) =>
	z
		.string(required)
		.check(z.trim(), z.minLength(1, required), z.maxLength(max, `Keep it under ${max} characters`));

/** Optional, trimmed text: blank → null. */
const optWords = (max: number) =>
	z.pipe(
		z.nullish(z.string().check(z.trim(), z.maxLength(max, `Keep it under ${max} characters`))),
		z.transform((v) => (v ? v : null))
	);

/** A finite number within bounds. */
const between = (min: number, max: number, message: string) =>
	z.number(message).check(z.minimum(min, message), z.maximum(max, message));

const wholeBetween = (min: number, max: number, message: string) =>
	z.int(message).check(z.minimum(min, message), z.maximum(max, message));

/** Optional number: undefined → null. */
const opt = <T extends z.ZodMiniType>(schema: T) =>
	z.pipe(
		z.nullish(schema),
		z.transform((v) => (v ?? null) as z.output<T> | null)
	);

const isoDate = (message = 'Use a real date') =>
	z.iso.date(message).check(z.refine((d) => d >= '1900-01-01' && d <= '2100-12-31', message));

const optDate = (message?: string) => opt(isoDate(message));

/**
 * Cross-field rules normally run only when every field parsed; with this they run anyway, so the
 * owner sees every problem at once. Such rules must read fields defensively.
 */
const always = {
	when: (payload: { value: unknown }) => typeof payload.value === 'object' && payload.value !== null
};

const uniqueBy = <T>(items: T[], key: (item: T) => string) =>
	new Set(items.map(key)).size === items.length;

// ---- basics (welcome step) -------------------------------------------------------------------

export const basicsSchema = z.object({
	name: words(64, 'Tell your coach what to call you'),
	weightUnit: z.enum(WEIGHT_UNITS, 'Pick kg or lb'),
	distanceUnit: z.enum(DISTANCE_UNITS, 'Pick km or mi')
});
export type BasicsInput = z.input<typeof basicsSchema>;
export type Basics = z.output<typeof basicsSchema>;

// ---- goals -----------------------------------------------------------------------------------

const goalCommon = {
	title: words(80, 'Give this goal a name'),
	disciplines: z.array(z.enum(DISCIPLINES, 'Pick a discipline')).check(
		z.minLength(1, 'Pick at least one discipline'),
		z.maxLength(DISCIPLINES.length, 'Too many disciplines'),
		z.refine((list) => new Set(list).size === list.length, 'Each discipline once')
	),
	customDiscipline: optWords(40),
	status: z.optional(z.enum(GOAL_STATUSES, 'Pick a status')),
	notes: optWords(500)
};

export const eventGoalSchema = z.object({
	kind: z.literal('event'),
	...goalCommon,
	eventType: words(60, 'What kind of event is it?'),
	eventDate: isoDate('Pick the event date'),
	weightClass: optWords(40),
	targetPerformance: optWords(200),
	requirements: optWords(500)
});

export const generalGoalSchema = z.object({
	kind: z.literal('general'),
	...goalCommon,
	focus: words(200, 'What do you want to improve?'),
	measure: words(200, 'How will you know it’s working?'),
	targetDate: optDate()
});

export const goalSchema = z
	.discriminatedUnion(
		'kind',
		[eventGoalSchema, generalGoalSchema],
		'Pick an event or a general goal'
	)
	.check(
		z.superRefine((goal, ctx) => {
			const disciplines: unknown = goal.disciplines;
			if (Array.isArray(disciplines) && disciplines.includes('custom') && !goal.customDiscipline) {
				ctx.addIssue({
					code: 'custom',
					message: 'Name your custom discipline',
					path: ['customDiscipline'],
					input: goal.customDiscipline
				});
			}
		}, always)
	);
export type GoalInput = z.input<typeof goalSchema>;
export type GoalData = z.output<typeof goalSchema>;

export const goalOrderSchema = z.object({
	ids: z.array(z.uuid('Unknown goal')).check(
		z.minLength(1, 'Nothing to reorder'),
		z.maxLength(50, 'Too many goals'),
		z.refine((ids) => new Set(ids).size === ids.length, 'Each goal once')
	)
});

export const goalStatusSchema = z.object({ status: z.enum(GOAL_STATUSES, 'Pick a status') });

// ---- experience ------------------------------------------------------------------------------

export const experienceEntrySchema = z.object({
	discipline: z.enum(DISCIPLINES, 'Pick a discipline'),
	customLabel: optWords(40),
	level: z.enum(EXPERIENCE_LEVELS, 'Pick your level'),
	years: opt(between(0, 60, 'Years between 0 and 60')),
	sessionsPerWeek: opt(between(0, 21, 'Sessions per week between 0 and 21')),
	notes: optWords(300)
});

export const experienceSchema = z
	.object({ entries: z.array(experienceEntrySchema).check(z.maxLength(20, 'Too many entries')) })
	.check(
		z.superRefine(({ entries }, ctx) => {
			entries.forEach((entry, i) => {
				if (entry.discipline === 'custom' && !entry.customLabel) {
					ctx.addIssue({
						code: 'custom',
						message: 'Name this discipline',
						path: ['entries', i, 'customLabel'],
						input: entry.customLabel
					});
				}
			});
			if (!uniqueBy(entries, (e) => `${e.discipline}:${(e.customLabel ?? '').toLowerCase()}`)) {
				ctx.addIssue({
					code: 'custom',
					message: 'Each discipline once',
					path: ['entries'],
					input: entries
				});
			}
		})
	);
export type ExperienceInput = z.input<typeof experienceSchema>;
export type ExperienceData = z.output<typeof experienceSchema>;

// ---- strength baselines ----------------------------------------------------------------------

const ONE_RM_RANGE = { kg: [1, 500], lb: [2, 1100] } as const;

export const baselineEntrySchema = z
	.object({
		lift: z.enum(LIFTS, 'Pick a lift'),
		customLabel: optWords(40),
		source: z.enum(BASELINE_SOURCES, 'How do you know this number?'),
		/** The 1RM (tested, competition, best guess). For `set` it is computed, never trusted. */
		value: opt(z.number('Enter a weight')),
		unit: z.enum(WEIGHT_UNITS, 'Pick kg or lb'),
		achievedOn: optDate(),
		setWeight: opt(z.number('Enter the weight you lifted')),
		setReps: opt(wholeBetween(1, 20, 'Reps between 1 and 20')),
		setRpe: opt(between(6, 10, 'RPE between 6 and 10')),
		notes: optWords(200)
	})
	.check(
		z.superRefine((entry, ctx) => {
			const [min, max] = ONE_RM_RANGE[entry.unit];
			const outOfRange = (v: number) => v < min || v > max;
			if (entry.lift === 'custom' && !entry.customLabel) {
				ctx.addIssue({
					code: 'custom',
					message: 'Name the lift',
					path: ['customLabel'],
					input: entry.customLabel
				});
			}
			if (entry.source === 'set') {
				if (entry.setWeight == null || outOfRange(entry.setWeight)) {
					ctx.addIssue({
						code: 'custom',
						message: `Weight between ${min} and ${max} ${entry.unit}`,
						path: ['setWeight'],
						input: entry.setWeight
					});
				}
				if (entry.setReps == null) {
					ctx.addIssue({
						code: 'custom',
						message: 'How many reps?',
						path: ['setReps'],
						input: entry.setReps
					});
				}
				if (entry.setRpe != null && (entry.setRpe * 2) % 1 !== 0) {
					ctx.addIssue({
						code: 'custom',
						message: 'RPE in half steps (e.g. 8 or 8.5)',
						path: ['setRpe'],
						input: entry.setRpe
					});
				}
				if (
					entry.setWeight != null &&
					entry.setReps != null &&
					!outOfRange(entry.setWeight) &&
					!estimateOneRepMax({ weight: entry.setWeight, reps: entry.setReps, rpe: entry.setRpe })
				) {
					ctx.addIssue({
						code: 'custom',
						message: 'Can’t estimate from that set — use 1–12 reps at RPE 6–10',
						path: ['setReps'],
						input: entry.setReps
					});
				}
			} else if (entry.value == null || outOfRange(entry.value)) {
				ctx.addIssue({
					code: 'custom',
					message: `1RM between ${min} and ${max} ${entry.unit}`,
					path: ['value'],
					input: entry.value
				});
			}
		})
	);

export const baselinesSchema = z
	.object({
		/** "I don't know my 1RMs": week 1 establishes them with RPE-based sets. */
		unknown: z.boolean(),
		lifts: z.array(baselineEntrySchema).check(z.maxLength(20, 'Too many lifts'))
	})
	.check(
		z.superRefine(({ unknown, lifts }, ctx) => {
			if (unknown && lifts.length > 0) {
				ctx.addIssue({
					code: 'custom',
					message: 'Clear your lifts, or untick “I don’t know my 1RMs”',
					path: ['lifts'],
					input: lifts
				});
			}
			if (!uniqueBy(lifts, (l) => `${l.lift}:${(l.customLabel ?? '').toLowerCase()}`)) {
				ctx.addIssue({
					code: 'custom',
					message: 'Each lift once',
					path: ['lifts'],
					input: lifts
				});
			}
		})
	);
export type BaselineEntryInput = z.input<typeof baselineEntrySchema>;
export type BaselinesInput = z.input<typeof baselinesSchema>;
export type BaselinesData = z.output<typeof baselinesSchema>;

// ---- running & Muay Thai ---------------------------------------------------------------------

export const raceResultSchema = z
	.object({
		distance: z.enum(RACE_DISTANCES, 'Pick a distance'),
		/** Only for `other`, in the running profile's distance unit. */
		customDistance: opt(between(0.1, 400, 'Distance between 0.1 and 400')),
		timeSeconds: wholeBetween(60, 7 * 24 * 3600, 'Enter your time as h:mm:ss or mm:ss'),
		racedOn: optDate(),
		eventName: optWords(80)
	})
	.check(
		z.superRefine((race, ctx) => {
			if (race.distance === 'other' && typeof race.customDistance !== 'number') {
				ctx.addIssue({
					code: 'custom',
					message: 'How far was it?',
					path: ['customDistance'],
					input: race.customDistance
				});
			}
		}, always)
	);

export const runningSchema = z.object({
	unit: z.enum(DISTANCE_UNITS, 'Pick km or mi'),
	weeklyDistance: opt(between(0, 500, 'Weekly distance between 0 and 500')),
	runsPerWeek: opt(between(0, 21, 'Runs per week between 0 and 21')),
	longestRun: opt(between(0, 400, 'Longest run between 0 and 400')),
	/** Seconds per distance unit. */
	easyPaceSeconds: opt(wholeBetween(120, 1500, 'Easy pace between 2:00 and 25:00')),
	races: z.array(raceResultSchema).check(z.maxLength(20, 'Too many races')),
	notes: optWords(300)
});

export const muayThaiSchema = z.object({
	sessionsPerWeek: opt(between(0, 21, 'Sessions per week between 0 and 21')),
	sparringPerWeek: opt(between(0, 14, 'Sparring sessions between 0 and 14')),
	fights: opt(wholeBetween(0, 500, 'Fights between 0 and 500')),
	notes: optWords(300)
});

export const specificsSchema = z.object({
	running: z.nullable(runningSchema),
	muayThai: z.nullable(muayThaiSchema)
});
export type RunningInput = z.input<typeof runningSchema>;
export type MuayThaiInput = z.input<typeof muayThaiSchema>;
export type SpecificsInput = z.input<typeof specificsSchema>;
export type SpecificsData = z.output<typeof specificsSchema>;

// ---- equipment -------------------------------------------------------------------------------

const equipmentList = z
	.array(z.enum(EQUIPMENT, 'Unknown equipment'))
	.check(z.refine((list) => new Set(list).size === list.length, 'Each item once'));

export const equipmentSchema = z.object({
	gymType: z.nullable(z.enum(GYM_TYPES, 'Pick where you train')),
	equipment: equipmentList,
	homeEquipment: equipmentList,
	notes: optWords(300)
});
export type EquipmentInput = z.input<typeof equipmentSchema>;
export type EquipmentData = z.output<typeof equipmentSchema>;

// ---- injuries & limitations ------------------------------------------------------------------

export const injurySchema = z.object({
	id: opt(z.uuid()),
	bodyArea: z.enum(BODY_AREAS, 'Where is it?'),
	side: z.nullable(z.enum(SIDES, 'Pick a side')),
	severity: z.enum(SEVERITIES, 'How bad is it?'),
	notes: optWords(300),
	avoid: z
		.array(words(60, 'Name the movement'))
		.check(z.maxLength(12, 'Up to 12 movements per injury')),
	active: z.boolean(),
	since: optDate()
});

export const injuriesSchema = z.object({
	injuries: z.array(injurySchema).check(z.maxLength(20, 'Too many injuries'))
});
export type InjuryInput = z.input<typeof injurySchema>;
export type InjuriesInput = z.input<typeof injuriesSchema>;
export type InjuriesData = z.output<typeof injuriesSchema>;

// ---- exercise likes & dislikes ---------------------------------------------------------------

export const exercisePreferenceSchema = z.object({
	exercise: words(80, 'Name the exercise'),
	sentiment: z.enum(SENTIMENTS, 'Like or dislike?'),
	reason: optWords(200)
});

export const exercisePreferencesSchema = z
	.object({
		items: z.array(exercisePreferenceSchema).check(z.maxLength(60, 'Up to 60 exercises'))
	})
	.check(
		z.superRefine(({ items }, ctx) => {
			if (!uniqueBy(items, (i) => i.exercise.toLowerCase())) {
				ctx.addIssue({
					code: 'custom',
					message: 'Each exercise once — it can’t be liked and disliked',
					path: ['items'],
					input: items
				});
			}
		})
	);
export type ExercisePreferencesInput = z.input<typeof exercisePreferencesSchema>;
export type ExercisePreferencesData = z.output<typeof exercisePreferencesSchema>;

// ---- schedule & availability -----------------------------------------------------------------

const weekdays = z
	.array(z.enum(WEEKDAYS, 'Unknown day'))
	.check(z.refine((days) => new Set(days).size === days.length, 'Each day once'));

export const commitmentSchema = z.object({
	id: opt(z.uuid()),
	discipline: z.enum(DISCIPLINES, 'Pick a discipline'),
	label: words(60, 'Name the commitment'),
	days: weekdays.check(z.minLength(1, 'Pick at least one day')),
	timeOfDay: z.nullable(z.enum(TIMES_OF_DAY, 'Pick a time')),
	durationMinutes: opt(wholeBetween(10, 300, 'Between 10 and 300 minutes')),
	intensity: z.nullable(z.enum(INTENSITIES, 'Pick an intensity')),
	notes: optWords(200)
});

export const scheduleSchema = z
	.object({
		daysPerWeek: opt(wholeBetween(1, 7, 'Between 1 and 7 days')),
		availableDays: weekdays,
		preferredTimes: z
			.array(z.enum(TIMES_OF_DAY, 'Unknown time'))
			.check(z.refine((t) => new Set(t).size === t.length, 'Each time once')),
		sessionMinutes: opt(wholeBetween(10, 300, 'Between 10 and 300 minutes')),
		constraints: optWords(500),
		commitments: z.array(commitmentSchema).check(z.maxLength(20, 'Too many commitments'))
	})
	.check(
		z.superRefine((s, ctx) => {
			const days: unknown = s.availableDays;
			if (typeof s.daysPerWeek === 'number' && Array.isArray(days) && days.length > 0) {
				if (s.daysPerWeek > s.availableDays.length) {
					ctx.addIssue({
						code: 'custom',
						message: `You picked ${s.availableDays.length} available ${
							s.availableDays.length === 1 ? 'day' : 'days'
						} — fewer than ${s.daysPerWeek} sessions`,
						path: ['daysPerWeek'],
						input: s.daysPerWeek
					});
				}
			}
		}, always)
	);
export type CommitmentInput = z.input<typeof commitmentSchema>;
export type ScheduleInput = z.input<typeof scheduleSchema>;
export type ScheduleData = z.output<typeof scheduleSchema>;

// ---- body & nutrition ------------------------------------------------------------------------

const BODY_WEIGHT_RANGE: Record<string, readonly [number, number]> = {
	kg: [25, 350],
	lb: [55, 770]
};

const birthYearRange = () => {
	const year = new Date().getFullYear();
	return [year - 100, year - 10] as const;
};

export const bodySchema = z
	.object({
		birthYear: opt(
			z.int('Enter a year').check(
				z.refine(
					(y) => {
						const [min, max] = birthYearRange();
						return y >= min && y <= max;
					},
					{ error: () => `A year between ${birthYearRange().join(' and ')}` }
				)
			)
		),
		weightUnit: z.enum(WEIGHT_UNITS, 'Pick kg or lb'),
		bodyWeight: opt(z.number('Enter your body weight')),
		nutritionPhase: z.nullable(z.enum(NUTRITION_PHASES, 'Pick a phase')),
		targetWeight: opt(z.number('Enter a target weight')),
		targetDate: optDate()
	})
	.check(
		z.superRefine((b, ctx) => {
			const range = BODY_WEIGHT_RANGE[String(b.weightUnit)];
			if (!range) return;
			const [min, max] = range;
			for (const key of ['bodyWeight', 'targetWeight'] as const) {
				const v: unknown = b[key];
				if (typeof v === 'number' && (v < min || v > max)) {
					ctx.addIssue({
						code: 'custom',
						message: `Between ${min} and ${max} ${b.weightUnit}`,
						path: [key],
						input: v
					});
				}
			}
		}, always)
	);
export type BodyInput = z.input<typeof bodySchema>;
export type BodyData = z.output<typeof bodySchema>;

// ---- results ---------------------------------------------------------------------------------

/** Field path → first message, e.g. `{ 'entries.0.level': 'Pick your level' }`. */
export type FieldErrors = Record<string, string>;

export type Validated<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

/** Validate with a shared schema; errors keyed by dotted path (root errors under `''`). */
export function validate<S extends z.ZodMiniType>(
	schema: S,
	input: unknown
): Validated<z.output<S>> {
	const result = z.safeParse(schema, input);
	if (result.success) return { ok: true, data: result.data };
	const errors: FieldErrors = {};
	for (const issue of result.error.issues) {
		const key = issue.path.map(String).join('.');
		errors[key] ??= issue.message;
	}
	return { ok: false, errors };
}

export const SCHEMAS = {
	basics: basicsSchema,
	goal: goalSchema,
	experience: experienceSchema,
	baselines: baselinesSchema,
	specifics: specificsSchema,
	equipment: equipmentSchema,
	injuries: injuriesSchema,
	exercises: exercisePreferencesSchema,
	schedule: scheduleSchema,
	body: bodySchema
} as const;
export type SchemaName = keyof typeof SCHEMAS;
