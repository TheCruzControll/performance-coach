/**
 * The Profile edit screens' form actions (src/lib/server/forms/profile.ts) on real Postgres,
 * through the real services: a section (or one goal) posted as JSON is validated again on the
 * server, saved as a Profile change, and every way it can fail reaches the form as something the
 * owner can act on — field errors by dotted path, a message, or a refusal without a session.
 */
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import {
	deleteGoalAction,
	editAction,
	reorderGoalsAction,
	saveGoalAction,
	type SaveSection
} from '../../../src/lib/server/forms/profile';
import {
	createGoal,
	getEquipment,
	goalHistory,
	listGoals,
	saveEquipment,
	updateGoal
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner } from './fixtures';

const equipment = {
	gymType: 'commercial',
	equipment: ['barbell', 'squat_rack'],
	homeEquipment: ['dumbbells'],
	notes: 'Rack is free before 7am'
};

/** A save running inside the test's transaction (the route passes only `source`). */
const within =
	(db: Executor, save: SaveSection): SaveSection =>
	(owner, payload, deps) =>
		save(owner, payload, { ...deps, db });

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

/** The request a section's Save sends (src/lib/client/profile-form.ts). */
function post(payload: unknown, raw = JSON.stringify(payload)): Request {
	const body = new FormData();
	body.set('payload', raw);
	return new Request('http://localhost/profile/equipment?/save', { method: 'POST', body });
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

describe('a Profile edit screen’s save action', () => {
	it('stores a valid section and answers with it as stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const save = editAction(within(db, saveEquipment));
			const result = await save({ locals: session(owner), request: post(equipment) });
			expect(result).toEqual({ saved: true, section: await getEquipment(owner, { db }) });
			expect(await getEquipment(owner, { db })).toMatchObject(equipment);
		});
	});

	it('records the change as made from Profile', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const save = editAction(within(db, createGoal));
			await save({ locals: session(owner), request: post(eventGoal()) });
			const history = await goalHistory(owner, { db });
			expect(history.map((e) => [e.change, e.source])).toEqual([['created', 'profile']]);
		});
	});

	it('returns the service’s field errors keyed by dotted path, and stores nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const save = editAction(within(db, saveEquipment));
			const result = await save({
				locals: session(owner),
				request: post({ ...equipment, gymType: 'castle', equipment: ['barbell', 'trebuchet'] })
			});
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({
				status: 400,
				data: { errors: { gymType: 'Pick where you train', 'equipment.1': 'Unknown equipment' } }
			});
			expect(await getEquipment(owner, { db })).toBeNull();
		});
	});

	it('tells the owner when what they edited no longer exists', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const gone = crypto.randomUUID();
			const save = editAction(within(db, (o, payload, deps) => updateGoal(o, gone, payload, deps)));
			const result = await save({ locals: session(owner), request: post(eventGoal()) });
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({
				status: 404,
				data: { message: 'That no longer exists. Reload to see the latest.' }
			});
		});
	});

	it('refuses a payload that is not JSON, or a body that is not a form, without calling the service', async () => {
		const service = vi.fn<SaveSection>();
		const notAForm = new Request('http://localhost/profile/equipment?/save', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'payload={}'
		});
		for (const request of [post(null, '{"gym'), notAForm]) {
			const err = await thrown(
				editAction(service)({ locals: session(crypto.randomUUID()), request })
			);
			expect(isHttpError(err, 400)).toBe(true);
			expect((err as { body: App.Error }).body.message).toBe(
				'The form could not be read. Reload and try again.'
			);
		}
		expect(service).not.toHaveBeenCalled();
	});

	it('refuses without an owner session, and with a recovery session', async () => {
		const service = vi.fn<SaveSection>();
		const owner = crypto.randomUUID();
		for (const locals of [{ requestId: 'test', session: null }, session(owner, 'recovery')]) {
			const err = await thrown(editAction(service)({ locals, request: post(equipment) }));
			expect(isHttpError(err, 401)).toBe(true);
		}
		expect(service).not.toHaveBeenCalled();
	});
});

/** Every goal change since the goals were created: what changed, on which goal, from where. */
async function changes(owner: string, db: Executor) {
	const history = await goalHistory(owner, { db });
	return history
		.filter((e) => e.change !== 'created')
		.map((e) => [e.change, e.goalId, e.source])
		.sort();
}

/** What a goal save returned once it saved (fails the test otherwise). */
function savedGoal(result: Awaited<ReturnType<typeof saveGoalAction>>) {
	if (!('goals' in result)) throw new Error(`not saved: ${JSON.stringify(result)}`);
	return result;
}

