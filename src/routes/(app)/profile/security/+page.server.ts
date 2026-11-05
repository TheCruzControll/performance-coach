import { error, fail } from '@sveltejs/kit';
import {
	authRequest,
	isAuthError,
	listPasskeys,
	listSessions,
	recentAuthActivity,
	recoveryCodeStatus,
	regenerateRecoveryCodes,
	removePasskey,
	renamePasskey,
	revokeOtherSessions,
	revokeSession,
	type AuthSession
} from '#lib/server/auth/index.ts';
import type { Actions, PageServerLoad } from './$types';

function requireSession(locals: App.Locals): AuthSession {
	if (!locals.session) error(401, 'Sign in to continue.'); // the guard already enforces this
	return locals.session;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = requireSession(locals);
	const [passkeys, sessions, codes, activity] = await Promise.all([
		listPasskeys(session),
		listSessions(session),
		recoveryCodeStatus(session),
		recentAuthActivity(session)
	]);
	return {
		now: new Date(),
		passkeys,
		sessions,
		codes,
		activity,
		recovered: url.searchParams.has('recovered')
	};
};

type Action = 'rename' | 'remove' | 'revoke' | 'revokeOthers' | 'regenerate';

/** Run a security action; auth failures become form errors the screen can show. */
async function run<T>(action: Action, fn: () => Promise<T>) {
	try {
		return { action, ok: true as const, ...(await fn()) };
	} catch (err) {
		if (!isAuthError(err)) throw err;
		return fail(err.status, { action, error: err.message });
	}
}

const field = (form: FormData, name: string) => {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
};

export const actions: Actions = {
	rename: async (event) => {
		const session = requireSession(event.locals);
		const form = await event.request.formData();
		return run('rename', async () => ({
			nickname: await renamePasskey(
				session,
				field(form, 'id'),
				form.get('nickname'),
				authRequest(event)
			)
		}));
	},
	remove: async (event) => {
		const session = requireSession(event.locals);
		const form = await event.request.formData();
		return run('remove', () => removePasskey(session, field(form, 'id'), authRequest(event)));
	},
	revoke: async (event) => {
		const session = requireSession(event.locals);
		const form = await event.request.formData();
		return run('revoke', async () => {
			await revokeSession(session, field(form, 'id'), authRequest(event));
			return {};
		});
	},
	revokeOthers: async (event) => {
		const session = requireSession(event.locals);
		return run('revokeOthers', async () => ({
			count: await revokeOtherSessions(session, authRequest(event))
		}));
	},
	regenerate: async (event) => {
		const session = requireSession(event.locals);
		event.setHeaders({ 'cache-control': 'no-store' });
		return run('regenerate', async () => ({
			codes: await regenerateRecoveryCodes(session, authRequest(event))
		}));
	}
};
