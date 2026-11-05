import { describe, expect, it } from 'vitest';
import { checkOrigin } from './csrf';

const APP = 'https://coach.nikocruz.com';
const req = (method: string, headers: Record<string, string> = {}) =>
	new Request(`${APP}/api/auth/signout`, { method, headers });

describe('CSRF origin check', () => {
	it('lets safe methods through untouched', () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			expect(checkOrigin(req(method, { origin: 'https://evil.example' }), APP)).toEqual({
				ok: true
			});
		}
	});

	it('accepts state-changing requests from the app’s own origin', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(checkOrigin(req(method, { origin: APP }), APP)).toEqual({ ok: true });
			expect(
				checkOrigin(req(method, { origin: APP, 'sec-fetch-site': 'same-origin' }), APP)
			).toEqual({ ok: true });
		}
	});

	it('refuses cross-site, sibling-subdomain, null and missing origins', () => {
		for (const origin of [
			'https://evil.example',
			'https://nikocruz.com',
			'https://other.nikocruz.com',
			'http://coach.nikocruz.com',
			'null'
		]) {
			expect(checkOrigin(req('POST', { origin }), APP).ok, origin).toBe(false);
		}
		expect(checkOrigin(req('POST'), APP)).toEqual({ ok: false, reason: 'missing Origin header' });
	});

	it('refuses a matching Origin when Fetch Metadata says the request is cross-site', () => {
		expect(checkOrigin(req('POST', { origin: APP, 'sec-fetch-site': 'cross-site' }), APP).ok).toBe(
			false
		);
		expect(checkOrigin(req('POST', { origin: APP, 'sec-fetch-site': 'same-site' }), APP).ok).toBe(
			false
		);
	});
});
