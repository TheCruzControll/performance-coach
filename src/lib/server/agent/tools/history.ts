/**
 * The coach's history tools (PRD §4, §9; the M5 plan's tools-history): what the owner did, as
 * compact facts with their sources, read through the services History uses, owner-scoped by the
 * session's owner, so someone else's ids read as NOT_FOUND or as nothing.
 *
 * - get_training_history: the days from `from` to `to` (the last TRAINING_HISTORY_DAYS by
 *   default): the sessions the active version planned, with their status, and the completed
 *   workouts logged, newest first.
 * - get_exercise_history: one exercise's sets, newest first, a page at a time (M4's
 *   getExerciseHistory, the exercise-history sheet's read), with its records and its e1RM trend
 *   as Progress's exercise detail gives them (getExerciseAnalytics).
 * - get_running_history: weekly running distance (M3's getWeeklyMileage) and the runs behind it.
 * - get_recent_workouts: History's list of completed workouts, a page at a time, or with `id` one
 *   workout's summary as History's detail shows it (getWorkoutDetail).
 * - get_personal_records: the best e1RM (always an estimate), the rep maxes and the PR timeline of
 *   one exercise, or of every exercise that has any, PERSONAL_RECORDS_PAGE exercises at a time.
 *
 * Records and PRs are M6's (services/analytics/records.ts), the strength dashboard's own: only
 * completed, undeleted workouts count, so a set in an abandoned workout is never a record.
 *
 * An exercise is named by its id or by its name, which M3's resolver matches exactly (aliases,
 * plurals and case aside). A name it cannot match to one exercise is AMBIGUOUS with the library's
 * exercises whose names contain it as candidates (the model asks again by id), or NOT_FOUND when
 * none does. Workouts are cited and looked up by the id History opens (the client id).
 *
 * Stored free text (titles, notes, the owner's exercise names) travels as untrusted_text.
 */
import * as z from 'zod/mini';
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import { localDay } from '../../../domain/dates.ts';
import { normaliseExerciseName } from '../../../domain/exercises/match.ts';
import { DEFAULT_PERIOD, PERIODS } from '../../../domain/analytics/periods.ts';
import { STRENGTH_PR_LABEL, type StrengthPr } from '../../../domain/analytics/strength.ts';
import { PR_KIND_LABEL } from '../../../domain/workout/logging.ts';
import { OTHER_SESSION_KINDS, SESSION_STATUSES } from '../../../domain/training/vocabulary.ts';
import { getExerciseAnalytics } from '../../services/analytics/exercise.ts';
import { metricAbout, trendCall } from '../../services/analytics/index.ts';
import { getStrengthRecords, type LiftRecords } from '../../services/analytics/records.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import {
	getExercisesByIds,
	listExercises,
	resolveExerciseName,
	type ExerciseDef
} from '../../services/exercises/index.ts';
import { isUuid } from '../../services/ids.ts';
import {
	getSessionsInRange,
	getWeeklyMileage,
	ZONE_SLACK_MS,
	type HistorySet
} from '../../services/training/history.ts';
import {
	getExerciseHistory,
	getWorkoutDetail,
	listWorkouts,
	MAX_WORKOUT_PAGE,
	type WorkoutListItem
} from '../../services/workouts/history.ts';
import { aboutSchema, dashboardSchema, trendCallShape } from './analytics.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import {
	metric,
	metricSchema,
	PAGE_MAX,
	sourceRefSchema,
	toolError,
	untrusted,
	untrustedSchema
} from './output.ts';

/** Decision: the days get_training_history reads when the model does not say, and the most. */
export const TRAINING_HISTORY_DAYS = Object.freeze({ default: 14, max: 28 });
/** Decision: the weeks get_running_history reads when the model does not say, and the most. */
export const RUNNING_HISTORY_WEEKS = Object.freeze({ default: 8, max: 12 });
/** Decision: workouts per get_recent_workouts page, and sets per get_exercise_history page. */
export const RECENT_WORKOUTS_LIMIT = Object.freeze({ default: 10, max: PAGE_MAX });
export const EXERCISE_SETS_LIMIT = Object.freeze({ default: PAGE_MAX, max: PAGE_MAX });
/** Exercises per get_personal_records page: ten rep maxes each keep a page under the cap. */
export const PERSONAL_RECORDS_PAGE = 5;
/** Decision: the newest PRs each get_personal_records item lists; prCount counts them all. */
export const PRS_PER_EXERCISE = 5;
/** The most candidates an AMBIGUOUS exercise name lists, shortest name first. */
export const EXERCISE_CANDIDATES_MAX = 8;
/**
 * History pages (MAX_WORKOUT_PAGE workouts each) a date-range read scans for completed workouts,
 * starting at the range's last day: 200 workouts, more than twelve weeks of daily training. A
 * range it cannot finish says so.
 */
