import { json } from '@sveltejs/kit';
import { getCanonicalWorkout } from '#lib/server/services/workouts/canonical.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * One workout's canonical rows (services/workouts/canonical.ts), for reconcile and adoptRemote:
 * owner-only by the guard, never cached. A malformed, unknown or foreign id is a 404, which the
 * device reads by reconcile's rule.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const canonical = await getCanonicalWorkout(locals.session!.ownerId, params.id);
	if (!canonical) {
		return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
	}
	return json(canonical, { headers: NO_STORE });
};
