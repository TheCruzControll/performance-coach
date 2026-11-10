/**
 * The workout history reads (PRD §7, §9): what History lists and shows, and an exercise's history
 * for its sheet and for the last-time line of a substitute or an added exercise.
 *
 * - listWorkouts: the owner's completed workouts of every kind, newest first, WORKOUT_PAGE_SIZE at
 *   a time, each with the numbers its row shows (queries/history.ts completedWorkoutsPage, keyset
 *   on started_at and id). In-progress, abandoned and deleted workouts are not history.
 * - getWorkoutDetail: one completed workout's canonical rows (canonical.ts), its summary by the
 *   domain's summarizeWorkout over the same projection the device renders, against the bests from
 *   before it started, and, for a planned session, the plan against what was done. Anything else
 *   (a malformed id, an unknown one, another owner's, one not completed or deleted) reads as null.
 * - completedWorkoutIds: the History detail a planned session that reads 'Done' opens, by lineage
 *   (queries/history.ts completedWorkoutsFor): its newest completed workout's client id.
 * - getExerciseHistory: an exercise's sets page by page and its records (services/training/
 *   history.ts, never redefined; the best e1RM is labelled estimated), with its previous session:
 *   the last completed workout that did it, planned or ad-hoc (the plan's open question on
 *   'previous performance' keeps this default). Null for an exercise the owner cannot see.
 * - Loads and paces read in the training profile's units; every query is awaited in turn on one
 *   Executor (#62).
 */
import type { IsoDate } from '../../../domain/calendar';
import type { CustomMetric, OtherDetails, RunSegment } from '../../../domain/training/types';
import { isWorking, prKinds } from '../../../domain/workout/logging';
import { project, type AnyTable } from '../../../domain/workout/project';
import { runTable } from '../../../domain/workout/reducers/run';
import { otherTable } from '../../../domain/workout/reducers/other';
import { strengthTable } from '../../../domain/workout/reducers/tables';
import { STOPPING_PAIN_ACTIONS } from '../../../domain/workout/substitution';
import { summarizeWorkout } from '../../../domain/workout/summary';
import type { PriorBests, WorkoutSummary } from '../../../domain/workout/summary';
import type {
	CanonicalWorkout,
	ExerciseSummary,
	Instant,
	KitUnits,
	PreviousPerformance,
	SlotState,
	WorkoutView
} from '../../../domain/workout/index';
import { bestE1rm, personalRecords, sessionLoadOf } from '../../../domain/training/metrics';
import { createHistoryRepository } from '../../db/repositories/history';
import type { CompletedWorkoutRow, HistorySetRow } from '../../db/repositories/history';
import { createProfileRepository } from '../../db/repositories/profile';
import { createProgramsRepository } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds } from '../exercises/index';
import { isUuid } from '../ids';
import { toStoredSessions } from '../programs/mapping';
import {
	getExerciseHistory as exerciseSets,
	getPersonalRecords,
	type ExerciseHistoryPage,
	type ExerciseRecords
} from '../training/history';
import { resolveDeps, TrainingInputError, type TrainingDeps } from '../training/shared';
import { getCanonicalWorkout } from './canonical';
import { previousOf } from './kit';

/** Workouts per History page unless asked otherwise, and at most. */
export const WORKOUT_PAGE_SIZE = 20;
export const MAX_WORKOUT_PAGE = 50;

/** athlete_profiles' own defaults, for an owner with no profile row yet. */
const DEFAULT_UNITS: KitUnits = { weight: 'kg', distance: 'km' };
const DEFAULT_TIME_ZONE = 'UTC';

/** A History row: what the list shows of one completed workout. */
export interface WorkoutListItem {
	/** The workout's client id, which the detail and the next page's `before` take. */
	id: string;
	kind: CompletedWorkoutRow['kind'];
	discipline: CompletedWorkoutRow['discipline'];
	sessionType: CompletedWorkoutRow['sessionType'];
	title: string;
	/** Logged from a planned session. */
	planned: boolean;
	startedAt: Instant;
	durationSeconds: number | null;
	sessionRpe: number | null;
	/** M3's sessionLoadOf: minutes × session RPE; null until both are known. */
	sessionLoad: number | null;
	/** A strength workout's working sets, and the exercises they were done in. */
	strength: { sets: number; exercises: number } | null;
	/** A run's totals, each null until recorded. */
	run: {
		distanceMetres: number | null;
		durationSeconds: number | null;
		paceSecondsPerKm: number | null;
	} | null;
	other: { kind: OtherDetails['kind']; durationMinutes: number } | null;
}