const SCAN_PAGES = 4;
const NAME_MAX = 100;

type Ctx = ToolContext<ResolvedCoachDeps>;
const training = (ctx: Ctx) => ({ db: ctx.deps.db, now: ctx.deps.now });
const whole = (min: number, max: number) => z.int().check(z.minimum(min), z.maximum(max));
const isoDate = z.iso.date();
const truncated = z.optional(z.literal(true));

const exerciseRef = (e: { id: string }): SourceRef => ({ type: 'exercise', id: e.id });
const workoutRef = (id: string, date: IsoDate): SourceRef => ({ type: 'workout', id, date });
const setRef = (
	set: Pick<HistorySet, 'performedAt'> & { id: string | number },
	timeZone: string
): SourceRef => ({
	type: 'set',
	id: String(set.id),
	date: localDay(set.performedAt, timeZone)
});

// ---- exercises by id or name ----------------------------------------------------------------

const exerciseInput = z.string().check(z.minLength(1), z.maxLength(NAME_MAX));

/** The one exercise `text` names (an id, or a name M3's resolver matches), or a tool error. */
export async function resolveExercise(ctx: Ctx, text: string): Promise<ExerciseDef> {
	if (isUuid(text)) {
		const found = (await getExercisesByIds(ctx.ownerId, [text], training(ctx))).get(text);
		if (!found) throw toolError('NOT_FOUND', 'You have no exercise with that id');
		return found;
	}
	const named = await resolveExerciseName(ctx.ownerId, text, training(ctx));
	if (named) return named;
	const wanted = normaliseExerciseName(text);
	const library = wanted ? await listExercises(ctx.ownerId, {}, training(ctx)) : [];
	const candidates = library
		.filter((e) => [e.name, ...e.aliases].some((n) => normaliseExerciseName(n).includes(wanted)))
		// The closest first: the shortest names hold the least besides the text.
		.sort((a, b) => a.name.length - b.name.length)
		.slice(0, EXERCISE_CANDIDATES_MAX)
		.map((e) => ({ id: e.id, name: untrusted(e.name) }));
	if (candidates.length === 0)
		throw toolError('NOT_FOUND', 'No exercise in the library has that name');
	throw toolError(
		'AMBIGUOUS',
		'That name does not match one exercise; ask again with one candidate’s id',
		{ candidates }
	);
}

// ---- records: get_exercise_history and get_personal_records ---------------------------------

const recordsSchema = z.object({
	/** Always an estimate from one set, never a measured max. */
	bestE1rm: z.nullable(z.extend(metricSchema, { confidence: z.enum(['high', 'medium', 'low']) })),
	repMaxes: z.array(z.object({ reps: z.int(), weightKg: z.number(), source: sourceRefSchema }))
});

/** A lift's records, or none. */
const NO_RECORDS = { bestE1rm: null, repMaxes: [] };

function recordsOut(
	r: Pick<LiftRecords, 'bestE1rm' | 'repMaxes'>,
	timeZone: string
): z.input<typeof recordsSchema> {
	const best = r.bestE1rm;
	return {
		bestE1rm: best && {
			...metric({
				value: best.value,
				unit: 'kg',
				method: `estimated 1RM from one set (${best.method})`,
				sources: [setRef(best.set, timeZone)]
			}),
			confidence: best.confidence
		},
		repMaxes: r.repMaxes.map(({ reps, weightKg, set }) => ({
			reps,
			weightKg,
			source: setRef(set, timeZone)
		}))
	};
}

const setSchema = z.object({
	source: sourceRefSchema,
	weight: z.nullable(z.number()),
	unit: z.enum(['kg', 'lb']),
	weightKg: z.nullable(z.number()),
	reps: z.nullable(z.int()),
	seconds: z.nullable(z.number()),
	metres: z.nullable(z.number()),
	rpe: z.nullable(z.number()),
	warmup: z.boolean(),
	skipped: z.boolean()
});

/** The lift's e1RM over a period, as Progress's exercise detail gives it, with its verdict. */
const e1rmTrendSchema = z.object({
	/** The period's best e1RM in kg (an estimate); null until the lift has enough sessions. */
	value: z.nullable(z.number()),
	shown: z.nullable(z.string()),
	unit: z.literal('kg'),
	comparison: z.string(),
	about: aboutSchema,
	...trendCallShape,
	dashboard: dashboardSchema
});

