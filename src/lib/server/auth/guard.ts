/**
 * The request guard run by `hooks.server.ts` for every dynamic request (deny by default):
 *
 * 1. CSRF: state-changing requests must come from the app's own origin (csrf.ts).
 * 2. Cron: a `cron` route (routes.ts) is decided by its bearer secret alone, before any session
 *    logic, so a session never grants it (cron.ts): 404 while the secret is unset, 405 for any
 *    method but GET, 401 without the exact bearer. A refusal logs its reason, never the header.
 * 3. Session: the cookie token is resolved to a live session (`locals.session`); a stale cookie
 *    is cleared; the sliding expiry is re-sent when it moves.
 * 4. Access: the route's policy (routes.ts). Without a session, pages redirect to sign-in with a
 *    safe return path and `/api/*` answers 401 JSON. A recovery session reaches only the
 *    new-passkey screen, its endpoints and sign-out.
 *
 * Returns a response to send instead of resolving the route, or null to continue.
 */
import { json, type RequestEvent } from '@sveltejs/kit';
import { getEnv } from '../env';
import { logger } from '../observability/logger';
import { measure } from '../observability/timing';
import { expiredSessionCookie } from './cookies';
import { CRON_METHOD, cronRefusal, verifyCronRequest } from './cron';
import { checkOrigin } from './csrf';
import { readSessionToken, refreshSessionCookie } from './http';
import { signInUrl } from './return-path';
import { RECOVERY_PASSKEY_PATH, routeAccess } from './routes';
import { validateSessionToken } from './sessions';

type GuardEvent = Pick<RequestEvent, 'url' | 'request' | 'cookies' | 'locals' | 'route'>;

const isApi = (url: URL) => url.pathname === '/api' || url.pathname.startsWith('/api/');

function wantsActionJson(request: Request): boolean {
	const accept = request.headers.get('accept') ?? '';
	return request.method === 'POST' && /application\/json/.test(accept);
}

function redirectTo(event: GuardEvent, location: string, clearCookie: boolean): Response {
	const headers = new Headers({ 'cache-control': 'no-store' });
	if (clearCookie) appendClearCookie(event, headers);
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		headers.set('location', location);
		return new Response(null, { status: 303, headers });
	}
	// A form action submitted with `use:enhance`: SvelteKit's action-result redirect.
	if (wantsActionJson(event.request)) {
		return json({ type: 'redirect', status: 303, location }, { headers });
	}
	headers.set('location', location);
	return new Response(null, { status: 303, headers });
}

function apiError(
	event: GuardEvent,
	status: number,
	error: string,
	message: string,
	clearCookie = false
): Response {
	const headers = new Headers({ 'cache-control': 'no-store' });
	if (clearCookie) appendClearCookie(event, headers);
	return json({ error, message }, { status, headers });
}

function appendClearCookie(event: GuardEvent, headers: Headers) {
	const { name, options } = expiredSessionCookie(event.url);
	headers.append('set-cookie', event.cookies.serialize(name, '', options));
}

export async function guardRequest(event: GuardEvent): Promise<Response | null> {
	event.locals.session = null;

	const csrf = checkOrigin(event.request, event.url.origin);
	if (!csrf.ok) {
		logger.warn('csrf: request refused', {
			method: event.request.method,
			path: event.url.pathname,
			reason: csrf.reason
		});
		return isApi(event.url)
			? apiError(event, 403, 'forbidden', 'Cross-site request refused.')
			: new Response('Cross-site request refused.', {
					status: 403,
					headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
				});
	}

	const access = routeAccess(event.route.id);
	if (access === 'cron') return guardCron(event);

	const token = readSessionToken(event.cookies, event.url);
	let staleCookie = false;
	if (token) {
		const check = await measure('auth', () => validateSessionToken(token));
		if (check) {
			event.locals.session = check.session;
			if (check.refreshedExpiry) {
				refreshSessionCookie(event.cookies, event.url, token, check.refreshedExpiry);
			}
		} else {
			staleCookie = true;
		}
	}

	const session = event.locals.session;

	if (access === 'public') {
		if (staleCookie) {
			const { name, options } = expiredSessionCookie(event.url);
			event.cookies.set(name, '', options);
		}
		return null;
	}

	if (!session) {
		return isApi(event.url)
			? apiError(event, 401, 'unauthenticated', 'Sign in to continue.', staleCookie)
			: redirectTo(event, signInUrl(`${event.url.pathname}${event.url.search}`), staleCookie);
	}

	if (session.kind === 'recovery' && access === 'owner') {
		return isApi(event.url)
			? apiError(event, 403, 'passkey_required', 'Add a new passkey to finish recovery.')
			: redirectTo(event, RECOVERY_PASSKEY_PATH, false);
	}

	return null;
}

/** A `cron` route: the bearer secret decides, and a session is never read. */
function guardCron(event: GuardEvent): Response | null {
	const check = verifyCronRequest(event.request, getEnv());
	const refused = (status: 401 | 404 | 405, reason: string) => {
		logger.warn('cron: request refused', {
			method: event.request.method,
			path: event.url.pathname,
			status,
			reason
		});
		return cronRefusal(status);
	};
	if (!check.ok && check.status === 404) return refused(404, check.reason);
	if (event.request.method !== CRON_METHOD) return refused(405, 'method_not_allowed');
	return check.ok ? null : refused(check.status, check.reason);
}