export interface WorkoutPage {
	v: 1;
	/** Newest first. */
	workouts: WorkoutListItem[];
	/** The `before` that gives the next page; null on the last. */
	next: string | null;
}

/** A planned exercise and what became of it, in its slot (the kit's 1-based position). */
export interface PlannedExerciseResult {
	position: number;
	plannedLineage: string;
	/** The exercise the plan named. */
	exerciseId: string;
	name: string;
	/** The sets the plan asked for, warm-ups included. */
	sets: number;
	/** The slot's state as the workout ended; 'missed' when nothing was logged or reported in it. */
	state: SlotState | 'missed';
	/** What was performed there: the planned exercise or its substitute; null when missed. */
	performedId: string | null;
	/** Working sets done, and sets skipped. */
	done: number;
	skipped: number;
}

/** The planned session against what was done. */
export interface PlannedAgainstDone {
	sessionId: string;
	lineage: string;
	title: string;
	date: IsoDate;
	/** Strength: each planned exercise in order, then the exercises added on top. */
	exercises: PlannedExerciseResult[];
	added: { position: number; exerciseId: string; done: number }[];
	/** A run's segments as planned (a repeat group once, with its repeats). */
	run: { segments: RunSegment[] } | null;
	other: {
		kind: OtherDetails['kind'];
		durationMinutes: number;
		targetRpe: number | null;
		metrics: CustomMetric[];
	} | null;
}

export interface WorkoutDetail {
	v: 1;
	/** The stored rows, as the device reads them, tombstones included. */
	workout: CanonicalWorkout;
	summary: WorkoutSummary;
	/** Null for a workout logged off plan, or whose planned session is gone. */
	planned: PlannedAgainstDone | null;
}

export interface ExerciseHistory extends ExerciseHistoryPage {
	v: 1;
	exercise: ExerciseSummary & { id: string };
	/** Its last completed session before now, skipped sets left out; null if never done. */
	previous: PreviousPerformance | null;
	/** The best e1RM (always an estimate) and the heaviest set at each rep count. */
	records: Pick<ExerciseRecords, 'bestE1rm' | 'repMaxes'>;
}

const TABLES: Record<CanonicalWorkout['workout']['kind'], AnyTable> = {
	strength: strengthTable,
	run: runTable,
	other: otherTable
};

async function settingsOf(db: Executor, ownerId: string) {
	const profile = await createProfileRepository(db).getProfile(ownerId);
	const units: KitUnits = profile
		? { weight: profile.weightUnit, distance: profile.distanceUnit }
		: DEFAULT_UNITS;
	return { units, timeZone: profile?.timeZone ?? DEFAULT_TIME_ZONE };
}

function listItem(row: CompletedWorkoutRow): WorkoutListItem {
	const { id, kind, discipline, sessionType, title, durationSeconds, sessionRpe } = row;
	return {
		id,
		kind,
		discipline,
		sessionType,
		title,
		planned: row.plannedLineage !== null,
		startedAt: row.startedAt.toISOString(),
		durationSeconds,
		sessionRpe,
		sessionLoad: sessionLoadOf({ durationSeconds, sessionRpe }),
		strength: kind === 'strength' ? { sets: row.sets.count, exercises: row.sets.slots } : null,
		run: kind === 'run' ? row.run : null,
		other: kind === 'other' ? row.other : null
	};
}

/**
 * The owner's completed workouts, newest first, those started before `startedBefore` when given;
 * a page's `next`, as `before`, gives the next.
 */