const prSummarySchema = z.object({
	kind: z.enum(Object.keys(STRENGTH_PR_LABEL) as [keyof typeof STRENGTH_PR_LABEL]),
	label: z.string(),
	reps: z.nullable(z.int()),
	/** kg, or reps for most_reps; an e1RM is an estimate. */
	value: z.number(),
	estimated: z.boolean(),
	previous: z.object({ value: z.number(), date: isoDate }),
	source: sourceRefSchema
});

const prOut = (pr: StrengthPr): z.input<typeof prSummarySchema> => ({
	kind: pr.kind,
	label: pr.label,
	reps: pr.reps,
	value: pr.value,
	estimated: pr.estimated,
	previous: { value: pr.previous.value, date: pr.previous.on },
	source:
		pr.setId === null ? workoutRef(pr.workoutId, pr.on) : { type: 'set', id: pr.setId, date: pr.on }
});

const getExerciseHistoryTool = defineTool({
	name: 'get_exercise_history',
	description: `One exercise's logged sets, newest first, warm-ups and skipped sets flagged, ${EXERCISE_SETS_LIMIT.default} at a time unless limit says otherwise, with its records from completed workouts (the best estimated 1RM, an estimate and never a measured max, and the heaviest load at each rep count) and e1rmTrend: the period's best e1RM (${DEFAULT_PERIOD} unless period says otherwise) with Progress's verdict, real_trend or normal_variation over window, which is the only basis for calling it either. Name the exercise by its id from an earlier result or by its name; a name that matches no single exercise is an AMBIGUOUS error listing candidates to ask again with. Give before (the previous result's next) for older sets.`,
	input: z.object({
		exercise: exerciseInput,
		before: z.optional(whole(1, Number.MAX_SAFE_INTEGER)),
		limit: z.optional(whole(1, EXERCISE_SETS_LIMIT.max)),
		period: z.optional(z.enum(PERIODS))
	}),
	output: z.object({
		exercise: z.object({ source: sourceRefSchema, name: untrustedSchema }),
		records: recordsSchema,
		e1rmTrend: e1rmTrendSchema,
		sets: z.array(setSchema).check(z.maxLength(PAGE_MAX)),
		more: z.boolean(),
		next: z.nullable(z.int()),
		truncated
	}),
	run: async ({ exercise, before, limit, period = DEFAULT_PERIOD }, ctx: Ctx) => {
		const found = await resolveExercise(ctx, exercise);
		const page = { before, limit: limit ?? EXERCISE_SETS_LIMIT.default };
		const history = await getExerciseHistory(ctx.ownerId, found.id, page, training(ctx));
		if (!history) throw toolError('NOT_FOUND', 'You have no exercise with that id');
		const { db } = ctx.deps;
		const today = ctx.today as IsoDate;
		const [records] = await getStrengthRecords(db, ctx.ownerId, { today, exerciseId: found.id });
		const { e1rm } = await getExerciseAnalytics(db, ctx.ownerId, found.id, { period, today });
		return {
			exercise: { source: exerciseRef(found), name: untrusted(found.name) },
			records: recordsOut(records ?? NO_RECORDS, ctx.timeZone),
			e1rmTrend: {
				value: e1rm.value?.value ?? null,
				shown: e1rm.value?.text ?? null,
				unit: 'kg' as const,
				comparison: e1rm.comparison.words,
				about: metricAbout('e1rm'),
				...trendCall(e1rm.trend),
				dashboard: `/progress/exercises/${encodeURIComponent(found.id)}?period=${period}`
			},
			sets: history.sets.map((s) => ({
				source: setRef(s, ctx.timeZone),
				weight: s.weight,
				unit: s.unit,
				weightKg: s.weightKg,
				reps: s.reps,
				seconds: s.seconds,
				metres: s.metres,
				rpe: s.rpe,
				warmup: s.isWarmup,
				skipped: s.isSkipped
			})),
			more: history.next !== null,
			next: history.next
		};
	}
});

