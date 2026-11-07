/**
 * The coach proposals service on real Postgres (the M5 plan's coach-proposals-service):
 * - Every kind proposed against the program is stored with its summary (the first summary line),
 *   card rows, payload version and hash, and program_id beside base_version_id.
 * - An invalid payload or one today's data refuses is not stored, with every field at fault.
 * - An identical open proposal is returned instead of a second row; a revision supersedes the
 *   proposal it revises.
 * - Reject stores the owner's optional reason, once; accept takes only the id, re-checks the
 *   stored payload against today and runs its kind's applier in the same transaction, or
 *   supersedes it when the program has moved on. A decided proposal returns as stored.
 * - Lists read the same view, by ids or a page at a time.
 * - Someone else's id is not found, and nothing changes.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026; it is Monday morning.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ProposalKind } from '../../../src/lib/domain/coach/proposals';
import { RULE_MESSAGES } from '../../../src/lib/domain/coach/proposal-rules';
import { coachProposals, exercisePreferences, type Executor } from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	alternativesFor,
	createProgramFromPlan,
	getProgramVersion,
	skipSession,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	APPLIERS,
	ApplierUnavailableError,
	type ApplyInput
} from '../../../src/lib/server/services/coach/apply';
import {
	acceptProposal,
	createProposal,
	getProposalView,
	listProposals,
	NEW_PROGRAM_NEEDS_NO_PROGRAM,
	PROGRAM_ACTIVE,
	PROPOSAL_IDS_MAX,
	ProposalClosedError,
	ProposalRefusedError,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import {
	CoachInputError,
	CoachNotFoundError,
	type CoachDeps
} from '../../../src/lib/server/services/coach/shared';
import { getAthleteProfile } from '../../../src/lib/server/services/profile';
import { recordExercisePreference } from '../../../src/lib/server/services/training/preferences';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const MONDAY_MORNING = new Date(`${MONDAY}T08:00:00Z`);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A clock that moves a second each read, so proposals are created in order. */
function ticking(start = MONDAY_MORNING) {
	let t = start.getTime();
	return () => new Date((t += 1000));
}

async function owner(db: Executor) {
	const ownerId = await makeOwner(db);
	const deps: CoachDeps = { db, now: ticking() };
	return { ownerId, deps };
}

async function withProgram(db: Executor) {
	const { ownerId, deps } = await owner(db);
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId, versionId } = await createProgramFromPlan(
		ownerId,
		plan,
		{ source: 'rules' },
		{ db }
	);
	const stored = await getProgramVersion(ownerId, programId, 1, { db });
	const week1 = stored.blocks[0]!.weeks[0]!.sessions;
	const fullBody = week1.find((s) => s.title === 'Full body') as Extract<
		StoredSession,
		{ kind: 'strength' }
	>;
	const intervals = week1.find((s) => s.title === 'Intervals')!;
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
		versionId,
		stored,
		fullBody,
		intervals,
		squat,
		squatId,
		alternative: alternatives[0]!.id
	};
}

type Fixture = Awaited<ReturnType<typeof withProgram>>;

const draft = (kind: ProposalKind, payload: object, title = 'A change') => ({
	kind,
	title,
	rationale: 'Your squat is moving well and the week is crowded.',
	payload
});

/** One proposal of each kind proposed against the program. */
const programKinds = (f: Fixture): Record<string, object> => ({
	program_adjustment: draft('program_adjustment', {
		ops: [{ op: 'move', sessionLineage: f.intervals.lineage, toDate: '2026-11-13' }]
	}),
	workout_update: draft('workout_update', {
		ops: [
			{
				op: 'adjust_set',
				sessionLineage: f.fullBody.lineage,
				plannedExerciseLineage: f.squat.lineage,
				position: 2,
				sets: 3
			}
		]
	}),
	session_substitution: draft('session_substitution', {
		sessionLineage: f.fullBody.lineage,
		plannedExerciseLineage: f.squat.lineage,
		position: 2,
		fromExerciseId: f.squatId,
		toExerciseId: f.alternative,
		reason: 'equipment_unavailable'
	}),
	next_cycle: draft('next_cycle', {
		fromBlockLineage: f.stored.blocks[0]!.lineage,
		focus: 'Build the squat',
		phase: 'accumulation',
		weeks: 4,
		emphasis: ['quads'],
		targets: { rpeCap: 8, volumeFactor: 1.1, loadStep: 0.025, runVolumeFactor: 1 },
		rotation: [],
		running: null,
		ending: 'deload',
		constraints: []
	})
});

