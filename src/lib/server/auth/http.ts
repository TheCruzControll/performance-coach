/**
 * SvelteKit glue for auth: request context, session cookie I/O and JSON error responses.
 * Routes stay thin: parse, call a use-case, answer with these helpers.
 */
import { json, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { getEnv } from '../env';
import type { AuthRequest } from './context';
import { expiredSessionCookie, sessionCookie } from './cookies';
import { AuthError, isAuthError } from './errors';
import { relyingPartyFor, type RelyingPartyResult } from './relying-party';
import type { IssuedSession } from './sessions';

type EventLike = Pick<RequestEvent, 'url' | 'request' | 'getClientAddress' | 'locals' | 'cookies'>;

export function relyingParty(url: URL): RelyingPartyResult {
	return relyingPartyFor(getEnv(), url);
}

function clientAddress(event: EventLike): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

/**
 * The request as auth use-cases see it. With `webauthn: true` the relying party must resolve
 * for this origin, or the request is refused (`wrong_origin`): a production build serving a
 * non-production host, a preview on the production domain, or dev on 127.0.0.1.
 */
export function authRequest(event: EventLike, options: { webauthn?: boolean } = {}): AuthRequest {
	const base: AuthRequest = {
		ip: clientAddress(event),
		userAgent: event.request.headers.get('user-agent'),
		requestId: event.locals.requestId
	};
	if (!options.webauthn) return base;
	const rp = relyingParty(event.url);
	if (!rp.ok) throw new AuthError('wrong_origin', rp.reason);
	return { ...base, rp: { rpID: rp.rpID, origin: rp.origin, rpName: rp.rpName } };
}

export function readSessionToken(cookies: Cookies, url: URL): string | undefined {
	return cookies.get(sessionCookie(url).name) || undefined;
}

export function setSessionCookie(cookies: Cookies, url: URL, issued: IssuedSession): void {
	const { name, options } = sessionCookie(url, issued.session.expiresAt);
	cookies.set(name, issued.token, options);
}

/** Re-send the cookie with a new expiry (sliding refresh). */
export function refreshSessionCookie(cookies: Cookies, url: URL, token: string, expires: Date) {
	const { name, options } = sessionCookie(url, expires);
	cookies.set(name, token, options);
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	const { name, options } = expiredSessionCookie(url);
	cookies.set(name, '', options);
}

/** JSON error body for an auth failure; unknown errors are rethrown (500 via handleError). */
export function authErrorResponse(error: unknown): Response {
	if (!isAuthError(error)) throw error;
	return json(
		{ error: error.code, message: error.message },
		{
			status: error.status,
			headers: {
				'cache-control': 'no-store',
				...(error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {})
			}
		}
	);
}

/** Parse a small JSON body (auth payloads are a few KB at most). */
export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > maxBytes) throw new AuthError('invalid_input', 'Request too large.');
	const text = await request.text();
	if (text.length > maxBytes) throw new AuthError('invalid_input', 'Request too large.');
	try {
		return JSON.parse(text);
	} catch {
		throw new AuthError('invalid_input', 'Body must be JSON.');
	}
}

export const NO_STORE = { 'cache-control': 'no-store' } as const;
