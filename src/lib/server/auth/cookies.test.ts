import { describe, expect, it } from 'vitest';
import { expiredSessionCookie, sessionCookie } from './cookies';

describe('session cookie', () => {
	it('is __Host-session; HttpOnly; Secure; SameSite=Lax; Path=/ over HTTPS', () => {
		const expires = new Date('2026-12-05T00:00:00Z');
		expect(sessionCookie('https://coach.nikocruz.com', expires)).toEqual({
			name: '__Host-session',
			options: { path: '/', httpOnly: true, sameSite: 'lax', secure: true, expires }
		});
		expect(sessionCookie(new URL('https://preview-x.vercel.app/today')).name).toBe(
			'__Host-session'
		);
	});

	it('drops Secure and the __Host- prefix on plain-HTTP localhost (browsers refuse them there)', () => {
		expect(sessionCookie('http://localhost:4173')).toEqual({
			name: 'session',
			options: { path: '/', httpOnly: true, sameSite: 'lax', secure: false }
		});
	});

	it('never sets a Domain attribute (host-only cookie)', () => {
		expect(Object.keys(sessionCookie('https://coach.nikocruz.com').options)).not.toContain(
			'domain'
		);
	});

	it('expires with the same name and flags when cleared', () => {
		const cleared = expiredSessionCookie('https://coach.nikocruz.com');
		expect(cleared.name).toBe('__Host-session');
		expect(cleared.options).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			maxAge: 0
		});
		expect(cleared.options.expires!.getTime()).toBe(0);
	});
});
