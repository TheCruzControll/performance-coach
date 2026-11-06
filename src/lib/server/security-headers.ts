/**
 * The security headers every page and endpoint is sent.
 *
 * - Dynamic responses (pages, endpoints): hooks.server.ts sends SECURITY_HEADERS. SvelteKit sets
 *   their Content-Security-Policy itself (`csp` in vite.config.ts).
 * - Prerendered pages (/offline): static files that never reach the hooks. vercel.json sends them
 *   STATIC_PAGE_HEADERS, and scripts/vercel-headers.test.ts fails when it does not, for every
 *   page that sets `prerender`. The post-deploy smoke check asserts them in production.
 *
 * Other static files (immutable build assets, icons, the manifest, robots.txt, the service
 * worker) hold no personal data and get the platform's defaults.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	'cross-origin-opener-policy': 'same-origin',
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
