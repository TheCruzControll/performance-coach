/**
 * Training history (PRD §7, §9) for the screens (M4) and the coach's tools (M5–M6): an exercise's
 * sets page by page, its last performances, its PRs and best e1RM, weekly hard sets per muscle,
 * weekly mileage, and the sessions planned and logged in a date range. Callers import this module
 * by path; services/index.ts does not re-export it.
 * - Every read is the owner's. A malformed exercise id is not found, never a database error.
 * - Dates are explicit and on the owner's calendar (the profile's time zone). A range becomes
 *   instants with ZONE_SLACK_MS to spare on each side, and each row is kept by the day it fell on
 *   there, so a Sunday-evening session stays in its week whatever its UTC date. Weekly reads take
 *   whole weeks, Monday to Sunday, which the caller sets: no read looks at the clock.
 * - Aggregates are the domain metrics on the rows a query returns (hardSets, weeklyDistance,
 *   bestE1rm, personalRecords, sessionLoadOf), so a hard set, a PR or a week has one definition.
 */
import {
	addDays,
	daysBetween,
	mondayOf,
	parseIsoDate,
	type IsoDate
} from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { ProfileDistanceUnit } from '../../../domain/profile/types';
import {
	bestE1rm,
	hardSets,
	personalRecords,
	sessionLoadOf,
	weeklyDistance
} from '../../../domain/training/metrics';
import type {
	BestE1rm,
	ExerciseMuscles,
	RepRecord,
	WeekDistance,
	WeekHardSets
} from '../../../domain/training/metrics';
import type { SessionStatus } from '../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../domain/validation';
import { createHistoryRepository } from '../../db/repositories/history';
import type {
	HistorySetRow,
	InstantRange,
	PerformanceRow,
	RecordRow,
	WorkoutRow
} from '../../db/repositories/history';
import { createProfileRepository } from '../../db/repositories/profile';
import { createProgramsRepository, type SessionRow } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from './shared';

/** Sets per history page unless asked otherwise, and at most. */
export const HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE = 100;
/** Last performances per read unless asked otherwise, and at most. */
export const LAST_PERFORMANCES = 3;
export const MAX_LAST_PERFORMANCES = 10;
/** The longest date range a read covers, both ends included: two years of training. */
export const MAX_RANGE_DAYS = 731;

/** UTC offsets run from −12:00 to +14:00, so a local day starts within 14 hours of UTC midnight. */
const ZONE_SLACK_MS = 14 * 3_600_000;
/** athlete_profiles' own defaults, for an owner with no profile row yet. */
const DEFAULT_TIME_ZONE = 'UTC';
const DEFAULT_DISTANCE_UNIT: ProfileDistanceUnit = 'km';

/** A set as history shows it: the weight and unit as entered, its exact kg and stored e1RM. */
export type HistorySet = HistorySetRow;

export interface ExerciseHistoryPage {
	/** Newest first. */
	sets: HistorySet[];
	/** The `before` that gives the next page; null on the last. */
	next: number | null;
}

/** A workout and its working sets of one exercise, in workout order. */
export type Performance = PerformanceRow['workout'] & { sets: HistorySet[] };

/** An exercise's best e1RM (always an estimate) and its heaviest set at each rep count. */
export interface ExerciseRecords {
	exerciseId: string;
	/** The catalogue key; null for the owner's own exercise. */
	key: string | null;
	name: string;
	bestE1rm: BestE1rm<HistorySet> | null;
	/** Lightest rep count first, from 1 to PR_MAX_REPS. */
	repMaxes: RepRecord<HistorySet>[];
}

/** Days on the owner's calendar, both included. */
export interface DateRange {
	from: IsoDate;
	to: IsoDate;
}

export interface WeeklyMileage {
	unit: ProfileDistanceUnit;
	/** Oldest week first; weeks with no run are left out. */
	weeks: WeekDistance[];
}

/** A session of the current version, 'completed' once a completed workout names its lineage. */
export type PlannedSessionInRange = Omit<SessionRow, 'status'> & { status: SessionStatus };

/** A logged workout, with the owner's day it started on and its load (sessionLoadOf). */
export type LoggedSession = WorkoutRow & { date: IsoDate; load: number | null };

export interface SessionsInRange extends DateRange {
	/** By day and order in the day; none without an active program. */
	planned: PlannedSessionInRange[];
	/** By start time, planned or not. */
	logged: LoggedSession[];
}

const isWhole = (n: unknown, min: number, max: number): n is number =>
	Number.isInteger(n) && (n as number) >= min && (n as number) <= max;