const getPersonalRecordsTool = defineTool({
	name: 'get_personal_records',
	description: `The owner's records, as Progress shows them, from completed workouts only: for each exercise, the best estimated 1RM (an estimate, never a measured max), the heaviest load lifted at each rep count from 1 to 10, and its newest PRs (e1RM, rep max, most reps and session volume, each with the record it beat; prCount counts them all), each citing the set or workout it came from. Name one exercise (its id or name), or leave exercise out for every exercise with a record, by name, ${PERSONAL_RECORDS_PAGE} at a time; give from (the previous result's next) for the next ones.`,
	input: z.object({
		exercise: z.optional(exerciseInput),
		from: z.optional(whole(0, Number.MAX_SAFE_INTEGER))
	}),
	output: z.object({
		items: z
			.array(
				z.extend(recordsSchema, {
					exercise: sourceRefSchema,
					name: untrustedSchema,
					prs: z.array(prSummarySchema).check(z.maxLength(PRS_PER_EXERCISE)),
					prCount: z.int()
				})
			)
			.check(z.maxLength(PERSONAL_RECORDS_PAGE)),
		more: z.boolean(),
		next: z.nullable(z.int()),
		truncated
	}),
	run: async ({ exercise, from = 0 }, ctx: Ctx) => {
		const one = exercise === undefined ? undefined : await resolveExercise(ctx, exercise);
		const all: LiftRecords[] = await getStrengthRecords(ctx.deps.db, ctx.ownerId, {
			today: ctx.today as IsoDate,
			exerciseId: one?.id
		});
		const shown = all.slice(from, from + PERSONAL_RECORDS_PAGE);
		const more = all.length > from + shown.length;
		return {
			items: shown.map((r) => ({
				exercise: exerciseRef({ id: r.exerciseId }),
				name: untrusted(r.name),
				...recordsOut(r, ctx.timeZone),
				prs: r.prs.slice(0, PRS_PER_EXERCISE).map(prOut),
				prCount: r.prs.length
			})),
			more,
			next: more ? from + shown.length : null
		};
	}
});

// ---- workouts: get_recent_workouts, get_training_history and get_running_history ------------

const workoutItemSchema = z.object({
	source: sourceRefSchema,
	date: isoDate,
	kind: z.enum(['strength', 'run', 'other']),
	title: untrustedSchema,
	planned: z.boolean(),
	durationSeconds: z.nullable(z.number()),
	sessionRpe: z.nullable(z.number()),
	sessionLoad: z.nullable(z.number()),
	strength: z.nullable(z.object({ sets: z.int(), exercises: z.int() })),
	run: z.nullable(
		z.object({
			distanceMetres: z.nullable(z.number()),
			durationSeconds: z.nullable(z.number()),
			paceSecondsPerKm: z.nullable(z.number())
		})
	),
	other: z.nullable(z.object({ kind: z.enum(OTHER_SESSION_KINDS), durationMinutes: z.number() }))
});

type Dated = WorkoutListItem & { date: IsoDate };
const dated = (w: WorkoutListItem, timeZone: string): Dated => ({
	...w,
	date: localDay(new Date(w.startedAt), timeZone)
});
const workoutOut = (w: Dated): z.input<typeof workoutItemSchema> => ({
	source: workoutRef(w.id, w.date),
	date: w.date,
	kind: w.kind,
	title: untrusted(w.title),
	planned: w.planned,
	durationSeconds: w.durationSeconds,
	sessionRpe: w.sessionRpe,
	sessionLoad: w.sessionLoad,
	strength: w.strength,
	run: w.run,
	other: w.other
});

/** The completed workouts from `from` to `to`, newest first, through History's own pages. */
async function completedBetween(ctx: Ctx, from: IsoDate, to: IsoDate) {
	const found: Dated[] = [];
	// The instant `to` ends in any time zone; the days are then read in the owner's.
	const startedBefore = new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + ZONE_SLACK_MS);
	let before: string | undefined;
	for (let n = 0; n < SCAN_PAGES; n += 1) {
		// One page at a time: the services may hold a transaction (docs/architecture.md).
		const page = await listWorkouts(
			ctx.ownerId,
			{ before, startedBefore, limit: MAX_WORKOUT_PAGE },
			training(ctx)
		);
		for (const w of page.workouts.map((each) => dated(each, ctx.timeZone))) {
			if (w.date < from) return { workouts: found, complete: true };
			if (w.date <= to) found.push(w);
		}
		if (page.next === null) return { workouts: found, complete: true };
		before = page.next;
	}
	return { workouts: found, complete: false };
}

