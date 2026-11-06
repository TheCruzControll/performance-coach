/**
 * Logging runs, other sessions and recovery notes on real Postgres
 * (src/lib/server/services/training/log.ts), under the replay contract m3/30 froze for sets:
 * - A create is idempotent on its device id (a run and an other session by their workout's
 *   client id, a segment and a recovery note by their client mutation ids). A replay writes
 *   nothing and returns the stored rows with duplicate: true; matches says whether its payload
 *   was the same, and the stored rows win.
 * - Edits carry absolute values: a replayed edit changes nothing, bumps no updated_at and writes
 *   no audit row; a real one writes exactly one.
 * - Distances are stored in exact metres through M1's toMetres; each pace is generated.
 * Audit assertions always filter by table and row id.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	otherSessionRecords,
	recoveryNotes,
	runRecords,
	runRecordSegments,
	trainingAudit,
	type Executor
} from '../../../src/lib/server/db';
import {
	editRecoveryNote,
	editRun,
	logOtherSession,
	logRun,
	recordRecoveryNote,
	startWorkout
} from '../../../src/lib/server/services/training/log';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** An instant on Tuesday 10 November 2026, in UTC, as a device sends it. */
const at = (time: string) => `2026-11-10T${time}:00.000Z`;
const deviceId = () => crypto.randomUUID();
const km = (value: number) => ({ value, unit: 'km' });
const metres = (value: number) => ({ value, unit: 'm' });

const RUN_START = {
	kind: 'run',
	discipline: 'running',
	sessionType: 'interval_run',
	title: 'Intervals',
	plannedSessionId: null,
	startedAt: at('06:30')
};
const MUAY_THAI_START = {
	kind: 'other',
	discipline: 'muay_thai',
	sessionType: 'muay_thai',
	title: 'Sparring',
	plannedSessionId: null,
	startedAt: at('18:00')
};

const segment = (position: number, kind: string, over: Record<string, unknown> = {}) => ({
	clientMutationId: deviceId(),
	position,
	kind,
	distance: null,
	durationSeconds: null,
	avgHr: null,
	rpe: null,
	...over
});

/** A warm-up, 6 × (400 m interval + 90 s recovery) and a cool-down, in the order run. */
const intervalSession = () => [
	segment(1, 'warm_up', { distance: km(2), durationSeconds: 720 }),
	...Array.from({ length: 6 }, (_, k) => [
		segment(2 + 2 * k, 'interval', { distance: metres(400), durationSeconds: 84, rpe: 9 }),
		segment(3 + 2 * k, 'recovery', { durationSeconds: 90 })
	]).flat(),
	segment(14, 'cool_down', { distance: km(1.5), durationSeconds: 600, avgHr: 140 })
];

const runInput = (workout: string, over: Record<string, unknown> = {}) => ({
	workoutClientId: workout,
	distance: km(8),
	durationSeconds: 2700,
	avgHr: 152,
	rpe: 8,
	notes: 'Felt sharp',
	segments: intervalSession(),
	...over
});

const otherInput = (workout: string, over: Record<string, unknown> = {}) => ({
	workoutClientId: workout,
	kind: 'sparring',
	durationMinutes: 60,
	rpe: 8,
	metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }],
	notes: null,
	...over
});

const noteValues = {
	notedOn: '2026-11-10',
	sleepHours: 7.5,
	soreness: 3,
	energy: 4,
	stress: 2,
	note: 'Calves tight after intervals'
};

/** A workout the owner starts: its client id and its row's id. */
async function start(db: Executor, owner: string, kind = RUN_START) {
	const workout = deviceId();
	const { workout: row } = await startWorkout(owner, { ...kind, clientId: workout }, { db });
	return { workout, workoutId: row.id };
}

/** The owner (there is only ever one) and a started workout of the given kind. */
async function setup(db: Executor, kind = RUN_START) {
	const owner = await makeOwner(db);
	return { owner, ...(await start(db, owner, kind)) };
}

const segmentsOf = (db: Executor, workoutId: string) =>
	db
		.select()
		.from(runRecordSegments)
		.where(eq(runRecordSegments.workoutId, workoutId))
		.orderBy(asc(runRecordSegments.position));

const auditOf = (db: Executor, table: string, rowId: string) =>
	db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, rowId)))
		.orderBy(trainingAudit.id);

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

async function fieldErrors(promise: Promise<unknown>) {
	const error = await refusal(promise);
	expect(error).toBeInstanceOf(TrainingInputError);
	return (error as TrainingInputError).errors;
}

