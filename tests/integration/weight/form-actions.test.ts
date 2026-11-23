/**
 * The weight screens' form actions (src/lib/server/forms/weight.ts) and the coach's Undo endpoint
 * (src/routes/api/coach/weights/[id]/undo) on real Postgres, through the real services:
 * - every action saves what the owner posted, answers 200 with it as stored, and refuses input
 *   the owner can fix with 400 (field errors, nothing stored); an action that names a record
 *   answers 404 when it no longer exists. An unreadable form and a signed-out request never reach
 *   the service
 * - Undo answers 200 when it takes the coach's write back, 404 once the weigh-in is gone, 409
 *   when the owner has changed it since, and 401 for a signed-out request (the guard)
 */
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { guardRequest } from '../../../src/lib/server/auth/guard';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import { createWeightRepository, type Executor } from '../../../src/lib/server/db';
import {
	clearGoalAction,
	deleteWeightAction,
	editMilestonesAction,
	editWeightAction,
	logWeightAction,
	setGoalAction,
	setPhaseAction,
	type WeightFormDeps
} from '../../../src/lib/server/forms/weight';
import { getAthleteProfile } from '../../../src/lib/server/services/profile';
import {
	clearWeightGoal,
	editWeight,
	logWeight,
	setNutritionPhase,
	setWeightGoal
} from '../../../src/lib/server/services/weight';
import { POST as undo } from '../../../src/routes/api/coach/weights/[id]/undo/+server';
import { withCommitted, withRollback } from '../helpers';
import { clock, makeOwner, makeSecondOwner } from '../profile/fixtures';

const ORIGIN = 'http://localhost:5173';
const NOW = '2026-11-10T08:00:00Z';
const TODAY = '2026-11-10';
const GOAL = { targetWeight: 78, targetOn: '2027-01-31' };
const RUN = crypto.randomUUID();

/** The database and a clock on the test's day, so "today" is TODAY wherever a service asks. */
const deps = (db: Executor): WeightFormDeps & { db: Executor } => ({ db, now: clock(NOW).now });

function session(ownerId: string, kind: AuthSession['kind'] = 'owner'): App.Locals {
	return {
		requestId: 'test',
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind,
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

/** The request a weight form posts (src/lib/client/profile-form.ts's JSON `payload`). */
function post(payload: unknown, raw = JSON.stringify(payload)): Request {
	const body = new FormData();
	body.set('payload', raw);
	return new Request(`${ORIGIN}/progress?/action`, { method: 'POST', body });
}

/** What an action threw (fails the test if it returned instead). */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		(value) => {
			throw new Error(`expected the action to throw, it returned ${JSON.stringify(value)}`);
		},
		(err: unknown) => err
	);
}

/** The field errors of a refused form (fails the test if it was not a 400 with errors). */
function refused(result: unknown, status: number) {
	expect(isActionFailure(result)).toBe(true);
	expect((result as { status: number }).status).toBe(status);
	return (result as { data: { errors?: Record<string, string>; message?: string } }).data;
}

const kg = (value: number, measuredOn: string) => ({ value, unit: 'kg', measuredOn });

describe('logging a weigh-in', () => {
	it('stores today’s weigh-in from the log source and answers with it as stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const at = deps(db);
			const result = await logWeightAction(
				{ locals: session(owner), request: post({ value: 82.4, unit: 'kg' }) },
				at
			);
			expect(result).toEqual({
				entry: {
					id: expect.any(Number),
					measuredOn: TODAY,
					value: 82.4,
					unit: 'kg',
					source: 'log'
				},
				replaced: null
			});
		});
	});

	it('replaces the day’s weigh-in and answers with the one it replaced', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const at = deps(db);
			await logWeightAction({ locals: session(owner), request: post(kg(82.4, TODAY)) }, at);
			const result = (await logWeightAction(
				{ locals: session(owner), request: post(kg(81.9, TODAY)) },
				at
			)) as { entry: { value: number }; replaced: { value: number } };
			expect(result.entry.value).toBe(81.9);
			expect(result.replaced.value).toBe(82.4);
		});
	});

	it('refuses a weight out of range or a day that has not come, with field errors', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const at = deps(db);
			const bad = await logWeightAction(
				{ locals: session(owner), request: post({ value: 5, unit: 'kg' }) },
				at
			);
			expect(Object.keys(refused(bad, 400).errors ?? {})).toContain('value');
			const future = await logWeightAction(
				{ locals: session(owner), request: post(kg(82.4, '2026-11-11')) },
				at
			);
			expect(Object.keys(refused(future, 400).errors ?? {})).toContain('measuredOn');
			expect(await createWeightRepository(db).listRange(owner, null, '2099-01-01')).toEqual([]);
		});
	});

	it('refuses a body that is not a form, without calling the service', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const notAForm = new Request(`${ORIGIN}/progress?/logWeight`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'payload={}'
			});
			const err = await thrown(
				logWeightAction({ locals: session(owner), request: notAForm }, { db })
			);
			expect(isHttpError(err, 400)).toBe(true);
		});
	});
});

