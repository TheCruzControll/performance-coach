/**
 * Accepting program_adjustment and workout_update proposals on real Postgres (the M5 plan's
 * apply-program-proposals):
 * - Accepting makes version N+1, copy-on-write (the affected week copied, the others shared),
 *   with one coach decision per op carrying the proposal's rationale and id; the proposal is
 *   applied, with applied_version_id and closed_at.
 * - Three ops are one version; accepting twice gives the same version and writes nothing more.
 * - An owner edit in between supersedes it (program_changed), and nothing is applied.
 * - A session gone past, or done since, refuses it and it stays proposed; a rejected one stays
 *   rejected.
 * - A workout_update is refused once its workout has started (in progress or completed).
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026; it is Monday morning.
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RULE_MESSAGES } from '../../../src/lib/domain/coach/proposal-rules';
import type { ProposalKind } from '../../../src/lib/domain/coach/proposals';
import { coachProposals, workouts, type Executor } from '../../../src/lib/server/db';
import { programVersions } from '../../../src/lib/server/db/schema/programs';
import { APPLIERS } from '../../../src/lib/server/services/coach/apply';
import { WORKOUT_STARTED } from '../../../src/lib/server/services/coach/apply/program';
import {
	acceptProposal,
	createProposal,
	ProposalRefusedError,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import type { CoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	createProgramFromPlan,
	getProgramVersion,
	skipSession,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const FRIDAY = '2026-11-13';
const RATIONALE = 'Your squat is moving well and the week is crowded.';

/** A clock that moves a second each read, from `start`. */
function ticking(start = new Date(`${MONDAY}T08:00:00Z`)) {
	let t = start.getTime();
	return () => new Date((t += 1000));
}

const titled = (v: ProgramVersion, title: string) =>
	v.blocks[0]!.weeks[0]!.sessions.find((s) => s.title === title)!;

function strength(session: StoredSession) {
	if (session.kind !== 'strength') throw new Error(`${session.title} is not a strength session`);
	return session;
}

async function withProgram(db: Executor) {
	const ownerId = await makeOwner(db);
	const deps: CoachDeps = { db, now: ticking() };
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId } = await createProgramFromPlan(ownerId, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(ownerId, programId, 1, { db });
	const fullBody = strength(titled(v1, 'Full body'));
	const squat = fullBody.exercises.find(
		(e) => 'key' in e.exercise && e.exercise.key === 'back_squat'
	)!;
	return { ownerId, deps, programId, v1, fullBody, squat, intervals: titled(v1, 'Intervals') };
}

type Fixture = Awaited<ReturnType<typeof withProgram>>;

const draft = (kind: ProposalKind, ops: object[], title = 'Spread out the week') => ({
	kind,
	title,
	rationale: RATIONALE,
	payload: { ops }
});

/** An adjust_set on the Full body squat's back-off set. */
const backOff = (f: Fixture, sets: number) => ({
	op: 'adjust_set',
	sessionLineage: f.fullBody.lineage,
	plannedExerciseLineage: f.squat.lineage,
	position: 2,
	sets
});

async function propose(f: Fixture, kind: ProposalKind, ops: object[]) {
	const { proposal } = await createProposal(f.ownerId, { proposal: draft(kind, ops) }, f.deps);
	return proposal.id;
}

const versionCount = async (db: Executor, programId: string) =>
	(
		await db
			.select({ n: count() })
			.from(programVersions)
			.where(eq(programVersions.programId, programId))
	)[0]!.n;

async function storedProposal(db: Executor, id: string) {
	const [row] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
	return row!;
}

async function refusal(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	expect(error).toBeInstanceOf(ProposalRefusedError);
	return (error as ProposalRefusedError).errors;
}

