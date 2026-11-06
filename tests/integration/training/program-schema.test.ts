/**
 * The program tables on real Postgres (ADR 0010): stored history never changes and is never
 * deleted, a program's head moves only forward to its own version, the closed vocabularies are
 * CHECKed and the open ones are not, and TRUNCATE is the one (test-only) bypass.
 */
import { eq, getTableName, is, sql, type SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
	getDb,
	plannedSessions,
	programBlocks,
	programmingDecisions,
	programs,
	programVersionBlocks,
	programVersions,
	programVersionWeeks,
	programWeeks,
	type Executor
} from '../../../src/lib/server/db';
import * as programSchema from '../../../src/lib/server/db/schema/programs';
import { createGoal, deleteGoal } from '../../../src/lib/server/services/profile';
import { withCommitted, withRollback } from '../helpers';
import { generalGoal, makeOwner } from '../profile/fixtures';

/** Every table programs.ts defines, so a new one cannot miss its guard. */
const PROGRAM_TABLES = Object.values(programSchema)
	.filter((value) => is(value, PgTable))
	.map((table) => getTableName(table))
	.sort();

/** Store a one-week program the way the program store will: head first, version 1 last. */
async function storeProgram(
	db: Executor,
	ownerId: string,
	status: 'active' | 'archived' = 'active'
) {
	const [program] = await db
		.insert(programs)
		.values({
			ownerId,
			title: 'Fight camp',
			status,
			archivedAt: status === 'archived' ? new Date() : null
		})
		.returning();
	const [version] = await db
		.insert(programVersions)
		.values({
			programId: program!.id,
			number: 1,
			createdBy: 'rules',
			summary: 'Your first program',
			generator: 'baseline-v1',
			startsOn: '2026-11-09',
			firstPlannedDay: '2026-11-09'
		})
		.returning();
	const [block] = await db
		.insert(programBlocks)
		.values({
			programId: program!.id,
			position: 1,
			phase: 'baseline',
			name: 'Baseline',
			startsOn: '2026-11-09',
			endsOn: '2026-12-13',
			progression: { rpe: { from: 7, step: 0.5 } }
		})
		.returning();
	const [week] = await db
		.insert(programWeeks)
		.values({
			blockId: block!.id,
			indexInBlock: 1,
			startsOn: '2026-11-09',
			endsOn: '2026-11-15',
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
			title: 'Lower body',
			estMinutes: 60,
			estLoad: 420,
			intensity: 'moderate',
			targetRpe: 7,
			source: 'rules'
		})
		.returning();
	await db.insert(programVersionBlocks).values({ versionId: version!.id, blockId: block!.id });
	await db.insert(programVersionWeeks).values({ versionId: version!.id, weekId: week!.id });
	const [decision] = await db
		.insert(programmingDecisions)
		.values({
			programId: program!.id,
			versionId: version!.id,
			kind: 'program_purpose',
			ruleKey: 'blocks.baseline_first',
			summary: 'Week 1 establishes your baselines',
			why: 'Your 1RMs are not known yet.',
			decidedBy: 'rules',
			affected: [week!.lineageId]
		})
		.returning();
	await db
		.update(programs)
		.set({ currentVersionId: version!.id })
		.where(eq(programs.id, program!.id));
	return {
		program: program!,
		version: version!,
		block: block!,
		week: week!,
		session: session!,
		decision: decision!
	};
}

/** Version `number` of a program, built on `parent`, as an edit would store it. */
async function storeVersion(db: Executor, programId: string, number: number, parent: string) {
	const [version] = await db
		.insert(programVersions)
		.values({
			programId,
			number,
			parentVersionId: parent,
			createdBy: 'owner',
			summary: 'Moved a session',
			startsOn: '2026-11-09',
			firstPlannedDay: '2026-11-09'
		})
		.returning();
	return version!;
}

type PgError = { code?: string; constraint?: string; table?: string };

/**
 * The Postgres error `statement` fails with. It runs in a savepoint, so the test's transaction
 * carries on; drizzle wraps the driver's error, which is its cause.
 */
async function refusal(db: Executor, statement: SQL) {
	const error = await db
		.transaction((sp) => sp.execute(statement))
		.then(
			() => null,
			(err: unknown) => err
		);
	if (!error) throw new Error('expected the statement to be refused');
	const { code, constraint, table } = ((error as { cause?: PgError }).cause ?? error) as PgError;
	return { code, constraint, table };
}

const guard = (constraint: string, table: string) => ({ code: '23001', constraint, table });
const violation = (code: string, constraint: string) =>
	expect.objectContaining({ code, constraint });

