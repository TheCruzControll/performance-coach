/**
 * The writes M4's sync handlers need beyond M3's first cut (src/lib/server/services/training/log.ts,
 * the fallback for M4's amendments A3–A4), on real Postgres:
 * - sets by measure and load type: seconds, metres and assistance stored; the exercise's load
 *   type checked with logging-rules' checkSet; an e1RM only for an external-load reps set
 * - every write in the caller's transaction, rows addressed by client id
 * - startWorkout's pinned planned session checked against the program and lineage it names
 * - a run's segments and an other session's record added and edited one piece at a time, with
 *   absolute values: a no-op writes nothing, a real change one audit row
 * Audit assertions always filter by table and row id.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { checkSet } from '../../../src/lib/domain/workout/logging';
import {
	programs,
	runRecords,
	runRecordSegments,
	setRecords,
	trainingAudit,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import {
	addRunSegment,
	deleteSet,
	editOtherSession,
	editRunSegment,
	editSet,
	logOtherSession,
	logRun,
	logSet,
	recordSubstitution,
	startWorkout
} from '../../../src/lib/server/services/training/log';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
/** An instant on Tuesday 10 November 2026, in UTC, as a device sends it. */
const at = (time: string) => `2026-11-10T${time}:00.000Z`;
const deviceId = () => crypto.randomUUID();
const km = (value: number) => ({ value, unit: 'km' });

const STRENGTH_START = {
	kind: 'strength',
	discipline: 'strength',
	sessionType: 'strength',
	title: 'Full body',
	plannedSessionId: null,
	startedAt: at('07:00')
};
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

/** A set with nothing recorded yet: each case gives its amount and load. */
const setInput = (workout: string, exerciseId: string, over: Record<string, unknown> = {}) => ({
	clientMutationId: deviceId(),
	workoutClientId: workout,
	exerciseId,
	plannedExerciseLineageId: null,
	exercisePosition: 1,
	setIndex: 1,
	weight: null,
	unit: 'kg',
	reps: null,
	missedReps: 0,
	seconds: null,
	metres: null,
	rpe: null,
	isWarmup: false,
	isExtra: false,
	isSkipped: false,
	performedAt: at('07:10'),
	...over
});

/** The set's values as editSet takes them, from the logged input. */
const editOf = ({
	clientMutationId: _id,
	workoutClientId: _workout,
	exerciseId: _exercise,
	plannedExerciseLineageId: _lineage,
	exercisePosition: _position,
	setIndex: _index,
	performedAt: _at,
	...values
}: ReturnType<typeof setInput>) => values;

const segment = (position: number, over: Record<string, unknown> = {}) => ({
	clientMutationId: deviceId(),
	position,
	kind: 'interval',
	distance: { value: 400, unit: 'm' },
	durationSeconds: 84,
	avgHr: null,
	rpe: 9,
	...over
});

const sparring = (rounds: number) => ({
	kind: 'sparring',
	durationMinutes: 60,
	rpe: 8,
	metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: rounds }],
	notes: null
});

/** A workout the owner starts: its client id and its row's id. */
async function start(db: Executor, owner: string, kind: Record<string, unknown>) {
	const workout = deviceId();
	const { workout: row } = await startWorkout(owner, { ...kind, clientId: workout }, { db });
	return { workout, workoutId: row.id };
}

/** The owner, a started strength workout and the catalogue exercises the cases log. */
async function setup(db: Executor) {
	const owner = await makeOwner(db);
	const keys = await resolveKeys(
		['back_squat', 'plank', 'sled_push', 'pull_up', 'assisted_pull_up'],
		{ db }
	);
	const id = (key: string) => keys.get(key)!.id;
	return {
		owner,
		...(await start(db, owner, STRENGTH_START)),
		squat: id('back_squat'),
		plank: id('plank'),
		sled: id('sled_push'),
		pullUp: id('pull_up'),
		assisted: id('assisted_pull_up')
	};
}

const auditOf = (db: Executor, table: string, rowId: number | string) =>
	db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, String(rowId))))
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

/** checkSet's errors at the service input's own paths (the mutation's payload is that input). */
const inputPaths = (errors: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(errors).map(([path, m]) => [path.replace(/^payload\./, ''), m])
	);