const preference = (exerciseId: string, sentiment: 'like' | 'dislike' = 'like') =>
	draft('preference_update', { exerciseId, sentiment, reason: 'It suits my hips' }, 'Like it');

/** Exercises from the catalogue, by key, for preference proposals. */
async function exerciseIds(db: Executor, ...keys: string[]) {
	const rows = await resolveKeys(keys, { db });
	return keys.map((k) => rows.get(k)!.id);
}

/** Every proposal row the owner has, as stored. */
const proposalRows = (db: Executor, ownerId: string) =>
	db
		.select()
		.from(coachProposals)
		.where(eq(coachProposals.ownerId, ownerId))
		.orderBy(coachProposals.createdAt);

const totalProposals = async (db: Executor) =>
	(await db.select({ n: count() }).from(coachProposals))[0]!.n;

async function refusal(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	expect(error).toBeInstanceOf(ProposalRefusedError);
	return (error as ProposalRefusedError).errors;
}

describe('createProposal', () => {
	it('stores every kind proposed against the program with its summary, rows and base', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			for (const [kind, proposal] of Object.entries(programKinds(f))) {
				const { proposal: view, duplicate } = await createProposal(f.ownerId, { proposal }, f.deps);
				expect(duplicate, kind).toBe(false);
				expect(view.status, kind).toBe('proposed');
				expect(view.rows.length, kind).toBeGreaterThan(0);
				expect(view.summary, kind).toBe(view.summaryLines[0]);
				expect(view.summary.length, kind).toBeLessThanOrEqual(200);
			}
			const rows = await proposalRows(db, f.ownerId);
			expect(rows.map((r) => r.kind)).toEqual(Object.keys(programKinds(f)));
			for (const row of rows) {
				expect(row.summary.length, row.kind).toBeGreaterThan(0);
				expect(row.programId, row.kind).toBe(f.programId);
				expect(row.baseVersionId, row.kind).toBe(f.versionId);
				expect(row.payloadVersion, row.kind).toBe(1);
				expect(row.payloadHash, row.kind).toMatch(/^[0-9a-f]{16}$/);
			}
			// The move's card row reads before → after, and the substitution names both exercises.
			const [move, , swap] = rows;
			expect(move!.summary).toMatch(/Intervals.*Wed 11 Nov.*→.*Fri 13 Nov/);
			expect(swap!.summary).toMatch(/^Full body, this session only: Back squat → /);
		});
	});

	it('stores a proposal that needs no program without one, and ties it to its conversation', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench] = await exerciseIds(db, 'bench_press');
			const evidence = { said: 'I like bench' };
			const { proposal } = await createProposal(
				ownerId,
				{ proposal: preference(bench!), evidence },
				deps
			);
			expect(proposal.summary).toBe('Bench press: No preference → Like');
			expect(proposal.links).toEqual([{ type: 'exercise', id: bench, label: 'Bench press' }]);
			const [row] = await proposalRows(db, ownerId);
			expect(row).toMatchObject({ programId: null, baseVersionId: null, evidence });
		});
	});

	it('refuses an invalid payload with every field at fault, and stores nothing', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const errors = await refusal(
				createProposal(
					f.ownerId,
					{ proposal: { ...draft('program_adjustment', { ops: [], extra: 1 }), title: ' ' } },
					f.deps
				)
			);
			expect(errors).toMatchObject({
				title: 'Give it a title',
				'payload.ops': 'Propose at least one change',
				payload: 'Unknown field: extra'
			});
			expect(
				await refusal(createProposal(f.ownerId, { proposal: { kind: 'diet' } }, f.deps))
			).toEqual({ kind: 'Unknown proposal kind' });
			expect(await proposalRows(db, f.ownerId)).toEqual([]);
		});
	});

	it('refuses what today’s data rules out: the past, a dislike, an unknown id, a second program', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			// A week on, week 1 has passed.
			const nextWeek = { ...f.deps, now: ticking(new Date('2026-11-16T08:00:00Z')) };
			expect(
				await refusal(
					createProposal(f.ownerId, { proposal: programKinds(f).workout_update }, nextWeek)
				)
			).toEqual({ 'payload.ops.0.sessionLineage': RULE_MESSAGES.past });

			await recordExercisePreference(
				f.ownerId,
				{ exerciseId: f.alternative, sentiment: 'dislike', reason: null, source: 'profile' },
				{ db }
			);
			expect(
				await refusal(
					createProposal(f.ownerId, { proposal: programKinds(f).session_substitution }, f.deps)
				)
			).toEqual({ 'payload.toExerciseId': RULE_MESSAGES.disliked });

			expect(
				await refusal(
					createProposal(f.ownerId, { proposal: preference(crypto.randomUUID()) }, f.deps)
				)
			).toEqual({ 'payload.exerciseId': RULE_MESSAGES.unknownExercise });

			// A move to another week is refused as the Move sheet refuses it.
			const away = draft('program_adjustment', {
				ops: [{ op: 'move', sessionLineage: f.intervals.lineage, toDate: '2026-11-17' }]
			});
			expect(await refusal(createProposal(f.ownerId, { proposal: away }, f.deps))).toEqual({
				'payload.ops.0.toDate': 'Pick a day in its own week'
			});

			expect(NEW_PROGRAM_NEEDS_NO_PROGRAM).toBe(true);
			const fresh = draft('new_program', {
				start: 'next_monday',
				startsOn: '2026-11-16',
				firstPlannedDay: '2026-11-16',
				fingerprint: '0123456789abcdef',
				digest: 'fedcba9876543210'
			});
			expect(await refusal(createProposal(f.ownerId, { proposal: fresh }, f.deps))).toEqual({
				kind: PROGRAM_ACTIVE
			});
			expect(await proposalRows(db, f.ownerId)).toEqual([]);
		});
	});

	it('refuses an adjustment whose set is not there or whose merged prescription is invalid', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const adjust = (change: object) =>
				draft('workout_update', {
					ops: [
						{
							op: 'adjust_set',
							sessionLineage: f.fullBody.lineage,
							plannedExerciseLineage: f.squat.lineage,
							position: 2,
							...change
						}
					]
				});
			expect(f.squat.sets[1]!.repsMax).toBe(5);
			expect(
				await refusal(createProposal(f.ownerId, { proposal: adjust({ repsMin: 6 }) }, f.deps))
			).toEqual({ 'payload.ops.0.repsMax': 'The range runs low to high' });
			const missing = f.squat.sets.length + 1;
			expect(
				await refusal(
					createProposal(f.ownerId, { proposal: adjust({ position: missing, sets: 3 }) }, f.deps)
				)
			).toEqual({ 'payload.ops.0.position': 'Unknown set' });
			expect(await proposalRows(db, f.ownerId)).toEqual([]);
		});
	});

	it('stores one of two identical proposals created at once on separate connections', async () => {
		await withCommitted(async (db) => {
			const { ownerId } = await owner(db);
			const [bench] = await exerciseIds(db, 'bench_press');
			const proposal = preference(bench!);
			// The profile row exists first, so the only lock between the two is the create's own.
			await getAthleteProfile(ownerId, { db });
			let first: Awaited<ReturnType<typeof createProposal>> | undefined;
			// The first create holds its transaction open, its row not yet committed.
			const held = await holdTransaction(async (tx) => {
				first = await createProposal(ownerId, { proposal }, { db: tx, now: ticking() });
			});
			const second = createProposal(ownerId, { proposal }, { db, now: ticking() });
			await lockWaiters(1);
			await held.commit();
			const again = await second;
			expect(first!.duplicate).toBe(false);
			expect(again).toEqual({ proposal: first!.proposal, duplicate: true });
			expect(await proposalRows(db, ownerId)).toHaveLength(1);
		});
	});

	it('returns an identical open proposal instead of storing it twice', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const proposal = programKinds(f).program_adjustment;
			const first = await createProposal(f.ownerId, { proposal }, f.deps);
			// The same payload, keys in another order, under another title.
			const again = await createProposal(
				f.ownerId,
				{
					proposal: {
						...draft(
							'program_adjustment',
							{ ops: [{ toDate: '2026-11-13', sessionLineage: f.intervals.lineage, op: 'move' }] },
							'Again'
						)
					}
				},
				f.deps
			);
			expect(again).toEqual({ proposal: first.proposal, duplicate: true });
			expect(await proposalRows(db, f.ownerId)).toHaveLength(1);
			// Once it is decided, the same change can be proposed again.
			await rejectProposal(f.ownerId, first.proposal.id, {}, f.deps);
			const later = await createProposal(f.ownerId, { proposal }, f.deps);
			expect(later.duplicate).toBe(false);
			expect(await proposalRows(db, f.ownerId)).toHaveLength(2);
		});
	});

	it('supersedes the open proposal a revision revises, and refuses to revise a decided one', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench, row] = await exerciseIds(db, 'bench_press', 'barbell_row');
			const first = await createProposal(ownerId, { proposal: preference(bench!) }, deps);
			const revised = await createProposal(
				ownerId,
				{ proposal: preference(row!), revises: first.proposal.id },
				deps
			);
			expect(revised.proposal.revisionOf).toBe(first.proposal.id);
			expect(revised.proposal.links).toContainEqual({ type: 'proposal', id: first.proposal.id });
			const before = await getProposalView(ownerId, first.proposal.id, deps);
			expect(before).toMatchObject({ status: 'superseded', supersededReason: 'revised' });
			expect(before.closedAt).not.toBeNull();

			const [squat] = await exerciseIds(db, 'back_squat');
			await expect(
				createProposal(ownerId, { proposal: preference(squat!), revises: first.proposal.id }, deps)
			).rejects.toBeInstanceOf(ProposalClosedError);
			await expect(
				createProposal(
					ownerId,
					{ proposal: preference(squat!), revises: crypto.randomUUID() },
					deps
				)
			).rejects.toBeInstanceOf(CoachNotFoundError);
			expect(await proposalRows(db, ownerId)).toHaveLength(2);
		});
	});
});