async function counts(db: Executor) {
	const result: Record<string, number> = {};
	for (const table of PROGRAM_TABLES) {
		const { rows } = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(table)}`
		);
		result[table] = rows[0]!.n;
	}
	return result;
}

describe('program history', () => {
	it('refuses every UPDATE of a stored version, block, week, session or decision', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);
			const updates: Record<string, SQL> = {
				program_versions: sql`update program_versions set summary = 'Rewritten' where id = ${p.version.id}`,
				program_blocks: sql`update program_blocks set name = 'Renamed' where id = ${p.block.id}`,
				program_version_blocks: sql`update program_version_blocks set block_id = block_id where version_id = ${p.version.id}`,
				program_weeks: sql`update program_weeks set kind = 'deload' where id = ${p.week.id}`,
				program_version_weeks: sql`update program_version_weeks set week_id = week_id where version_id = ${p.version.id}`,
				planned_sessions: sql`update planned_sessions set status = 'skipped' where id = ${p.session.id}`,
				programming_decisions: sql`update programming_decisions set why = 'Because.' where id = ${p.decision.id}`
			};
			expect(Object.keys(updates).sort()).toEqual(PROGRAM_TABLES.filter((t) => t !== 'programs'));

			for (const [table, statement] of Object.entries(updates)) {
				expect(await refusal(db, statement), table).toEqual(guard('history_refuse_update', table));
			}
			const [session] = await db
				.select()
				.from(plannedSessions)
				.where(eq(plannedSessions.id, p.session.id));
			expect(session).toMatchObject({ status: 'planned', title: 'Lower body' });
		});
	});

	it('moves a program head only forward, to its own version, and changes nothing else', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);
			const v2 = await storeVersion(db, p.program.id, 2, p.version.id);
			const head = (version: string | null) =>
				sql`update programs set current_version_id = ${version} where id = ${p.program.id}`;

			await db.execute(head(v2.id));
			const other = await storeProgram(db, owner, 'archived');
			const headGuard = guard('program_head_guard', 'programs');
			expect(await refusal(db, head(p.version.id)), 'backwards').toEqual(headGuard);
			expect(await refusal(db, head(null)), 'unset').toEqual(headGuard);
			expect(await refusal(db, head(other.version.id)), "another program's").toEqual(headGuard);
			expect(
				await refusal(db, sql`update programs set title = 'Renamed' where id = ${p.program.id}`)
			).toEqual(headGuard);
			expect(
				await refusal(
					db,
					sql`update programs set created_at = created_at - interval '1 day' where id = ${p.program.id}`
				)
			).toEqual(headGuard);
			expect(
				await refusal(
					db,
					sql`insert into programs (owner_id, title, status, archived_at, current_version_id)
						values (${owner}, 'Copied', 'archived', now(), ${v2.id})`
				),
				'created with a head'
			).toEqual(headGuard);

			await db
				.update(programs)
				.set({ status: 'archived', archivedAt: new Date() })
				.where(eq(programs.id, p.program.id));
			const [stored] = await db.select().from(programs).where(eq(programs.id, p.program.id));
			expect(stored).toMatchObject({
				title: 'Fight camp',
				status: 'archived',
				currentVersionId: v2.id
			});
			expect(stored!.archivedAt).toBeInstanceOf(Date);
		});
	});

	it('refuses DELETE on every program table, and so refuses deleting the owner', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);
			const deletes: Record<string, SQL> = {
				programs: sql`delete from programs where id = ${p.program.id}`,
				program_versions: sql`delete from program_versions where id = ${p.version.id}`,
				program_blocks: sql`delete from program_blocks where id = ${p.block.id}`,
				program_version_blocks: sql`delete from program_version_blocks where version_id = ${p.version.id}`,
				program_weeks: sql`delete from program_weeks where id = ${p.week.id}`,
				program_version_weeks: sql`delete from program_version_weeks where version_id = ${p.version.id}`,
				planned_sessions: sql`delete from planned_sessions where id = ${p.session.id}`,
				programming_decisions: sql`delete from programming_decisions where id = ${p.decision.id}`
			};
			expect(Object.keys(deletes).sort()).toEqual(PROGRAM_TABLES);

			for (const [table, statement] of Object.entries(deletes)) {
				expect(await refusal(db, statement), table).toEqual(guard('history_refuse_delete', table));
			}
			// The owner's ON DELETE CASCADE reaches the program, whose guard refuses it.
			expect(await refusal(db, sql`delete from owners where id = ${owner}`)).toEqual(
				guard('history_refuse_delete', 'programs')
			);
			expect(Object.values(await counts(db)).every((n) => n === 1)).toBe(true);
		});
	});

	it('is purged whole by TRUNCATE programs CASCADE, the test-only bypass', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);
			await storeVersion(db, p.program.id, 2, p.version.id);
			await storeProgram(db, owner, 'archived');

			await db.execute(sql`truncate programs cascade`);

			expect(await counts(db)).toEqual(
				Object.fromEntries(PROGRAM_TABLES.map((table) => [table, 0]))
			);
			const { rows } = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from owners where id = ${owner}`
			);
			expect(rows[0]!.n).toBe(1);
		});
	});

	it('refuses DELETE outside and inside a transaction; the test cleanup still removes it', async () => {
		let programId = '';
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			programId = (await storeProgram(db, owner)).program.id;
			const remove = sql`delete from programs where id = ${programId}`;

			const autocommit = await db.execute(remove).then(
				() => null,
				(err: unknown) => (err as { cause?: PgError }).cause
			);
			expect(autocommit).toMatchObject(guard('history_refuse_delete', 'programs'));
			expect(await refusal(db, remove)).toEqual(guard('history_refuse_delete', 'programs'));
			expect(await counts(db)).toMatchObject({ programs: 1, planned_sessions: 1 });
		});

		const db = getDb();
		const [gone] = await db.select().from(programs).where(eq(programs.id, programId));
		expect(gone).toBeUndefined();
		expect(Object.values(await counts(db)).every((n) => n === 0)).toBe(true);
	});
});

