/**
 * Pain reports on real Postgres (the M4 plan's pain-reports-db): 'This hurts' stored apart from
 * exercise preferences, owner-scoped and audited.
 * - A report round-trips with every field, or with only its slot and action; its id is the
 *   device's, so a replayed report is a conflict, never a second row.
 * - severity is one of M2's SEVERITIES and action one of the contract's PAIN_ACTIONS; body_area
 *   stays open, as M2's injuries keep it. A note is 1 to 500 characters, and only a report that
 *   switched to a gentler option names a substitution.
 * - M3's logged-table guards: an UPDATE that changes a report writes one training_audit row and
 *   moves updated_at, one that changes nothing leaves no trace, and DELETE is refused.
 * - The withCommitted cleanup, and resetPrograms' TRUNCATE cascading from workouts, clear it.
 * Audit assertions always filter by table and row id.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PAIN_ACTIONS } from '../../../src/lib/domain/workout/mutations';
import { SEVERITIES } from '../../../src/lib/domain/profile/catalog';
import {
	AUDIT_ACTOR_SETTING,
	exercises,
	getDb,
	painReports,
	trainingAudit,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import { restrictRefusalCode, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const id = () => crypto.randomUUID();
const REPORTED_AT = new Date('2026-11-10T07:42:13.250Z');

type NewPainReport = typeof painReports.$inferInsert;
type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Run `write` in a savepoint that is always undone: the Postgres error, or null if accepted. */
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

const refused = (code: string, constraint: string) => ({ code, table: 'pain_reports', constraint });

/** An owner, a strength workout in progress and a custom exercise it performs. */
async function setup(db: Executor) {
	const ownerId = await makeOwner(db);
	const [workout] = await db
		.insert(workouts)
		.values({
			ownerId,
			clientId: id(),
			kind: 'strength',
			discipline: 'strength',
			sessionType: 'strength',
			title: 'Full body A',
			startedAt: new Date('2026-11-10T07:00:00Z')
		})
		.returning({ id: workouts.id });
	const [exercise] = await db
		.insert(exercises)
		.values({
			ownerId,
			name: 'Landmine press',
			pattern: 'vertical_push',
			primaryMuscles: ['front_delts'],
			skillLevel: 'beginner',
			measure: 'reps',
			loadType: 'external'
		})
		.returning({ id: exercises.id });
	const report = (overrides: Partial<NewPainReport> = {}): NewPainReport => ({
		id: id(),
		ownerId,
		workoutId: workout!.id,
		exerciseId: exercise!.id,
		plannedExerciseLineageId: id(),
		exercisePosition: 2,
		bodyArea: 'shoulder',
		severity: 'moderate',
		action: 'stopped',
		substitutionClientId: null,
		note: 'Sharp at the top of the press',
		reportedAt: REPORTED_AT,
		...overrides
	});
	return { ownerId, workoutId: workout!.id, exerciseId: exercise!.id, report };
}

const insert = (db: Executor, row: NewPainReport) => db.insert(painReports).values(row);

/** A stored report as the audit trigger sees it (to_jsonb: timestamps to the microsecond). */
async function rowOf(db: Executor, reportId: string) {
	const { rows } = await db.execute<{ row: Record<string, unknown> }>(
		sql`select to_jsonb(t) as row from pain_reports t where id = ${reportId}`
	);
	return rows[0]?.row;
}

function auditOf(db: Executor, reportId: string) {
	return db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, 'pain_reports'), eq(trainingAudit.rowId, reportId)))
		.orderBy(asc(trainingAudit.id));
}

/** Whether a report's updated_at has moved past its created_at, to the microsecond. */
async function moved(db: Executor, reportId: string) {
	const { rows } = await db.execute<{ moved: boolean }>(
		sql`select updated_at > created_at as moved from pain_reports where id = ${reportId}`
	);
	return rows[0]!.moved;
}

const count = async (db: Executor) => (await db.select().from(painReports)).length;

