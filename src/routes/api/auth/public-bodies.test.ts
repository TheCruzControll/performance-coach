/**
 * The public auth routes that read a JSON body cap it at the public limit (16 KB), not the 64 KB
 * default. The hook refuses a declared Content-Length over the cap; a chunked body has none, so
 * readJsonBody is what holds the cap there. Each handler reads its body first, so a refusal here
 * needs no database.
 */
import { describe, expect, it } from 'vitest';
import { BODY_LIMITS } from '#lib/server/body-limit.ts';
import { POST as setupOptions } from './setup/options/+server.ts';
import { POST as setupVerify } from './setup/verify/+server.ts';
import { POST as signinVerify } from './signin/verify/+server.ts';

const ORIGIN = 'https://coach.nikocruz.com';
const KB = 1024;

/** A POST whose body is `bytes` long and sent without a Content-Length, as a chunked request is. */
function chunked(bytes: number, pathname: string): Request {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(bytes).fill(0x78));
			controller.close();
		}
	});
	return new Request(new URL(pathname, ORIGIN), {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		body,
		duplex: 'half'
	} as RequestInit);
}

const ROUTES = [
	['/api/auth/setup/options', setupOptions],
	['/api/auth/setup/verify', setupVerify],
	['/api/auth/signin/verify', signinVerify]
] as const;

describe('public auth routes cap a JSON body at 16 KB, even without a Content-Length', () => {
	it('is the public limit', () => {
		expect(BODY_LIMITS.public).toBe(16 * KB);
	});

	it.each(ROUTES)('%s refuses 16 KB + 1 byte as too large', async (pathname, handler) => {
		const request = chunked(BODY_LIMITS.public + 1, pathname);
		expect(request.headers.get('content-length')).toBeNull();
		const response = await handler({ request } as never);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: 'invalid_input',
			message: 'Request too large.'
		});
	});

	it.each(ROUTES)(
		'%s passes a body of exactly 16 KB on to the parser',
		async (pathname, handler) => {
			// 16 KB of x is not JSON: the size check passes, and the parser refuses it instead.
			const request = chunked(BODY_LIMITS.public, pathname);
			const response = await handler({ request } as never);
			expect(await response.json()).toEqual({
				error: 'invalid_input',
				message: 'Body must be JSON.'
			});
		}
	);
});
