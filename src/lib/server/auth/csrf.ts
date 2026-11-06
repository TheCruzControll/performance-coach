/**
 * Cross-site request forgery guard for every state-changing request (pure, unit-tested).
 *
 * SvelteKit already rejects cross-site *form* submissions (`csrf.checkOrigin`, on by default).
 * This check covers everything else too — JSON endpoints, `fetch` with any content type,
 * beacons — by requiring an `Origin` header equal to the app's own origin on every method other
 * than GET/HEAD/OPTIONS. Browsers send `Origin` on all such requests, so a missing header means
 * a non-browser client, which cannot carry the owner's cookies in a CSRF attack anyway and is
 * refused for simplicity. SameSite=Lax on the session cookie is a second, independent layer.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

export function checkOrigin(request: Request, appOrigin: string): CsrfVerdict {
	if (SAFE_METHODS.has(request.method)) return { ok: true };
	const origin = request.headers.get('origin');
	if (!origin) return { ok: false, reason: 'missing Origin header' };
	if (origin !== appOrigin) return { ok: false, reason: `cross-site request from ${origin}` };
	const site = request.headers.get('sec-fetch-site');
	if (site && site !== 'same-origin') {
		return { ok: false, reason: `Sec-Fetch-Site: ${site}` };
	}
	return { ok: true };
}