describe('pain reports', () => {
	it('round-trip with every field, or with only the slot and the action', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			const full = report({ action: 'substituted', substitutionClientId: id() });
			const bare = report({
				exerciseId: null,
				plannedExerciseLineageId: null,
				exercisePosition: 1,
				bodyArea: null,
				severity: null,
				action: 'ended_workout',
				note: null
			});
			await insert(tx, full);
			await insert(tx, bare);

			const stored = await tx.select().from(painReports).orderBy(painReports.exercisePosition);
			const server = { createdAt: expect.any(Date), updatedAt: expect.any(Date), deletedAt: null };
			expect(stored).toEqual([
				{ ...bare, ...server },
				{ ...full, ...server }
			]);
		});
	});

	it('store a device id once: a replayed report is a conflict, not a second row', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			const row = report();
			await insert(tx, row);

			expect(await attempt(tx, (t) => insert(t, { ...row, severity: 'mild' }))).toEqual(
				refused('23505', 'pain_reports_pkey')
			);
			// The replay's no-op, as the pain handler writes it.
			await tx.insert(painReports).values(row).onConflictDoNothing();
			expect(await tx.select().from(painReports)).toMatchObject([
				{ id: row.id, severity: 'moderate' }
			]);
		});
	});

	it('refuse a severity or an action outside their lists, and accept every one in them', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			const write = (values: Record<string, unknown>) =>
				attempt(tx, (t) => insert(t, report(values as Partial<NewPainReport>)));

			expect(await write({ severity: 'extreme' })).toEqual(
				refused('23514', 'pain_reports_severity_ck')
			);
			expect(await write({ action: 'pushed_through' })).toEqual(
				refused('23514', 'pain_reports_action_ck')
			);
			for (const severity of SEVERITIES) expect(await write({ severity }), severity).toBeNull();
			for (const action of PAIN_ACTIONS) expect(await write({ action }), action).toBeNull();
			// The area is open, as M2's injuries keep it.
			expect(await write({ bodyArea: 'jaw' })).toBeNull();
		});
	});

	it('bound the note, the slot and the substitution, and need a known workout', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			const write = (values: Partial<NewPainReport>) =>
				attempt(tx, (t) => insert(t, report(values)));

			expect(await write({ note: 'x'.repeat(500) })).toBeNull();
			expect(await write({ note: 'x'.repeat(501) })).toEqual(
				refused('23514', 'pain_reports_note_ck')
			);
			expect(await write({ note: '' })).toEqual(refused('23514', 'pain_reports_note_ck'));
			expect(await write({ exercisePosition: 0 })).toEqual(
				refused('23514', 'pain_reports_exercise_position_ck')
			);
			expect(await write({ action: 'stopped', substitutionClientId: id() })).toEqual(
				refused('23514', 'pain_reports_substitution_ck')
			);
			expect(await write({ action: 'substituted', substitutionClientId: null })).toBeNull();
			expect(await write({ workoutId: id() })).toEqual(
				refused('23503', 'pain_reports_workout_id_workouts_id_fk')
			);
			expect(await write({ exerciseId: id() })).toEqual(
				refused('23503', 'pain_reports_exercise_id_exercises_id_fk')
			);
		});
	});

	it('keep an exercise a report names', async () => {
		await withRollback(async (tx) => {
			const { report, exerciseId } = await setup(tx);
			await insert(tx, report());
			expect(
				await attempt(tx, (t) => t.delete(exercises).where(eq(exercises.id, exerciseId)))
			).toEqual(refused(await restrictRefusalCode(tx), 'pain_reports_exercise_id_exercises_id_fk'));
			// RESTRICT, not NO ACTION ('r', not 'a'): PostgreSQL 16 reports both as 23503.
			const { rows } = await tx.execute<{ onDelete: string }>(
				sql`select confdeltype as "onDelete" from pg_constraint
					where conname = 'pain_reports_exercise_id_exercises_id_fk'`
			);
			expect(rows).toEqual([{ onDelete: 'r' }]);
		});
	});

	it('audit an UPDATE that changes a report once, with its before, after, actor and owner', async () => {
		await withRollback(async (tx) => {
			const { ownerId, report } = await setup(tx);
			const row = report();
			await insert(tx, row);
			const before = await rowOf(tx, row.id);

			await tx
				.update(painReports)
				.set({ severity: 'severe', note: 'Worse on the second set' })
				.where(eq(painReports.id, row.id));
			const after = await rowOf(tx, row.id);
			expect(after).toMatchObject({ severity: 'severe', note: 'Worse on the second set' });
			expect(await auditOf(tx, row.id)).toEqual([
				expect.objectContaining({
					ownerId,
					tableName: 'pain_reports',
					rowId: row.id,
					action: 'update',
					actor: 'owner',
					before,
					after,
					changedAt: new Date(String(after!.updated_at))
				})
			]);
			expect(await moved(tx, row.id)).toBe(true);

			// The coach's edit is recorded as the coach's, and a soft delete as a delete.
			await tx.execute(sql`select set_config(${AUDIT_ACTOR_SETTING}, 'coach', true)`);
			await tx
				.update(painReports)
				.set({ deletedAt: sql`statement_timestamp()` })
				.where(eq(painReports.id, row.id));
			expect((await auditOf(tx, row.id)).map((a) => [a.action, a.actor])).toEqual([
				['update', 'owner'],
				['delete', 'coach']
			]);
		});
	});

	it('leave no trace of an UPDATE that changes nothing: no audit row, updated_at unchanged', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			const row = report();
			await insert(tx, row);
			const before = await rowOf(tx, row.id);

			await tx
				.update(painReports)
				.set({ severity: row.severity, note: row.note })
				.where(eq(painReports.id, row.id));
			// updated_at is the trigger's: a statement that sets only it changes nothing.
			await tx
				.update(painReports)
				.set({ updatedAt: new Date('2000-01-01T00:00:00Z') })
				.where(eq(painReports.id, row.id));

			expect(await rowOf(tx, row.id)).toEqual(before);
			expect(await auditOf(tx, row.id)).toEqual([]);
			expect(await moved(tx, row.id)).toBe(false);
		});
	});

	it('refuse a DELETE, also when the owner is deleted', async () => {
		await withRollback(async (tx) => {
			const { ownerId, report } = await setup(tx);
			const row = report();
			await insert(tx, row);

			expect(
				await attempt(tx, (t) => t.delete(painReports).where(eq(painReports.id, row.id)))
			).toEqual(refused('23001', 'history_refuse_delete'));
			// The owner's ON DELETE CASCADE reaches the report, whose guard refuses it.
			expect(
				await attempt(tx, (t) => t.execute(sql`delete from owners where id = ${ownerId}`))
			).toMatchObject({ code: '23001', constraint: 'history_refuse_delete' });
			expect(await count(tx)).toBe(1);
		});
	});

	it('are guarded by row triggers only, none on TRUNCATE, and indexed for their reads', async () => {
		// tgtype bit 5 (32) is TRIGGER_TYPE_TRUNCATE.
		const triggers = await getDb().execute<{ name: string; truncate: boolean }>(
			sql`select tgname as name, (tgtype & 32) <> 0 as truncate from pg_trigger
				where not tgisinternal and tgrelid = 'pain_reports'::regclass order by 1`
		);
		expect(triggers.rows).toEqual([
			{ name: 'pain_reports_audit', truncate: false },
			{ name: 'pain_reports_refuse_delete', truncate: false },
			{ name: 'pain_reports_touch', truncate: false }
		]);

		const indexes = await getDb().execute<{ name: string; definition: string }>(
			sql`select indexname as name, indexdef as definition from pg_indexes
				where tablename = 'pain_reports' order by 1`
		);
		expect(indexes.rows).toEqual([
			{
				name: 'pain_reports_owner_reported_idx',
				definition: expect.stringContaining('USING btree (owner_id, reported_at DESC)')
			},
			{ name: 'pain_reports_pkey', definition: expect.stringContaining('USING btree (id)') },
			{
				name: 'pain_reports_workout_idx',
				definition: expect.stringContaining('USING btree (workout_id)')
			}
		]);
	});

	it('are cleared by resetPrograms, whose TRUNCATE cascades from workouts', async () => {
		await withRollback(async (tx) => {
			const { report } = await setup(tx);
			await insert(tx, report());
			expect(await count(tx)).toBe(1);

			// e2e/program-support.ts's RESET_ROOTS has workouts; it never lists pain_reports.
			await tx.execute(sql`truncate workouts cascade`);
			expect(await count(tx)).toBe(0);
		});
	});

	it('are emptied by the withCommitted cleanup', async () => {
		await withCommitted(async (db) => {
			const { report } = await setup(db);
			await insert(db, report());
			expect(await count(db)).toBe(1);
		});
		expect(await count(getDb())).toBe(0);
	});
});
