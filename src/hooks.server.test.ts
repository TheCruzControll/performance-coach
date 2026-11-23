/**
 * The body cap runs in the hook before the guard: an oversized POST is refused with 413 and
 * nothing reads it (the guard, the session and the route never run), while a body within its
 * limit goes on to the guard. Here it reaches the guard's deny-by-default 401 for an owner route.
 */
import type { Handle } from '@sveltejs/kit/hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let handle: Handle;

beforeAll(async () => {
	// The hook logs every request; keep the unit run quiet (the logger reads LOG_LEVEL on import).
	vi.stubEnv('LOG_LEVEL', 'silent');
	({ handle } = await import('./hooks.server.ts'));
});

afterAll(() => {
	vi.unstubAllEnvs();
});

const ORIGIN = 'https://coach.nikocruz.com';

function run(path: string, routeId: string, length: number) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'content-length': String(length),
			'content-type': 'application/json'
		},
		body: '{}'
	});
	const event = {
		request,
		url,
		route: { id: routeId },
		locals: {},
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
		getClientAddress: () => '198.51.100.60',
		isDataRequest: false,
		setHeaders: () => {}
	};
	const resolve = vi.fn(async () => new Response('routed'));
	return {
		resolve,
		response: handle({ event: event as never, resolve: resolve as never })
	};
}

describe('the body cap in the server hook', () => {
	it('refuses an oversized public POST with 413 before the guard or the route', async () => {
		const { resolve, response } = run(
			'/api/auth/signin/verify',
			'/api/auth/signin/verify',
			16 * 1024 + 1
		);
		const answer = await response;
		expect(answer.status).toBe(413);
		expect(resolve).not.toHaveBeenCalled();
		// The hook's headers still go on the refusal.
		expect(answer.headers.get('x-frame-options')).toBe('DENY');
	});

	it('refuses an oversized owner POST at 64 KB + 1 byte', async () => {
		const { resolve, response } = run('/api/coach/turns', '/api/coach/turns', 64 * 1024 + 1);
		expect((await response).status).toBe(413);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('lets a body within the public limit through to the guard (an owner route answers 401)', async () => {
		const { resolve, response } = run('/api/workouts/sync', '/api/workouts/sync', 16 * 1024);
		const answer = await response;
		expect(answer.status).toBe(401);
		expect(await answer.json()).toMatchObject({ error: 'unauthenticated' });
		expect(resolve).not.toHaveBeenCalled();
	});
});