describe('editing a weigh-in', () => {
	it('changes the entry the id names and answers with it as stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, '2026-11-09'), deps(db));
			const result = await editWeightAction(
				{
					locals: session(owner),
					request: post({ id: entry.id, ...kg(81.9, '2026-11-09') })
				},
				{ db }
			);
			expect(result).toEqual({
				entry: expect.objectContaining({ id: entry.id, value: 81.9, source: 'log' })
			});
		});
	});

	it('refuses a missing or non-integer id, a bad value, and a move onto a day that has one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await logWeight(owner, kg(82.4, '2026-11-09'), deps(db));
			await logWeight(owner, kg(80, '2026-11-08'), deps(db));
			const noId = await editWeightAction(
				{ locals: session(owner), request: post(kg(81.9, '2026-11-09')) },
				{ db }
			);
			expect(Object.keys(refused(noId, 400).errors ?? {})).toContain('id');
			const badId = await editWeightAction(
				{ locals: session(owner), request: post({ id: 'first', ...kg(81.9, '2026-11-09') }) },
				{ db }
			);
			expect(Object.keys(refused(badId, 400).errors ?? {})).toContain('id');
			const badValue = await editWeightAction(
				{
					locals: session(owner),
					request: post({ id: first.entry.id, value: 900, unit: 'kg', measuredOn: '2026-11-09' })
				},
				{ db }
			);
			expect(Object.keys(refused(badValue, 400).errors ?? {})).toContain('value');
			const taken = await editWeightAction(
				{
					locals: session(owner),
					request: post({ id: first.entry.id, ...kg(82.4, '2026-11-08') })
				},
				{ db }
			);
			expect(refused(taken, 400).errors).toEqual({
				measuredOn: 'That day already has a weigh-in'
			});
		});
	});

	it('answers 404 for an id that names no weigh-in of the owner’s', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const result = await editWeightAction(
				{ locals: session(owner), request: post({ id: 999_999, ...kg(81.9, TODAY) }) },
				{ db }
			);
			expect(refused(result, 404).message).toBe('That no longer exists. Reload to see the latest.');
		});
	});

	it('keeps the day when the edit names none', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, '2026-11-09'), deps(db));
			const result = await editWeightAction(
				{ locals: session(owner), request: post({ id: entry.id, value: 81.9, unit: 'kg' }) },
				deps(db)
			);
			expect(result).toEqual({
				entry: { id: entry.id, measuredOn: '2026-11-09', value: 81.9, unit: 'kg', source: 'log' }
			});
		});
	});

	it('answers 404 for a missing id before it checks the body', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const result = await editWeightAction(
				{ locals: session(owner), request: post({ id: 999_999, value: 900, unit: 'kg' }) },
				{ db }
			);
			expect(refused(result, 404).message).toBe('That no longer exists. Reload to see the latest.');
		});
	});

	it('answers 404 for another owner’s id, and leaves the entry as it is', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, '2026-11-09'), deps(db));
			const other = await makeSecondOwner(db);
			const result = await editWeightAction(
				{ locals: session(other), request: post({ id: entry.id, ...kg(81.9, '2026-11-09') }) },
				{ db }
			);
			expect(refused(result, 404).message).toBe('That no longer exists. Reload to see the latest.');
			expect(await createWeightRepository(db).getById(owner, entry.id)).toMatchObject({
				value: 82.4
			});
		});
	});
});