function throwIfAny(errors: FieldErrors): void {
	if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);
}

function checkExercise(id: unknown): string {
	if (!isUuid(id)) throw new TrainingNotFoundError('exercise');
	return id;
}

const isDate = (value: unknown): value is IsoDate =>
	typeof value === 'string' && parseIsoDate(value) !== null;

/** Real dates, in order, at most MAX_RANGE_DAYS apart; whole weeks when `weeks`. */
function rangeErrors({ from, to }: DateRange, weeks = false): FieldErrors {
	const errors: FieldErrors = {};
	const WEEKS = 'weeks run Monday to Sunday';
	if (!isDate(from)) errors.from = 'Not a calendar date (YYYY-MM-DD)';
	else if (weeks && mondayOf(from) !== from) errors.from = `A Monday: ${WEEKS}`;
	if (!isDate(to)) errors.to = 'Not a calendar date (YYYY-MM-DD)';
	else if (weeks && addDays(mondayOf(to), 6) !== to) errors.to = `A Sunday: ${WEEKS}`;
	else if (isDate(from) && to < from) errors.to = 'On or after the first day';
	else if (isDate(from) && daysBetween(from, to) >= MAX_RANGE_DAYS) {
		errors.to = `At most ${MAX_RANGE_DAYS} days from the first day`;
	}
	return errors;
}

/** Every instant that falls on one of the range's days in any time zone. */
const instantsOf = ({ from, to }: DateRange): InstantRange => ({
	start: new Date(Date.parse(`${from}T00:00:00Z`) - ZONE_SLACK_MS),
	end: new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + ZONE_SLACK_MS)
});

const within = ({ from, to }: DateRange, day: IsoDate) => from <= day && day <= to;

async function profileOf(db: Executor, ownerId: string) {
	const profile = await createProfileRepository(db).getProfile(ownerId);
	return {
		timeZone: profile?.timeZone ?? DEFAULT_TIME_ZONE,
		distanceUnit: profile?.distanceUnit ?? DEFAULT_DISTANCE_UNIT
	};
}

/**
 * An exercise's sets, newest first, warm-ups and skipped sets included and flagged; deleted sets
 * are left out. A page's `next`, passed as `before`, gives the page after it.
 */
export async function getExerciseHistory(
	ownerId: string,
	exerciseId: string,
	{ before, limit = HISTORY_PAGE_SIZE }: { before?: number; limit?: number } = {},
	deps: TrainingDeps = {}
): Promise<ExerciseHistoryPage> {
	const exercise = checkExercise(exerciseId);
	const errors: FieldErrors = {};
	if (!isWhole(limit, 1, MAX_HISTORY_PAGE)) errors.limit = `From 1 to ${MAX_HISTORY_PAGE}`;
	if (before !== undefined && !isWhole(before, 1, Number.MAX_SAFE_INTEGER)) {
		errors.before = "A page's next";
	}
	throwIfAny(errors);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		// One more than the page shows, so the last page knows it is the last.
		const rows = await createHistoryRepository(db).exerciseHistory(ownerId, exercise, {
			before,
			limit: limit + 1
		});
		const sets = rows.slice(0, limit);
		return { sets, next: rows.length > limit ? sets.at(-1)!.id : null };
	});
}

/**
 * The last `count` workouts with a working set of the exercise, newest first, each with all its
 * working sets: warm-ups, skipped and deleted sets are no performance.
 */
export async function getLastPerformances(
	ownerId: string,
	exerciseId: string,
	{ count = LAST_PERFORMANCES }: { count?: number } = {},
	deps: TrainingDeps = {}
): Promise<Performance[]> {
	const exercise = checkExercise(exerciseId);
	if (!isWhole(count, 1, MAX_LAST_PERFORMANCES)) {
		throw new TrainingInputError({ count: `From 1 to ${MAX_LAST_PERFORMANCES}` });
	}
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const rows = await createHistoryRepository(db).lastPerformances(ownerId, exercise, count);
		const performances = new Map<string, Performance>();
		for (const { workout, set } of rows) {
			const performance = performances.get(workout.workoutId) ?? { ...workout, sets: [] };
			performance.sets.push(set);
			performances.set(workout.workoutId, performance);
		}
		return [...performances.values()];
	});
}

/**
 * The records of one exercise, or of every exercise that has any (the catalogue, retired entries
 * included, and the owner's own), by name. Each is the domain's bestE1rm or personalRecords on
 * the sets the indexes pick, so warm-ups, skipped and deleted sets never count.
 */
