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
import { relativeTime } from '#lib/ui/time.ts';
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
	const now = new Date();
	// Relative times ("3 h ago") are labelled here, with the `now` the page gets, so their
	// wording ships no JS. Dates ("5 Nov") stay in the browser, in the device's time zone: the
	// page shows one wherever a label here is null (7 days and older).
	const ago = (at: Date | null) => (at ? relativeTime(at, now) : null);
	return {
		now,
		passkeys: passkeys.map((p) => ({ ...p, lastUsedAgo: ago(p.lastUsedAt) })),
		sessions: sessions.map((s) => ({ ...s, lastSeenAgo: ago(s.lastSeenAt) })),
		codes,
		activity: activity.map((e) => ({ ...e, ago: ago(e.at) })),
		recovered: url.searchParams.has('recovered')
	};
};

type Action = 'rename' | 'remove' | 'revoke' | 'revokeOthers' | 'regenerate';

/**
 * Run a security action; auth failures become form errors the screen can show. `code` tells
 * the screen when to ask for a passkey first (`reauth_required`) and retry.
 */
async function run<T>(action: Action, fn: () => Promise<T>) {
	try {
		return { action, ok: true as const, ...(await fn()) };
	} catch (err) {
		if (!isAuthError(err)) throw err;
		return fail(err.status, { action, code: err.code, error: err.message });
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
