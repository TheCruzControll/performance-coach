/**
 * Accepting and rejecting a proposal by id on real Postgres (POST /api/coach/proposals/[id], the
 * M5 plan's proposal-actions), called as SvelteKit calls it:
 * - accept applies the stored proposal; a modified payload, a status or an ownerId in the body
 *   change nothing about what is applied or for whom
 * - a second accept answers the same result with changed: false and writes nothing
 * - the reject reason is stored, trimmed; one too long is a 400 and writes nothing
 * - a superseded proposal is a 409 carrying it, for accept and for reject; so is an accept that
 *   finds its program moved on
 * - 404 for an unknown or malformed id, and for a session whose owner it is not; 400 for a body
 *   that is not a decision; 429 past the 'coach.action' limit
 * - the services with a random ownerId against the owner's proposals are not_found and change
 *   nothing (one database holds one owner, owners_singleton_uq, so a second session cannot exist)
 */
import { asc, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	coachNotes,
	coachProposals,
	createAuthRepository,
	exercisePreferences,
	programmingDecisions,
	programVersions,
	type Executor
} from '../../../src/lib/server/db';
import { RATE_LIMITS } from '../../../src/lib/server/auth/policy';
import {
	acceptProposal,
	createProposal,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import { CoachNotFoundError, type CoachDeps } from '../../../src/lib/server/services/coach/shared';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import { listExercisePreferences } from '../../../src/lib/server/services/training/preferences';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { POST } from '../../../src/routes/api/coach/proposals/[id]/+server';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const RATIONALE = 'Bench has suited your shoulders for three weeks now.';
const URL_BASE = 'http://localhost:5173';

/** A clock that moves a second each read, from Monday morning. */
function ticking(start = new Date(`${MONDAY}T08:00:00Z`)) {
	let t = start.getTime();
	return () => new Date((t += 1000));
}

function decide(owner: string, id: string, body: unknown) {
	const request = new Request(`${URL_BASE}/api/coach/proposals/${id}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	return POST({
		request,
		params: { id },
		url: new URL(request.url),
		locals: { session: { id: crypto.randomUUID(), ownerId: owner }, requestId: 'req-test' },
		getClientAddress: () => '127.0.0.1'
	} as never) as Promise<Response>;
}

async function exerciseId(db: Executor, key: string) {
	return (await resolveKeys([key], { db })).get(key)!.id;
}

/** The owner and an open proposal to like bench press. */
async function withPreferenceProposal(db: Executor) {
	const ownerId = await makeOwner(db);
	const deps: CoachDeps = { db, now: ticking() };
	const bench = await exerciseId(db, 'bench_press');
	const draft = {
		kind: 'preference_update',
		title: 'Like bench press',
		rationale: RATIONALE,
		payload: { exerciseId: bench, sentiment: 'like', reason: 'It suits my shoulders' }
	};
	const { proposal } = await createProposal(ownerId, { proposal: draft }, deps);
	return { ownerId, deps, bench, draft, id: proposal.id };
}

/** Every row the decisions could touch, in a stable order. */
async function snapshot(db: Executor) {
	return {
		proposals: await db.select().from(coachProposals).orderBy(asc(coachProposals.id)),
		versions: await db.select().from(programVersions).orderBy(asc(programVersions.id)),
		decisions: await db.select().from(programmingDecisions).orderBy(asc(programmingDecisions.id)),
		preferences: await db.select().from(exercisePreferences).orderBy(asc(exercisePreferences.id)),
		notes: (await db.select({ n: count() }).from(coachNotes))[0]!.n
	};
}

async function stored(db: Executor, id: string) {
	const [row] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
	return row!;
}

describe('accepting by id', () => {
	it('applies the stored proposal for the session owner, whatever else the body says', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const squat = await exerciseId(db, 'back_squat');
			const response = await decide(f.ownerId, f.id, {
				action: 'accept',
				ownerId: crypto.randomUUID(),
				kind: 'preference_update',
				status: 'applied',
				payload: { exerciseId: squat, sentiment: 'dislike', reason: 'Changed in the client' },
				proposal: { ...f.draft, payload: { ...f.draft.payload, sentiment: 'dislike' } }
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = await response.json();
			expect(body).toMatchObject({ changed: true, proposal: { id: f.id, status: 'applied' } });
			const preferences = await listExercisePreferences(f.ownerId, { db });
			expect(preferences).toHaveLength(1);
			expect(preferences[0]).toMatchObject({
				exerciseId: f.bench,
				sentiment: 'like',
				reason: 'It suits my shoulders'
			});
			const row = await stored(db, f.id);
			expect(row).toMatchObject({
				ownerId: f.ownerId,
				status: 'applied',
				payload: f.draft.payload
			});
		});
	});

	it('answers a second accept with the same result, and writes nothing', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const first = await decide(f.ownerId, f.id, { action: 'accept' });
			expect(first.status).toBe(200);
			const firstBody = await first.json();
			const before = await snapshot(db);

			const second = await decide(f.ownerId, f.id, { action: 'accept' });
			expect(second.status).toBe(200);
			const secondBody = await second.json();
			expect(secondBody).toEqual({ ...firstBody, changed: false });
			expect(await snapshot(db)).toEqual(before);
		});
	});

	it('is a 409 carrying the proposal when its program moved on, and nothing is applied', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const deps: CoachDeps = { db, now: ticking() };
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const { programId } = await createProgramFromPlan(ownerId, plan, { source: 'rules' }, { db });
			const v1 = await getProgramVersion(ownerId, programId, 1, { db });
			const [fullBody, easyRun] = ['Full body', 'Easy run'].map((title) =>
				v1.blocks[0]!.weeks[0]!.sessions.find((s) => s.title === title)!
			);
			const draft = {
				kind: 'program_adjustment',
				title: 'Skip the full body day',
				rationale: RATIONALE,
				payload: { ops: [{ op: 'skip', sessionLineage: fullBody!.lineage }] }
			};
			const { proposal } = await createProposal(ownerId, { proposal: draft }, deps);
			// The owner skips another session themselves: version 2, which the proposal is not on.
			await skipSession(
				ownerId,
				{ sessionLineage: easyRun!.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);

			const response = await decide(ownerId, proposal.id, { action: 'accept' });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				error: 'conflict',
				proposal: { id: proposal.id, status: 'superseded', supersededReason: 'program_changed' }
			});
			const versions = await db
				.select({ n: count() })
				.from(programVersions)
				.where(eq(programVersions.programId, programId));
			expect(versions[0]!.n).toBe(2);
		});
	});
});

describe('rejecting by id', () => {
	it('stores the reason, trimmed, and applies nothing', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const response = await decide(f.ownerId, f.id, {
				action: 'reject',
				reason: '  I would rather keep it neutral  '
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				changed: true,
				proposal: { status: 'rejected', decisionNote: 'I would rather keep it neutral' }
			});
			expect(await stored(db, f.id)).toMatchObject({
				status: 'rejected',
				decisionNote: 'I would rather keep it neutral'
			});
			expect(await listExercisePreferences(f.ownerId, { db })).toEqual([]);
		});
	});

	it('refuses a reason that is too long with 400, and writes nothing', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const before = await snapshot(db);
			const response = await decide(f.ownerId, f.id, { action: 'reject', reason: 'x'.repeat(501) });
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'invalid_request', field: 'reason' });
			expect(await snapshot(db)).toEqual(before);
		});
	});
});

describe('a superseded proposal', () => {
	it('is a 409 carrying it, for accept and for reject, and nothing changes', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const revision = { ...f.draft, payload: { ...f.draft.payload, reason: null } };
			await createProposal(f.ownerId, { proposal: revision, revises: f.id }, f.deps);
			const before = await snapshot(db);

			for (const action of ['accept', 'reject']) {
				const response = await decide(f.ownerId, f.id, { action, reason: 'Not now' });
				expect(response.status, action).toBe(409);
				expect(await response.json(), action).toMatchObject({
					error: 'conflict',
					proposal: { id: f.id, status: 'superseded', supersededReason: 'revised' }
				});
			}
			expect(await snapshot(db)).toEqual(before);
		});
	});

	it('an accept after a reject is a 409, and it stays rejected', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			expect((await decide(f.ownerId, f.id, { action: 'reject' })).status).toBe(200);
			const response = await decide(f.ownerId, f.id, { action: 'accept' });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ proposal: { status: 'rejected' } });
			expect(await listExercisePreferences(f.ownerId, { db })).toEqual([]);
		});
	});
});

describe('requests that are not the owner’s proposal or not a decision', () => {
	it('answers 404 for an unknown id, a malformed id and another owner’s session', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const before = await snapshot(db);
			const cases: [string, string][] = [
				[f.ownerId, crypto.randomUUID()],
				[f.ownerId, 'not-a-uuid'],
				[crypto.randomUUID(), f.id]
			];
			for (const [owner, id] of cases) {
				for (const action of ['accept', 'reject']) {
					const response = await decide(owner, id, { action });
					expect(response.status, `${action} ${id}`).toBe(404);
					expect(await response.json()).toEqual({ error: 'not_found' });
				}
			}
			expect(await snapshot(db)).toEqual(before);
		});
	});

	it('answers 400 for a body that is not a decision', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			for (const body of ['not json', {}, { action: 'apply' }, { action: 'reject', reason: 7 }]) {
				const response = await decide(f.ownerId, f.id, body);
				expect(response.status, JSON.stringify(body)).toBe(400);
				expect(await response.json()).toMatchObject({ error: 'invalid_request' });
			}
			expect((await stored(db, f.id)).status).toBe('proposed');
		});
	});

	it('answers 429 past the coach.action limit, and decides nothing', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const { limit, windowMs } = RATE_LIMITS['coach.action'];
			const repo = createAuthRepository(db);
			let hits = 0;
			while (hits < limit)
				hits = await repo.hitRateLimit('coach.action:global', windowMs, new Date());

			const response = await decide(f.ownerId, f.id, { action: 'accept' });
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({ error: 'rate_limited' });
			expect((await stored(db, f.id)).status).toBe('proposed');
		});
	});
});

describe('the services with someone else’s ownerId', () => {
	it('accept and reject are not_found, and change no proposal, version, decision or preference', async () => {
		await withCommitted(async (db) => {
			const f = await withPreferenceProposal(db);
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const { programId } = await createProgramFromPlan(
				f.ownerId,
				plan,
				{ source: 'rules' },
				{ db }
			);
			const v1 = await getProgramVersion(f.ownerId, programId, 1, { db });
			const session = v1.blocks[0]!.weeks[0]!.sessions.find((s) => s.title === 'Easy run')!;
			const { proposal: adjustment } = await createProposal(
				f.ownerId,
				{
					proposal: {
						kind: 'program_adjustment',
						title: 'Skip the easy run',
						rationale: RATIONALE,
						payload: { ops: [{ op: 'skip', sessionLineage: session.lineage }] }
					}
				},
				f.deps
			);
			const before = await snapshot(db);
			expect(before.proposals).toHaveLength(2);
			expect(before.versions).toHaveLength(1);

			const stranger = crypto.randomUUID();
			for (const id of [f.id, adjustment.id]) {
				await expect(acceptProposal(stranger, id, f.deps)).rejects.toBeInstanceOf(
					CoachNotFoundError
				);
				await expect(
					rejectProposal(stranger, id, { reason: 'Not mine' }, f.deps)
				).rejects.toBeInstanceOf(CoachNotFoundError);
			}
			expect(await snapshot(db)).toEqual(before);
		});
	});
});