describe('Profile → Goals’ saveGoal action', () => {
	it('adds a goal as a Profile change and returns the ranking, the new goal last', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = savedGoal(
				await saveGoalAction({ locals: session(owner), request: post(eventGoal()) }, { db })
			);
			const marathon = eventGoal({ title: 'Valencia marathon', disciplines: ['distance_running'] });
			const second = savedGoal(
				await saveGoalAction({ locals: session(owner), request: post(marathon) }, { db })
			);
			expect(first.goals.map((g) => [g.title, g.priority])).toEqual([['First Muay Thai fight', 1]]);
			expect(second.goals.map((g) => [g.title, g.priority])).toEqual([
				['First Muay Thai fight', 1],
				['Valencia marathon', 2]
			]);
			expect(second.saved).toBe(second.goals[1]!.id);
			const history = await goalHistory(owner, { db });
			expect(history.map((e) => [e.change, e.source])).toEqual([
				['created', 'profile'],
				['created', 'profile']
			]);
		});
	});

	it('updates the goal its id names, which keeps its rank', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db, source: 'onboarding' });
			await createGoal(owner, eventGoal({ title: 'Valencia marathon' }), { db });
			const edit = { id: fight.id, ...eventGoal({ title: 'A-class fight', weightClass: null }) };
			const result = savedGoal(
				await saveGoalAction({ locals: session(owner), request: post(edit) }, { db })
			);
			expect(result.saved).toBe(fight.id);
			expect(result.goals.map((g) => [g.id, g.title, g.priority, g.weightClass])).toEqual([
				[fight.id, 'A-class fight', 1, null],
				[result.goals[1]!.id, 'Valencia marathon', 2, '-71 kg']
			]);
			const history = await goalHistory(owner, { db });
			expect(history.map((e) => [e.change, e.source])).toContainEqual(['updated', 'profile']);
			expect(history).toHaveLength(3);
		});
	});

	it('returns the sheet’s field errors by field name, and stores nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = eventGoal({ eventDate: '', weightClass: 'x'.repeat(41) });
			const result = await saveGoalAction({ locals: session(owner), request: post(goal) }, { db });
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({
				status: 400,
				data: {
					errors: {
						eventDate: 'Pick the event date',
						weightClass: 'Keep it under 40 characters'
					}
				}
			});
			expect(await listGoals(owner, { db })).toEqual([]);
		});
	});

	it('never adds a goal for an id that names none: the owner is told it is gone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			for (const id of [crypto.randomUUID(), 'not-a-goal', 42, null]) {
				const result = await saveGoalAction(
					{ locals: session(owner), request: post({ id, ...eventGoal() }) },
					{ db }
				);
				expect(result, String(id)).toMatchObject({
					status: 404,
					data: { message: 'That no longer exists. Reload to see the latest.' }
				});
			}
			expect(await listGoals(owner, { db })).toEqual([]);
		});
	});

	it('changes a goal’s status: achieved leaves the ranking, active again goes last', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			const strength = await createGoal(owner, generalGoal(), { db });
			const status = async (value: string) =>
				savedGoal(
					await saveGoalAction(
						{
							locals: session(owner),
							request: post({ id: fight.id, ...eventGoal(), status: value })
						},
						{ db }
					)
				).goals.map((g) => [g.id, g.status, g.priority]);

			expect(await status('achieved')).toEqual([
				[strength.id, 'active', 1],
				[fight.id, 'achieved', null]
			]);
			expect(await status('active')).toEqual([
				[strength.id, 'active', 1],
				[fight.id, 'active', 2]
			]);
			expect(await changes(owner, db)).toEqual(
				[
					['status_changed', fight.id, 'profile'],
					['status_changed', fight.id, 'profile'],
					['reprioritized', strength.id, 'profile']
				].sort()
			);
		});
	});

	it('refuses without an owner session, before reading the form', async () => {
		const err = await thrown(
			saveGoalAction({ locals: { requestId: 'test', session: null }, request: post(eventGoal()) })
		);
		expect(isHttpError(err, 401)).toBe(true);
	});
});

