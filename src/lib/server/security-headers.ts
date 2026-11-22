/**
 * The security headers every page and endpoint is sent.
 *
 * - Dynamic responses (pages, endpoints): hooks.server.ts sends SECURITY_HEADERS. SvelteKit sets
 *   their Content-Security-Policy itself (`csp` in vite.config.ts).
 * - Prerendered pages (/offline): static files that never reach the hooks. vercel.json sends them
 *   STATIC_PAGE_HEADERS, and scripts/vercel-headers.test.ts fails when it does not, for every
 *   page that sets `prerender`. The post-deploy smoke check asserts them in production.
 * - Dynamic responses without their own cache-control: `/api/*` gets `no-store` and pages
 *   `private, no-cache` (`defaultCacheControl`). A request whose auth guard throws gets a 500
 *   from `failedRequestResponse`, with the headers, instead of SvelteKit's fallback without them.
 *
 * Other static files (immutable build assets, icons, the manifest, robots.txt, the service
 * worker) hold no personal data and get the platform's defaults.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy':
		'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), browsing-topics=(), hid=(), serial=(), bluetooth=(), midi=(), screen-wake-lock=(self)',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
	// Vercel adds HSTS on its domains; this covers any other host (ignored over plain HTTP).
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	// Private, single-user app: never indexed.
	'x-robots-tag': 'noindex, nofollow'
};

/**
 * A prerendered page carries the rest of its CSP as a <meta> tag, which browsers obey for
 * everything but `frame-ancestors`. This header policy adds that one directive; a browser
 * enforces both policies.
 */
export const STATIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
	...SECURITY_HEADERS,
	'content-security-policy': "frame-ancestors 'none'"
};

/** `/api` and everything under it. `/apiary` is not an API path. */
export function isApiPath(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * The cache-control the hooks add to a dynamic response whose handler set none: API answers are
 * never stored by any cache, and pages, which hold personal data, may be revalidated by the
 * browser but not stored by a CDN. Anything else (null) is left to the handler.
 */
export function defaultCacheControl(pathname: string, contentType: string): string | null {
	if (isApiPath(pathname)) return 'no-store';
	if (contentType.startsWith('text/html')) return 'private, no-cache';
	return null;
}

const FAILURE_MESSAGE = 'Something went wrong on our side.';

/**
 * The 500 sent when the request guard throws. SvelteKit's own fallback for a throwing `handle`
 * skips the hooks, so it would carry none of SECURITY_HEADERS; this one is returned by the hook
 * and gets them. `body` is what `handleError` returned (it has already recorded the error).
 */
export function failedRequestResponse(json: boolean, body: App.Error | void): Response {
	const message = body?.message ?? FAILURE_MESSAGE;
	if (json) {
		return Response.json(body ?? { message }, {
			status: 500,
			headers: { 'cache-control': 'no-store' }
		});
	}
	return new Response(message, {
		status: 500,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}
