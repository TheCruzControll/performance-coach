import { json } from '@sveltejs/kit';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { getCoachingMemory } from '#lib/server/services/coach/memory.ts';
import { knowsView, type KnowsView } from '../../../(app)/coach/[[thread]]/knows.ts';
import type { RequestHandler } from './$types';

/**
 * 'What the coach knows' for the memory sheet (PRD §4, §12): the coaching memory as of the
 * owner's today, from structured records only, in the sheet's sections (knows.ts knowsView).
 *
 * - 200 {asOf, sections}; never cached. No sections: the coach knows nothing yet.
 * - Owner-only by the guard; rate-limited ('coach.action').
 */
export const GET: RequestHandler = async (event) => {
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = event.locals.session!.ownerId;
	const today = await ownerToday(ownerId, new Date());
	const body: KnowsView = knowsView(await getCoachingMemory(ownerId, { today }));
	return json(body, { headers: { 'cache-control': 'no-store' } });
};
