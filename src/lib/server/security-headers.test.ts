import { describe, expect, it } from 'vitest';
import {
	SECURITY_HEADERS,
	defaultCacheControl,
	failedRequestResponse,
	isApiPath
} from './security-headers.ts';

const MESSAGE = 'Something went wrong on our side.';
// What handleError returns for a 500: message and requestId, no status.
const HANDLED = { message: MESSAGE, requestId: 'req-12345678' } as App.Error;

describe('SECURITY_HEADERS', () => {
	it('is exactly the eight dynamic and prerendered security headers', () => {
		expect(SECURITY_HEADERS).toEqual({
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			'referrer-policy': 'strict-origin-when-cross-origin',
			'permissions-policy':
				'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), browsing-topics=(), hid=(), serial=(), bluetooth=(), midi=(), screen-wake-lock=(self)',
			'cross-origin-opener-policy': 'same-origin',
			'cross-origin-resource-policy': 'same-origin',
			'strict-transport-security': 'max-age=63072000; includeSubDomains',
			'x-robots-tag': 'noindex, nofollow'
		});
	});
});

describe('isApiPath', () => {
	it.each(['/api', '/api/health'])('treats %s as an API path', (pathname) => {
		expect(isApiPath(pathname)).toBe(true);
	});

	it.each(['/apiary', '/', '/today'])('does not treat %s as an API path', (pathname) => {
		expect(isApiPath(pathname)).toBe(false);
	});
});

describe('defaultCacheControl', () => {
	it.each([
		['/api/health', 'application/json', 'no-store'],
		// A 204 has no content type.
		['/api/vitals', '', 'no-store'],
		// An API 404 rendered as HTML.
		['/api/nope', 'text/html; charset=utf-8', 'no-store'],
		['/today', 'text/html; charset=utf-8', 'private, no-cache'],
		['/apiary', 'application/json', null],
		['/manifest.webmanifest', 'application/manifest+json', null]
	])('%s (%s) → %s', (pathname, contentType, expected) => {
		expect(defaultCacheControl(pathname, contentType)).toBe(expected);
	});
});

describe('failedRequestResponse', () => {
	it('answers a JSON request with the handled error body, no-store and status 500', async () => {
		const res = failedRequestResponse(true, HANDLED);
		expect(res.status).toBe(500);
		expect(res.headers.get('content-type')).toMatch(/^application\/json/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual(HANDLED);
	});

	it('answers a page request with the message as plain text, no-store and status 500', async () => {
		const res = failedRequestResponse(false, HANDLED);
		expect(res.status).toBe(500);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toBe(MESSAGE);
	});

	it('falls back to the generic message as plain text when there is no body', async () => {
		const res = failedRequestResponse(false, undefined);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe(MESSAGE);
	});

	it('falls back to the generic message as JSON when there is no body', async () => {
		const res = failedRequestResponse(true, undefined);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ message: MESSAGE });
	});
});
