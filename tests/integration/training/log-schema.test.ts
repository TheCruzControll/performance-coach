/**
 * The training log on real Postgres (ADR 0010; the M3 plan's training log): workouts, set
 * records, runs and their segments, other sessions, recovery notes and substitutions, and the
 * audit trail of every owner edit.
 * - Every row is the owner's, and a device id (client_id, client_mutation_id) is stored once, so
 *   a replayed create can never duplicate a row.
 * - A weight keeps the value and unit it was entered in, beside an exact weight in kg; a run and
 *   a segment get their pace.
 * - An UPDATE that changes a row writes one audit row (before, after, actor, owner) and moves
 *   updated_at; one that changes nothing leaves no trace. Deletes are soft and audited, hard
 *   deletes are refused, and the audit trail itself never changes.
 * - The CHECKs cover the closed lists, the scales and coherence; the open lists stay open.
 * - Every history index exists in the shape the history queries use, and TRUNCATE (the
 *   withCommitted cleanup) is the one bypass.
 * Audit assertions always filter by table and row id.
 */
import { and, asc, eq, getTableName, inArray, is, sql, type SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LoggedSessionLoad, LoggedSet } from '../../../src/lib/domain/training/metrics';
import type { SessionKind } from '../../../src/lib/domain/training/types';
import {
	AUDIT_ACTOR_SETTING,
	exercises,
	getDb,
	otherSessionRecords,
	plannedSessions,
	programBlocks,
	programs,
	programVersions,
	programWeeks,
	recoveryNotes,
	runRecords,
	runRecordSegments,
	setRecords,
	trainingAudit,
	WORKOUT_KINDS,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import * as logSchema from '../../../src/lib/server/db/schema/training-log';
import { restrictRefusalCode, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Every table training-log.ts defines, so a new one cannot miss its guards. */
const TABLES = Object.values(logSchema)
	.filter((value) => is(value, PgTable))
	.map((table) => getTableName(table))
	.sort();

type Logged =
	| 'workouts'
	| 'set_records'
	| 'run_records'
	| 'run_record_segments'
	| 'other_session_records'
	| 'recovery_notes'
	| 'workout_substitutions';
type Table = Logged | 'training_audit';

/** The column each logged table's audit rows name their row by. */
const KEY: Record<Logged, string> = {
	workouts: 'id',
	set_records: 'id',
	run_records: 'workout_id',
	run_record_segments: 'id',
	other_session_records: 'workout_id',
	recovery_notes: 'id',
	workout_substitutions: 'id'
};
const LOGGED = Object.keys(KEY).sort() as Logged[];

type Row = Record<string, unknown>;

const INSERT: Record<Table, (tx: Executor, row: Row) => Promise<unknown>> = {
	workouts: (tx, row) => tx.insert(workouts).values(row as never),
	set_records: (tx, row) => tx.insert(setRecords).values(row as never),
	run_records: (tx, row) => tx.insert(runRecords).values(row as never),
	run_record_segments: (tx, row) => tx.insert(runRecordSegments).values(row as never),
	other_session_records: (tx, row) => tx.insert(otherSessionRecords).values(row as never),
	recovery_notes: (tx, row) => tx.insert(recoveryNotes).values(row as never),
	workout_substitutions: (tx, row) => tx.insert(workoutSubstitutions).values(row as never),
	training_audit: (tx, row) => tx.insert(trainingAudit).values(row as never)
};

const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-15';
/** A time on Tuesday 10 November 2026, in UTC. */
const at = (time: string) => new Date(`2026-11-10T${time}:00Z`);
const deviceId = () => crypto.randomUUID();

// ---- fixtures -------------------------------------------------------------------------------

/** A planned session to log against: one program, version, block, week and session. */
async function storePlan(db: Executor, ownerId: string) {
	const [program] = await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning();
	const programId = program!.id;
	await db.insert(programVersions).values({
		programId,
		number: 1,
		createdBy: 'rules',
		summary: 'Your first program',
		startsOn: MONDAY,
		firstPlannedDay: MONDAY
	});
	const [block] = await db
		.insert(programBlocks)
		.values({
			programId,
			position: 1,
			phase: 'baseline',
			name: 'Baseline',
			startsOn: MONDAY,
			endsOn: SUNDAY
		})
		.returning();
	const [week] = await db
		.insert(programWeeks)
		.values({
			blockId: block!.id,
			indexInBlock: 1,
			startsOn: MONDAY,
			endsOn: SUNDAY,
			kind: 'baseline'
		})
		.returning();
	const [session] = await db
		.insert(plannedSessions)
		.values({
			weekId: week!.id,
			scheduledOn: '2026-11-10',
			discipline: 'strength',
			sessionType: 'strength',
			title: 'Full body A',
			estMinutes: 60,
			intensity: 'moderate',
			source: 'generator'
		})
		.returning();
	return { programId, sessionId: session!.id, lineageId: session!.lineageId };
}

const done = { status: 'completed', startedAt: at('17:00'), finishedAt: at('18:00') } as const;

/**
 * One row in every logged table: a planned strength workout with a 225 lb set and a swap, an
 * interval run with its record and first segment, a Muay Thai class with its details, and a
 * recovery note. A run and a mobility session with no details yet take the 1:1 tables' inserts.
 */
async function storeLog(db: Executor) {
	const ownerId = await makeOwner(db);
	const plan = await storePlan(db, ownerId);
	const library = await db
		.select({ id: exercises.id, key: exercises.key })
		.from(exercises)
		.where(inArray(exercises.key, ['back_squat', 'front_squat']));
	const exercise = (key: string) => library.find((row) => row.key === key)!.id;
	const squat = exercise('back_squat');
	const frontSquat = exercise('front_squat');

	type Values = Omit<typeof workouts.$inferInsert, 'ownerId' | 'clientId' | keyof typeof done>;
	const workout = async (values: Values) => {
		const [row] = await db
			.insert(workouts)
			.values({ ownerId, clientId: deviceId(), ...done, ...values })
			.returning();
		return row!.id;
	};
	const strength = await workout({
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: 'Full body A',
		plannedSessionId: plan.sessionId,
		plannedLineageId: plan.lineageId,
		programId: plan.programId,
		durationSeconds: 3600,
		sessionRpe: 7.5
	});
	const run = await workout({
		kind: 'run',
		discipline: 'running',
		sessionType: 'interval_run',
		title: 'Intervals'
	});
	const bareRun = await workout({
		kind: 'run',
		discipline: 'running',
		sessionType: 'easy_run',
		title: 'Easy run'
	});
	const other = await workout({
		kind: 'other',
		discipline: 'muay_thai',
		sessionType: 'muay_thai',
		title: 'Muay Thai class'
	});
	const bareOther = await workout({
		kind: 'other',
		discipline: 'athletic',
		sessionType: 'mobility',
		title: 'Mobility'
	});

	const [set] = await db
		.insert(setRecords)
		.values({
			ownerId,
			clientMutationId: deviceId(),
			workoutId: strength,
			exerciseId: squat,
			exercisePosition: 1,
			setIndex: 1,
			weight: 225,
			unit: 'lb',
			reps: 5,
			rpe: 8,
			e1rmKg: 125.84,
			performedAt: at('17:20')
		})
		.returning();
	await db
		.insert(runRecords)
		.values({ ownerId, workoutId: run, distanceMetres: 5000, durationSeconds: 1500, avgHr: 150 });
	const [segment] = await db
		.insert(runRecordSegments)
		.values({
			ownerId,
			clientMutationId: deviceId(),
			workoutId: run,
			position: 1,
			kind: 'warm_up',
			distanceMetres: 1000,
			durationSeconds: 360,
			rpe: 3
		})
		.returning();
	await db.insert(otherSessionRecords).values({
		ownerId,
		workoutId: other,
		kind: 'class',
		durationMinutes: 90,
		rpe: 8,
		metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }]
	});
	const [note] = await db
		.insert(recoveryNotes)
		.values({
			ownerId,
			clientMutationId: deviceId(),
			notedOn: '2026-11-11',
			sleepHours: 7.5,
			soreness: 3,
			energy: 4,
			stress: 2
		})
		.returning();
	const [swap] = await db
		.insert(workoutSubstitutions)
		.values({
			ownerId,
			clientMutationId: deviceId(),
			workoutId: strength,
			fromExerciseId: frontSquat,
			toExerciseId: squat,
			reason: 'equipment_unavailable'
		})
		.returning();
	return {
		ownerId,
		...plan,
		squat,
		frontSquat,
		strength,
		run,
		bareRun,
		other,
		bareOther,
		set: set!.id,
		segment: segment!.id,
		note: note!.id,
		swap: swap!.id
	};
}