describe('program constraints', () => {
	it('allows one active program per owner, any number archived', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner);
			await storeProgram(db, owner, 'archived');
			await storeProgram(db, owner, 'archived');

			expect(
				await refusal(db, sql`insert into programs (owner_id, title) values (${owner}, 'Second')`)
			).toEqual(violation('23505', 'programs_owner_active_uq'));
		});
	});

	it('CHECKs a 7-day week and the closed lists: program status, plan status, decided_by', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);

			expect(
				await refusal(
					db,
					sql`insert into program_weeks (block_id, index_in_block, starts_on, ends_on, kind)
						values (${p.block.id}, 2, '2026-11-16', '2026-11-21', 'accumulation')`
				),
				'a 6-day week'
			).toEqual(violation('23514', 'program_weeks_span_ck'));
			expect(
				await refusal(
					db,
					sql`insert into programs (owner_id, title, status) values (${owner}, 'Paused', 'paused')`
				)
			).toEqual(violation('23514', 'programs_status_ck'));
			expect(
				await refusal(
					db,
					sql`insert into planned_sessions
						(week_id, scheduled_on, discipline, session_type, title, est_minutes, intensity, status, source)
						values (${p.week.id}, '2026-11-11', 'running', 'easy_run', 'Easy run', 30, 'easy', 'completed', 'rules')`
				),
				"'completed' is derived, never stored"
			).toEqual(violation('23514', 'planned_sessions_status_ck'));
			expect(
				await refusal(
					db,
					sql`insert into programming_decisions (program_id, version_id, kind, summary, why, decided_by)
						values (${p.program.id}, ${p.version.id}, 'session_moved', 'Moved', 'Asked to.', 'assistant')`
				)
			).toEqual(violation('23514', 'programming_decisions_decided_by_ck'));
			expect(
				await refusal(
					db,
					sql`insert into programming_decisions (program_id, version_id, kind, summary, why, decided_by)
						values (${p.program.id}, ${p.version.id}, 'session_moved', 'Moved', '', 'owner')`
				),
				'an empty why'
			).toEqual(violation('23514', 'programming_decisions_why_ck'));
		});
	});

	it('accepts an unknown phase, week kind, session type or decision kind (open lists)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const p = await storeProgram(db, owner);

			await db.execute(
				sql`insert into program_blocks (program_id, position, phase, name, starts_on, ends_on)
					values (${p.program.id}, 2, 'fight_camp', 'Fight camp', '2026-12-14', '2027-01-10')`
			);
			await db.execute(
				sql`insert into program_weeks (block_id, index_in_block, starts_on, ends_on, kind)
					values (${p.block.id}, 2, '2026-11-16', '2026-11-22', 'overreach')`
			);
			await db.execute(
				sql`insert into planned_sessions
					(week_id, scheduled_on, discipline, session_type, title, est_minutes, intensity, source)
					values (${p.week.id}, '2026-11-12', 'muay_thai', 'clinch_rounds', 'Clinch', 45, 'hard', 'commitment')`
			);
			await db.execute(
				sql`insert into programming_decisions (program_id, version_id, kind, rule_key, summary, why, decided_by)
					values (${p.program.id}, ${p.version.id}, 'weight_cut_planned', 'weight.cut', 'Cut planned', 'A fight at -71 kg.', 'coach')`
			);
			expect(await counts(db)).toMatchObject({
				program_blocks: 2,
				program_weeks: 2,
				planned_sessions: 2,
				programming_decisions: 2
			});
		});
	});

	it('keeps a program intact when the M2 goal it serves is deleted', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, generalGoal(), { db });
			const p = await storeProgram(db, owner);
			const [block] = await db
				.insert(programBlocks)
				.values({
					programId: p.program.id,
					position: 2,
					phase: 'accumulation',
					name: 'Strength',
					startsOn: '2026-12-14',
					endsOn: '2027-01-10',
					goalRefs: [goal.id]
				})
				.returning();
			const before = await counts(db);

			await deleteGoal(owner, goal.id, { db });

			expect(await counts(db)).toEqual(before);
			const [stored] = await db.select().from(programBlocks).where(eq(programBlocks.id, block!.id));
			expect(stored!.goalRefs).toEqual([goal.id]);
		});
	});
});