/** A workout of the owner's logged against `session` of version 1. */
async function logWorkout(
	db: Executor,
	f: Fixture,
	session: StoredSession,
	status: 'in_progress' | 'completed' | 'abandoned'
) {
	const startedAt = new Date(`${MONDAY}T07:00:00Z`);
	await db.insert(workouts).values({
		ownerId: f.ownerId,
		clientId: crypto.randomUUID(),
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: session.title,
		plannedSessionId: session.id,
		plannedLineageId: session.lineage,
		programId: f.programId,
		status,
		startedAt,
		finishedAt: status === 'in_progress' ? null : new Date(startedAt.getTime() + 3_600_000)
	});
}

describe('accepting a program_adjustment', () => {
	it('makes one new version of three ops, copy-on-write, with coach decisions carrying the rationale', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [
				{ op: 'move', sessionLineage: f.intervals.lineage, toDate: FRIDAY },
				backOff(f, 4),
				{ op: 'skip', sessionLineage: titled(f.v1, 'Easy run').lineage }
			]);
			expect(await versionCount(db, f.programId)).toBe(1);

			const { proposal, changed } = await acceptProposal(f.ownerId, id, f.deps);
			expect(changed).toBe(true);
			expect(proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			expect(proposal.closedAt).toBeInstanceOf(Date);
			expect(await versionCount(db, f.programId)).toBe(2);

			const v2 = await getProgramVersion(f.ownerId, f.programId, 2, { db });
			expect(v2.version).toMatchObject({
				id: proposal.appliedVersion!.id,
				summary: 'Spread out the week',
				createdBy: 'coach',
				current: true
			});
			const row = await storedProposal(db, id);
			expect(row.appliedVersionId).toBe(v2.version.id);
			expect(row.closedAt).not.toBeNull();

			// Every op landed in the one version.
			expect(titled(v2, 'Intervals')).toMatchObject({ date: FRIDAY, status: 'moved' });
			expect(titled(v2, 'Easy run')).toMatchObject({ status: 'skipped' });
			const squat2 = strength(titled(v2, 'Full body')).exercises.find(
				(e) => e.lineage === f.squat.lineage
			)!;
			expect(squat2.sets[1]).toMatchObject({ sets: 4 });

			// Copy-on-write: week 1 is copied once, every later week is shared as it was.
			const weeks1 = f.v1.blocks.flatMap((b) => b.weeks);
			const weeks2 = v2.blocks.flatMap((b) => b.weeks);
			expect(weeks2[0]!.id).not.toBe(weeks1[0]!.id);
			expect(weeks2[0]!.lineage).toBe(weeks1[0]!.lineage);
			expect(weeks2.slice(1)).toEqual(weeks1.slice(1));
			expect(weeks2.length).toBeGreaterThan(1);

			// One coach decision per op, each with the rationale and the proposal's id.
			expect(v2.decisions.map((d) => d.kind)).toEqual([
				'session_moved',
				'prescription_adjusted',
				'session_skipped'
			]);
			for (const decision of v2.decisions) {
				expect(decision).toMatchObject({
					why: RATIONALE,
					decidedBy: 'coach',
					evidence: expect.objectContaining({ proposalId: id })
				});
			}
		});
	});

	it('gives the same version when accepted twice, writing nothing more', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [backOff(f, 4)]);
			const first = await acceptProposal(f.ownerId, id, f.deps);
			const again = await acceptProposal(f.ownerId, id, f.deps);
			expect(again.changed).toBe(false);
			expect(again.proposal).toEqual(first.proposal);
			expect(again.proposal.appliedVersion).toMatchObject({ number: 2 });
			expect(await versionCount(db, f.programId)).toBe(2);
		});
	});

	it('is superseded when the owner edited the program in between, and applies nothing', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [backOff(f, 4)]);
			await skipSession(
				f.ownerId,
				{ sessionLineage: f.intervals.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);
			const { proposal } = await acceptProposal(f.ownerId, id, f.deps);
			expect(proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'program_changed',
				appliedVersion: null
			});
			expect(await versionCount(db, f.programId)).toBe(2);
			const v2 = await getProgramVersion(f.ownerId, f.programId, 2, { db });
			expect(v2.decisions.every((d) => d.decidedBy === 'owner')).toBe(true);
		});
	});

	it('is superseded by the applier itself when its base is no longer current', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [backOff(f, 4)]);
			const base = (await storedProposal(db, id)).baseVersionId!;
			await skipSession(
				f.ownerId,
				{ sessionLineage: f.intervals.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);
			const outcome = await APPLIERS.program_adjustment({
				ownerId: f.ownerId,
				proposalId: id,
				proposal: draft('program_adjustment', [backOff(f, 4)]) as never,
				programId: f.programId,
				baseVersionId: base,
				today: MONDAY,
				deps: { db, now: ticking() }
			});
			expect(outcome).toEqual({ status: 'superseded', reason: 'program_changed' });
			expect(await versionCount(db, f.programId)).toBe(2);
		});
	});

	it('is refused for a session gone past, and stays proposed', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [backOff(f, 4)]);
			// A week later, Monday's session is past.
			const later = { db, now: ticking(new Date('2026-11-16T08:00:00Z')) };
			expect(await refusal(acceptProposal(f.ownerId, id, later))).toEqual({
				'payload.ops.0.sessionLineage': RULE_MESSAGES.past
			});
			expect(await storedProposal(db, id)).toMatchObject({ status: 'proposed', closedAt: null });
			expect(await versionCount(db, f.programId)).toBe(1);
		});
	});

	it('is refused at its op when the session is done since, writing nothing', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [
				{ op: 'skip', sessionLineage: f.intervals.lineage },
				backOff(f, 4)
			]);
			await logWorkout(db, f, f.fullBody, 'completed');
			expect(await refusal(acceptProposal(f.ownerId, id, f.deps))).toEqual({
				'payload.ops.1.sessionLineage': 'This session is done'
			});
			expect(await storedProposal(db, id)).toMatchObject({ status: 'proposed', closedAt: null });
			expect(await versionCount(db, f.programId)).toBe(1);
		});
	});

	it('stays rejected when accepted after a rejection', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f, 'program_adjustment', [backOff(f, 4)]);
			await rejectProposal(f.ownerId, id, { reason: 'Not this week' }, f.deps);
			const { proposal, changed } = await acceptProposal(f.ownerId, id, f.deps);
			expect(changed).toBe(false);
			expect(proposal).toMatchObject({ status: 'rejected', appliedVersion: null });
			expect(await versionCount(db, f.programId)).toBe(1);
		});
	});
});