describe('rejectProposal', () => {
	it('rejects with the owner’s reason or none, and a second reject changes nothing', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench, row] = await exerciseIds(db, 'bench_press', 'barbell_row');
			const a = await createProposal(ownerId, { proposal: preference(bench!) }, deps);
			const b = await createProposal(ownerId, { proposal: preference(row!) }, deps);

			const withReason = await rejectProposal(
				ownerId,
				a.proposal.id,
				{ reason: '  My shoulder hates it  ' },
				deps
			);
			expect(withReason.changed).toBe(true);
			expect(withReason.proposal).toMatchObject({
				status: 'rejected',
				decisionNote: 'My shoulder hates it'
			});
			expect(withReason.proposal.closedAt).not.toBeNull();
			const without = await rejectProposal(ownerId, b.proposal.id, { reason: '  ' }, deps);
			expect(without.proposal).toMatchObject({ status: 'rejected', decisionNote: null });

			const [stored] = await proposalRows(db, ownerId);
			const again = await rejectProposal(
				ownerId,
				a.proposal.id,
				{ reason: 'Changed my mind' },
				deps
			);
			expect(again).toEqual({ proposal: withReason.proposal, changed: false });
			expect((await proposalRows(db, ownerId))[0]).toEqual(stored);

			await expect(
				rejectProposal(ownerId, a.proposal.id, { reason: 'x'.repeat(501) }, deps)
			).rejects.toBeInstanceOf(CoachInputError);
		});
	});
});

