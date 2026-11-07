import { json } from '@sveltejs/kit';
import { listActiveWorkouts } from '#lib/server/services/workouts/canonical.ts';
import type { RequestHandler } from './$types';

/**
 * The owner's workouts in progress, newest first (services/workouts/canonical.ts), so Today can
 * offer to continue one started on another device: owner-only by the guard, never cached.
 */
export const GET: RequestHandler = async ({ locals }) => {
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const active = await listActiveWorkouts(locals.session!.ownerId);
	return json(active, { headers: { 'cache-control': 'no-store' } });
};