describe('accepting a workout_update', () => {
	it('applies to a workout not yet started, as one coach version', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			// An abandoned attempt does not count as the workout having started.
			await logWorkout(db, f, f.fullBody, 'abandoned');
			const id = await propose(f, 'workout_update', [backOff(f, 5)]);
			const { proposal } = await acceptProposal(f.ownerId, id, f.deps);
			expect(proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			const v2 = await getProgramVersion(f.ownerId, f.programId, 2, { db });
			expect(v2.decisions).toEqual([
				expect.objectContaining({ decidedBy: 'coach', why: RATIONALE })
			]);
		});
	});

	for (const status of ['in_progress', 'completed'] as const) {
		it(`is refused once its workout has started (${status}), writing nothing`, async () => {
			await withRollback(async (db) => {
				const f = await withProgram(db);
				const id = await propose(f, 'workout_update', [backOff(f, 5)]);
				await logWorkout(db, f, f.fullBody, status);
				expect(await refusal(acceptProposal(f.ownerId, id, f.deps))).toEqual({
					'payload.ops.0.sessionLineage': WORKOUT_STARTED
				});
				const open = await db
					.select({ n: count() })
					.from(coachProposals)
					.where(and(eq(coachProposals.id, id), eq(coachProposals.status, 'proposed')));
				expect(open[0]!.n).toBe(1);
				expect(await versionCount(db, f.programId)).toBe(1);
			});
		});
	}
});