describe('Profile → Goals’ deleteGoal action', () => {
	it('deletes the goal its id names as a Profile change, and the goals below it move up', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			const strength = await createGoal(owner, generalGoal(), { db });
			const marathon = await createGoal(owner, eventGoal({ title: 'Valencia marathon' }), { db });
			const result = await deleteGoalAction(
				{ locals: session(owner), request: post({ id: fight.id }) },
				{ db }
			);
			const ranking = [
				[strength.id, 1],
				[marathon.id, 2]
			];
			expect(result).not.toHaveProperty('status');
			expect('goals' in result && result.goals.map((g) => [g.id, g.priority])).toEqual(ranking);
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual(ranking);
			expect(await changes(owner, db)).toEqual(
				[
					['deleted', fight.id, 'profile'],
					['reprioritized', strength.id, 'profile'],
					['reprioritized', marathon.id, 'profile']
				].sort()
			);
		});
	});

	it('deletes nothing for an id that names none of the owner’s goals: the owner is told it is gone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, eventGoal(), { db });
			const gone = 'That no longer exists. Reload to see the latest.';
			const attempts: [string, unknown][] = [
				[owner, { id: crypto.randomUUID() }],
				[owner, { id: 'not-a-goal' }],
				[owner, { id: 42 }],
				[owner, { id: null }],
				[owner, {}],
				[owner, null],
				// One owner today, but an action never trusts a goal id on its own.
				[crypto.randomUUID(), { id: goal.id }]
			];
			for (const [who, payload] of attempts) {
				const result = await deleteGoalAction(
					{ locals: session(who), request: post(payload) },
					{ db }
				);
				expect(isActionFailure(result), JSON.stringify(payload)).toBe(true);
				expect(result, JSON.stringify(payload)).toMatchObject({
					status: 404,
					data: { message: gone }
				});
			}
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual([
				[goal.id, 1]
			]);
			expect(await goalHistory(owner, { db })).toHaveLength(1);
		});
	});

	it('refuses without an owner session, and with a recovery session', async () => {
		const owner = crypto.randomUUID();
		for (const locals of [{ requestId: 'test', session: null }, session(owner, 'recovery')]) {
			const err = await thrown(
				deleteGoalAction({ locals, request: post({ id: crypto.randomUUID() }) })
			);
			expect(isHttpError(err, 401)).toBe(true);
		}
	});
});

describe('Profile → Goals’ reorderGoals action', () => {
	it('ranks the open goals in the order posted as a Profile change, and returns the ranking', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			const strength = await createGoal(owner, generalGoal(), { db });
			const marathon = await createGoal(owner, eventGoal({ title: 'Valencia marathon' }), { db });
			const smoker = await createGoal(owner, eventGoal({ status: 'dropped' }), { db });
			const ids = [marathon.id, strength.id, fight.id];
			const result = await reorderGoalsAction(
				{ locals: session(owner), request: post({ ids }) },
				{ db }
			);
			const ranking = [
				[marathon.id, 1],
				[strength.id, 2],
				[fight.id, 3],
				[smoker.id, null]
			];
			expect(result).not.toHaveProperty('status');
			expect('goals' in result && result.goals.map((g) => [g.id, g.priority])).toEqual(ranking);
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual(ranking);
			// Each goal whose rank changed, from Profile; the one that kept its rank has no event.
			expect(await changes(owner, db)).toEqual(
				[
					['reprioritized', marathon.id, 'profile'],
					['reprioritized', fight.id, 'profile']
				].sort()
			);
		});
	});

	it('refuses a ranking that leaves out, repeats or adds a goal, and changes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			const strength = await createGoal(owner, generalGoal(), { db });
			const dropped = await createGoal(owner, eventGoal({ status: 'dropped' }), { db });
			const attempts: [string, unknown][] = [
				[owner, { ids: [strength.id] }],
				[owner, { ids: [strength.id, strength.id] }],
				[owner, { ids: [strength.id, fight.id, dropped.id] }],
				[owner, { ids: [strength.id, crypto.randomUUID()] }],
				[owner, { ids: [strength.id, 'not-a-goal'] }],
				[owner, { ids: [] }],
				[owner, { ids: 'all' }],
				[owner, {}],
				[owner, null],
				// One owner today, but an action never trusts a goal id on its own.
				[crypto.randomUUID(), { ids: [strength.id, fight.id] }]
			];
			for (const [who, payload] of attempts) {
				const result = await reorderGoalsAction(
					{ locals: session(who), request: post(payload) },
					{ db }
				);
				expect(isActionFailure(result), JSON.stringify(payload)).toBe(true);
				expect(result, JSON.stringify(payload)).toMatchObject({ status: 400 });
				expect(Object.keys((result as { data: { errors: object } }).data.errors)).not.toEqual([]);
			}
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual([
				[fight.id, 1],
				[strength.id, 2],
				[dropped.id, null]
			]);
			expect(await changes(owner, db)).toEqual([]);
		});
	});

	it('refuses without an owner session, and with a recovery session', async () => {
		const owner = crypto.randomUUID();
		for (const locals of [{ requestId: 'test', session: null }, session(owner, 'recovery')]) {
			const err = await thrown(
				reorderGoalsAction({ locals, request: post({ ids: [crypto.randomUUID()] }) })
			);
			expect(isHttpError(err, 401)).toBe(true);
		}
	});
});
