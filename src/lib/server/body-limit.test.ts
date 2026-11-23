import { parse } from 'devalue';
import { describe, expect, it } from 'vitest';
import { BODY_LIMITS, bodyLimitFor, oversizedBodyResponse } from './body-limit';

const KB = 1024;

function post(length: number | null, method = 'POST', extra: Record<string, string> = {}): Request {
	const headers: Record<string, string> = { ...extra };
	if (length !== null) headers['content-length'] = String(length);
	return new Request('https://coach.nikocruz.com/api/x', { method, headers });
}

describe('body cap limits', () => {
	it('caps owner routes at the largest owner endpoint body, 64 KB', () => {
		expect(bodyLimitFor('owner')).toBe(64 * KB);
		expect(bodyLimitFor('any-session')).toBe(64 * KB);
		expect(bodyLimitFor('cron')).toBe(64 * KB);
		expect(BODY_LIMITS.default).toBe(64 * KB);
	});

	it('caps public routes tighter, at 16 KB', () => {
		expect(bodyLimitFor('public')).toBe(16 * KB);
	});
});

describe('oversizedBodyResponse', () => {
	it('passes a declared body up to the limit and refuses one a byte over it', () => {
		expect(oversizedBodyResponse(post(64 * KB), '/api/x', 'owner')).toBeNull();
		const over = oversizedBodyResponse(post(64 * KB + 1), '/api/x', 'owner');
		expect(over?.status).toBe(413);
	});

	it('refuses a public route at 16 KB + 1 byte, though an owner route would take it', () => {
		expect(
			oversizedBodyResponse(post(16 * KB + 1), '/api/auth/signin/verify', 'public')?.status
		).toBe(413);
		expect(oversizedBodyResponse(post(16 * KB + 1), '/api/x', 'owner')).toBeNull();
	});

	it('answers an API path with JSON and any other path with text, both no-store', async () => {
		const api = oversizedBodyResponse(post(1e9), '/api/auth/signout', 'public')!;
		expect(api.headers.get('content-type')).toMatch(/application\/json/);
		expect(api.headers.get('cache-control')).toBe('no-store');
		expect(await api.json()).toEqual({ error: 'too_large', message: 'Request body too large.' });

		const page = oversizedBodyResponse(post(1e9), '/recover', 'public')!;
		expect(page.headers.get('content-type')).toMatch(/text\/plain/);
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(await page.text()).toBe('Request body too large.');
	});

	it('answers a form action with an action failure that deserialize() reads as a failure', async () => {
		const action = oversizedBodyResponse(
			post(1e9, 'POST', { 'x-sveltekit-action': 'true' }),
			'/recover',
			'public'
		)!;
		expect(action.status).toBe(413);
		expect(action.headers.get('content-type')).toMatch(/application\/json/);
		expect(action.headers.get('cache-control')).toBe('no-store');
		const answer = JSON.parse(await action.text()) as {
			type: string;
			status: number;
			data: string;
		};
		expect(answer).toMatchObject({ type: 'failure', status: 413 });
		// deserialize() is JSON.parse, then devalue's parse of `data`, which must not throw.
		expect(parse(answer.data)).toEqual({ error: 'too_large', message: 'Request body too large.' });
	});

	it('does not check a request without a declared length, or a read-only method', () => {
		expect(oversizedBodyResponse(post(null), '/api/x', 'public')).toBeNull();
		expect(oversizedBodyResponse(post(1e9, 'GET'), '/api/x', 'public')).toBeNull();
		expect(oversizedBodyResponse(post(1e9, 'HEAD'), '/api/x', 'public')).toBeNull();
	});

	it('leaves a length it cannot read to the route (an empty or malformed header)', () => {
		const empty = new Request('https://coach.nikocruz.com/api/x', {
			method: 'POST',
			headers: { 'content-length': '' }
		});
		expect(oversizedBodyResponse(empty, '/api/x', 'public')).toBeNull();
		expect(
			oversizedBodyResponse(
				new Request('https://coach.nikocruz.com/api/x', {
					method: 'POST',
					headers: { 'content-length': 'many' }
				}),
				'/api/x',
				'public'
			)
		).toBeNull();
	});
});
