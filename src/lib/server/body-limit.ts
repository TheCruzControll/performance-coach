/**
 * The central cap on request bodies, run by hooks.server.ts before the guard and before any route
 * reads a body: a request whose declared Content-Length is over its limit is answered 413 and
 * nothing is parsed. Public routes (routes.ts `public`) get the smaller limit: their payloads are
 * a WebAuthn response or a recovery code, a few KB at most.
 *
 * Routes keep their own caps, which are the same or tighter (coach turns 64 KB, client errors and
 * vitals 16 KB, the workout sync 64 KB), and they answer with their own messages. Only a declared
 * length is checked here. A chunked body with no Content-Length is capped by the adapter instead
 * (BODY_SIZE_LIMIT under adapter-node, the platform's limit on Vercel).
 */
import type { RouteAccess } from './auth/routes';
import { isApiPath } from './security-headers';

export const BODY_LIMITS = {
	/** Every other route and form action: the largest body any owner endpoint accepts. */
	default: 64 * 1024,
	/** Public routes (sign-in, setup, sign-out, recovery, test support). */
	public: 16 * 1024
} as const;

/**
 * The `data` of a form action's failure in SvelteKit's devalue encoding: `{ error, message }`, with
 * index 0 the root object and its values at indices 1 and 2. Written out so no devalue import runs
 * in the server bundle; body-limit.test.ts parses it with devalue to hold it to that format.
 */
const TOO_LARGE_ACTION_DATA = '[{"error":1,"message":2},"too_large","Request body too large."]';

export function bodyLimitFor(access: RouteAccess): number {
	return access === 'public' ? BODY_LIMITS.public : BODY_LIMITS.default;
}

/** The 413 for a body over its limit, or null to let the request on (no body, or within it). */
export function oversizedBodyResponse(
	request: Request,
	pathname: string,
	access: RouteAccess
): Response | null {
	if (request.method === 'GET' || request.method === 'HEAD') return null;
	const declared = request.headers.get('content-length');
	if (declared === null || !(Number(declared) > bodyLimitFor(access))) return null;
	const headers = { 'cache-control': 'no-store' };
	// A form action (SvelteKit's enhanced forms send x-sveltekit-action) reads its answer with
	// deserialize(), so its 413 is an action failure: `{type, status, data}` with devalue-encoded data.
	if (request.headers.get('x-sveltekit-action') === 'true') {
		const failure = { type: 'failure', status: 413, data: TOO_LARGE_ACTION_DATA };
		return new Response(JSON.stringify(failure), {
			status: 413,
			headers: { ...headers, 'content-type': 'application/json' }
		});
	}
	return isApiPath(pathname)
		? Response.json(
				{ error: 'too_large', message: 'Request body too large.' },
				{
					status: 413,
					headers
				}
			)
		: new Response('Request body too large.', {
				status: 413,
				headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
			});
}