const prSchema = z.object({
	exercise: sourceRefSchema,
	kind: z.enum(Object.keys(PR_KIND_LABEL) as [keyof typeof PR_KIND_LABEL]),
	reps: z.nullable(z.int()),
	value: z.number(),
	previous: z.number(),
	estimated: z.boolean()
});
const detailSchema = z.extend(workoutItemSchema, {
	notes: z.nullable(untrustedSchema),
	weightUnit: z.enum(['kg', 'lb']),
	exercises: z.array(
		z.object({
			exercise: sourceRefSchema,
			name: untrustedSchema,
			setsDone: z.int(),
			setsSkipped: z.int(),
			volume: z.nullable(z.number()),
			best: z.nullable(
				z.object({
					weight: z.nullable(z.number()),
					unit: z.enum(['kg', 'lb']),
					reps: z.nullable(z.int()),
					rpe: z.nullable(z.number()),
					e1rm: z.nullable(z.number())
				})
			),
			firstTime: z.boolean()
		})
	),
	prs: z.array(prSchema),
	plannedSession: z.nullable(z.object({ source: sourceRefSchema, missed: z.int() }))
});

async function workoutDetail(ctx: Ctx, id: string): Promise<z.input<typeof detailSchema>> {
	const detail = await getWorkoutDetail(ctx.ownerId, id, training(ctx));
	if (!detail) throw toolError('NOT_FOUND', 'You have no completed workout with that id');
	const { workout: w } = detail.workout;
	const { summary, planned } = detail;
	const date = localDay(new Date(w.startedAt), ctx.timeZone);
	const item = workoutOut({
		id: w.id,
		date,
		kind: w.kind,
		discipline: w.discipline,
		sessionType: w.sessionType,
		title: w.title,
		planned: w.plannedLineage !== null,
		startedAt: w.startedAt,
		durationSeconds: summary.durationSeconds,
		sessionRpe: summary.sessionRpe,
		sessionLoad: summary.sessionLoad,
		strength:
			w.kind === 'strength'
				? { sets: summary.sets.done, exercises: summary.exercises.length }
				: null,
		run: summary.run && {
			distanceMetres: summary.run.distanceMetres,
			durationSeconds: summary.run.durationSeconds,
			paceSecondsPerKm: detail.workout.run?.paceSecondsPerKm ?? null
		},
		other: summary.other && {
			kind: summary.other.kind,
			durationMinutes: summary.other.durationMinutes
		}
	});
	return {
		...item,
		notes: w.notes === null ? null : untrusted(w.notes),
		weightUnit: summary.units.weight,
		exercises: summary.exercises.map((e) => ({
			exercise: exerciseRef({ id: e.exerciseId }),
			name: untrusted(e.name),
			setsDone: e.sets.done,
			setsSkipped: e.sets.skipped,
			volume: e.volume,
			best: e.best && {
				weight: e.best.weight,
				unit: e.best.unit,
				reps: e.best.reps,
				rpe: e.best.rpe,
				e1rm: e.best.e1rm?.value ?? null
			},
			firstTime: e.firstTime
		})),
		prs: summary.prs.map((pr) => ({
			exercise: exerciseRef({ id: pr.exerciseId }),
			kind: pr.kind,
			reps: pr.reps,
			value: pr.value,
			previous: pr.previous,
			estimated: pr.estimated
		})),
		plannedSession: planned && {
			source: { type: 'session' as const, id: planned.lineage, date: planned.date },
			missed: planned.exercises.filter((e) => e.state === 'missed').length
		}
	};
}

const getRecentWorkoutsTool = defineTool({
	name: 'get_recent_workouts',
	description: `The owner's completed workouts as History lists them, newest first, ${RECENT_WORKOUTS_LIMIT.default} at a time unless limit says otherwise: each one's date, kind, title, duration, session RPE and load, and its sets, run totals or class. Give before (the previous result's next) for older ones. Give id (a workout's source id from an earlier result) for that workout's summary instead, in workout: each exercise's sets, volume and best set, its PRs, notes, and the planned session it came from.`,
	input: z.object({
		id: z.optional(z.uuid()),
		before: z.optional(z.uuid()),
		limit: z.optional(whole(1, RECENT_WORKOUTS_LIMIT.max))
	}),
	output: z.object({
		workout: z.nullable(detailSchema),
		items: z.array(workoutItemSchema).check(z.maxLength(PAGE_MAX)),
		more: z.boolean(),
		next: z.nullable(z.string()),
		truncated
	}),
	run: async ({ id, before, limit }, ctx: Ctx) => {
		if (id !== undefined)
			return { workout: await workoutDetail(ctx, id), items: [], more: false, next: null };
		const page = await listWorkouts(
			ctx.ownerId,
			{ before, limit: limit ?? RECENT_WORKOUTS_LIMIT.default },
			training(ctx)
		);
		return {
			workout: null,
			items: page.workouts.map((w) => workoutOut(dated(w, ctx.timeZone))),
			more: page.next !== null,
			next: page.next
		};
	}
});