describe('logSet and editSet: by measure and load type', () => {
	it('stores a plank’s seconds, a sled push’s metres and weight, and an assisted pull-up’s help', async () => {
		await withRollback(async (db) => {
			const { owner, workout, plank, sled, assisted } = await setup(db);

			const hold = await logSet(owner, setInput(workout, plank, { seconds: 45 }), { db });
			const push = await logSet(
				owner,
				setInput(workout, sled, { exercisePosition: 2, metres: 20, weight: 80, rpe: 8 }),
				{ db }
			);
			const pulls = await logSet(
				owner,
				setInput(workout, assisted, { exercisePosition: 3, reps: 8, assistance: 20, rpe: 8 }),
				{ db }
			);

			expect(hold.set).toMatchObject({ seconds: 45, reps: null, metres: null, weight: null });
			expect(push.set).toMatchObject({ metres: 20, weight: 80, weightKg: 80, e1rmKg: null });
			expect(pulls.set).toMatchObject({
				reps: 8,
				assistance: 20,
				weight: null,
				weightKg: null,
				e1rmKg: null
			});
			const [stored] = await db
				.select()
				.from(setRecords)
				.where(eq(setRecords.clientMutationId, pulls.set.clientMutationId));
			expect(stored).toEqual(pulls.set);
		});
	});

	it('gives an e1RM to an external-load reps set only, never to added bodyweight', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat, pullUp } = await setup(db);

			const squats = await logSet(
				owner,
				setInput(workout, squat, { weight: 100, reps: 5, rpe: 8 }),
				{
					db
				}
			);
			const weighted = await logSet(
				owner,
				setInput(workout, pullUp, { exercisePosition: 2, weight: 10, reps: 5, rpe: 8 }),
				{ db }
			);

			expect(squats.set.e1rmKg).toBeGreaterThan(100);
			expect(weighted.set).toMatchObject({ weight: 10, e1rmKg: null });
		});
	});

	it('refuses a load the exercise does not take, in checkSet’s words', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat, pullUp } = await setup(db);
			const unloaded = setInput(workout, squat, { reps: 5 });
			const helped = setInput(workout, pullUp, { reps: 8, assistance: 20 });
			const squatDef = { name: 'Back squat', measure: 'reps', loadType: 'external' } as const;
			const pullUpDef = { name: 'Pull-up', measure: 'reps', loadType: 'bodyweight' } as const;

			const noWeight = await fieldErrors(logSet(owner, unloaded, { db }));
			const assistance = await fieldErrors(logSet(owner, helped, { db }));

			expect(noWeight).toEqual({ weight: 'Back squat needs a weight' });
			expect(noWeight).toEqual(inputPaths(checkSet({ ...unloaded, assistance: null }, squatDef)));
			expect(assistance).toEqual({ assistance: 'Only assisted exercises take assistance' });
			expect(assistance).toEqual(inputPaths(checkSet({ ...helped, assistance: 20 }, pullUpDef)));
			expect(await db.select().from(setRecords).where(eq(setRecords.ownerId, owner))).toEqual([]);
		});
	});

	it('checks an edit against the set’s exercise, and moves a weight to the assistance it was', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat, assisted } = await setup(db);
			const squats = setInput(workout, squat, { weight: 100, reps: 5, rpe: 8 });
			const pulls = setInput(workout, assisted, { exercisePosition: 2, reps: 8, assistance: 20 });
			const { set: squatSet } = await logSet(owner, squats, { db });
			const { set: pullSet } = await logSet(owner, pulls, { db });

			const dropped = await fieldErrors(
				editSet(owner, squatSet.clientMutationId, { ...editOf(squats), weight: null }, { db })
			);
			const lighter = await editSet(
				owner,
				pullSet.clientMutationId,
				{ ...editOf(pulls), assistance: 15 },
				{ db }
			);

			expect(dropped).toEqual({ weight: 'Back squat needs a weight' });
			expect(lighter).toMatchObject({ changed: true, set: { assistance: 15, weight: null } });
			expect(await auditOf(db, 'set_records', pullSet.id)).toHaveLength(1);
			expect(await auditOf(db, 'set_records', squatSet.id)).toEqual([]);
		});
	});

	it('refuses a weight and an assistance together, and two amounts at once', async () => {
		await withRollback(async (db) => {
			const { owner, workout, assisted } = await setup(db);
			const both = setInput(workout, assisted, { reps: 8, weight: 10, assistance: 20 });
			const twice = setInput(workout, assisted, { reps: 8, seconds: 30, assistance: 20 });

			expect(await fieldErrors(logSet(owner, both, { db }))).toMatchObject({
				assistance: 'A weight or the assistance, not both'
			});
			expect(await fieldErrors(logSet(owner, twice, { db }))).toMatchObject({
				seconds: 'Reps, a time or a distance: one of them'
			});
		});
	});
});