describe('logRun: a run with its segments', () => {
	it('stores a warm-up, 6 × interval/recovery and a cool-down in order, with paces', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const segments = intervalSession();
			// Sent in any order: the positions say where each segment ran.
			const shuffled = [...segments].reverse();

			const logged = await logRun(owner, runInput(workout, { segments: shuffled }), { db });

			expect(logged).toMatchObject({ duplicate: false, matches: true });
			expect(logged.run).toMatchObject({
				workoutId,
				ownerId: owner,
				distanceMetres: 8000,
				durationSeconds: 2700,
				paceSecondsPerKm: 337.5,
				avgHr: 152,
				rpe: 8,
				notes: 'Felt sharp'
			});
			const stored = await segmentsOf(db, workoutId);
			expect(logged.segments).toEqual(stored);
			expect(stored.map((s) => s.clientMutationId)).toEqual(
				segments.map((s) => s.clientMutationId)
			);
			expect(stored.map((s) => [s.position, s.kind, s.distanceMetres, s.paceSecondsPerKm])).toEqual(
				[
					[1, 'warm_up', 2000, 360],
					...Array.from({ length: 6 }, (_, k) => [
						[2 + 2 * k, 'interval', 400, 210],
						[3 + 2 * k, 'recovery', null, null]
					]).flat(),
					[14, 'cool_down', 1500, 400]
				]
			);
			expect(stored[1]).toMatchObject({ durationSeconds: 84, rpe: 9 });
			expect(stored[13]).toMatchObject({ avgHr: 140, ownerId: owner });
		});
	});

	it('stores 5 mi as 8046.72 m, exactly', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const input = runInput(workout, {
				distance: { value: 5, unit: 'mi' },
				durationSeconds: 2400,
				segments: [
					segment(1, 'steady', { distance: { value: 1.7, unit: 'mi' } }),
					// 3.3 × 1609.344 is 5310.8351999999995 in binary floating point.
					segment(2, 'tempo', { distance: { value: 3.3, unit: 'mi' } })
				]
			});

			const { run, segments } = await logRun(owner, input, { db });

			expect(run.distanceMetres).toBe(8046.72);
			expect(segments.map((s) => s.distanceMetres)).toEqual([2735.8848, 5310.8352]);
			const [text] = await db
				.select({ distance: sql<string>`${runRecords.distanceMetres}::text` })
				.from(runRecords)
				.where(eq(runRecords.workoutId, workoutId));
			expect(text!.distance).toBe('8046.72');
			// 2400 s over 8.04672 km: the generated pace, per km.
			expect(run.paceSecondsPerKm).toBeCloseTo(298.26, 2);
		});
	});

	it('stores a replay once, and keeps the stored run when a replay differs', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const input = runInput(workout);
			const first = await logRun(owner, input, { db });

			const replay = await logRun(owner, input, { db });
			const longer = await logRun(owner, { ...input, distance: km(8.4) }, { db });
			const [warmUp, ...rest] = input.segments;
			const renamed = { ...input, segments: [{ ...warmUp!, kind: 'easy' }, ...rest] };
			const otherSegment = await logRun(owner, renamed, { db });
			const fewer = await logRun(owner, { ...input, segments: rest }, { db });

			expect(replay).toEqual({ ...first, duplicate: true, matches: true });
			for (const differs of [longer, otherSegment, fewer]) {
				expect(differs).toEqual({ ...first, duplicate: true, matches: false });
			}
			const runs = await db.select().from(runRecords).where(eq(runRecords.workoutId, workoutId));
			expect(runs).toEqual([first.run]);
			expect(await segmentsOf(db, workoutId)).toEqual(first.segments);
			expect(await auditOf(db, 'run_records', workoutId)).toEqual([]);
		});
	});

	it('stores one run when two connections send the same run at once', async () => {
		await withCommitted(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const input = runInput(workout);

			// Each call runs its own transaction on its own pooled connection.
			const results = await Promise.all([logRun(owner, input), logRun(owner, input)]);

			expect(await db.select().from(runRecords).where(eq(runRecords.workoutId, workoutId))).toEqual(
				[results[0]!.run]
			);
			expect(await segmentsOf(db, workoutId)).toHaveLength(14);
			expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
			expect(results.every((r) => r.matches)).toBe(true);
			expect(results[0]!.segments).toEqual(results[1]!.segments);
		});
	});

	it('refuses what it cannot store, and a workout that is not a run', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const [warmUp, interval] = intervalSession();
			const unmeasured = segment(3, 'easy');
			const bad = runInput(workout, {
				avgHr: 300,
				segments: [warmUp, { ...interval!, position: 1 }, unmeasured]
			});

			expect(await fieldErrors(logRun(owner, bad, { db }))).toEqual({
				avgHr: 'Heart rate between 20 and 250',
				'segments.1.position': 'Each position once',
				'segments.2.distance': 'Give a distance or a duration'
			});
			const tooFar = runInput(workout, { distance: km(501) });
			expect(await fieldErrors(logRun(owner, tooFar, { db }))).toEqual({
				'distance.value': 'Up to 500 km'
			});
			const strength = await start(db, owner, {
				...RUN_START,
				kind: 'strength',
				sessionType: 'strength'
			});
			expect(await fieldErrors(logRun(owner, runInput(strength.workout), { db }))).toEqual({
				workoutClientId: 'Not a run'
			});
			expect(await refusal(logRun(owner, runInput(deviceId()), { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			expect(await db.select().from(runRecords).where(eq(runRecords.workoutId, workoutId))).toEqual(
				[]
			);
		});
	});

	it('refuses a segment id another run already holds, and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, workout } = await setup(db);
			const first = await logRun(owner, runInput(workout), { db });
			const second = await start(db, owner);
			const reused = segment(1, 'easy', {
				clientMutationId: first.segments[3]!.clientMutationId,
				durationSeconds: 1800
			});

			const errors = await fieldErrors(
				logRun(owner, runInput(second.workout, { segments: [reused] }), { db })
			);

			expect(errors).toEqual({ 'segments.0.clientMutationId': 'Already used' });
			expect(await db.select().from(runRecords)).toEqual([first.run]);
		});
	});
});

