/**
 * Accepting a session substitution, a new program and a next cycle on real Postgres (the M5
 * plan's apply-session-program-cycle):
 * - In a live workout, 'machine unavailable' is M4's exercise.substitute through the sync
 *   dispatcher, under the proposal's id: one substitution and one ledger row, no preference, the
 *   same program version. Accepting again writes nothing.
 * - With no workout, it is M3's one-off swap: one new version, the session's exercise swapped in
 *   that week only.
 * - A workout finished, or gone, supersedes it, and nothing is written.
 * - new_program is M3's buildProgram: version 1, with program_id and applied_version_id set at
 *   apply. A profile changed since the preview supersedes it.
 * - next_cycle is accepted, and changes no program.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026; it is Monday morning.
 */
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ProposalKind } from '../../../src/lib/domain/coach/proposals';
import {
	coachProposals,
	exercisePreferences,
	programs,
	syncMutations,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { programVersions } from '../../../src/lib/server/db/schema/programs';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
// The proposals service first: it loads every applier, as the app does.
import {
	acceptProposal,
	createProposal,
	ProposalRefusedError
} from '../../../src/lib/server/services/coach/proposals';
import { OTHER_SESSION, SESSION_ENDED } from '../../../src/lib/server/services/coach/apply/session';
import type { CoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	completeOnboarding,
	createGoal,
	saveSchedule
} from '../../../src/lib/server/services/profile';
import { previewProgram } from '../../../src/lib/server/services/programming/index';
import {
	alternativesFor,
	createProgramFromPlan,
	getProgramVersion,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const RATIONALE = 'The rack is taken; the leg press trains the same pattern today.';

/** A clock that moves a second each read, from Monday morning. */
function ticking(start = new Date(`${MONDAY}T08:00:00Z`)) {
	let t = start.getTime();
	return () => new Date((t += 1000));
}

function strength(session: StoredSession) {
	if (session.kind !== 'strength') throw new Error(`${session.title} is not a strength session`);
	return session;
}

const weeksOf = (v: ProgramVersion) => v.blocks.flatMap((b) => b.weeks);
const fullBodyOf = (v: ProgramVersion, week = 0) =>
	strength(weeksOf(v)[week]!.sessions.find((s) => s.title === 'Full body')!);

async function withProgram(db: Executor) {
	const ownerId = await makeOwner(db);
	const deps: CoachDeps = { db, now: ticking() };
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId } = await createProgramFromPlan(ownerId, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(ownerId, programId, 1, { db });
	const fullBody = fullBodyOf(v1);
	const squat = fullBody.exercises.find(
		(e) => 'key' in e.exercise && e.exercise.key === 'back_squat'
	)!;
	const squatId = (await resolveKeys(['back_squat'], { db })).get('back_squat')!.id;
	const at = { sessionLineage: fullBody.lineage, plannedExerciseLineage: squat.lineage };
	const { alternatives } = await alternativesFor(ownerId, at, { db });
	return {
		ownerId,
		deps,
		programId,
		v1,
		fullBody,
		squat,
		squatId,
		alternative: alternatives[0]!.id
	};
}

type Fixture = Awaited<ReturnType<typeof withProgram>>;

const draft = (kind: ProposalKind, payload: object, title = 'Swap the squat today') => ({
	kind,
	title,
	rationale: RATIONALE,
	payload
});

/** 'Machine unavailable': the squat swapped for an alternative in Full body. */
const substitution = (f: Fixture, workoutId?: string) =>
	draft('session_substitution', {
		...(workoutId && { workoutId }),
		sessionLineage: f.fullBody.lineage,
		plannedExerciseLineage: f.squat.lineage,
		position: 1,
		fromExerciseId: f.squatId,
		toExerciseId: f.alternative,
		reason: 'equipment_unavailable'
	});

async function propose(ownerId: string, proposal: object, deps: CoachDeps) {
	return (await createProposal(ownerId, { proposal }, deps)).proposal.id;
}

/** A workout of the owner's on Full body, as M4's workout.start stores it; its client id. */
async function logWorkout(
	db: Executor,
	f: Fixture,
	status: 'in_progress' | 'completed' | 'abandoned',
	deleted = false
) {
	const clientId = crypto.randomUUID();
	const startedAt = new Date(`${MONDAY}T07:00:00Z`);
	await db.insert(workouts).values({
		ownerId: f.ownerId,
		clientId,
		kind: 'strength',
		discipline: 'strength',
		sessionType: 'strength',
		title: f.fullBody.title,
		plannedSessionId: f.fullBody.id,
		plannedLineageId: f.fullBody.lineage,
		programId: f.programId,
		status,
		startedAt,
		finishedAt: status === 'in_progress' ? null : new Date(startedAt.getTime() + 3_600_000),
		deletedAt: deleted ? new Date(`${MONDAY}T07:30:00Z`) : null
	});
	return clientId;
}

/** What a session substitution may write, counted for the owner. */
async function writes(db: Executor, f: Fixture) {
	const n = async (table: typeof workoutSubstitutions | typeof syncMutations) =>
		(await db.select({ n: count() }).from(table).where(eq(table.ownerId, f.ownerId)))[0]!.n;
	const versions = await db
		.select({ n: count() })
		.from(programVersions)
		.where(eq(programVersions.programId, f.programId));
	const preferences = await db
		.select({ n: count() })
		.from(exercisePreferences)
		.where(eq(exercisePreferences.ownerId, f.ownerId));
	return {
		substitutions: await n(workoutSubstitutions),
		ledger: await n(syncMutations),
		versions: versions[0]!.n,
		preferences: preferences[0]!.n
	};
}

const NOTHING = { substitutions: 0, ledger: 0, versions: 1, preferences: 0 };

async function storedProposal(db: Executor, id: string) {
	const [row] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
	return row!;
}

describe('accepting a session substitution', () => {
	it('in a live workout is one substitution and one ledger row under its id, with no preference and the same version', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const workoutId = await logWorkout(db, f, 'in_progress');
			const id = await propose(f.ownerId, substitution(f, workoutId), f.deps);

			const { proposal, changed } = await acceptProposal(f.ownerId, id, f.deps);
			expect(changed).toBe(true);
			const [row] = await db
				.select()
				.from(workoutSubstitutions)
				.where(eq(workoutSubstitutions.ownerId, f.ownerId));
			expect(row).toMatchObject({
				clientMutationId: id,
				plannedExerciseLineageId: f.squat.lineage,
				exercisePosition: 1,
				fromExerciseId: f.squatId,
				toExerciseId: f.alternative,
				reason: 'equipment_unavailable'
			});
			expect(proposal).toMatchObject({
				status: 'applied',
				appliedVersion: null,
				appliedRef: { kind: 'substitution', id: row!.id }
			});
			const [ledger] = await db
				.select()
				.from(syncMutations)
				.where(eq(syncMutations.ownerId, f.ownerId));
			expect(ledger).toMatchObject({
				mutationId: id,
				type: 'exercise.substitute',
				entityId: id,
				workoutClientId: workoutId
			});
			expect(await writes(db, f)).toEqual({ ...NOTHING, substitutions: 1, ledger: 1 });
			const current = await getProgramVersion(f.ownerId, f.programId, 1, { db });
			expect(current.version.current).toBe(true);

			// A second accept returns it as stored and writes nothing.
			const again = await acceptProposal(f.ownerId, id, f.deps);
			expect(again).toEqual({ proposal, changed: false });
			expect(await writes(db, f)).toEqual({ ...NOTHING, substitutions: 1, ledger: 1 });
		});
	});

	it('goes into a workout started on its session since it was proposed', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f.ownerId, substitution(f), f.deps);
			const workoutId = await logWorkout(db, f, 'in_progress');
			const { proposal } = await acceptProposal(f.ownerId, id, f.deps);
			expect(proposal).toMatchObject({
				status: 'applied',
				appliedRef: { kind: 'substitution' }
			});
			const [ledger] = await db
				.select()
				.from(syncMutations)
				.where(eq(syncMutations.ownerId, f.ownerId));
			expect(ledger).toMatchObject({ mutationId: id, workoutClientId: workoutId });
			expect(await writes(db, f)).toEqual({ ...NOTHING, substitutions: 1, ledger: 1 });
		});
	});

	it('with no workout is one new version swapping the exercise in that session only', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f.ownerId, substitution(f), f.deps);
			const { proposal } = await acceptProposal(f.ownerId, id, f.deps);
			expect(proposal).toMatchObject({
				status: 'applied',
				appliedVersion: { number: 2 },
				appliedRef: null
			});
			expect(await writes(db, f)).toEqual({ ...NOTHING, versions: 2 });

			const v2 = await getProgramVersion(f.ownerId, f.programId, 2, { db });
			expect((await storedProposal(db, id)).appliedVersionId).toBe(v2.version.id);
			const swapped = fullBodyOf(v2).exercises.find((e) => e.lineage === f.squat.lineage)!;
			expect(swapped.exercise).not.toEqual(f.squat.exercise);
			// Scope once: next week's Full body still squats.
			const nextWeek = fullBodyOf(v2, 1).exercises.map((e) => e.exercise);
			expect(nextWeek).toContainEqual(f.squat.exercise);
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					decidedBy: 'coach',
					why: RATIONALE,
					evidence: expect.objectContaining({ proposalId: id })
				})
			]);
		});
	});

	for (const [name, status, deleted] of [
		['finished', 'completed', false],
		['abandoned', 'abandoned', false],
		['deleted', 'in_progress', true]
	] as const) {
		it(`is superseded when its workout is ${name}, writing nothing`, async () => {
			await withRollback(async (db) => {
				const f = await withProgram(db);
				const workoutId = await logWorkout(db, f, 'in_progress');
				const id = await propose(f.ownerId, substitution(f, workoutId), f.deps);
				await db
					.update(workouts)
					.set({
						status,
						finishedAt: status === 'in_progress' ? null : new Date(`${MONDAY}T07:50:00Z`),
						deletedAt: deleted ? new Date(`${MONDAY}T07:50:00Z`) : null
					})
					.where(eq(workouts.clientId, workoutId));

				const { proposal, changed } = await acceptProposal(f.ownerId, id, f.deps);
				expect(changed).toBe(true);
				expect(proposal).toMatchObject({
					status: 'superseded',
					supersededReason: SESSION_ENDED,
					appliedVersion: null,
					appliedRef: null
				});
				expect(await writes(db, f)).toEqual(NOTHING);
			});
		});
	}

	it('is superseded with no workout named once the session is done, writing nothing', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const id = await propose(f.ownerId, substitution(f), f.deps);
			await logWorkout(db, f, 'completed');
			const { proposal } = await acceptProposal(f.ownerId, id, f.deps);
			expect(proposal).toMatchObject({ status: 'superseded', supersededReason: SESSION_ENDED });
			expect(await writes(db, f)).toEqual(NOTHING);
		});
	});

	it('is superseded, not refused as past, when its workout finished and it is accepted the next day', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const workoutId = await logWorkout(db, f, 'in_progress');
			const id = await propose(f.ownerId, substitution(f, workoutId), f.deps);
			await db
				.update(workouts)
				.set({ status: 'completed', finishedAt: new Date(`${MONDAY}T07:50:00Z`) })
				.where(eq(workouts.clientId, workoutId));

			const tuesday = { db, now: ticking(new Date('2026-11-10T08:00:00Z')) };
			const { proposal } = await acceptProposal(f.ownerId, id, tuesday);
			expect(proposal).toMatchObject({ status: 'superseded', supersededReason: SESSION_ENDED });
			expect(await writes(db, f)).toEqual(NOTHING);
		});
	});

	it('is refused when the workout it names is another session’s, and stays proposed', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const workoutId = await logWorkout(db, f, 'in_progress');
			await db
				.update(workouts)
				.set({ plannedLineageId: weeksOf(f.v1)[1]!.sessions[0]!.lineage })
				.where(eq(workouts.clientId, workoutId));
			const id = await propose(f.ownerId, substitution(f, workoutId), f.deps);
			const error = await acceptProposal(f.ownerId, id, f.deps).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposalRefusedError);
			expect((error as ProposalRefusedError).errors).toEqual({
				'payload.workoutId': OTHER_SESSION
			});
			expect(await storedProposal(db, id)).toMatchObject({ status: 'proposed' });
			expect(await writes(db, f)).toEqual(NOTHING);
		});
	});
});