describe('acceptProposal', () => {
	it('takes only the id, and runs the stored proposal’s applier in its own transaction', async () => {
		expectTypeOf(acceptProposal).parameters.toEqualTypeOf<[string, string, CoachDeps?]>();
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench] = await exerciseIds(db, 'bench_press');
			const { proposal } = await createProposal(ownerId, { proposal: preference(bench!) }, deps);

			// An applier that refuses, as a stub does until its slice lands, writes nothing.
			vi.spyOn(APPLIERS, 'preference_update').mockRejectedValue(
				new ApplierUnavailableError('preference_update')
			);
			await expect(acceptProposal(ownerId, proposal.id, deps)).rejects.toBeInstanceOf(
				ApplierUnavailableError
			);
			expect((await getProposalView(ownerId, proposal.id, deps)).status).toBe('proposed');
			vi.restoreAllMocks();

			// An applier that writes and then fails leaves nothing behind: it shares the transaction.
			const failing = vi
				.spyOn(APPLIERS, 'preference_update')
				.mockImplementation(async ({ ownerId: who, proposal: p, deps: inner }) => {
					await recordExercisePreference(who, { ...p.payload, source: 'coach' }, inner);
					throw new Error('applier failed');
				});
			await expect(acceptProposal(ownerId, proposal.id, deps)).rejects.toThrow('applier failed');
			expect(failing).toHaveBeenCalledOnce();
			const preferences = await db
				.select({ n: count() })
				.from(exercisePreferences)
				.where(eq(exercisePreferences.ownerId, ownerId));
			expect(preferences[0]!.n).toBe(0);

			const applied = vi.spyOn(APPLIERS, 'preference_update').mockResolvedValue({
				status: 'applied',
				appliedRef: { kind: 'preference', id: '42' }
			});
			const result = await acceptProposal(ownerId, proposal.id, deps);
			const [input] = applied.mock.calls[0] as [ApplyInput<'preference_update'>];
			expect(input).toMatchObject({
				ownerId,
				proposalId: proposal.id,
				proposal: preference(bench!),
				programId: null,
				baseVersionId: null,
				today: MONDAY
			});
			expect(result.changed).toBe(true);
			expect(result.proposal).toMatchObject({
				status: 'applied',
				appliedRef: { kind: 'preference', id: '42' }
			});
		});
	});

	it('returns an applied proposal as stored on a second accept, writing nothing', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench] = await exerciseIds(db, 'bench_press');
			const { proposal } = await createProposal(ownerId, { proposal: preference(bench!) }, deps);
			const applier = vi.spyOn(APPLIERS, 'preference_update').mockResolvedValue({
				status: 'applied',
				appliedRef: { kind: 'preference', id: '42' }
			});
			const first = await acceptProposal(ownerId, proposal.id, deps);
			const [stored] = await proposalRows(db, ownerId);

			const second = await acceptProposal(ownerId, proposal.id, deps);
			expect(second).toEqual({ proposal: first.proposal, changed: false });
			expect(applier).toHaveBeenCalledOnce();
			expect(await proposalRows(db, ownerId)).toEqual([stored]);
		});
	});

	it('refuses a proposal that no longer passes today, after a dislike, and keeps it open', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const { proposal } = await createProposal(
				f.ownerId,
				{ proposal: programKinds(f).session_substitution },
				f.deps
			);
			await recordExercisePreference(
				f.ownerId,
				{ exerciseId: f.alternative, sentiment: 'dislike', reason: null, source: 'profile' },
				{ db }
			);
			const applier = vi.spyOn(APPLIERS, 'session_substitution');
			expect(await refusal(acceptProposal(f.ownerId, proposal.id, f.deps))).toEqual({
				'payload.toExerciseId': RULE_MESSAGES.disliked
			});
			expect(applier).not.toHaveBeenCalled();
			expect((await getProposalView(f.ownerId, proposal.id, f.deps)).status).toBe('proposed');
		});
	});

	it('supersedes a proposal whose program has a newer version, without applying it', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const { proposal } = await createProposal(
				f.ownerId,
				{ proposal: programKinds(f).program_adjustment },
				f.deps
			);
			// The owner skips a session first: version 2.
			await skipSession(
				f.ownerId,
				{ sessionLineage: f.fullBody.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);
			const applier = vi.spyOn(APPLIERS, 'program_adjustment');
			const result = await acceptProposal(f.ownerId, proposal.id, f.deps);
			expect(applier).not.toHaveBeenCalled();
			expect(result.changed).toBe(true);
			expect(result.proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'program_changed',
				appliedVersion: null
			});
			// It is closed now: rejecting it is refused.
			await expect(rejectProposal(f.ownerId, proposal.id, {}, f.deps)).rejects.toBeInstanceOf(
				ProposalClosedError
			);
		});
	});
});

