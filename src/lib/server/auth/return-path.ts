/**
 * Where to send the owner after signing in: a *same-origin path* taken from `?next=`, or the
 * default. Anything that could leave the site (absolute or protocol-relative URLs, backslash
 * tricks, control characters, `javascript:`) or point at an API/auth endpoint falls back to the
 * default. Pure; unit-tested in return-path.test.ts.
 */
export const DEFAULT_RETURN_PATH = '/today';

const BASE = 'https://return-path.invalid';

export function safeReturnPath(raw: string | null | undefined, fallback = DEFAULT_RETURN_PATH) {
	if (!raw || raw.length > 512) return fallback;
	// Paths only: one leading slash, never `//` or `/\` (browsers treat both as protocol-relative).
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
	// …nor percent-encoded ones (harmless once encoded, but never a legitimate app path).
	if (/%(0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)) return fallback;

	let url: URL;
	try {
		url = new URL(raw, BASE);
	} catch {
		return fallback;
	}
	if (url.origin !== BASE) return fallback;

	const path = url.pathname;
	// Never bounce into an endpoint or back into the sign-in/setup/recovery flow.
	if (path === '/' || /^\/(api|setup|recover)(\/|$)/.test(path) || path.includes('__data.json')) {
		return fallback;
	}
	return `${path}${url.search}${url.hash}`;
}

/** The sign-in URL that returns to `pathAndSearch` afterwards. */
export function signInUrl(pathAndSearch: string): string {
	const next = safeReturnPath(pathAndSearch, '');
	return next ? `/?next=${encodeURIComponent(next)}` : '/';
}