describe('the caller’s transaction, and rows by client id', () => {
	it('leaves nothing when the caller’s transaction rolls back', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const keys = await resolveKeys(['back_squat'], { db });
			const workout = deviceId();
			const rollback = new Error('the caller rolls back');

			const outcome = await refusal(
				db.transaction(async (tx) => {
					await startWorkout(owner, { ...STRENGTH_START, clientId: workout }, { db: tx });
					const squat = keys.get('back_squat')!.id;
					await logSet(owner, setInput(workout, squat, { weight: 100, reps: 5 }), { db: tx });
					// Inside the transaction, both rows are there.
					expect(await tx.select().from(workouts).where(eq(workouts.ownerId, owner))).toHaveLength(
						1
					);
					throw rollback;
				})
			);

			expect(outcome).toBe(rollback);
			expect(await db.select().from(workouts).where(eq(workouts.ownerId, owner))).toEqual([]);
			expect(await db.select().from(setRecords).where(eq(setRecords.ownerId, owner))).toEqual([]);
		});
	});

	it('edits and deletes a set by its client id; an unknown client id is not found', async () => {
		await withRollback(async (db) => {
			const { owner, workout, plank } = await setup(db);
			const input = setInput(workout, plank, { seconds: 45 });
			const { set } = await logSet(owner, input, { db });

			const longer = await editSet(
				owner,
				input.clientMutationId,
				{ ...editOf(input), seconds: 60 },
				{
					db
				}
			);
			const deleted = await deleteSet(owner, input.clientMutationId, { db });

			expect(longer).toMatchObject({ changed: true, set: { id: set.id, seconds: 60 } });
			expect(deleted.set).toMatchObject({ id: set.id, deletedAt: expect.any(Date) });
			const unknown = deviceId();
			expect(await refusal(editSet(owner, unknown, editOf(input), { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			expect(await refusal(deleteSet(owner, unknown, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
		});
	});

	it('records a substitution in its slot', async () => {
		await withRollback(async (db) => {
			const { owner, workout, pullUp, assisted } = await setup(db);
			const swap = {
				clientMutationId: deviceId(),
				workoutClientId: workout,
				plannedExerciseLineageId: null,
				exercisePosition: 3,
				fromExerciseId: pullUp,
				toExerciseId: assisted,
				reason: 'situational'
			};

			const { substitution } = await recordSubstitution(owner, swap, { db });

			expect(substitution).toMatchObject({ exercisePosition: 3, toExerciseId: assisted });
			const stored = await db
				.select()
				.from(workoutSubstitutions)
				.where(eq(workoutSubstitutions.clientMutationId, swap.clientMutationId));
			expect(stored).toEqual([substitution]);
		});
	});
});

describe('startWorkout: a pinned planned session', () => {
	it('refuses a session from another program, or of another lineage, than the start names', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const first = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			await db
				.update(programs)
				.set({ status: 'archived', archivedAt: new Date() })
				.where(eq(programs.id, first.programId));
			const second = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const version = await getProgramVersion(owner, second.programId, 1, { db });
			const [session, other] = version.blocks[0]!.weeks[0]!.sessions;
			const pinned = {
				...STRENGTH_START,
				plannedSessionId: session!.id,
				plannedLineageId: session!.lineage,
				programId: second.programId
			};

			const fromFirst = await fieldErrors(
				startWorkout(owner, { ...pinned, clientId: deviceId(), programId: first.programId }, { db })
			);
			const wrongLineage = await fieldErrors(
				startWorkout(
					owner,
					{ ...pinned, clientId: deviceId(), plannedLineageId: other!.lineage },
					{ db }
				)
			);
			const { workout } = await startWorkout(owner, { ...pinned, clientId: deviceId() }, { db });

			expect(fromFirst).toEqual({
				programId: 'Not the program this session is in'
			});
			expect(wrongLineage).toEqual({
				plannedLineageId: 'Not this session’s lineage'
			});
			expect(workout).toMatchObject({
				plannedSessionId: session!.id,
				plannedLineageId: session!.lineage,
				programId: second.programId
			});
			expect(await db.select().from(workouts).where(eq(workouts.ownerId, owner))).toHaveLength(1);
		});
	});
});

describe('runs by piece', () => {
	it('creates the run record with empty totals on its first segment; a replay adds none', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout, workoutId } = await start(db, owner, RUN_START);
			const interval = segment(1);

			const first = await addRunSegment(owner, workout, interval, { db });
			const replay = await addRunSegment(owner, workout, interval, { db });
			const changed = await addRunSegment(owner, workout, { ...interval, rpe: 10 }, { db });

			expect(first).toMatchObject({
				duplicate: false,
				matches: true,
				segment: { clientMutationId: interval.clientMutationId, distanceMetres: 400 }
			});
			expect(replay).toEqual({ segment: first.segment, duplicate: true, matches: true });
			expect(changed).toEqual({ segment: first.segment, duplicate: true, matches: false });
			const [run] = await db.select().from(runRecords).where(eq(runRecords.workoutId, workoutId));
			expect(run).toMatchObject({
				distanceMetres: null,
				durationSeconds: null,
				paceSecondsPerKm: null,
				avgHr: null,
				rpe: null,
				notes: null
			});
			const segments = await db
				.select()
				.from(runRecordSegments)
				.where(eq(runRecordSegments.workoutId, workoutId));
			expect(segments).toEqual([first.segment]);
		});
	});

	it('logs a run’s own fields, any of them, and no segments', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout } = await start(db, owner, RUN_START);

			const { run, segments } = await logRun(owner, { workoutClientId: workout, rpe: 7 }, { db });

			expect(run).toMatchObject({ rpe: 7, distanceMetres: null, durationSeconds: null });
			expect(segments).toEqual([]);
		});
	});

	it('refuses a segment id already used in another run, and a run segment in a strength workout', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout } = await start(db, owner, RUN_START);
			const { workout: secondRun } = await start(db, owner, RUN_START);
			const { workout: strength } = await start(db, owner, STRENGTH_START);
			const interval = segment(1);
			await addRunSegment(owner, workout, interval, { db });

			expect(await fieldErrors(addRunSegment(owner, secondRun, interval, { db }))).toEqual({
				clientMutationId: 'Already used'
			});
			expect(await fieldErrors(addRunSegment(owner, strength, segment(1), { db }))).toEqual({
				workoutClientId: 'Not a run'
			});
		});
	});

	it('edits a segment’s duration with one audit row; the same values again write nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout } = await start(db, owner, RUN_START);
			const interval = segment(2);
			const { segment: added } = await addRunSegment(owner, workout, interval, { db });
			const { clientMutationId: id, ...values } = interval;
			const slower = { ...values, durationSeconds: 90 };

			const first = await editRunSegment(owner, id, slower, { db });
			const replay = await editRunSegment(owner, id, slower, { db });

			expect(first).toMatchObject({ changed: true, segment: { durationSeconds: 90 } });
			expect(first.segment.paceSecondsPerKm).toBe(225);
			expect(first.segment.updatedAt.getTime()).toBeGreaterThan(added.updatedAt.getTime());
			expect(replay).toEqual({ segment: first.segment, changed: false });
			const audit = await auditOf(db, 'run_record_segments', added.id);
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({
				action: 'update',
				actor: 'owner',
				before: { duration_s: 84 },
				after: { duration_s: 90 }
			});
		});
	});

	it('edits a segment in another unit that comes to the same metres as no change', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout } = await start(db, owner, RUN_START);
			const interval = segment(1, { distance: km(0.4) });
			const { segment: added } = await addRunSegment(owner, workout, interval, { db });
			const { clientMutationId: id, ...values } = interval;

			const same = await editRunSegment(
				owner,
				id,
				{ ...values, distance: { value: 400, unit: 'm' } },
				{
					db
				}
			);

			expect(same).toEqual({ segment: added, changed: false });
			expect(await auditOf(db, 'run_record_segments', added.id)).toEqual([]);
			expect(await refusal(editRunSegment(owner, deviceId(), values, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
		});
	});
});

