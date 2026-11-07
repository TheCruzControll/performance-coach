import { json } from '@sveltejs/kit';
import { SYNC_LIMITS } from '#lib/domain/workout/index.ts';
import {
	applySyncBatch,
	parseSyncBody,
	SyncUnavailableError
} from '#lib/server/services/workouts/sync.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The outbox's flush (the offline workout sync ADR): owner-only and Origin-checked by the guard,
 * at most 64 KB of JSON, each mutation validated and applied on its own (services/workouts/sync.ts).
 * 200 answers one result per mutation; 413, 400 and 503 answer the batch.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > SYNC_LIMITS.maxBytes) {
		return json(
			{ error: 'too_large', message: 'At most 64 KB' },
			{ status: 413, headers: NO_STORE }
		);
	}
	const body = parseSyncBody(await request.text());
	if (!body.ok) {
		const { status, error, errors } = body;
		return json({ error, ...(errors && { errors }) }, { status, headers: NO_STORE });
	}
	try {
		// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
		const response = await applySyncBatch(locals.session!.ownerId, body.mutations, {
			requestId: locals.requestId,
			discarded: body.discarded
		});
		return json(response, { headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof SyncUnavailableError)) throw err;
		return json(
			{ error: 'unavailable', message: 'The server is busy' },
			{ status: 503, headers: { ...NO_STORE, 'retry-after': '5' } }
		);
	}
};
