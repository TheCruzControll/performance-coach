import { error } from '@sveltejs/kit';
import { testRoutesEnabled } from '#lib/server/env.ts';
import type { RequestHandler } from './$types';

/**
 * Throws an unexpected error so automated tests can verify error logging and recording.
 * Exists only when ENABLE_TEST_ROUTES=true (rejected by env validation in production).
 */
export const GET: RequestHandler = () => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	throw new Error('Intentional test error (observability check)');
};
