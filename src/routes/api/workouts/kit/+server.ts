import { json } from '@sveltejs/kit';
import { kitForLineage, kitForSession } from '#lib/server/services/workouts/kit.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * A planned session's start kit (services/workouts/kit.ts): owner-only by the guard, never
 * cached. ?lineage= is the current version's session (to start it), ?session= a pinned row (to
 * adopt a workout started elsewhere). A malformed, unknown or foreign id, both or neither, is a
 * 404.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = locals.session!.ownerId;
	const lineage = url.searchParams.get('lineage');
	const session = url.searchParams.get('session');
	const kit =
		lineage !== null && session === null
			? await kitForLineage(ownerId, lineage)
			: session !== null && lineage === null
				? await kitForSession(ownerId, session)
				: null;
	if (!kit) return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
	return json(kit, { headers: NO_STORE });
};