describe('reading proposals', () => {
	it('lists by ids with the decision note, and pages newest first', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const ids = await exerciseIds(db, 'bench_press', 'barbell_row', 'back_squat');
			const made: string[] = [];
			for (const id of ids) {
				made.push((await createProposal(ownerId, { proposal: preference(id) }, deps)).proposal.id);
			}
			await rejectProposal(ownerId, made[0]!, { reason: 'Not now' }, deps);

			const byIds = await listProposals(
				ownerId,
				{ ids: [made[0]!, crypto.randomUUID(), 'x'] },
				deps
			);
			expect(byIds.proposals.map((p) => [p.id, p.decisionNote])).toEqual([[made[0], 'Not now']]);
			await expect(
				listProposals(
					ownerId,
					{ ids: Array.from({ length: PROPOSAL_IDS_MAX + 1 }, () => made[0]!) },
					deps
				)
			).rejects.toBeInstanceOf(CoachInputError);

			const first = await listProposals(ownerId, { limit: 2 }, deps);
			expect(first.proposals.map((p) => p.id)).toEqual([made[2], made[1]]);
			const second = await listProposals(ownerId, { limit: 2, before: first.next! }, deps);
			expect(second).toMatchObject({ next: null });
			expect(second.proposals.map((p) => p.id)).toEqual([made[0]]);

			const open = await listProposals(ownerId, { status: 'proposed' }, deps);
			expect(open.proposals.map((p) => p.id)).toEqual([made[2], made[1]]);
			expect(await getProposalView(ownerId, made[1]!, deps)).toEqual(open.proposals[1]);
		});
	});

	it('shows a stranger nothing: someone else’s proposals are not found or listed', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps } = await owner(db);
			const [bench] = await exerciseIds(db, 'bench_press');
			const { proposal } = await createProposal(ownerId, { proposal: preference(bench!) }, deps);
			const stranger = crypto.randomUUID();
			await expect(getProposalView(stranger, proposal.id, deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			expect(await listProposals(stranger, { ids: [proposal.id] }, deps)).toEqual({
				proposals: [],
				next: null
			});
		});
	});
});

