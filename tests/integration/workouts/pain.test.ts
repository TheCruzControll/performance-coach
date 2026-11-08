/**
 * pain.report through the sync dispatcher (services/workouts/apply/pain.ts) on real Postgres,
 * from M3's 'workout-day' program: 'This hurts' records where it hurt, how badly, the note and
 * what the owner chose, beside the choice the device sends with it (an exercise.skip for Stop,
 * an exercise.substitute with reason pain for a gentler option), and never becomes a preference.
 *
 * Batches go through applySyncBatch as the endpoint calls it, at 08:00 UTC on Wednesday
 * 11 November 2026 (the owner's time zone is UTC).
 */
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	createMutation,
	type MutationPayloads,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import {
	exercisePreferences,
	painReports,
	syncMutations,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { createTrainingLogRepository } from '../../../src/lib/server/db/repositories/training-log';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	getVersionHistory,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { getCanonicalWorkout } from '../../../src/lib/server/services/workouts/canonical';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TODAY = '2026-11-11';
const MONDAY = '2026-11-09';
const NOW = new Date(`${TODAY}T08:00:00Z`);
/** An instant `minute` minutes after 07:00 UTC today. */
const at = (minute = 0) => new Date(Date.UTC(2026, 10, 11, 7, minute)).toISOString();

const sync = (db: Executor, owner: string, mutations: readonly unknown[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db,
		now: () => NOW
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** Position 3 of today's strength session: the Romanian deadlift as planned. */
function rdlIn(v: ProgramVersion) {
	const sessions = v.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));
	const session = sessions.find((s) => s.date === TODAY && s.kind === 'strength');
	if (session?.kind !== 'strength') throw new Error('no strength session today');
	return { session, rdl: session.exercises[2]! };
}

/** The owner, workout-day (version 1), a workout started from today's strength session. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const fixture = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	const { programId } = await createProgramFromPlan(owner, fixture, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const { session, rdl } = rdlIn(v1);
	const found = await resolveKeys(['romanian_deadlift', 'glute_bridge'] as const, { db });
	const workoutId = crypto.randomUUID();
	const start = createMutation('workout.start', {
		workoutId,
		at: at(),
		payload: {
			kind: 'strength',
			title: session.title,
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: session.id,
			plannedLineage: session.lineage,
			programId
		}
	});
	expect(statuses((await sync(db, owner, [start])).results)).toEqual(['applied']);
	return {
		owner,
		workoutId,
		slot: { position: 3, plannedLineage: rdl.lineage },
		rdl: found.get('romanian_deadlift')!.id,
		/** A gentler option for the lower back, as the kit would offer one. */
		gentler: found.get('glute_bridge')!.id
	};
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Another owner's workout row id, ad hoc. */
async function theirWorkout(db: Executor, owner: string) {
	const [row] = await db
		.insert(workouts)
		.values({
			ownerId: owner,
			clientId: crypto.randomUUID(),
			kind: 'strength',
			title: 'Their workout',
			sessionType: 'strength',
			discipline: 'strength',
			startedAt: NOW
		})
		.returning({ id: workouts.id });
	return row!.id;
}

/** The report the device sends for the Romanian deadlift, with `over` changed. */
const reportOf = (s: Seeded, over: Partial<MutationPayloads['pain.report']> = {}) =>
	createMutation('pain.report', {
		workoutId: s.workoutId,
		at: at(25),
		payload: {
			...s.slot,
			exerciseId: s.rdl,
			area: 'lower_back',
			severity: 'moderate',
			action: 'stopped',
			substitutionId: null,
			note: 'Twinge on the way down',
			...over
		}
	});

/** What a stored report holds, as the columns name it. */
const reportsOf = (db: Executor, owner: string) =>
	db
		.select({
			id: painReports.id,
			exerciseId: painReports.exerciseId,
			lineage: painReports.plannedExerciseLineageId,
			position: painReports.exercisePosition,
			area: painReports.bodyArea,
			severity: painReports.severity,
			action: painReports.action,
			substitutionId: painReports.substitutionClientId,
			note: painReports.note,
			reportedAt: painReports.reportedAt
		})
		.from(painReports)
		.where(eq(painReports.ownerId, owner));

const substitutionsOf = (db: Executor, owner: string) =>
	db
		.select({
			id: workoutSubstitutions.clientMutationId,
			to: workoutSubstitutions.toExerciseId,
			reason: workoutSubstitutions.reason
		})
		.from(workoutSubstitutions)
		.where(eq(workoutSubstitutions.ownerId, owner));

