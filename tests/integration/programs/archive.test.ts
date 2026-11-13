/**
 * Ending a plan (services/programs/archive.ts) on real Postgres: the active program is archived,
 * Today goes back to 'none' so Build my program is offered, a new program can be stored at once,
 * and the archived program's workouts stay. Its open coach proposals are superseded
 * ('program_changed'); a decided one and one with no program are left as they were. A workout
 * of the plan in progress refuses it and writes nothing; with no active program nothing changes.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { createCoachProposalsRepository } from '../../../src/lib/server/db/repositories/coach-proposals';
import { coachProposals, programs, workouts } from '../../../src/lib/server/db/schema';
import {
	archiveProgram,
	createProgramFromPlan,
	ProgramArchiveConflictError
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadTodayProgram } from '../../../src/routes/(app)/today/program.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const now = new Date('2026-11-05T09:00:00Z');
const at = () => now;
const plan = () => programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-05' });
const origin = () => ({
	requestId: crypto.randomUUID(),
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

async function logWorkout(
	db: Executor,
	owner: string,
	programId: string,
	status: 'in_progress' | 'completed'
) {
	const startedAt = new Date('2026-11-04T07:00:00Z');
	await db.insert(workouts).values({
		ownerId: owner,
		clientId: crypto.randomUUID(),
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: 'Squat day',
		programId,
		status,
		startedAt,
		finishedAt: status === 'in_progress' ? null : new Date(startedAt.getTime() + 3_600_000)
	});
}

async function propose(db: Executor, owner: string, programId: string | null) {
	return createCoachProposalsRepository(db).insertProposal({
		ownerId: owner,
		kind: 'program_adjustment',
		title: 'Lighter Thursday',
		summary: 'A change',
		rationale: 'A reason',
		payload: {},
		programId,
		createdAt: new Date('2026-11-04T08:00:00Z')
	});
}

const statusOf = async (db: Executor, id: string) =>
	(await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;

describe('archiveProgram', () => {
	it('archives the active plan, keeps its workouts, and lets Today build a new one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId } = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			await logWorkout(db, owner, programId, 'completed');

			expect(await archiveProgram(owner, { db, now: at })).toEqual({
				programId,
				archived: true,
				supersededProposals: 0
			});
			const [row] = await db.select().from(programs).where(eq(programs.id, programId));
			expect(row).toMatchObject({ status: 'archived', archivedAt: now });
			const kept = await db.select().from(workouts).where(eq(workouts.programId, programId));
			expect(kept).toHaveLength(1);
			expect(await loadTodayProgram(owner, { now, origin: origin() }, { db })).toMatchObject({
				state: 'none',
				program: null
			});

			// The same build again is a new program now, not the archived one repeated.
			const next = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			expect(next).toMatchObject({ created: true });
			expect(next.programId).not.toBe(programId);
		});
	});

	it('supersedes the plan’s open proposals and leaves the rest alone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId } = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			const open = await propose(db, owner, programId);
			const unrelated = await propose(db, owner, null);

			const result = await archiveProgram(owner, { db, now: at });
			expect(result.supersededProposals).toBe(1);
			expect(await statusOf(db, open)).toMatchObject({
				status: 'superseded',
				supersededReason: 'program_changed',
				closedAt: now
			});
			expect(await statusOf(db, unrelated)).toMatchObject({ status: 'proposed' });
		});
	});

	it('refuses while a workout of the plan is in progress, writing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId } = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			await logWorkout(db, owner, programId, 'in_progress');
			const open = await propose(db, owner, programId);

			await expect(archiveProgram(owner, { db, now: at })).rejects.toBeInstanceOf(
				ProgramArchiveConflictError
			);
			const [row] = await db.select().from(programs).where(eq(programs.id, programId));
			expect(row).toMatchObject({ status: 'active', archivedAt: null });
			expect(await statusOf(db, open)).toMatchObject({ status: 'proposed' });
		});
	});

	it('changes nothing with no active plan, and is owner-scoped', async () => {
		await withRollback(async (db) => {
			// One owner per app (owners_singleton_uq): another id stands for someone else.
			const owner = await makeOwner(db);
			const { programId } = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			expect(await archiveProgram(crypto.randomUUID(), { db, now: at })).toEqual({
				programId: null,
				archived: false,
				supersededProposals: 0
			});
			const [row] = await db.select().from(programs).where(eq(programs.id, programId));
			expect(row).toMatchObject({ status: 'active' });
		});
	});
});
