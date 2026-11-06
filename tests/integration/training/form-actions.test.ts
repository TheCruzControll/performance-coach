/**
 * The program screens' form actions (src/lib/server/forms/program.ts) on real Postgres, through
 * the real program services: a change posted as JSON reaches the service for the signed-in
 * owner, and every way the training services refuse it reaches the form as something the screen
 * can show — field errors by dotted path (400), a conflict's reason (409), a record that is gone
 * (404) — while a request without the owner's session or with an unreadable form never reaches
 * the service. Anything else is the server's error, never dressed up as the owner's.
 */
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ProgramPlan } from '../../../src/lib/domain/training/types';
import type { AuthSession } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import { programAction, type ProgramChange } from '../../../src/lib/server/forms/program';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getPlannedSession
} from '../../../src/lib/server/services/programs/index';
import { ProgramConflictError } from '../../../src/lib/server/services/training/shared';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const plan = () => programFixture('hybrid', { monday: MONDAY, today: MONDAY });

/** Store the posted plan as the owner's program, inside the test's transaction. */
const build =
	(db: Executor): ProgramChange<unknown> =>
	(owner, payload) =>
		createProgramFromPlan(owner, payload as ProgramPlan, { source: 'owner' }, { db });

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

/** The request a program screen's form sends: its state as JSON in `payload`. */
function post(payload: unknown, raw = JSON.stringify(payload)): Request {
	const body = new FormData();
	body.set('payload', raw);
	return new Request('http://localhost/train?/change', { method: 'POST', body });
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

describe('a program form action', () => {
	it('runs the change for the signed-in owner with the posted payload, and returns its result', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const result = await programAction(build(db))({
				locals: session(owner),
				request: post(plan())
			});
			expect(result).toMatchObject({ created: true, programId: expect.any(String) });
			expect(await getCurrentProgram(owner, MONDAY, { db })).toMatchObject({
				title: 'Strength, running and Muay Thai'
			});
		});
	});

	it('returns the service’s field errors keyed by dotted path (400), and stores nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const bad = plan();
			bad.blocks[0]!.weeks[0]!.sessions[0]!.estMinutes = -5;
			bad.blocks[1]!.weeks[2]!.kind = 42 as never;
			const result = await programAction(build(db))({ locals: session(owner), request: post(bad) });
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({ status: 400 });
			const { errors } = (result as { data: { errors: Record<string, string> } }).data;
			expect(Object.keys(errors).sort()).toEqual([
				'blocks.0.weeks.0.sessions.0.estMinutes',
				'blocks.1.weeks.2.kind'
			]);
			expect(Object.values(errors).every((message) => message.length > 0)).toBe(true);
			expect(await getCurrentProgram(owner, MONDAY, { db })).toBeNull();
		});
	});

	it('answers a conflict with 409 and its reason, so the screen can say what changed', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const action = programAction(build(db));
			await action({ locals: session(owner), request: post(plan()) });
			// A second, different build while the first program is active.
			const other = { ...plan(), title: 'Another program' };
			const result = await action({ locals: session(owner), request: post(other) });
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({ status: 409, data: { reason: 'program_exists' } });
			expect(await getCurrentProgram(owner, MONDAY, { db })).toMatchObject({
				title: 'Strength, running and Muay Thai'
			});
		});
		// Any ConflictError, whichever service throws it: here an edit from an old version.
		const stale = programAction(() => Promise.reject(new ProgramConflictError()));
		const result = await stale({ locals: session(crypto.randomUUID()), request: post({}) });
		expect(result).toMatchObject({ status: 409, data: { reason: 'version' } });
	});

	it('tells the owner when what they acted on no longer exists (404)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
			const open = programAction((o, payload) =>
				getPlannedSession(o, (payload as { lineage: string }).lineage, {}, { db })
			);
			const result = await open({
				locals: session(owner),
				request: post({ lineage: crypto.randomUUID() })
			});
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({
				status: 404,
				data: { message: 'That no longer exists. Reload to see the latest.' }
			});
		});
	});

	it('refuses a payload that is not JSON, or a body that is not a form, without running the change', async () => {
		const change = vi.fn<ProgramChange<unknown>>();
		const notAForm = new Request('http://localhost/train?/change', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'payload={}'
		});
		for (const request of [post(null, '{"blocks'), notAForm]) {
			const err = await thrown(
				programAction(change)({ locals: session(crypto.randomUUID()), request })
			);
			expect(isHttpError(err, 400)).toBe(true);
			expect((err as { body: App.Error }).body.message).toBe(
				'The form could not be read. Reload and try again.'
			);
		}
		expect(change).not.toHaveBeenCalled();
	});

	it('refuses a request without the owner’s session (401), without running the change', async () => {
		const change = vi.fn<ProgramChange<unknown>>();
		const action = programAction(change);
		const recovery = session(crypto.randomUUID(), 'recovery');
		for (const locals of [{ requestId: 'test' } as App.Locals, recovery]) {
			const err = await thrown(action({ locals, request: post(plan()) }));
			expect(isHttpError(err, 401)).toBe(true);
		}
		expect(change).not.toHaveBeenCalled();
	});

	it('passes a blank payload on as undefined, for the service to refuse', async () => {
		const change = vi.fn<ProgramChange<unknown>>().mockResolvedValue({ ok: true });
		const owner = crypto.randomUUID();
		await programAction(change)({ locals: session(owner), request: post(null, '') });
		expect(change).toHaveBeenCalledWith(owner, undefined);
	});

	it('rethrows any other failure: the server’s error, never shown as the owner’s', async () => {
		const boom = new Error('connection reset');
		const action = programAction(() => Promise.reject(boom));
		expect(await thrown(action({ locals: session(crypto.randomUUID()), request: post({}) }))).toBe(
			boom
		);
	});
});