describe('deleting a weigh-in', () => {
	it('removes the entry the id names', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, TODAY), deps(db));
			const result = await deleteWeightAction(
				{ locals: session(owner), request: post({ id: entry.id }) },
				{ db }
			);
			expect(result).toEqual({ deleted: true });
			expect(await createWeightRepository(db).getById(owner, entry.id)).toBeNull();
		});
	});

	it('refuses a payload with no id as a 400', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const result = await deleteWeightAction(
				{ locals: session(owner), request: post({}) },
				{ db }
			);
			expect(Object.keys(refused(result, 400).errors ?? {})).toContain('id');
		});
	});

	it('answers 404 once the entry is gone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, TODAY), deps(db));
			const deleteIt = () =>
				deleteWeightAction({ locals: session(owner), request: post({ id: entry.id }) }, { db });
			expect(await deleteIt()).toEqual({ deleted: true });
			expect(refused(await deleteIt(), 404).message).toBe(
				'That no longer exists. Reload to see the latest.'
			);
		});
	});

	it('answers 404 for another owner’s id, and keeps the entry', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82.4, TODAY), deps(db));
			const other = await makeSecondOwner(db);
			const result = await deleteWeightAction(
				{ locals: session(other), request: post({ id: entry.id }) },
				{ db }
			);
			expect(refused(result, 404).message).toBe('That no longer exists. Reload to see the latest.');
			expect(await createWeightRepository(db).getById(owner, entry.id)).not.toBeNull();
		});
	});
});

describe('setting the goal', () => {
	it('sets the goal and answers with it and the phase it suggests', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, TODAY), deps(db));
			const result = await setGoalAction({ locals: session(owner), request: post(GOAL) }, deps(db));
			expect(result).toEqual({
				goal: {
					id: expect.any(String),
					unit: 'kg',
					startOn: TODAY,
					startWeight: 82.4,
					targetOn: GOAL.targetOn,
					targetWeight: 78
				},
				phasePrompt: 'cut'
			});
		});
	});

	it('suggests no phase when the owner is already in it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, TODAY), deps(db));
			await setNutritionPhase(owner, 'cut', { db });
			const result = await setGoalAction(
				{ locals: session(owner), request: post({ ...GOAL, targetWeight: 80 }) },
				deps(db)
			);
			expect(result).toMatchObject({ phasePrompt: null });
		});
	});

	it('refuses a goal-by day that is not after today, a target out of range, and no weigh-in', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const noWeighIn = await setGoalAction(
				{ locals: session(owner), request: post(GOAL) },
				deps(db)
			);
			expect(Object.keys(refused(noWeighIn, 400).errors ?? {})).toContain('targetWeight');
			await logWeight(owner, kg(82.4, TODAY), deps(db));
			const past = await setGoalAction(
				{ locals: session(owner), request: post({ ...GOAL, targetOn: TODAY }) },
				deps(db)
			);
			expect(refused(past, 400).errors).toEqual({ targetOn: 'Pick a day after today' });
			const range = await setGoalAction(
				{ locals: session(owner), request: post({ ...GOAL, targetWeight: 900 }) },
				deps(db)
			);
			expect(Object.keys(refused(range, 400).errors ?? {})).toContain('targetWeight');
		});
	});
});