const plannedSchema = z.object({
	source: sourceRefSchema,
	date: isoDate,
	title: untrustedSchema,
	status: z.enum(SESSION_STATUSES)
});

const getTrainingHistoryTool = defineTool({
	name: 'get_training_history',
	description: `What the owner planned and did from from to to (YYYY-MM-DD, both included; the last ${TRAINING_HISTORY_DAYS.default} days to today by default, at most ${TRAINING_HISTORY_DAYS.max} days): the sessions the active program planned on those days with their status (planned, completed, skipped or moved), and the completed workouts logged, planned or not, newest first. complete is false when the range holds more workouts than one read covers.`,
	input: z.object({ from: z.optional(isoDate), to: z.optional(isoDate) }),
	output: z.object({
		from: isoDate,
		to: isoDate,
		planned: z.array(plannedSchema),
		workouts: z.array(workoutItemSchema),
		complete: z.boolean(),
		truncated
	}),
	run: async (input, ctx: Ctx) => {
		const to = input.to ?? ctx.today;
		const from = input.from ?? addDays(to, 1 - TRAINING_HISTORY_DAYS.default);
		if (to < from)
			throw toolError('INVALID_INPUT', 'to is before from', { issues: { to: 'On or after from' } });
		if (daysBetween(from, to) >= TRAINING_HISTORY_DAYS.max)
			throw toolError('INVALID_INPUT', `At most ${TRAINING_HISTORY_DAYS.max} days`, {
				issues: { to: `At most ${TRAINING_HISTORY_DAYS.max} days from from` }
			});
		const { planned } = await getSessionsInRange(ctx.ownerId, { from, to }, training(ctx));
		const { workouts, complete } = await completedBetween(ctx, from, to);
		return {
			from,
			to,
			planned: [...planned].reverse().map((s) => ({
				source: { type: 'session' as const, id: s.lineageId, date: s.scheduledOn },
				date: s.scheduledOn,
				title: untrusted(s.title),
				status: s.status
			})),
			workouts: workouts.map(workoutOut),
			complete
		};
	}
});

const getRunningHistoryTool = defineTool({
	name: 'get_running_history',
	description: `The owner's running over the last ${RUNNING_HISTORY_WEEKS.default} Monday-to-Sunday weeks unless weeks says otherwise (this week included): each week's total distance in their distance unit (weeks with no run left out) and the runs, newest first, with distance, duration, pace and session RPE. complete is false when the weeks hold more workouts than one read covers.`,
	input: z.object({ weeks: z.optional(whole(1, RUNNING_HISTORY_WEEKS.max)) }),
	output: z.object({
		from: isoDate,
		to: isoDate,
		weeks: z.array(z.extend(metricSchema, { weekStart: isoDate })),
		runs: z.array(workoutItemSchema).check(z.maxLength(PAGE_MAX)),
		more: z.boolean(),
		complete: z.boolean(),
		truncated
	}),
	run: async (input, ctx: Ctx) => {
		const count = input.weeks ?? RUNNING_HISTORY_WEEKS.default;
		const monday = mondayOf(ctx.today);
		const range = { from: addDays(monday, -7 * (count - 1)), to: addDays(monday, 6) };
		const mileage = await getWeeklyMileage(ctx.ownerId, range, {}, training(ctx));
		const { workouts, complete } = await completedBetween(ctx, range.from, range.to);
		const runs = workouts.filter((w) => w.kind === 'run');
		return {
			...range,
			weeks: mileage.weeks.map((w) => ({
				weekStart: w.weekStart,
				...metric({
					value: w.distance,
					unit: mileage.unit,
					method: 'sum of the week’s logged run distances, Monday to Sunday',
					sources: [{ type: 'date', id: w.weekStart, label: `Week of ${w.weekStart}` }]
				})
			})),
			runs: runs.slice(0, PAGE_MAX).map(workoutOut),
			more: runs.length > PAGE_MAX,
			complete
		};
	}
});

export const HISTORY_TOOLS: readonly CoachTool[] = [
	getTrainingHistoryTool,
	getExerciseHistoryTool,
	getRunningHistoryTool,
	getRecentWorkoutsTool,
	getPersonalRecordsTool
];
