import { redirect } from '@sveltejs/kit';
import { recoveryCodeStatus, relyingParty } from '#lib/server/auth/index.ts';
import type { PageServerLoad } from './$types';

/** After a recovery code: the only screen a recovery session can see until it adds a passkey. */
export const load: PageServerLoad = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) redirect(303, '/recover');
	if (session.kind !== 'recovery') redirect(303, '/profile/security');
	const rp = relyingParty(url);
	const codes = await recoveryCodeStatus(session);
	return {
		name: session.ownerName,
		remaining: codes.unused,
		expiresAt: session.expiresAt.toISOString(),
		unavailable: rp.ok ? null : rp.reason
	};
};
