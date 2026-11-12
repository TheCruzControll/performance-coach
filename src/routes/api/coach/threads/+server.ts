import { json } from '@sveltejs/kit';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import { CoachInputError } from '#lib/server/services/coach/shared.ts';
import { listThreads } from '#lib/server/services/coach/threads.ts';
import { ARCHIVED_PAGE, type ArchivedPage } from '../../../(app)/coach/[[thread]]/manage.ts';
import { archivedWords } from '../../../(app)/coach/[[thread]]/words.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * A page of the owner's archived conversations for the Archived list (PRD §12): `?archived=1`
 * (required) lists them newest archived first, each saying when it was archived. `?before=<id>`
 * continues from that conversation, `?limit=<1..50>` sizes the page (ARCHIVED_PAGE by default).
 *
 * - 200 {threads: [{id, title, when}], next}; never cached. next is the next page's `before`,
 *   null on the last.
 * - 400 without `archived=1`, or for a limit or cursor that is not one. Owner-only by the guard; rate-limited
 *   ('coach.action').
 */
export const GET: RequestHandler = async (event) => {
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = event.locals.session!.ownerId;
	const params = event.url.searchParams;
	if (params.get('archived') !== '1') {
		return json(
			{ error: 'invalid_request', message: 'Only archived=1 is listed.', field: 'archived' },
			{ status: 400, headers: NO_STORE }
		);
	}
	const before = params.get('before') ?? undefined;
	const limit = params.has('limit') ? Number(params.get('limit')) : ARCHIVED_PAGE;
	try {
		const page = await listThreads(ownerId, { archived: true, before, limit });
		const { timeZone } = await getAthleteProfile(ownerId);
		const now = new Date();
		const body: ArchivedPage = {
			threads: page.threads.map((thread) => ({
				id: thread.id,
				title: thread.title,
				when: archivedWords(thread.archivedAt!, now, timeZone)
			})),
			next: page.nextBefore
		};
		return json(body, { headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof CoachInputError)) throw err;
		return json(
			{ error: 'invalid_request', message: err.message, field: err.field },
			{ status: 400, headers: NO_STORE }
		);
	}
};
