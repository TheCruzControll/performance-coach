import { fail, redirect } from '@sveltejs/kit';
import {
	authRequest,
	isAuthError,
	readSessionToken,
	RECOVERY_PASSKEY_PATH,
	redeemRecoveryCode,
	setSessionCookie
} from '#lib/server/auth/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.session?.kind === 'recovery') redirect(303, RECOVERY_PASSKEY_PATH);
	if (locals.session) redirect(303, '/profile/security');
	return {};
};

export const actions: Actions = {
	/** Sign in with a recovery code: burns it, then the owner must register a new passkey. */
	default: async (event) => {
		const form = await event.request.formData();
		const code = form.get('code');
		try {
			const issued = await redeemRecoveryCode(
				code,
				readSessionToken(event.cookies, event.url),
				authRequest(event)
			);
			setSessionCookie(event.cookies, event.url, issued);
		} catch (err) {
			if (!isAuthError(err)) throw err;
			return fail(err.status, { error: err.message, code: err.code });
		}
		redirect(303, RECOVERY_PASSKEY_PATH);
	}
};
