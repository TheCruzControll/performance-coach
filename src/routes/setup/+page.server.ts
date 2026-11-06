import { error } from '@sveltejs/kit';
import {
	authRequest,
	checkSetupAccess,
	isAuthError,
	relyingParty
} from '#lib/server/auth/index.ts';
import type { PageServerLoad } from './$types';

/**
 * First-run setup. 404 unless the link's token matches OWNER_SETUP_TOKEN_HASH *and* no owner
 * exists yet — so once the first passkey is registered this URL is gone for good.
 */
export const load: PageServerLoad = async (event) => {
	const token = event.url.searchParams.get('token');
	const allowed = await checkSetupAccess(token, authRequest(event)).catch((err: unknown) => {
		// Too many token checks get the same 404 as a wrong token (no 429 to tell a guesser),
		// and are not a server incident: the limiter has already audited the refusal.
		if (isAuthError(err) && err.code === 'rate_limited') return false;
		throw err;
	});
	if (!allowed) error(404, 'Not found');
	event.setHeaders({ 'cache-control': 'no-store' });
	const rp = relyingParty(event.url);
	return { unavailable: rp.ok ? null : rp.reason };
};