describe('editing the milestones', () => {
	/** A goal from 82.4 kg on 10 November, with its generated milestones on 17 November (82) and 25 December (80). */
	async function withGoal(db: Executor, owner: string) {
		await logWeight(owner, kg(82.4, TODAY), deps(db));
		const { goal } = await setWeightGoal(owner, GOAL, deps(db));
		return goal;
	}

	it('replaces the active goal’s milestones and answers with the list as stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await withGoal(db, owner);
			const result = await editMilestonesAction(
				{
					locals: session(owner),
					request: post({
						goalId: goal.id,
						milestones: [
							{ day: '2027-01-10', weight: 79 },
							{ day: '2026-11-20', weight: 81.5 }
						]
					})
				},
				{ db }
			);
			expect(result).toEqual({
				milestones: [
					{ id: expect.any(Number), day: '2026-11-20', weight: 81.5, source: 'edited' },
					{ id: expect.any(Number), day: '2027-01-10', weight: 79, source: 'edited' }
				]
			});
		});
	});

	it('refuses a milestone outside the goal’s days with a field error, and stores nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await withGoal(db, owner);
			const result = await editMilestonesAction(
				{
					locals: session(owner),
					request: post({ goalId: goal.id, milestones: [{ day: '2027-02-15', weight: 79 }] })
				},
				{ db }
			);
			expect(refused(result, 400).errors).toEqual({
				'milestones.0.day': 'Pick a day between the start and the goal day'
			});
			expect(await createWeightRepository(db).listMilestones(owner, goal.id)).toHaveLength(2);
		});
	});

	it('answers 404 for a goal that is not the active one, or no goal id at all', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await withGoal(db, owner);
			for (const goalId of [crypto.randomUUID(), undefined]) {
				const result = await editMilestonesAction(
					{ locals: session(owner), request: post({ goalId, milestones: [] }) },
					{ db }
				);
				expect(refused(result, 404).message).toBe(
					'That no longer exists. Reload to see the latest.'
				);
			}
		});
	});
});

describe('clearing the goal', () => {
	it('ends the active goal as cleared and clears the profile target', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, TODAY), deps(db));
			const { goal } = await setWeightGoal(owner, GOAL, deps(db));
			const result = await clearGoalAction({ locals: session(owner), request: post({}) }, { db });
			expect(result).toEqual({ goal: { id: goal.id } });
			expect(await createWeightRepository(db).getActiveGoal(owner)).toBeNull();
			expect((await getAthleteProfile(owner, { db })).targetWeight).toBeNull();
		});
	});

	it('answers with no goal when there is none, and still clears the profile target', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await clearGoalAction({ locals: session(owner), request: post({}) }, { db })).toEqual({
				goal: null
			});
			expect(await clearWeightGoal(owner, deps(db))).toBeNull();
		});
	});
});

describe('setting the nutrition phase', () => {
	it('sets the phase, and clears it on null', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await setPhaseAction(
					{ locals: session(owner), request: post({ nutritionPhase: 'bulk' }) },
					{ db }
				)
			).toEqual({ nutritionPhase: 'bulk' });
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBe('bulk');
			expect(
				await setPhaseAction(
					{ locals: session(owner), request: post({ nutritionPhase: null }) },
					{ db }
				)
			).toEqual({ nutritionPhase: null });
		});
	});

	it('refuses an unknown phase or a missing one as a 400, and stores nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const unknown = await setPhaseAction(
				{ locals: session(owner), request: post({ nutritionPhase: 'shredding' }) },
				{ db }
			);
			expect(Object.keys(refused(unknown, 400).errors ?? {})).toContain('nutritionPhase');
			const missing = await setPhaseAction({ locals: session(owner), request: post({}) }, { db });
			expect(Object.keys(refused(missing, 400).errors ?? {})).toContain('nutritionPhase');
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBeNull();
		});
	});
});

describe('the weight forms without an owner session', () => {
	it('refuse every action with 401, before reading the request', async () => {
		const actions = [
			logWeightAction,
			editWeightAction,
			deleteWeightAction,
			setGoalAction,
			editMilestonesAction,
			clearGoalAction,
			setPhaseAction
		];
		const owner = crypto.randomUUID();
		for (const action of actions) {
			for (const locals of [{ requestId: 'test', session: null }, session(owner, 'recovery')]) {
				const err = await thrown(action({ locals, request: post({}) }));
				expect(isHttpError(err, 401)).toBe(true);
			}
		}
	});
});