describe('editOtherSession: absolute values, audited once', () => {
	it('changes rounds 6 → 7 with one audit row; the same values again write nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout, workoutId } = await start(db, owner, MUAY_THAI_START);
			const { session } = await logOtherSession(
				owner,
				{ workoutClientId: workout, ...sparring(6) },
				{ db }
			);

			const first = await editOtherSession(owner, workout, sparring(7), { db });
			const replay = await editOtherSession(owner, workout, sparring(7), { db });

			expect(first).toMatchObject({
				changed: true,
				session: { metrics: [{ key: 'rounds', value: 7 }] }
			});
			expect(first.session.updatedAt.getTime()).toBeGreaterThan(session.updatedAt.getTime());
			expect(replay).toEqual({ session: first.session, changed: false });
			const audit = await auditOf(db, 'other_session_records', workoutId);
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({
				action: 'update',
				actor: 'owner',
				before: { metrics: [{ value: 6 }] },
				after: { metrics: [{ value: 7 }] }
			});
		});
	});

	it('finds no record a workout has not logged, and takes every value', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { workout } = await start(db, owner, MUAY_THAI_START);

			expect(await refusal(editOtherSession(owner, workout, sparring(7), { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			const partial = editOtherSession(owner, workout, { durationMinutes: 45 }, { db });
			expect(Object.keys(await fieldErrors(partial))).toEqual(
				expect.arrayContaining(['kind', 'rpe', 'metrics', 'notes'])
			);
		});
	});
});
