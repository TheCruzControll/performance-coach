/**
 * Session cookie name and attributes, derived from the origin's protocol (pure, unit-tested).
 *
 * HTTPS (production, previews): `__Host-session; HttpOnly; Secure; SameSite=Lax; Path=/`, no
 * Domain. The `__Host-` prefix makes the browser refuse the cookie unless it is Secure, host-only
 * and Path=/, so a sibling subdomain of nikocruz.com can neither set nor shadow it.
 *
 * Plain-HTTP localhost (dev, e2e): browsers reject `Secure` (WebKit) and therefore `__Host-`
 * cookies there, so the cookie is called `session` and omits `Secure`; everything else is equal.
 */
export interface SessionCookieOptions {
	path: '/';
	httpOnly: true;
	sameSite: 'lax';
	secure: boolean;
	expires?: Date;
	maxAge?: number;
}

export interface SessionCookie {
	name: '__Host-session' | 'session';
	options: SessionCookieOptions;
}

export function sessionCookie(origin: URL | string, expires?: Date): SessionCookie {
	const secure = new URL(origin).protocol === 'https:';
	return {
		name: secure ? '__Host-session' : 'session',
		options: {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure,
			...(expires ? { expires } : {})
		}
	};
}

/** Attributes that delete the cookie (same name/path/flags, already expired). */
export function expiredSessionCookie(origin: URL | string): SessionCookie {
	const cookie = sessionCookie(origin);
	return { ...cookie, options: { ...cookie.options, maxAge: 0, expires: new Date(0) } };
}
