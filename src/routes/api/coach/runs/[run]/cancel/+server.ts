import { json } from '@sveltejs/kit';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { requestCancel } from '#lib/server/services/coach/runs.ts';
import { CoachNotFoundError } from '#lib/server/services/coach/shared.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Stop: flags the owner's run, which the turn reads between steps (the client also drops the
 * stream). 202 whether or not the run was still running (`running` says which); 404 for a run
 * that is not the owner's. Owner-only and Origin-checked by the guard; rate-limited
 * ('coach.action').
 */
export const POST: RequestHandler = async (event) => {
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}
	try {
		const running = await requestCancel(event.locals.session!.ownerId, event.params.run);
		return json({ running }, { status: 202, headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof CoachNotFoundError)) throw err;
		return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
	}
};
