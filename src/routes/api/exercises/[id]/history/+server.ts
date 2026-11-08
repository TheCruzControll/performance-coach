import { json } from '@sveltejs/kit';
import { TrainingInputError } from '#lib/server/services/training/shared.ts';
import { getExerciseHistory } from '#lib/server/services/workouts/history.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * An exercise's history (services/workouts/history.ts): its previous session, its sets newest
 * first a page at a time (?before= is a page's `next`), and its records, the best e1RM labelled
 * estimated. For the exercise-history sheet and the workout's previous-sets fetch: owner-only by
 * the guard, never cached. A malformed, unknown or foreign exercise is a 404; a malformed
 * `before` is a 400.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const raw = url.searchParams.get('before');
	const before = raw === null ? undefined : /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
	try {
		const history = await getExerciseHistory(locals.session!.ownerId, params.id, { before });
		if (!history) return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
		return json(history, { headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof TrainingInputError)) throw err;
		return json({ error: 'invalid', errors: err.errors }, { status: 400, headers: NO_STORE });
	}
};