describe('owner scoping', () => {
	it('accepts or rejects nothing for a random owner id: not found, with zero rows changed', async () => {
		await withRollback(async (db) => {
			const f = await withProgram(db);
			const { proposal } = await createProposal(
				f.ownerId,
				{ proposal: programKinds(f).program_adjustment },
				f.deps
			);
			const [bench] = await exerciseIds(db, 'bench_press');
			const { proposal: liked } = await createProposal(
				f.ownerId,
				{ proposal: preference(bench!) },
				f.deps
			);
			const stranger = crypto.randomUUID();
			const before = await proposalRows(db, f.ownerId);
			const total = await totalProposals(db);
			const applier = vi.spyOn(APPLIERS, 'program_adjustment');

			await expect(acceptProposal(stranger, proposal.id, f.deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			await expect(
				rejectProposal(stranger, proposal.id, { reason: 'Not mine' }, f.deps)
			).rejects.toBeInstanceOf(CoachNotFoundError);
			// One that needs no program is refused just the same, before anything is read for it.
			await expect(acceptProposal(stranger, liked.id, f.deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			await expect(acceptProposal(f.ownerId, 'not-a-uuid', f.deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);

			expect(applier).not.toHaveBeenCalled();
			expect(await proposalRows(db, f.ownerId)).toEqual(before);
			expect(await totalProposals(db)).toBe(total);
			const [{ n }] = (
				await db.execute<{ n: number }>(
					sql`select count(*)::int as n from coach_proposals where owner_id = ${stranger}`
				)
			).rows as [{ n: number }];
			expect(n).toBe(0);
			expect(
				await db
					.select({ id: coachProposals.id })
					.from(coachProposals)
					.where(and(eq(coachProposals.id, proposal.id), eq(coachProposals.status, 'proposed')))
			).toHaveLength(1);
		});
	});
});
