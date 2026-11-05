import { redirect } from '@sveltejs/kit';
import { RECOVERY_PASSKEY_PATH, relyingParty, safeReturnPath } from '#lib/server/auth/index.ts';
import type { PageServerLoad } from './$types';

/** The sign-in screen. Signed in already? Straight on to where the owner was going. */
export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeReturnPath(url.searchParams.get('next'));
	if (locals.session?.kind === 'recovery') redirect(303, RECOVERY_PASSKEY_PATH);
	if (locals.session) redirect(303, next);

	const rp = relyingParty(url);
	return {
		next,
		signedOut: url.searchParams.has('signedOut'),
		unavailable: rp.ok ? null : { reason: rp.reason, signInUrl: rp.signInUrl ?? null }
	};
};