type Log = Awaited<ReturnType<typeof storeLog>>;

/** storeLog's row in each logged table, by the id its audit rows carry. */
const rowIds = (log: Log): Record<Logged, string> => ({
	workouts: log.strength,
	set_records: String(log.set),
	run_records: log.run,
	run_record_segments: log.segment,
	other_session_records: log.other,
	recovery_notes: log.note,
	workout_substitutions: log.swap
});

/** A valid new row for each table, with fresh device ids; the 1:1 rows go to the bare workouts. */
const rowsFor = (log: Log): Record<Table, () => Row> => ({
	workouts: () => ({
		ownerId: log.ownerId,
		clientId: deviceId(),
		...done,
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: 'Full body B',
		durationSeconds: 3600,
		sessionRpe: 7
	}),
	set_records: () => ({
		ownerId: log.ownerId,
		clientMutationId: deviceId(),
		workoutId: log.strength,
		exerciseId: log.squat,
		exercisePosition: 1,
		setIndex: 2,
		weight: 100,
		unit: 'kg',
		reps: 5,
		rpe: 8,
		e1rmKg: 123.3,
		performedAt: at('17:25')
	}),
	run_records: () => ({
		ownerId: log.ownerId,
		workoutId: log.bareRun,
		distanceMetres: 8000,
		durationSeconds: 2700,
		avgHr: 140,
		rpe: 4
	}),
	run_record_segments: () => ({
		ownerId: log.ownerId,
		clientMutationId: deviceId(),
		workoutId: log.run,
		position: 2,
		kind: 'interval',
		distanceMetres: 400,
		durationSeconds: 90,
		avgHr: 172,
		rpe: 8.5
	}),
	other_session_records: () => ({
		ownerId: log.ownerId,
		workoutId: log.bareOther,
		kind: 'mobility',
		durationMinutes: 30,
		rpe: 3,
		metrics: []
	}),
	recovery_notes: () => ({
		ownerId: log.ownerId,
		clientMutationId: deviceId(),
		notedOn: '2026-11-12',
		sleepHours: 8,
		soreness: 2,
		energy: 4,
		stress: 1,
		note: 'Slept well.'
	}),
	workout_substitutions: () => ({
		ownerId: log.ownerId,
		clientMutationId: deviceId(),
		workoutId: log.strength,
		plannedExerciseLineageId: deviceId(),
		fromExerciseId: log.frontSquat,
		toExerciseId: log.squat,
		reason: 'situational'
	}),
	training_audit: () => ({
		ownerId: log.ownerId,
		tableName: 'set_records',
		rowId: String(log.set),
		action: 'update',
		before: {},
		after: {},
		actor: 'owner'
	})
});

