import { json } from '@sveltejs/kit';
import * as z from 'zod/mini';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { undoCoachWeight, WeightUndoError } from '#lib/server/services/weight/index.ts';
import type { RequestHandler } from './$types';

/** A run id and nothing else; anything longer is not one. */
const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { 'cache-control': 'no-store' };

/** The only field read: anything else the client sends is dropped by the parse. */
const UndoBody = z.object({ runId: z.uuid() });

/** The entry Undo leaves standing for the day (the service's row). */
type Standing = NonNullable<Awaited<ReturnType<typeof undoCoachWeight>>['entry']>;

const invalid = (message: string, field?: string) =>
	json({ error: 'invalid_request', message, field }, { status: 400, headers: NO_STORE });

const gone = (message = 'That weigh-in is gone') =>
	json({ error: 'not_found', message }, { status: 404, headers: NO_STORE });

/** The entry that now stands for the day, without the owner's row fields (run_id, replaced). */
const viewOf = ({ id, measuredOn, value, unit, source }: Standing) => ({
	id,
	measuredOn,
	value,
	unit,
	source
});

/**
 * Undo a weigh-in the coach logged in one run (PRD §14's coach writes; weight PR 9 shows the
 * card). Only the path id and the run are read; the owner is the session's. Undo takes back that
 * run's write: a replaced day comes back as it was, and a day the coach filled is emptied.
 *
 * - 200 {entry}: undone. `entry` is the day's entry as it now stands, or null when the day is
 *   empty again.
 * - 404 {error: 'not_found'} for a weigh-in that is gone, or an id that names none (Undo already
 *   removed the coach's entry, say).
 * - 409 {error: 'conflict', reason: 'changed'}: the weigh-in no longer holds that run's write
 *   (the owner edited or deleted it, or another run wrote it since); it is left as it is.
 * - 400: a body that is not JSON, or whose `runId` is not a run id.
 * Owner-only and Origin-checked by the guard; rate-limited ('coach.action').
 */
export const POST: RequestHandler = async (event) => {
	const { request, params, locals } = event;
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}

	const length = Number(request.headers.get('content-length') ?? 0);
	const text = length > MAX_BODY_BYTES ? '' : await request.text();
	if (length > MAX_BODY_BYTES || text.length > MAX_BODY_BYTES) return invalid('At most 4 KB');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid('Body must be JSON');
	}
	const body = UndoBody.safeParse(raw);
	if (!body.success) return invalid('Body is not an undo', 'runId');

	// A path id that is not a whole number names no weigh-in, as an unknown one does.
	const id = /^[1-9]\d*$/.test(params.id) ? Number(params.id) : NaN;
	if (!Number.isSafeInteger(id)) return gone();

	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	try {
		const { entry } = await undoCoachWeight(locals.session!.ownerId, id, body.data.runId);
		return json({ entry: entry ? viewOf(entry) : null }, { headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof WeightUndoError)) throw err;
		if (err.reason === 'gone') return gone(err.message);
		return json(
			{ error: 'conflict', reason: err.reason, message: err.message },
			{ status: 409, headers: NO_STORE }
		);
	}
};