export async function listWorkouts(
	ownerId: string,
	{
		before,
		startedBefore,
		limit = WORKOUT_PAGE_SIZE
	}: { before?: string; startedBefore?: Date; limit?: number } = {},
	deps: TrainingDeps = {}
): Promise<WorkoutPage> {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKOUT_PAGE) {
		throw new TrainingInputError({ limit: `From 1 to ${MAX_WORKOUT_PAGE}` });
	}
	if (before !== undefined && !isUuid(before)) {
		throw new TrainingInputError({ before: "A page's next" });
	}
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		// One more than the page shows, so the last page knows it is the last.
		const rows = await createHistoryRepository(db).completedWorkoutsPage(ownerId, {
			before,
			startedBefore,
			limit: limit + 1
		});
		const workouts = rows.slice(0, limit).map(listItem);
		return { v: 1, workouts, next: rows.length > limit ? workouts.at(-1)!.id : null };
	});
}

/**
 * The bests each exercise held before `before`, as a start kit carries them (kit.ts): null for an
 * exercise with no previous completed session and no bests, which is its first time.
 */
async function priorBestsOf(
	db: Executor,
	ownerId: string,
	exercises: Readonly<Record<string, ExerciseSummary>>,
	ids: string[],
	before: Date
): Promise<PriorBests> {
	const history = createHistoryRepository(db);
	const competing = ids.filter((id) => prKinds(exercises[id]!).includes('most_reps'));
	const last = await history.lastSessionSets(ownerId, ids, before);
	const records = await history.personalRecords(ownerId, ids, before);
	const most = await history.mostReps(ownerId, competing, before);
	const setsOf = <R extends { set: HistorySetRow }>(
		rows: R[],
		id: string,
		key: (row: R) => string
	) => rows.filter((row) => key(row) === id).map((row) => row.set);
	const prior: Record<string, PriorBests[string]> = {};
	for (const id of ids) {
		const e1rm = bestE1rm(setsOf(records.bestE1rms, id, (r) => r.exercise.id))?.value ?? null;
		const repMaxes = personalRecords(setsOf(records.repMaxes, id, (r) => r.exercise.id));
		const mostReps = most.find((row) => row.exerciseId === id)?.reps ?? null;
		const done = last.some((row) => row.exerciseId === id);
		prior[id] =
			done || e1rm !== null || repMaxes.length > 0 || mostReps !== null
				? {
						e1rmKg: e1rm,
						repMaxes: repMaxes.map(({ reps, weightKg }) => ({ reps, weightKg })),
						mostReps
					}
				: null;
	}
	return prior;
}

/** The planned session the workout was pinned to, against the view of what was done. */
async function plannedAgainstDone(
	db: Executor,
	ownerId: string,
	sessionId: string,
	view: WorkoutView,
	pain: CanonicalWorkout['pain']
): Promise<PlannedAgainstDone | null> {
	const programs = createProgramsRepository(db);
	const pinned = await programs.sessionById(ownerId, sessionId);
	if (!pinned) return null;
	const children = await programs.sessionChildren([sessionId]);
	const stored = toStoredSessions({ sessions: [pinned.session], ...children }).get(sessionId)!;
	const base = { sessionId, lineage: stored.lineage, title: stored.title, date: stored.date };
	const none = { exercises: [], added: [], run: null, other: null };
	if (stored.kind === 'run') return { ...base, ...none, run: { segments: stored.segments } };
	if (stored.kind === 'other') {
		const { kind, durationMinutes, targetRpe, metrics } = stored.details;
		return { ...base, ...none, other: { kind, durationMinutes, targetRpe, metrics } };
	}
	const exerciseOf = new Map(children.exercises.map((row) => [row.id, row.exerciseId]));
	const planned = stored.exercises.map((e) => ({ ...e, exerciseId: exerciseOf.get(e.id)! }));
	const names = await getExercisesByIds(
		ownerId,
		planned.map((e) => e.exerciseId),
		{ db }
	);
	const exercises = planned.map((e, i): PlannedExerciseResult => {
		const position = i + 1;
		const slot = view.slots.find((s) => s.position === position);
		// Pain that stopped a slot before any set: the projection, kit-less, has no slot there.
		const stopped = pain.some(
			(r) =>
				r.position === position && r.deletedAt === null && STOPPING_PAIN_ACTIONS.includes(r.action)
		);
		return {
			position,
			plannedLineage: e.lineage,
			exerciseId: e.exerciseId,
			name: names.get(e.exerciseId)?.name ?? view.exercises[e.exerciseId]?.name ?? '',
			sets: e.sets.reduce((total, line) => total + line.sets, 0),
			// A planned slot's rows written without its lineage (M3's own writers) read as added.
			state: !slot
				? stopped
					? 'stopped'
					: 'missed'
				: slot.state === 'added'
					? 'planned'
					: slot.state,
			performedId: slot?.exerciseId ?? null,
			done: slot?.sets.filter(isWorking).length ?? 0,
			skipped: slot?.sets.filter((s) => s.isSkipped).length ?? 0
		};
	});
	const added = view.slots
		.filter((slot) => slot.position > planned.length)
		.map(({ position, exerciseId, sets }) => ({
			position,
			exerciseId,
			done: sets.filter(isWorking).length
		}));
	return { ...base, ...none, exercises, added };
}

