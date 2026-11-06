import { describe, expect, it } from 'vitest';
import {
	PRODUCTION_ORIGIN,
	PRODUCTION_RP_ID,
	relyingPartyFor,
	type RelyingPartyEnv
} from './relying-party';

const url = (href: string) => new URL(href);
const production: RelyingPartyEnv = { appEnv: 'production', VERCEL_ENV: 'production' };
const preview: RelyingPartyEnv = {
	appEnv: 'preview',
	VERCEL_ENV: 'preview',
	VERCEL_URL: 'performance-coach-abc123-team.vercel.app',
	VERCEL_BRANCH_URL: 'performance-coach-git-feat-x-team.vercel.app'
};

describe('relying party: production', () => {
	it('is exactly https://coach.nikocruz.com with RP ID coach.nikocruz.com', () => {
		expect(PRODUCTION_ORIGIN).toBe('https://coach.nikocruz.com');
		expect(relyingPartyFor(production, url('https://coach.nikocruz.com/today'))).toEqual({
			ok: true,
			rpID: PRODUCTION_RP_ID,
			origin: PRODUCTION_ORIGIN,
			rpName: 'Performance Coach'
		});
	});

	it('applies whenever either signal says production', () => {
		for (const env of [{ appEnv: 'production' }, { appEnv: 'preview', VERCEL_ENV: 'production' }]) {
			const rp = relyingPartyFor(env as RelyingPartyEnv, url('https://coach.nikocruz.com/'));
			expect(rp).toMatchObject({ ok: true, rpID: 'coach.nikocruz.com' });
		}
	});

	it('refuses every other host, scheme or port, pointing at the real sign-in URL', () => {
		for (const href of [
			'https://performance-coach-abc123-team.vercel.app/',
			'http://coach.nikocruz.com/',
			'https://coach.nikocruz.com:8443/',
			'https://nikocruz.com/',
			'https://evil.coach.nikocruz.com/',
			'https://coach.nikocruz.com.evil.example/',
			'http://localhost:4173/'
		]) {
			expect(relyingPartyFor(production, url(href)), href).toEqual({
				ok: false,
				reason: expect.stringContaining('coach.nikocruz.com'),
				signInUrl: PRODUCTION_ORIGIN
			});
		}
	});
});

describe('relying party: preview', () => {
	it('uses the deployment’s own host as RP ID and origin', () => {
		for (const host of [preview.VERCEL_URL!, preview.VERCEL_BRANCH_URL!]) {
			expect(relyingPartyFor(preview, url(`https://${host}/setup`))).toEqual({
				ok: true,
				rpID: host,
				origin: `https://${host}`,
				rpName: 'Performance Coach (preview)'
			});
		}
	});

	it('accepts other *.vercel.app aliases of the deployment', () => {
		expect(
			relyingPartyFor(preview, url('https://performance-coach-team.vercel.app/'))
		).toMatchObject({ ok: true, rpID: 'performance-coach-team.vercel.app' });
	});

	it('never uses the production RP, or anything under nikocruz.com', () => {
		for (const href of [
			'https://coach.nikocruz.com/',
			'https://nikocruz.com/',
			'https://preview.coach.nikocruz.com/',
			'https://x.nikocruz.com/'
		]) {
			const rp = relyingPartyFor(preview, url(href));
			expect(rp.ok, href).toBe(false);
		}
		// Derived from the request, never configured: no preview input can yield the production RP.
		const spoofed = relyingPartyFor(
			{ ...preview, VERCEL_URL: 'coach.nikocruz.com', VERCEL_BRANCH_URL: 'coach.nikocruz.com' },
			url('https://coach.nikocruz.com/')
		);
		expect(spoofed.ok).toBe(false);
	});

	it('refuses plain HTTP and unknown hosts', () => {
		expect(relyingPartyFor(preview, url(`http://${preview.VERCEL_URL}/`)).ok).toBe(false);
		expect(relyingPartyFor(preview, url('https://example.com/')).ok).toBe(false);
		expect(relyingPartyFor(preview, url('https://vercel.app.example.com/')).ok).toBe(false);
	});

	it('also applies to APP_ENV=preview outside Vercel', () => {
		const rp = relyingPartyFor({ appEnv: 'preview' }, url('https://my-app.vercel.app/'));
		expect(rp).toMatchObject({ ok: true, rpID: 'my-app.vercel.app' });
	});
});

describe('relying party: development and test', () => {
	it('is localhost on any port and scheme', () => {
		for (const appEnv of ['development', 'test'] as const) {
			for (const origin of [
				'http://localhost:5173',
				'http://localhost:4173',
				'https://localhost'
			]) {
				expect(relyingPartyFor({ appEnv }, url(`${origin}/x`))).toEqual({
					ok: true,
					rpID: 'localhost',
					origin,
					rpName: 'Performance Coach'
				});
			}
		}
	});

	it('refuses IP addresses (not valid RP IDs) and any other host', () => {
		expect(relyingPartyFor({ appEnv: 'development' }, url('http://127.0.0.1:5173/'))).toEqual({
			ok: false,
			reason: expect.stringContaining('localhost')
		});
		expect(relyingPartyFor({ appEnv: 'test' }, url('http://[::1]:5173/')).ok).toBe(false);
		expect(relyingPartyFor({ appEnv: 'test' }, url('https://coach.nikocruz.com/')).ok).toBe(false);
		expect(relyingPartyFor({ appEnv: 'development' }, url('http://my-laptop.local/')).ok).toBe(
			false
		);
	});
});