describe('Undo a coach weigh-in', () => {
	/** The endpoint as SvelteKit calls it, with the owner's session and the Origin the guard checks. */
	function undoing(ownerId: string, id: string, body: unknown, raw?: string) {
		const url = new URL(`${ORIGIN}/api/coach/weights/${id}/undo`);
		return undo({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: raw ?? JSON.stringify(body)
			}),
			url,
			params: { id },
			locals: session(ownerId),
			getClientAddress: () => '127.0.0.1'
		} as never) as Promise<Response>;
	}

	/** The coach's write for a day, in a run (as the coach's log_body_weight tool makes it). */
	function coachLogs(db: Executor, owner: string, value: number, runId: string) {
		return logWeight(owner, kg(value, TODAY), { ...deps(db), source: 'coach', runId });
	}

	it('answers 200 with null when the coach’s write was a new entry, and the entry is gone', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			const response = await undoing(owner, String(entry.id), { runId: RUN });
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toEqual({ entry: null });
			expect(await createWeightRepository(db).getById(owner, entry.id)).toBeNull();
		});
	});

	it('answers 200 with the earlier entry when the coach replaced it', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const earlier = await logWeight(owner, kg(81, TODAY), deps(db));
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			const response = await undoing(owner, String(entry.id), { runId: RUN });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				entry: {
					id: earlier.entry.id,
					measuredOn: TODAY,
					value: 81,
					unit: 'kg',
					source: 'log'
				}
			});
		});
	});

	it('answers 404 for a second Undo of a new entry, and for an id that names no weigh-in', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			await undoing(owner, String(entry.id), { runId: RUN });
			const again = await undoing(owner, String(entry.id), { runId: RUN });
			expect(again.status).toBe(404);
			expect(await again.json()).toMatchObject({ error: 'not_found' });
			for (const id of ['999999', '0', 'first']) {
				const unknown = await undoing(owner, id, { runId: RUN });
				expect(unknown.status).toBe(404);
			}
		});
	});

	it('answers 404 when the owner deleted the coach’s entry', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			const repo = createWeightRepository(db);
			await repo.delete(owner, entry.id);
			const response = await undoing(owner, String(entry.id), { runId: RUN });
			expect(response.status).toBe(404);
		});
	});

	it('answers 409 when the owner has changed the entry since, and leaves it as it is', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			await editWeight(owner, entry.id, kg(81.9, TODAY), deps(db));
			const response = await undoing(owner, String(entry.id), { runId: RUN });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: 'conflict', reason: 'changed' });
			expect(await createWeightRepository(db).getById(owner, entry.id)).toMatchObject({
				value: 81.9
			});
		});
	});

	it('answers 409 for another run’s id, since the entry holds a different write', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			const response = await undoing(owner, String(entry.id), { runId: crypto.randomUUID() });
			expect(response.status).toBe(409);
			expect(await createWeightRepository(db).getById(owner, entry.id)).not.toBeNull();
		});
	});

	it('refuses a body that is not JSON, or whose runId is not a run id, as a 400', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			const notJson = await undoing(owner, String(entry.id), undefined, '{"runId":');
			expect(notJson.status).toBe(400);
			const notRun = await undoing(owner, String(entry.id), { runId: 'not-a-run' });
			expect(notRun.status).toBe(400);
			expect(await notRun.json()).toMatchObject({ error: 'invalid_request', field: 'runId' });
			expect(await createWeightRepository(db).getById(owner, entry.id)).not.toBeNull();
		});
	});

	it('answers 404 to another owner’s Undo, and leaves the coach’s entry standing', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await coachLogs(db, owner, 82.4, RUN);
			// makeSecondOwner drops the one-owner index for good on the shared pool, and this endpoint
			// reads only that pool, so the other session is an owner with no weigh-ins at all.
			const response = await undoing(crypto.randomUUID(), String(entry.id), { runId: RUN });
			expect(response.status).toBe(404);
			expect(await createWeightRepository(db).getById(owner, entry.id)).toMatchObject({
				value: 82.4,
				source: 'coach'
			});
		});
	});

	it('answers a signed-out request 401 from the guard, before the endpoint runs', async () => {
		const url = new URL(`${ORIGIN}/api/coach/weights/1/undo`);
		const response = await guardRequest({
			url,
			request: new Request(url, {
				method: 'POST',
				headers: { origin: ORIGIN, 'content-type': 'application/json' },
				body: JSON.stringify({ runId: RUN })
			}),
			cookies: {
				get: () => undefined,
				set: () => {},
				serialize: () => ''
			} as never,
			locals: {} as App.Locals,
			route: { id: '/api/coach/weights/[id]/undo' }
		});
		expect(response?.status).toBe(401);
		expect(await response!.json()).toMatchObject({ error: 'unauthenticated' });
	});
});