// ---- reading --------------------------------------------------------------------------------

/** A stored row as the audit trigger sees it (to_jsonb: timestamps to the microsecond). */
async function rowOf(db: Executor, table: Logged, rowId: string) {
	const { rows } = await db.execute<{ row: Row }>(
		sql`select to_jsonb(t) as row from ${sql.identifier(table)} t
			where ${sql.identifier(KEY[table])} = ${rowId}`
	);
	return rows[0]?.row;
}

/** A row's audit trail, oldest first. */
function auditOf(db: Executor, table: Table, rowId: string) {
	return db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, rowId)))
		.orderBy(asc(trainingAudit.id));
}

/** Whether a row's updated_at has moved past its created_at, to the microsecond. */
async function moved(db: Executor, table: Logged, rowId: string) {
	const { rows } = await db.execute<{ moved: boolean }>(
		sql`select updated_at > created_at as moved from ${sql.identifier(table)}
			where ${sql.identifier(KEY[table])} = ${rowId}`
	);
	return rows[0]!.moved;
}

async function counts(db: Executor) {
	const result: Record<string, number> = {};
	for (const table of TABLES) {
		const { rows } = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(table)}`
		);
		result[table] = rows[0]!.n;
	}
	return result;
}

type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/**
 * Run `write` in a savepoint that is always undone, so the test's transaction carries on: the
 * Postgres error it failed with (drizzle wraps it as the cause), or null when it was accepted.
 */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });

const setActor = (db: Executor, actor: string) =>
	db.execute(sql`select set_config(${AUDIT_ACTOR_SETTING}, ${actor}, true)`);

// ---- edits ----------------------------------------------------------------------------------

/** One real edit of storeLog's row in each logged table. */
const edits = (log: Log): Record<Logged, SQL> => ({
	workouts: sql`update workouts set notes = 'Felt strong' where id = ${log.strength}`,
	// A new weight: weight_kg is worked out again.
	set_records: sql`update set_records set weight = 230, reps = 3 where id = ${log.set}`,
	run_records: sql`update run_records set distance_m = 5200 where workout_id = ${log.run}`,
	run_record_segments: sql`update run_record_segments set rpe = 4 where id = ${log.segment}`,
	other_session_records: sql`update other_session_records
		set metrics = '[{"key": "rounds", "label": "Rounds", "unit": null, "value": 5}]'
		where workout_id = ${log.other}`,
	recovery_notes: sql`update recovery_notes set energy = 2 where id = ${log.note}`,
	workout_substitutions: sql`update workout_substitutions set reason = 'pain' where id = ${log.swap}`
});

/**
 * UPDATEs of storeLog's rows that change nothing: a column set to itself, the stored values
 * written again (the generated weight_kg and paces then worked out again, to the same values),
 * and updated_at alone.
 */
const noops = (log: Log): Record<Logged, SQL[]> => {
	const ids = rowIds(log);
	const touch = (table: Logged) =>
		sql`update ${sql.identifier(table)} set updated_at = now() + interval '1 day'
			where ${sql.identifier(KEY[table])} = ${ids[table]}`;
	const same: Record<Logged, SQL> = {
		workouts: sql`update workouts set session_rpe = 7.5, status = 'completed', title = title
			where id = ${log.strength}`,
		set_records: sql`update set_records set weight = 225, unit = 'lb', reps = 5 where id = ${log.set}`,
		run_records: sql`update run_records set distance_m = 5000, duration_s = 1500
			where workout_id = ${log.run}`,
		run_record_segments: sql`update run_record_segments set distance_m = 1000, duration_s = 360
			where id = ${log.segment}`,
		other_session_records: sql`update other_session_records set metrics = metrics, rpe = 8
			where workout_id = ${log.other}`,
		recovery_notes: sql`update recovery_notes set sleep_hours = 7.5 where id = ${log.note}`,
		workout_substitutions: sql`update workout_substitutions set reason = 'equipment_unavailable'
			where id = ${log.swap}`
	};
	return Object.fromEntries(LOGGED.map((table) => [table, [same[table], touch(table)]])) as Record<
		Logged,
		SQL[]
	>;
};

// ---- the shared table of values -------------------------------------------------------------

/** [what is wrong, the change to a valid row, the CHECK it breaks without its table and _ck]. */
type Bad = [string, Row, string];

const RPE: (field: string) => Bad[] = (field) => [
	['RPE 0.5', { [field]: 0.5 }, field === 'sessionRpe' ? 'session_rpe' : 'rpe'],
	['RPE 10.5', { [field]: 10.5 }, field === 'sessionRpe' ? 'session_rpe' : 'rpe'],
	['RPE off the half steps', { [field]: 7.3 }, field === 'sessionRpe' ? 'session_rpe' : 'rpe']
];
const HEART_RATE: Bad[] = [
	['a heart rate of 19', { avgHr: 19 }, 'avg_hr'],
	['a heart rate of 251', { avgHr: 251 }, 'avg_hr']
];

/** Per table, per CHECK: the values Postgres must refuse. */
function badValues(log: Log): Record<Table, Bad[]> {
	const planned = {
		plannedSessionId: log.sessionId,
		plannedLineageId: log.lineageId,
		programId: log.programId
	};
	return {
		workouts: [
			['an unknown kind', { kind: 'swim' }, 'kind'],
			['an unknown status', { status: 'paused' }, 'status'],
			['an empty title', { title: '' }, 'title'],
			['a session without its lineage', { ...planned, plannedLineageId: null }, 'plan'],
			['a lineage without its session', { ...planned, plannedSessionId: null }, 'plan'],
			['a planned session without its program', { ...planned, programId: null }, 'plan'],
			['completed with no finish', { finishedAt: null }, 'finished'],
			['in progress yet finished', { status: 'in_progress' }, 'finished'],
			['finished before it started', { finishedAt: at('16:59') }, 'times'],
			['a 0 s workout', { durationSeconds: 0 }, 'duration'],
			...RPE('sessionRpe')
		],
		set_records: [
			['exercise 0', { exercisePosition: 0 }, 'exercise_position'],
			['set 0', { setIndex: 0 }, 'set_index'],
			['an unknown unit', { unit: 'st' }, 'unit'],
			['0 kg', { weight: 0 }, 'weight'],
			['a negative weight', { weight: -2.5 }, 'weight'],
			['negative reps', { reps: -1 }, 'reps'],
			['negative missed reps', { missedReps: -1 }, 'missed_reps'],
			['51 missed reps', { reps: 0, missedReps: 51 }, 'missed_reps'],
			['missed reps on a timed set', { reps: null, seconds: 30, missedReps: 1 }, 'missed_reps'],
			['a 0 s hold', { reps: null, seconds: 0 }, 'seconds'],
			['a hold over a day', { reps: null, seconds: 86_401 }, 'seconds'],
			['a 0 m carry', { reps: null, metres: 0 }, 'metres'],
			['nothing recorded on a set that is not skipped', { reps: null }, 'measure'],
			['0 kg of assistance', { weight: null, assistance: 0 }, 'assistance'],
			['a weight beside an assistance', { assistance: 20 }, 'load'],
			...RPE('rpe'),
			['an e1RM of 0', { e1rmKg: 0 }, 'e1rm'],
			['an e1RM from a warm-up', { isWarmup: true }, 'e1rm'],
			['an e1RM from a skipped set', { isSkipped: true }, 'e1rm']
		],
		run_records: [
			['a 0 m run', { distanceMetres: 0 }, 'distance'],
			['a 0 s run', { durationSeconds: 0 }, 'duration'],
			...HEART_RATE,
			...RPE('rpe')
		],
		run_record_segments: [
			['position 0', { position: 0 }, 'position'],
			['neither distance nor duration', { distanceMetres: null, durationSeconds: null }, 'measure'],
			['a 0 m segment', { distanceMetres: 0 }, 'distance'],
			['a 0 s segment', { durationSeconds: 0 }, 'duration'],
			...HEART_RATE,
			...RPE('rpe')
		],
		other_session_records: [
			['a 0-minute session', { durationMinutes: 0 }, 'duration'],
			...RPE('rpe'),
			['metrics as an object', { metrics: { rounds: 6 } }, 'metrics'],
			['metrics as a number', { metrics: 6 }, 'metrics']
		],
		recovery_notes: [
			['negative sleep', { sleepHours: -0.5 }, 'sleep'],
			['more than a day of sleep', { sleepHours: 24.5 }, 'sleep'],
			['soreness 0', { soreness: 0 }, 'soreness'],
			['soreness 6', { soreness: 6 }, 'soreness'],
			['energy 0', { energy: 0 }, 'energy'],
			['energy 6', { energy: 6 }, 'energy'],
			['stress 0', { stress: 0 }, 'stress'],
			['stress 6', { stress: 6 }, 'stress'],
			['an empty note', { note: '' }, 'note'],
			[
				'nothing noted',
				{ sleepHours: null, soreness: null, energy: null, stress: null, note: null },
				'content'
			]
		],
		workout_substitutions: [
			['a swap for the same exercise', { toExerciseId: log.frontSquat }, 'exercises'],
			['slot 0', { exercisePosition: 0 }, 'exercise_position']
		],
		training_audit: [
			['an unknown action', { action: 'insert' }, 'action'],
			['an unknown actor', { actor: 'assistant' }, 'actor']
		]
	};
}

/** [what is at the edge, the change to a valid row]: Postgres must accept it. */
type Good = [string, Row];

function goodValues(log: Log): Record<Table, Good[]> {
	return {
		workouts: [
			['in progress', { status: 'in_progress', finishedAt: null, sessionRpe: null }],
			['abandoned', { status: 'abandoned' }],
			[
				'logged against the plan',
				{
					plannedSessionId: log.sessionId,
					plannedLineageId: log.lineageId,
					programId: log.programId
				}
			],
			['logged in a program, off plan', { programId: log.programId }],
			['finished as it started', { finishedAt: at('17:00') }],
			['a 1 s workout', { durationSeconds: 1 }],
			['no duration or RPE yet', { durationSeconds: null, sessionRpe: null }],
			['RPE 1', { sessionRpe: 1 }],
			['RPE 10', { sessionRpe: 10 }],
			['RPE 9.5', { sessionRpe: 9.5 }],
			// Open lists, which the services validate.
			['a discipline of its own', { kind: 'other', discipline: 'climbing' }],
			['a session type of its own', { sessionType: 'bouldering' }]
		],
		set_records: [
			['a missed single: no rep done, one missed', { reps: 0, missedReps: 1, e1rmKg: null }],
			['2 of 5 done', { reps: 2, missedReps: 3 }],
			['50 missed reps', { reps: 0, missedReps: 50, e1rmKg: null }],
			['a bodyweight set', { weight: null, e1rmKg: null }],
			['a 60 s plank', { weight: null, reps: null, seconds: 60, e1rmKg: null }],
			['a 40 m carry, timed', { reps: null, metres: 40, seconds: 35, e1rmKg: null }],
			['a day-long hold', { weight: null, reps: null, seconds: 86_400, e1rmKg: null }],
			['an assisted set', { weight: null, assistance: 20, e1rmKg: null }],
			['1.25 kg', { weight: 1.25 }],
			['9999.99 lb', { weight: 9999.99, unit: 'lb' }],
			['RPE 1', { rpe: 1 }],
			['RPE 10', { rpe: 10 }],
			['RPE 9.5', { rpe: 9.5 }],
			['no RPE', { rpe: null }],
			['an extra warm-up', { isWarmup: true, isExtra: true, e1rmKg: null }],
			['a skipped set', { isSkipped: true, weight: null, reps: null, rpe: null, e1rmKg: null }],
			['from the plan', { plannedExerciseLineageId: deviceId() }]
		],
		run_records: [
			['nothing recorded yet', { distanceMetres: null, durationSeconds: null, avgHr: null }],
			['5 mi, in metres', { distanceMetres: 8046.72 }],
			['a heart rate of 20', { avgHr: 20 }],
			['a heart rate of 250', { avgHr: 250 }],
			['RPE 1', { rpe: 1 }],
			['RPE 10', { rpe: 10 }]
		],
		run_record_segments: [
			['a distance only', { durationSeconds: null }],
			['a duration only', { distanceMetres: null }],
			['a heart rate of 20', { avgHr: 20 }],
			['a heart rate of 250', { avgHr: 250 }],
			['RPE 1', { rpe: 1 }],
			['RPE 10', { rpe: 10 }],
			['a kind of its own', { kind: 'strides' }]
		],
		other_session_records: [
			['1 minute', { durationMinutes: 1 }],
			['no RPE', { rpe: null }],
			['RPE 10', { rpe: 10 }],
			['metrics', { metrics: [{ key: 'sparring', label: 'Sparring', unit: null, value: true }] }],
			['a kind of its own', { kind: 'clinch_rounds' }]
		],
		recovery_notes: [
			[
				'only a note',
				{ sleepHours: null, soreness: null, energy: null, stress: null, note: 'Tight hips.' }
			],
			['no sleep', { sleepHours: 0 }],
			['a whole day', { sleepHours: 24 }],
			['every scale at 1', { soreness: 1, energy: 1, stress: 1 }],
			['every scale at 5', { soreness: 5, energy: 5, stress: 5 }]
		],
		workout_substitutions: [
			['off plan', { plannedExerciseLineageId: null }],
			['in its slot', { exercisePosition: 3 }],
			['a reason of its own', { reason: 'too_crowded' }]
		],
		training_audit: [
			['a delete', { action: 'delete' }],
			['a restore', { action: 'restore' }],
			['by the coach', { actor: 'coach' }],
			['by the rules', { actor: 'rules' }]
		]
	};
}

/** A CHECK's full name. */
const checkName = (table: Table, check: string) => `${table}_${check}_ck`;

// ---- tests ----------------------------------------------------------------------------------

describe('training log rows', () => {
	it('store a device id once in every table that takes one; a replay is a conflict, not a row', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const rows = rowsFor(log);
			/** The column a device replays by, and the index (or key) that refuses a second row. */
			const replayKeys: Partial<Record<Logged, [string, string]>> = {
				workouts: ['clientId', 'workouts_client_id_uq'],
				set_records: ['clientMutationId', 'set_records_client_mutation_id_uq'],
				run_record_segments: ['clientMutationId', 'run_record_segments_client_mutation_id_uq'],
				recovery_notes: ['clientMutationId', 'recovery_notes_client_mutation_id_uq'],
				workout_substitutions: ['clientMutationId', 'workout_substitutions_client_mutation_id_uq'],
				// One record per workout.
				run_records: ['workoutId', 'run_records_pkey'],
				other_session_records: ['workoutId', 'other_session_records_pkey']
			};
			expect(Object.keys(replayKeys).sort()).toEqual(LOGGED);

			for (const [table, [field, index]] of Object.entries(replayKeys) as [
				Logged,
				[string, string]
			][]) {
				const first = rows[table]();
				await INSERT[table](db, first);
				// The same device id with another payload: the stored row stays the only one.
				const replay = { ...rows[table](), [field]: first[field] };
				expect(await attempt(db, (tx) => INSERT[table](tx, replay)), table).toEqual(
					refused('23505', table, index)
				);
			}

			// The unique index is what m3/30's ON CONFLICT DO NOTHING turns into a no-op.
			const set = rows.set_records();
			await INSERT.set_records(db, set);
			const again = await db
				.insert(setRecords)
				.values({ ...(set as typeof setRecords.$inferInsert), weight: 105 })
				.onConflictDoNothing({ target: setRecords.clientMutationId })
				.returning();
			expect(again).toEqual([]);
			const stored = await db
				.select({ weight: setRecords.weight })
				.from(setRecords)
				.where(eq(setRecords.clientMutationId, set.clientMutationId as string));
			expect(stored).toEqual([{ weight: 100 }]);
		});
	});

	it('keep a weight as entered beside its exact weight in kg, and work out each pace', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const rows = rowsFor(log);

			const [lb] = await db.select().from(setRecords).where(eq(setRecords.id, log.set));
			expect(lb).toMatchObject({ weight: 225, unit: 'lb', weightKg: 102.05828325 });
			const exact = await db.execute<{ kg: string }>(
				sql`select weight_kg::text as kg from set_records where id = ${log.set}`
			);
			expect(exact.rows[0]!.kg).toBe('102.0582832500');

			const [kg] = await db
				.insert(setRecords)
				.values({ ...(rows.set_records() as typeof setRecords.$inferInsert), weight: 102.5 })
				.returning();
			expect(kg).toMatchObject({ weight: 102.5, unit: 'kg', weightKg: 102.5 });
			const [bodyweight] = await db
				.insert(setRecords)
				.values({
					...(rows.set_records() as typeof setRecords.$inferInsert),
					weight: null,
					e1rmKg: null
				})
				.returning();
			expect(bodyweight).toMatchObject({ weight: null, unit: 'kg', weightKg: null });

			// 5 km in 25:00 is 5:00 per km; 5 mi (exactly 8046.72 m) in 40:00 is just under 4:59.
			const [run] = await db.select().from(runRecords).where(eq(runRecords.workoutId, log.run));
			expect(run!.paceSecondsPerKm).toBe(300);
			const [miles] = await db
				.insert(runRecords)
				.values({ ownerId: log.ownerId, workoutId: log.bareRun, distanceMetres: 8046.72 })
				.returning();
			expect(miles).toMatchObject({ distanceMetres: 8046.72, paceSecondsPerKm: null });
			await db
				.update(runRecords)
				.set({ durationSeconds: 2400 })
				.where(eq(runRecords.workoutId, log.bareRun));
			const [timed] = await db
				.select()
				.from(runRecords)
				.where(eq(runRecords.workoutId, log.bareRun));
			expect(timed!.paceSecondsPerKm).toBeCloseTo((2400 * 1000) / 8046.72, 10);
			const [segment] = await db
				.select()
				.from(runRecordSegments)
				.where(eq(runRecordSegments.id, log.segment));
			expect(segment!.paceSecondsPerKm).toBe(360);
		});
	});

	it('are refused by the CHECKs for every bad value in one table', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const rows = rowsFor(log);
			for (const [table, cases] of Object.entries(badValues(log)) as [Table, Bad[]][]) {
				for (const [what, change, check] of cases) {
					const row = { ...rows[table](), ...change };
					expect(await attempt(db, (tx) => INSERT[table](tx, row)), `${table}: ${what}`).toEqual(
						refused('23514', table, checkName(table, check))
					);
				}
			}
		});
	});

	it('are accepted at every edge, and the open lists stay open', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const rows = rowsFor(log);
			for (const [table, cases] of Object.entries(goodValues(log)) as [Table, Good[]][]) {
				for (const [what, change] of cases) {
					const row = { ...rows[table](), ...change };
					expect(await attempt(db, (tx) => INSERT[table](tx, row)), `${table}: ${what}`).toBeNull();
				}
			}
		});
	});

	it('have no CHECK that the shared table leaves out', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const tables = sql.join(
				TABLES.map((table) => sql`${table}`),
				sql`, `
			);
			const { rows } = await db.execute<{ name: string }>(
				sql`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid
					where c.contype = 'c' and t.relname in (${tables})`
			);
			const shared = Object.entries(badValues(log)).flatMap(([table, cases]) =>
				cases.map(([, , check]) => checkName(table as Table, check))
			);
			expect(rows.map((row) => row.name).sort()).toEqual([...new Set(shared)].sort());
			expect(TABLES).toEqual([...LOGGED, 'training_audit'].sort());
		});
	});

	it('read as the metrics inputs and the plan contract name them', () => {
		expectTypeOf<(typeof WORKOUT_KINDS)[number]>().toEqualTypeOf<SessionKind>();
		type SetRow = typeof setRecords.$inferSelect;
		type Fields = Exclude<keyof LoggedSet, 'exercise'>;
		expectTypeOf<Pick<SetRow, Fields>>().toEqualTypeOf<Omit<LoggedSet, 'exercise'>>();
		type WorkoutRow = typeof workouts.$inferSelect;
		expectTypeOf<Pick<WorkoutRow, keyof LoggedSessionLoad>>().toEqualTypeOf<LoggedSessionLoad>();
		expect([...WORKOUT_KINDS].sort()).toEqual(['other', 'run', 'strength']);
	});
});

describe('training log edits', () => {
	it('audit every UPDATE that changes a row, once, with its before, after, actor and owner', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const ids = rowIds(log);
			const statements = edits(log);
			expect(Object.keys(statements).sort()).toEqual(LOGGED);

			for (const table of LOGGED) {
				const before = await rowOf(db, table, ids[table]);
				await db.execute(statements[table]);
				const after = await rowOf(db, table, ids[table]);
				expect(after, table).not.toEqual(before);
				expect(await auditOf(db, table, ids[table]), table).toEqual([
					expect.objectContaining({
						ownerId: log.ownerId,
						tableName: table,
						rowId: ids[table],
						action: 'update',
						actor: 'owner',
						before,
						after
					})
				]);
				expect(await moved(db, table, ids[table]), table).toBe(true);
			}

			// The after row is the stored one, its generated weight in kg worked out again.
			const [set] = await auditOf(db, 'set_records', ids.set_records);
			expect(set!.before).toMatchObject({ weight: 225, reps: 5, weight_kg: 102.05828325 });
			expect(set!.after).toMatchObject({ weight: 230, reps: 3, weight_kg: 104.3262451 });
			// Each audit row is stamped with the updated_at its edit gave the row.
			const { rows } = await db.execute<{ stamped: boolean; n: number }>(
				sql`select bool_and(changed_at = (after ->> 'updated_at')::timestamptz) as stamped,
					count(*)::int as n from training_audit`
			);
			expect(rows[0]).toEqual({ stamped: true, n: LOGGED.length });
		});
	});

	it('leave no trace of an UPDATE that changes nothing: no audit row, updated_at unchanged', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const ids = rowIds(log);
			const statements = noops(log);

			for (const table of LOGGED) {
				const before = await rowOf(db, table, ids[table]);
				for (const statement of statements[table]) await db.execute(statement);
				expect(await rowOf(db, table, ids[table]), table).toEqual(before);
				expect(await auditOf(db, table, ids[table]), table).toEqual([]);
				expect(await moved(db, table, ids[table]), table).toBe(false);
			}
		});
	});

	it('own updated_at: an edit is stamped when it runs, whatever the statement sets', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			await db.execute(
				sql`update set_records set reps = 4, updated_at = '2000-01-01T00:00:00Z' where id = ${log.set}`
			);
			expect(await moved(db, 'set_records', String(log.set))).toBe(true);
			expect(await auditOf(db, 'set_records', String(log.set))).toHaveLength(1);
		});
	});

	it('record who edited from app.actor, the owner by default, and refuse an unknown actor', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const row = String(log.set);
			const reps = (n: number) => sql`update set_records set reps = ${n} where id = ${log.set}`;

			await setActor(db, 'coach');
			await db.execute(reps(4));
			await setActor(db, '');
			await db.execute(reps(3));
			await setActor(db, 'assistant');
			expect(await attempt(db, (tx) => tx.execute(reps(2)))).toEqual(
				refused('23514', 'training_audit', 'training_audit_actor_ck')
			);

			const audit = await auditOf(db, 'set_records', row);
			expect(audit.map((a) => [a.actor, a.after.reps])).toEqual([
				['coach', 4],
				['owner', 3]
			]);
			const [set] = await db.select().from(setRecords).where(eq(setRecords.id, log.set));
			expect(set!.reps).toBe(3);
		});
	});

	it('audit a soft delete and a restore, write nothing for a replayed delete, refuse a hard one', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const ids = rowIds(log);
			// A replayed delete keeps the stored deletion, as m3/30's deleteSet does.
			const softDelete = (table: 'set_records' | 'workouts', id: string | number) =>
				sql`update ${sql.identifier(table)}
					set deleted_at = coalesce(deleted_at, statement_timestamp()) where id = ${id}`;

			await db.execute(softDelete('set_records', log.set));
			await db.execute(softDelete('set_records', log.set));
			await db.execute(sql`update set_records set deleted_at = null where id = ${log.set}`);
			await db.execute(softDelete('workouts', log.strength));
			const actions = async (table: Logged) =>
				(await auditOf(db, table, ids[table])).map((a) => [
					a.action,
					a.before.deleted_at === null,
					a.after.deleted_at === null
				]);
			expect(await actions('set_records')).toEqual([
				['delete', true, false],
				['restore', false, true]
			]);
			expect(await actions('workouts')).toEqual([['delete', true, false]]);

			const before = await counts(db);
			for (const table of LOGGED) {
				const statement = sql`delete from ${sql.identifier(table)}
					where ${sql.identifier(KEY[table])} = ${ids[table]}`;
				expect(await attempt(db, (tx) => tx.execute(statement)), table).toEqual(
					refused('23001', table, 'history_refuse_delete')
				);
			}
			// The owner's ON DELETE CASCADE reaches the log, whose guards refuse it.
			expect(
				await attempt(db, (tx) => tx.execute(sql`delete from owners where id = ${log.ownerId}`))
			).toMatchObject({ code: '23001', constraint: 'history_refuse_delete' });
			expect(await counts(db)).toEqual(before);
		});
	});

	it('never change or delete an audit row', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			await db.execute(edits(log).set_records);
			const trail = await auditOf(db, 'set_records', String(log.set));
			const audit = trail[0]!.id;

			for (const statement of [
				sql`update training_audit set actor = 'coach' where id = ${audit}`,
				sql`update training_audit set after = before where id = ${audit}`,
				sql`update training_audit set changed_at = changed_at where id = ${audit}`
			]) {
				expect(await attempt(db, (tx) => tx.execute(statement))).toEqual(
					refused('23001', 'training_audit', 'training_audit_refuse_update')
				);
			}
			expect(
				await attempt(db, (tx) => tx.execute(sql`delete from training_audit where id = ${audit}`))
			).toEqual(refused('23001', 'training_audit', 'history_refuse_delete'));
			expect(await auditOf(db, 'set_records', String(log.set))).toEqual(trail);
		});
	});

	it('keep an exercise that a logged set or a substitution names; one nothing names can go', async () => {
		await withRollback(async (db) => {
			const log = await storeLog(db);
			const rows = rowsFor(log);
			const custom = async (name: string) => {
				const [row] = await db
					.insert(exercises)
					.values({
						ownerId: log.ownerId,
						name,
						pattern: 'mobility',
						primaryMuscles: ['glutes'],
						skillLevel: 'beginner',
						measure: 'reps',
						loadType: 'none'
					})
					.returning();
				return row!.id;
			};
			const lifted = await custom('Banded hip walk');
			const replaced = await custom('Monster walk');
			const swappedIn = await custom('Clamshell');
			const unused = await custom('Fire hydrant');
			await INSERT.set_records(db, { ...rows.set_records(), exerciseId: lifted });
			await INSERT.workout_substitutions(db, {
				...rows.workout_substitutions(),
				fromExerciseId: replaced,
				toExerciseId: swappedIn
			});
			const remove = (id: string) => (tx: Executor) =>
				tx.delete(exercises).where(eq(exercises.id, id));
			// All three keys are ON DELETE RESTRICT, whose refusal code depends on the server major.
			const restrict = await restrictRefusalCode(db);

			expect(await attempt(db, remove(lifted))).toEqual(
				refused(restrict, 'set_records', 'set_records_exercise_id_exercises_id_fk')
			);
			expect(await attempt(db, remove(replaced))).toEqual(
				refused(
					restrict,
					'workout_substitutions',
					'workout_substitutions_from_exercise_id_exercises_id_fk'
				)
			);
			expect(await attempt(db, remove(swappedIn))).toEqual(
				refused(
					restrict,
					'workout_substitutions',
					'workout_substitutions_to_exercise_id_exercises_id_fk'
				)
			);
			expect(await attempt(db, remove(unused))).toBeNull();
		});
	});
});

describe('training log structure', () => {
	/**
	 * The history queries' indexes, as Postgres prints them. A bare DESC is DESC NULLS FIRST, the
	 * order an ORDER BY … DESC asks for; drizzle's .desc() alone would write NULLS LAST, which
	 * such a query cannot use.
	 */
	const HISTORY_INDEXES: Record<string, string> = {
		set_records_exercise_history_idx:
			'CREATE INDEX set_records_exercise_history_idx ON public.set_records USING btree (owner_id, exercise_id, performed_at DESC, id DESC) WHERE (deleted_at IS NULL)',
		set_records_exercise_e1rm_idx:
			'CREATE INDEX set_records_exercise_e1rm_idx ON public.set_records USING btree (owner_id, exercise_id, e1rm_kg DESC) WHERE ((e1rm_kg IS NOT NULL) AND (deleted_at IS NULL))',
		set_records_exercise_rep_max_idx:
			'CREATE INDEX set_records_exercise_rep_max_idx ON public.set_records USING btree (owner_id, exercise_id, reps, weight_kg DESC) WHERE ((deleted_at IS NULL) AND (NOT is_warmup) AND (NOT is_skipped) AND (weight_kg IS NOT NULL))',
		set_records_owner_performed_idx:
			'CREATE INDEX set_records_owner_performed_idx ON public.set_records USING btree (owner_id, performed_at)',
		set_records_workout_order_idx:
			'CREATE INDEX set_records_workout_order_idx ON public.set_records USING btree (workout_id, exercise_position, set_index)',
		workouts_owner_started_idx:
			'CREATE INDEX workouts_owner_started_idx ON public.workouts USING btree (owner_id, started_at DESC) WHERE (deleted_at IS NULL)',
		workouts_owner_kind_started_idx:
			'CREATE INDEX workouts_owner_kind_started_idx ON public.workouts USING btree (owner_id, kind, started_at) WHERE (deleted_at IS NULL)',
		workouts_planned_lineage_idx:
			'CREATE INDEX workouts_planned_lineage_idx ON public.workouts USING btree (planned_lineage_id)',
		run_record_segments_run_order_idx:
			'CREATE INDEX run_record_segments_run_order_idx ON public.run_record_segments USING btree (workout_id, "position")',
		training_audit_row_idx:
			'CREATE INDEX training_audit_row_idx ON public.training_audit USING btree (owner_id, table_name, row_id)',
		workout_substitutions_workout_idx:
			'CREATE INDEX workout_substitutions_workout_idx ON public.workout_substitutions USING btree (workout_id)'
	};

	it('has every history index, in the shape the history queries use', async () => {
		const tables = sql.join(
			TABLES.map((table) => sql`${table}`),
			sql`, `
		);
		const { rows } = await getDb().execute<{ name: string; definition: string }>(
			sql`select indexname as name, indexdef as definition from pg_indexes
				where schemaname = 'public' and tablename in (${tables})`
		);
		const found = Object.fromEntries(rows.map((row) => [row.name, row.definition]));
		expect(found).toMatchObject(HISTORY_INDEXES);
		// Besides them, only the keys and the device ids' unique indexes.
		expect(Object.keys(found).sort()).toEqual(
			[
				...Object.keys(HISTORY_INDEXES),
				...TABLES.map((table) => `${table}_pkey`),
				'workouts_client_id_uq',
				...['set_records', 'run_record_segments', 'recovery_notes', 'workout_substitutions'].map(
					(table) => `${table}_client_mutation_id_uq`
				)
			].sort()
		);
	});

	it('guards every logged table and the audit trail with row triggers, and none on TRUNCATE', async () => {
		const tables = sql.join(
			TABLES.map((table) => sql`${table}`),
			sql`, `
		);
		// tgtype bit 5 (32) is TRIGGER_TYPE_TRUNCATE.
		const { rows } = await getDb().execute<{ name: string; truncate: boolean }>(
			sql`select t.tgname as name, (t.tgtype & 32) <> 0 as truncate
				from pg_trigger t join pg_class c on c.oid = t.tgrelid
				where not t.tgisinternal and c.relname in (${tables})`
		);
		expect(rows.map((row) => row.name).sort()).toEqual(
			[
				...LOGGED.flatMap((table) => [
					`${table}_touch`,
					`${table}_audit`,
					`${table}_refuse_delete`
				]),
				'training_audit_refuse_update',
				'training_audit_refuse_delete'
			].sort()
		);
		expect(rows.filter((row) => row.truncate)).toEqual([]);
	});

	it('refuses a hard delete outside a transaction too; the withCommitted cleanup clears it all', async () => {
		await withCommitted(async (db) => {
			const log = await storeLog(db);
			await db.execute(edits(log).set_records);
			const refusedDelete = await db
				.execute(sql`delete from set_records where id = ${log.set}`)
				.then(
					() => null,
					(err: unknown) => (err as { cause?: PgError }).cause
				);
			expect(refusedDelete).toMatchObject(refused('23001', 'set_records', 'history_refuse_delete'));
			expect(await counts(db)).toMatchObject({
				workouts: 5,
				set_records: 1,
				run_records: 1,
				run_record_segments: 1,
				other_session_records: 1,
				recovery_notes: 1,
				workout_substitutions: 1,
				training_audit: 1
			});
		});

		expect(await counts(getDb())).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
	});
});
