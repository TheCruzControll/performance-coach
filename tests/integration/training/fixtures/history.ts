/**
 * The training log written straight into its tables, as M4's logging services will write it
 * (m3/30): workouts with their set records, runs with their totals, and other sessions. A set
 * stores the e1RM setE1rm gives it, as the writer and editSet do. History tests read the rows
 * back through the history services.
 */
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { Discipline } from '../../../../src/lib/domain/profile/catalog';
import { setE1rm } from '../../../../src/lib/domain/training/metrics';
import type { OtherSessionKind, SessionType } from '../../../../src/lib/domain/training/vocabulary';
import type { WeightUnit } from '../../../../src/lib/domain/units';
import {
	exercises,
	otherSessionRecords,
	runRecords,
	setRecords,
	workouts,
	type Executor,
	type WorkoutKind,
	type WorkoutStatus
} from '../../../../src/lib/server/db';

const MINUTE = 60_000;

/** An instant given as UTC wall time: `utc('2026-11-02', '17:00')`. */
export const utc = (date: string, time: string) => new Date(`${date}T${time}:00Z`);

/** Catalogue rows' ids by key. */
export async function exerciseIds<K extends string>(
	db: Executor,
	keys: readonly K[]
): Promise<Record<K, string>> {
	const rows = await db
		.select({ id: exercises.id, key: exercises.key })
		.from(exercises)
		.where(inArray(exercises.key, [...keys]));
	const ids = Object.fromEntries(rows.map((row) => [row.key, row.id]));
	for (const key of keys) if (!ids[key]) throw new Error(`no catalogue exercise '${key}'`);
	return ids as Record<K, string>;
}

export interface WorkoutSpec {
	startedAt: Date;
	title?: string;
	status?: WorkoutStatus;
	deleted?: boolean;
	durationSeconds?: number | null;
	sessionRpe?: number | null;
	/** The planned session it was logged from. */
	planned?: { sessionId: string; lineageId: string; programId: string };
	discipline?: Discipline;
	sessionType?: SessionType;
}

export interface SetSpec {
	exercise: string;
	weight?: number | null;
	unit?: WeightUnit;
	reps?: number | null;
	rpe?: number | null;
	warmup?: boolean;
	skipped?: boolean;
	extra?: boolean;
	deleted?: boolean;
	/** The workout's start plus a minute per set before it, unless given. Text keeps microseconds. */
	performedAt?: Date | string;
}

const DEFAULTS: Record<WorkoutKind, { discipline: Discipline; sessionType: SessionType }> = {
	strength: { discipline: 'strength', sessionType: 'strength' },
	run: { discipline: 'running', sessionType: 'easy_run' },
	other: { discipline: 'muay_thai', sessionType: 'muay_thai' }
};

async function insertWorkout(
	db: Executor,
	ownerId: string,
	kind: WorkoutKind,
	spec: WorkoutSpec
): Promise<string> {
	const status = spec.status ?? 'completed';
	const durationSeconds = spec.durationSeconds === undefined ? 3600 : spec.durationSeconds;
	const finishedAt =
		status === 'in_progress'
			? null
			: new Date(spec.startedAt.getTime() + (durationSeconds ?? 3600) * 1000);
	const [row] = await db
		.insert(workouts)
		.values({
			ownerId,
			clientId: crypto.randomUUID(),
			kind,
			discipline: spec.discipline ?? DEFAULTS[kind].discipline,
			sessionType: spec.sessionType ?? DEFAULTS[kind].sessionType,
			title: spec.title ?? 'Session',
			plannedSessionId: spec.planned?.sessionId ?? null,
			plannedLineageId: spec.planned?.lineageId ?? null,
			programId: spec.planned?.programId ?? null,
			status,
			startedAt: spec.startedAt,
			finishedAt,
			durationSeconds: status === 'in_progress' ? null : durationSeconds,
			sessionRpe: spec.sessionRpe === undefined ? 7 : spec.sessionRpe,
			deletedAt: spec.deleted ? new Date(spec.startedAt.getTime() + 2 * 3600 * 1000) : null
		})
		.returning({ id: workouts.id });
	return row!.id;
}

/**
 * A strength workout and its sets, in order: each exercise takes its place in the workout when it
 * first appears, and its sets count from 1. Returns the set ids in the order given.
 */
export async function logStrength(
	db: Executor,
	ownerId: string,
	workout: WorkoutSpec,
	sets: SetSpec[]
): Promise<{ workoutId: string; setIds: number[] }> {
	const workoutId = await insertWorkout(db, ownerId, 'strength', workout);
	const positions = new Map<string, { position: number; sets: number }>();
	const setIds: number[] = [];
	for (const [n, spec] of sets.entries()) {
		const place = positions.get(spec.exercise) ?? { position: positions.size + 1, sets: 0 };
		place.sets += 1;
		positions.set(spec.exercise, place);
		const set = {
			weight: spec.weight ?? null,
			unit: spec.unit ?? ('kg' as const),
			reps: spec.reps === undefined ? 5 : spec.reps,
			rpe: spec.rpe ?? null,
			isWarmup: spec.warmup ?? false,
			isSkipped: spec.skipped ?? false
		};
		const performedAt: Date | SQL =
			typeof spec.performedAt === 'string'
				? sql`${spec.performedAt}::timestamptz`
				: (spec.performedAt ?? new Date(workout.startedAt.getTime() + n * MINUTE));
		const [row] = await db
			.insert(setRecords)
			.values({
				ownerId,
				clientMutationId: crypto.randomUUID(),
				workoutId,
				exerciseId: spec.exercise,
				exercisePosition: place.position,
				setIndex: place.sets,
				...set,
				isExtra: spec.extra ?? false,
				e1rmKg: setE1rm(set)?.value ?? null,
				performedAt,
				deletedAt: spec.deleted ? new Date(workout.startedAt.getTime() + 3 * 3600 * 1000) : null
			})
			.returning({ id: setRecords.id });
		setIds.push(row!.id);
	}
	return { workoutId, setIds };
}

/** A run and its totals; `metres` null for a run whose distance is not recorded yet. */
export async function logRun(
	db: Executor,
	ownerId: string,
	workout: WorkoutSpec & { metres: number | null }
): Promise<string> {
	const workoutId = await insertWorkout(db, ownerId, 'run', workout);
	await db.insert(runRecords).values({
		ownerId,
		workoutId,
		distanceMetres: workout.metres,
		durationSeconds: workout.durationSeconds ?? null
	});
	return workoutId;
}

/** A Muay Thai class, mobility or other session with its details. */
export async function logOther(
	db: Executor,
	ownerId: string,
	workout: WorkoutSpec & { kind?: OtherSessionKind; minutes?: number }
): Promise<string> {
	const workoutId = await insertWorkout(db, ownerId, 'other', workout);
	await db.insert(otherSessionRecords).values({
		ownerId,
		workoutId,
		kind: workout.kind ?? 'class',
		durationMinutes: workout.minutes ?? 60,
		rpe: 7
	});
	return workoutId;
}