export async function getPersonalRecords(
	ownerId: string,
	{ exerciseId }: { exerciseId?: string } = {},
	deps: TrainingDeps = {}
): Promise<ExerciseRecords[]> {
	const exercise = exerciseId === undefined ? undefined : checkExercise(exerciseId);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const rows = await createHistoryRepository(db).personalRecords(ownerId, exercise);
		const found = new Map<string, { row: RecordRow; best: HistorySet[]; reps: HistorySet[] }>();
		const entry = (row: RecordRow) => {
			if (!found.has(row.exercise.id)) found.set(row.exercise.id, { row, best: [], reps: [] });
			return found.get(row.exercise.id)!;
		};
		for (const row of rows.bestE1rms) entry(row).best.push(row.set);
		for (const row of rows.repMaxes) entry(row).reps.push(row.set);
		return [...found.values()]
			.map(({ row: { exercise }, best, reps }) => ({
				exerciseId: exercise.id,
				key: exercise.key,
				name: exercise.name,
				bestE1rm: bestE1rm(best),
				repMaxes: personalRecords(reps)
			}))
			.filter((records) => records.bestE1rm !== null || records.repMaxes.length > 0)
			.sort((a, b) => a.name.localeCompare(b.name) || a.exerciseId.localeCompare(b.exerciseId));
	});
}

/** Hard sets per muscle and muscle group in each week from `from` (a Monday) to `to` (a Sunday). */
export async function getWeeklyMuscleVolume(
	ownerId: string,
	weeks: DateRange,
	deps: TrainingDeps = {}
): Promise<WeekHardSets[]> {
	throwIfAny(rangeErrors(weeks, true));
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const { timeZone } = await profileOf(db, ownerId);
		const rows = await createHistoryRepository(db).setsInRange(ownerId, instantsOf(weeks));
		const sets = rows.filter((set) => within(weeks, localDay(set.performedAt, timeZone)));
		const muscles = new Map<string, ExerciseMuscles>(sets.map((set) => [set.exercise, set]));
		return hardSets(sets, muscles, timeZone);
	});
}

/**
 * Running distance in each week from `from` (a Monday) to `to` (a Sunday), in `unit` or the
 * profile's distance unit. Runs are stored in exact metres, whichever unit they were entered in.
 */
export async function getWeeklyMileage(
	ownerId: string,
	weeks: DateRange,
	{ unit }: { unit?: ProfileDistanceUnit } = {},
	deps: TrainingDeps = {}
): Promise<WeeklyMileage> {
	const errors = rangeErrors(weeks, true);
	if (unit !== undefined && unit !== 'km' && unit !== 'mi') errors.unit = 'km or mi';
	throwIfAny(errors);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const { timeZone, distanceUnit } = await profileOf(db, ownerId);
		const rows = await createHistoryRepository(db).runsInRange(ownerId, instantsOf(weeks));
		const runs = rows
			.filter((run) => within(weeks, localDay(run.startedAt, timeZone)))
			.map((run) => ({
				distance: run.distanceMetres!,
				unit: 'm' as const,
				startedAt: run.startedAt
			}));
		const shown = unit ?? distanceUnit;
		return { unit: shown, weeks: weeklyDistance(runs, shown, timeZone) };
	});
}

/**
 * The sessions from `from` to `to`: those the active program's current version plans, and the
 * workouts logged on those days, planned or not.
 */
export async function getSessionsInRange(
	ownerId: string,
	range: DateRange,
	deps: TrainingDeps = {}
): Promise<SessionsInRange> {
	throwIfAny(rangeErrors(range));
	const { from, to } = range;
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const { timeZone } = await profileOf(db, ownerId);
		const programs = createProgramsRepository(db);
		const versionId = (await programs.currentProgram(ownerId))?.version.id ?? null;
		const rows = await createHistoryRepository(db).sessionsInRange(
			ownerId,
			versionId,
			from,
			to,
			instantsOf(range)
		);
		const lineages = rows.planned.map((s) => s.lineageId);
		const completed = await programs.completedLineages(ownerId, lineages);
		return {
			from,
			to,
			planned: rows.planned.map((s) => ({
				...s,
				status: completed.has(s.lineageId) ? 'completed' : s.status
			})),
			logged: rows.logged
				.map((w) => ({ ...w, date: localDay(w.startedAt, timeZone), load: sessionLoadOf(w) }))
				.filter((w) => within(range, w.date))
		};
	});
}