describe('editRun: absolute values, audited once', () => {
	it('audits a real edit once; its replay writes nothing and keeps updated_at', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			const { run } = await logRun(owner, runInput(workout), { db });
			const edit = {
				distance: km(8.2),
				durationSeconds: 2700,
				avgHr: 152,
				rpe: 8.5,
				notes: 'Felt sharp; GPS cut a corner'
			};

			const first = await editRun(owner, workout, edit, { db });
			const replay = await editRun(owner, workout, edit, { db });

			expect(first).toMatchObject({
				changed: true,
				run: { distanceMetres: 8200, rpe: 8.5, notes: 'Felt sharp; GPS cut a corner' }
			});
			expect(first.run.paceSecondsPerKm).toBeCloseTo(329.27, 2);
			expect(first.run.updatedAt.getTime()).toBeGreaterThan(run.updatedAt.getTime());
			expect(replay).toEqual({ run: first.run, changed: false });
			const [stored] = await db
				.select()
				.from(runRecords)
				.where(eq(runRecords.workoutId, workoutId));
			expect(stored).toEqual(first.run);
			const audit = await auditOf(db, 'run_records', workoutId);
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({
				action: 'update',
				actor: 'owner',
				ownerId: owner,
				before: { distance_m: 8000, rpe: 8 },
				after: { distance_m: 8200, rpe: 8.5 }
			});
		});
	});

	it('edits with the same values in another unit as no change', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db);
			// 1.001 × 1000 is 1000.9999999999999 in binary floating point.
			const input = runInput(workout, { distance: km(1.001) });
			const { run } = await logRun(owner, input, { db });
			const same = {
				distance: metres(1001),
				durationSeconds: 2700,
				avgHr: 152,
				rpe: 8,
				notes: 'Felt sharp'
			};

			expect(run.distanceMetres).toBe(1001);
			expect(await editRun(owner, workout, same, { db })).toEqual({ run, changed: false });
			expect(await auditOf(db, 'run_records', workoutId)).toEqual([]);
		});
	});

	it('takes every value, and finds no run a workout has not logged', async () => {
		await withRollback(async (db) => {
			const { owner, workout } = await setup(db);
			const edit = { distance: null, durationSeconds: 1800, avgHr: null, rpe: 6, notes: null };

			const partial = editRun(owner, workout, { durationSeconds: 1800 }, { db });
			expect(Object.keys(await fieldErrors(partial))).toEqual([
				'distance',
				'avgHr',
				'rpe',
				'notes'
			]);
			expect(await refusal(editRun(owner, workout, edit, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
		});
	});
});

describe('logOtherSession: a session with the metrics the owner tracked', () => {
	it('round-trips Muay Thai sparring with its rounds, once per workout', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db, MUAY_THAI_START);
			const input = otherInput(workout, { notes: 'Worked the teep' });

			const first = await logOtherSession(owner, input, { db });
			// The same metric with its keys in another order is the same payload.
			const reordered = {
				...input,
				metrics: [{ value: 6, unit: null, label: 'Rounds', key: 'rounds' }]
			};
			const replay = await logOtherSession(owner, reordered, { db });
			const moreRounds = await logOtherSession(
				owner,
				{ ...input, metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 7 }] },
				{ db }
			);

			expect(first).toMatchObject({
				duplicate: false,
				matches: true,
				session: {
					workoutId,
					ownerId: owner,
					kind: 'sparring',
					durationMinutes: 60,
					rpe: 8,
					metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }],
					notes: 'Worked the teep'
				}
			});
			expect(replay).toEqual({ session: first.session, duplicate: true, matches: true });
			expect(moreRounds).toEqual({ session: first.session, duplicate: true, matches: false });
			const stored = await db
				.select()
				.from(otherSessionRecords)
				.where(eq(otherSessionRecords.workoutId, workoutId));
			expect(stored).toEqual([first.session]);
		});
	});

	it('refuses a bad metrics shape as a field error, before the database check', async () => {
		await withRollback(async (db) => {
			const { owner, workout, workoutId } = await setup(db, MUAY_THAI_START);
			const log = (metrics: unknown) =>
				fieldErrors(logOtherSession(owner, otherInput(workout, { metrics }), { db }));

			expect(Object.keys(await log({ rounds: 6 }))).toEqual(['metrics']);
			expect(Object.keys(await log([{ key: 'rounds', value: 6 }]))).toEqual([
				'metrics.0.label',
				'metrics.0.unit'
			]);
			const twice = [
				{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
				{ key: 'rounds', label: 'Rounds again', unit: null, value: 2 }
			];
			expect(await log(twice)).toEqual({ 'metrics.1.key': 'Each metric once' });
			const run = await start(db, owner);
			expect(await fieldErrors(logOtherSession(owner, otherInput(run.workout), { db }))).toEqual({
				workoutClientId: 'Not a Muay Thai, mobility or other session'
			});
			const stored = await db
				.select()
				.from(otherSessionRecords)
				.where(eq(otherSessionRecords.workoutId, workoutId));
			expect(stored).toEqual([]);
		});
	});
});