/**
 * The client id of the newest completed, undeleted workout logged against each of `lineages`, by
 * lineage: the History detail Today and the session screen open from 'Done'. Lineages with none,
 * and malformed ones, are absent.
 */
export async function completedWorkoutIds(
	ownerId: string,
	lineages: readonly string[],
	deps: TrainingDeps = {}
): Promise<Record<string, string>> {
	const asked = lineages.filter(isUuid);
	if (!asked.length) return {};
	const { db } = resolveDeps(deps);
	const found = await measure('db', () =>
		createHistoryRepository(db).completedWorkoutsFor(ownerId, asked)
	);
	return Object.fromEntries(found);
}

/** One completed workout as History shows it; null for anything else. */
export async function getWorkoutDetail(
	ownerId: string,
	workoutClientId: string,
	deps: TrainingDeps = {}
): Promise<WorkoutDetail | null> {
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const workout = await getCanonicalWorkout(ownerId, workoutClientId, { db });
		if (workout?.workout.status !== 'completed' || workout.workout.deletedAt !== null) return null;
		const { kind, startedAt, plannedSessionId } = workout.workout;
		const view = project(TABLES[kind], {
			workoutId: workout.workout.id,
			kit: null,
			canonical: workout,
			pending: []
		})!;
		const { units } = await settingsOf(db, ownerId);
		const done = [
			...new Set(view.slots.flatMap((s) => s.sets.filter(isWorking)).map((s) => s.exerciseId))
		];
		const prior = await priorBestsOf(db, ownerId, view.exercises, done, new Date(startedAt));
		const planned =
			plannedSessionId &&
			(await plannedAgainstDone(db, ownerId, plannedSessionId, view, workout.pain));
		return {
			v: 1,
			workout,
			summary: summarizeWorkout(view, prior, units),
			planned: planned || null
		};
	});
}

/**
 * An exercise's sets, newest first, a page at a time, with its records and its previous session;
 * null when it is not one the owner can see. A page's `next`, as `before`, gives the next.
 */
export async function getExerciseHistory(
	ownerId: string,
	exerciseId: string,
	page: { before?: number; limit?: number } = {},
	deps: TrainingDeps = {}
): Promise<ExerciseHistory | null> {
	const { db, now } = resolveDeps(deps);
	const found = (await getExercisesByIds(ownerId, [exerciseId], { db })).get(exerciseId);
	if (!found) return null;
	const sets = await exerciseSets(ownerId, exerciseId, page, { db });
	const [records] = await getPersonalRecords(ownerId, { exerciseId }, { db });
	const previous = await measure('db', async () => {
		const { timeZone } = await settingsOf(db, ownerId);
		const rows = await createHistoryRepository(db).lastSessionSets(ownerId, [exerciseId], now());
		return previousOf(rows, timeZone);
	});
	const { id, name, measure: kind, loadType, unilateral } = found;
	return {
		v: 1,
		exercise: { id, name, measure: kind, loadType, unilateral },
		previous,
		...sets,
		records: { bestE1rm: records?.bestE1rm ?? null, repMaxes: records?.repMaxes ?? [] }
	};
}