describe('accepting a new program', () => {
	/** An onboarded owner with no program, and the preview the coach proposed from. */
	async function onboarded(db: Executor) {
		const ownerId = await makeOwner(db);
		const deps: CoachDeps = { db, now: ticking() };
		const goal = {
			kind: 'general',
			title: 'Get stronger',
			disciplines: ['strength'],
			focus: 'Get stronger',
			measure: 'Train every planned week'
		};
		await createGoal(ownerId, goal, { db });
		await saveSchedule(ownerId, schedule(3), { db });
		await completeOnboarding(ownerId, { db });
		const preview = await previewProgram(ownerId, { today: MONDAY, start: 'next_monday' }, { db });
		const proposal = draft(
			'new_program',
			{
				start: 'next_monday',
				startsOn: preview.startsOn,
				firstPlannedDay: preview.firstPlannedDay,
				fingerprint: preview.fingerprint,
				digest: preview.digest
			},
			'Your first program'
		);
		return { ownerId, deps, preview, id: await propose(ownerId, proposal, deps) };
	}

	const schedule = (daysPerWeek: number) => ({
		daysPerWeek,
		availableDays: [],
		preferredTimes: [],
		sessionMinutes: null,
		constraints: null,
		commitments: []
	});

	const programRows = (db: Executor, ownerId: string) =>
		db.select().from(programs).where(eq(programs.ownerId, ownerId));

	it('builds version 1 through M3’s generator, setting program_id with applied_version_id', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, preview, id } = await onboarded(db);
			expect(await storedProposal(db, id)).toMatchObject({ programId: null });

			const { proposal } = await acceptProposal(ownerId, id, deps);
			expect(proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 1 } });
			const [program] = await programRows(db, ownerId);
			const row = await storedProposal(db, id);
			expect(row.programId).toBe(program!.id);
			expect(row.appliedVersionId).toBe(proposal.appliedVersion!.id);

			const v1 = await getProgramVersion(ownerId, program!.id, 1, { db });
			expect(v1.version.id).toBe(row.appliedVersionId);
			expect([v1.startsOn, v1.firstPlannedDay]).toEqual([
				preview.startsOn,
				preview.firstPlannedDay
			]);
			expect(v1.decisions.filter((d) => d.kind === 'owner_confirmed')).toEqual([
				expect.objectContaining({
					decidedBy: 'coach',
					evidence: expect.objectContaining({
						fingerprint: preview.fingerprint,
						digest: preview.digest
					})
				})
			]);
		});
	});

	it('is superseded when the profile changed since the preview, and builds nothing', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, id } = await onboarded(db);
			await saveSchedule(ownerId, schedule(4), { db });
			const { proposal } = await acceptProposal(ownerId, id, deps);
			expect(proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'program_changed',
				appliedVersion: null
			});
			expect(await storedProposal(db, id)).toMatchObject({ programId: null });
			expect(await programRows(db, ownerId)).toEqual([]);
		});
	});
});

describe('accepting a next cycle', () => {
	it('is accepted and changes no program, waiting for the cycle review', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const nextCycle = draft(
				'next_cycle',
				{
					fromBlockLineage: f.v1.blocks[0]!.lineage,
					focus: 'Build the squat',
					phase: 'accumulation',
					weeks: 4,
					emphasis: ['quads'],
					targets: { rpeCap: 8, volumeFactor: 1.1, loadStep: 0.025, runVolumeFactor: 1 },
					rotation: [],
					running: null,
					ending: 'deload',
					constraints: []
				},
				'Next block: build the squat'
			);
			const id = await propose(f.ownerId, nextCycle, f.deps);
			const { proposal, changed } = await acceptProposal(f.ownerId, id, f.deps);
			expect(changed).toBe(true);
			expect(proposal).toMatchObject({
				status: 'accepted',
				appliedVersion: null,
				appliedRef: null
			});
			expect((await storedProposal(db, id)).closedAt).not.toBeNull();
			expect(await writes(db, f)).toEqual(NOTHING);
		});
	});
});