describe('recovery notes: one per mutation id, edited absolutely', () => {
	it('stores a note once per mutation id, and keeps it when a replay differs', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const input = { clientMutationId: deviceId(), ...noteValues };

			const first = await recordRecoveryNote(owner, input, { db });
			const replay = await recordRecoveryNote(owner, input, { db });
			const sorer = await recordRecoveryNote(owner, { ...input, soreness: 4 }, { db });

			expect(first).toMatchObject({
				duplicate: false,
				matches: true,
				note: { ownerId: owner, ...noteValues }
			});
			expect(replay).toEqual({ note: first.note, duplicate: true, matches: true });
			expect(sorer).toEqual({ note: first.note, duplicate: true, matches: false });
			const stored = await db
				.select()
				.from(recoveryNotes)
				.where(eq(recoveryNotes.clientMutationId, input.clientMutationId));
			expect(stored).toEqual([first.note]);
		});
	});

	it('refuses an empty note and values off its scales', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const empty = {
				clientMutationId: deviceId(),
				notedOn: '2026-11-10',
				sleepHours: null,
				soreness: null,
				energy: null,
				stress: null,
				note: null
			};

			expect(await fieldErrors(recordRecoveryNote(owner, empty, { db }))).toEqual({
				sleepHours: 'Record sleep, soreness, energy, stress or a note'
			});
			const off = { ...empty, sleepHours: 7.25, energy: 6 };
			expect(await fieldErrors(recordRecoveryNote(owner, off, { db }))).toEqual({
				sleepHours: 'One decimal',
				energy: 'From 1 to 5'
			});
			expect(await db.select().from(recoveryNotes)).toEqual([]);
		});
	});

	it('audits a real edit once; its replay writes nothing and keeps updated_at', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { note } = await recordRecoveryNote(
				owner,
				{ clientMutationId: deviceId(), ...noteValues },
				{ db }
			);
			const edit = { ...noteValues, soreness: 2, note: null };

			// The coach corrects it through its tools (M5).
			const coach = { db, source: 'coach' } as const;
			const first = await editRecoveryNote(owner, note.clientMutationId, edit, coach);
			const replay = await editRecoveryNote(owner, note.clientMutationId, edit, coach);

			expect(first).toMatchObject({ changed: true, note: { soreness: 2, note: null } });
			expect(first.note.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime());
			expect(replay).toEqual({ note: first.note, changed: false });
			const [stored] = await db.select().from(recoveryNotes).where(eq(recoveryNotes.id, note.id));
			expect(stored).toEqual(first.note);
			expect(await auditOf(db, 'recovery_notes', note.id)).toEqual([
				expect.objectContaining({
					action: 'update',
					actor: 'coach',
					before: expect.objectContaining({ soreness: 3 }),
					after: expect.objectContaining({ soreness: 2, note: null })
				})
			]);
			expect(await refusal(editRecoveryNote(owner, deviceId(), edit, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
		});
	});
});
