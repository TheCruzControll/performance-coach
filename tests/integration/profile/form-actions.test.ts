/**
 * The Profile edit screens' form action (src/lib/server/forms/profile.ts) on real Postgres,
 * through the real services: a section posted as JSON is validated again on the server, saved
 * as a Profile change, and every way it can fail reaches the form as something the owner can act
 * on — field errors by dotted path, a message, or a refusal without a session.
 */
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import { editAction, type SaveSection } from '../../../src/lib/server/forms/profile';
import {
	createGoal,
	getEquipment,
	goalHistory,
	saveEquipment,
	updateGoal
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { eventGoal, makeOwner } from './fixtures';

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
	it('stores a valid section and says it was saved', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const save = editAction(within(db, saveEquipment));
			const result = await save({ locals: session(owner), request: post(equipment) });
			expect(result).toEqual({ saved: true });
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
