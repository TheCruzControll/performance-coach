import { json } from '@sveltejs/kit';
import {
	etagMatches,
	getExerciseLibrary,
	LIBRARY_CACHE_CONTROL,
	libraryEtag
} from '#lib/server/services/workouts/library.ts';
import type { RequestHandler } from './$types';

/**
 * The live exercise library (services/workouts/library.ts), for the device's IndexedDB copy:
 * owner-only by the guard, kept in private caches only and revalidated by its digest. An
 * If-None-Match naming the current digest gets an empty 304.
 */
export const GET: RequestHandler = async ({ request, locals }) => {
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const library = await getExerciseLibrary(locals.session!.ownerId);
	const etag = libraryEtag(library.digest);
	const headers = { 'cache-control': LIBRARY_CACHE_CONTROL, etag };
	if (etagMatches(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}
	return json(library, { headers });
};