const preferenceCount = async (db: Executor, owner: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(exercisePreferences)
		.where(eq(exercisePreferences.ownerId, owner));
	return row!.n;
};

const versionNumbers = async (db: Executor, owner: string) =>
	(await getVersionHistory(owner, {}, { db }))!.versions.map((v) => v.number);

/** A second owner, inside the test's rolled-back transaction: the app allows only one. */
async function secondOwner(db: Executor) {
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	return makeOwner(db, 'Someone else');
}

const ledgerHas = async (db: Executor, mutationId: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(syncMutations)
		.where(eq(syncMutations.mutationId, mutationId));
	return row!.n === 1;
};

describe('pain.report', () => {
	it('a gentler option links its substitution (reason pain)', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const swap = createMutation('exercise.substitute', {
				workoutId: s.workoutId,
				at: at(24),
				payload: { ...s.slot, fromExerciseId: s.rdl, toExerciseId: s.gentler, reason: 'pain' }
			});
			const report = reportOf(s, { action: 'substituted', substitutionId: swap.id });

			const { results } = await sync(db, s.owner, [swap, report]);

			expect(statuses(results)).toEqual(['applied', 'applied']);
			expect(await substitutionsOf(db, s.owner)).toEqual([
				{ id: swap.id, to: s.gentler, reason: 'pain' }
			]);
			expect(await reportsOf(db, s.owner)).toEqual([
				{
					id: report.id,
					exerciseId: s.rdl,
					lineage: s.slot.plannedLineage,
					position: 3,
					area: 'lower_back',
					severity: 'moderate',
					action: 'substituted',
					substitutionId: swap.id,
					note: 'Twinge on the way down',
					reportedAt: new Date(at(25))
				}
			]);
			expect(await preferenceCount(db, s.owner)).toBe(0);
			expect(await versionNumbers(db, s.owner)).toEqual([1]);
		});
	});

	it("'stopped' gives skipped rows for the sets not done yet, and no substitution", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const first = createMutation('set.log', {
				workoutId: s.workoutId,
				at: at(20),
				payload: {
					...s.slot,
					setIndex: 1,
					exerciseId: s.rdl,
					reps: 8,
					seconds: null,
					metres: null,
					weight: 80,
					assistance: null,
					unit: 'kg',
					rpe: 7,
					missedReps: 0,
					isWarmup: false,
					isExtra: false
				}
			});
			const rest = [2, 3].map((setIndex) => ({ id: crypto.randomUUID(), setIndex }));
			const skip = createMutation('exercise.skip', {
				workoutId: s.workoutId,
				at: at(25),
				payload: { ...s.slot, exerciseId: s.rdl, unit: 'kg', sets: rest }
			});
			const report = reportOf(s);

			const { results } = await sync(db, s.owner, [first, skip, report]);

			expect(statuses(results)).toEqual(['applied', 'applied', 'applied']);
			const { sets } = (await createTrainingLogRepository(db).workoutWithSets(
				s.owner,
				s.workoutId
			))!;
			expect(sets.map((set) => [set.setIndex, set.isSkipped])).toEqual([
				[1, false],
				[2, true],
				[3, true]
			]);
			expect(await substitutionsOf(db, s.owner)).toEqual([]);
			expect(await reportsOf(db, s.owner)).toMatchObject([
				{ id: report.id, action: 'stopped', substitutionId: null }
			]);
			expect(await preferenceCount(db, s.owner)).toBe(0);
		});
	});

	it("'ended_workout' records the report, area and severity left out; the workout runs on until its finish", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const report = reportOf(s, {
				action: 'ended_workout',
				area: null,
				severity: null,
				note: null
			});

			expect(statuses((await sync(db, s.owner, [report])).results)).toEqual(['applied']);

			expect(await reportsOf(db, s.owner)).toMatchObject([
				{ id: report.id, action: 'ended_workout', area: null, severity: null, note: null }
			]);
			const workout = await createTrainingLogRepository(db).workout(s.owner, s.workoutId);
			expect(workout).toMatchObject({ status: 'in_progress', finishedAt: null });
			expect(await preferenceCount(db, s.owner)).toBe(0);
		});
	});

	it('severe pain, stopped or ending the workout, still writes no preference and no version', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const reports = (['stopped', 'ended_workout'] as const).map((action) =>
				reportOf(s, { action, severity: 'severe', note: 'Sharp, stop' })
			);

			expect(statuses((await sync(db, s.owner, reports)).results)).toEqual(['applied', 'applied']);

			expect(await reportsOf(db, s.owner)).toHaveLength(2);
			expect(await preferenceCount(db, s.owner)).toBe(0);
			expect(await versionNumbers(db, s.owner)).toEqual([1]);
		});
	});

	it('a replay is duplicate: one row however often it is sent', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const report = reportOf(s);

			expect(statuses((await sync(db, s.owner, [report, report])).results)).toEqual([
				'applied',
				'duplicate'
			]);
			expect(statuses((await sync(db, s.owner, [report])).results)).toEqual(['duplicate']);

			expect(await reportsOf(db, s.owner)).toHaveLength(1);
		});
	});

	it("a report on another owner's workout is rejected, with no row and no ledger claim", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const stranger = await secondOwner(db);
			const report = reportOf(s);

			const { results } = await sync(db, stranger, [report]);

			expect(results).toEqual([{ id: report.id, status: 'rejected', code: 'forbidden' }]);
			expect(await reportsOf(db, s.owner)).toEqual([]);
			expect(await reportsOf(db, stranger)).toEqual([]);
			expect(await ledgerHas(db, report.id)).toBe(false);
		});
	});

	it("a report id another owner's report holds is refused, and theirs is untouched", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const stranger = await secondOwner(db);
			const theirs = await theirWorkout(db, stranger);
			const report = reportOf(s);
			await db.insert(painReports).values({
				id: report.id,
				ownerId: stranger,
				workoutId: theirs,
				exercisePosition: 1,
				action: 'stopped',
				reportedAt: NOW
			});

			const { results } = await sync(db, s.owner, [report]);

			expect(results).toEqual([{ id: report.id, status: 'rejected', code: 'forbidden' }]);
			expect(await reportsOf(db, s.owner)).toEqual([]);
			expect(await reportsOf(db, stranger)).toMatchObject([{ id: report.id, position: 1 }]);
		});
	});

	it('a report on a deleted workout is deferred, never written', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			await db.update(workouts).set({ deletedAt: NOW }).where(eq(workouts.clientId, s.workoutId));
			const report = reportOf(s);

			const { results } = await sync(db, s.owner, [report]);

			expect(results).toEqual([{ id: report.id, status: 'deferred', code: 'missing' }]);
			expect(await reportsOf(db, s.owner)).toEqual([]);
		});
	});

	it('a report whose workout has not arrived yet is deferred', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const report = reportOf({ ...s, workoutId: crypto.randomUUID() });

			const { results } = await sync(db, s.owner, [report]);

			expect(results).toEqual([{ id: report.id, status: 'deferred', code: 'missing' }]);
			expect(await reportsOf(db, s.owner)).toEqual([]);
		});
	});

	it('a report naming an exercise outside the library is refused at payload.exerciseId', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const report = reportOf(s, { exerciseId: crypto.randomUUID() });

			const { results } = await sync(db, s.owner, [report]);

			expect(results).toEqual([
				{
					id: report.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.exerciseId': 'Not in your library' }
				}
			]);
			expect(await reportsOf(db, s.owner)).toEqual([]);
		});
	});

	it('a note over 500 characters is rejected at payload.note; 500 is kept', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const long = reportOf(s, { note: 'a'.repeat(501) });
			const longest = reportOf(s, { note: 'a'.repeat(500) });

			const [refused] = (await sync(db, s.owner, [long])).results;
			const [kept] = (await sync(db, s.owner, [longest])).results;

			expect(refused).toMatchObject({ id: long.id, status: 'rejected', code: 'invalid' });
			expect(Object.keys(refused!.errors!)).toEqual(['payload.note']);
			expect(kept).toMatchObject({ id: longest.id, status: 'applied' });
			expect((await reportsOf(db, s.owner)).map((r) => r.id)).toEqual([longest.id]);
		});
	});

	it('the canonical read includes it, keyed by its client id, with the exercise it names', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const report = reportOf(s, { severity: 'mild' });

			const { results } = await sync(db, s.owner, [report]);
			const canonical = await getCanonicalWorkout(s.owner, s.workoutId, { db });

			const expected = {
				id: report.id,
				position: 3,
				plannedLineage: s.slot.plannedLineage,
				exerciseId: s.rdl,
				area: 'lower_back',
				severity: 'mild',
				action: 'stopped',
				substitutionId: null,
				note: 'Twinge on the way down',
				reportedAt: at(25),
				deletedAt: null
			};
			expect(canonical!.pain).toEqual([expected]);
			expect(canonical!.exercises[s.rdl]).toMatchObject({ name: 'Romanian deadlift' });
			// The sync result carries the same rows.
			expect(results[0]!.canonical!.pain).toEqual([expected]);
		});
	});
});
