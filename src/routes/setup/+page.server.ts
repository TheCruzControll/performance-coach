import { error } from '@sveltejs/kit';
import { authRequest, checkSetupAccess, relyingParty } from '#lib/server/auth/index.ts';
import type { PageServerLoad } from './$types';

/**
 * First-run setup. 404 unless the link's token matches OWNER_SETUP_TOKEN_HASH *and* no owner
 * exists yet — so once the first passkey is registered this URL is gone for good.
 */
export const load: PageServerLoad = async (event) => {
	const token = event.url.searchParams.get('token');
	if (!(await checkSetupAccess(token, authRequest(event)))) error(404, 'Not found');
	event.setHeaders({ 'cache-control': 'no-store' });
	const rp = relyingParty(event.url);
	return { unavailable: rp.ok ? null : rp.reason };
};
