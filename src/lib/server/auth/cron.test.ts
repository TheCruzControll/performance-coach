import { describe, expect, it } from 'vitest';
import { MIN_CRON_SECRET_LENGTH } from '../backup/config';
import { cronRefusal, verifyCronRequest } from './cron';

const SECRET = 'c'.repeat(20) + 'R0n-S3cret-0f-44-Chars-xyz';
const ENV = { CRON_SECRET: SECRET };

/** A request with this Authorization header (or none). */
const withAuth = (authorization?: string) =>
	new Request('https://coach.nikocruz.com/api/cron/backup', {
		headers: authorization === undefined ? {} : { authorization }
	});

/**
 * A header exactly as given: fetch's Headers trims a value's surrounding whitespace, a proxy or
 * another runtime need not.
 */
const raw = (authorization: string) =>
	({ headers: { get: () => authorization } }) as unknown as Request;

describe('verifyCronRequest', () => {
	it('opens for exactly `Bearer <CRON_SECRET>`', () => {
		expect(verifyCronRequest(withAuth(`Bearer ${SECRET}`), ENV)).toEqual({ ok: true });
	});

	it('refuses a missing header with 401', () => {
		expect(verifyCronRequest(withAuth(), ENV)).toEqual({
			ok: false,
			status: 401,
			reason: 'missing'
		});
	});

	it('refuses another scheme, or the scheme in another case, with 401', () => {
		const basic = `Basic ${Buffer.from(`cron:${SECRET}`).toString('base64')}`;
		for (const header of [
			basic,
			`bearer ${SECRET}`,
			`BEARER ${SECRET}`,
			SECRET,
			`Bearer${SECRET}`,
			'Bearer '
		]) {
			expect(verifyCronRequest(withAuth(header), ENV), header).toEqual({
				ok: false,
				status: 401,
				reason: 'malformed'
			});
		}
	});

	it('refuses padding around the secret with 401', () => {
		for (const header of [`Bearer ${SECRET} `, `Bearer  ${SECRET}`, `Bearer ${SECRET}\t`]) {
			expect(verifyCronRequest(raw(header), ENV), JSON.stringify(header)).toEqual({
				ok: false,
				status: 401,
				reason: 'mismatch'
			});
		}
	});

	it('refuses a secret of the right length with one character wrong, or a prefix, with 401', () => {
		const wrong = `${SECRET.slice(0, -1)}${SECRET.endsWith('z') ? 'y' : 'z'}`;
		expect(wrong).toHaveLength(SECRET.length);
		for (const secret of [wrong, SECRET.slice(0, -1), `${SECRET}x`]) {
			expect(verifyCronRequest(withAuth(`Bearer ${secret}`), ENV), secret).toEqual({
				ok: false,
				status: 401,
				reason: 'mismatch'
			});
		}
	});

	it('answers 404 while CRON_SECRET is unset or too short, whatever the request carries', () => {
		const short = 's'.repeat(MIN_CRON_SECRET_LENGTH - 1);
		const envs: { CRON_SECRET?: string }[] = [
			{},
			{ CRON_SECRET: short },
			{ CRON_SECRET: `${SECRET} with spaces` }
		];
		for (const env of envs) {
			for (const request of [withAuth(), withAuth(`Bearer ${env.CRON_SECRET ?? SECRET}`)]) {
				expect(verifyCronRequest(request, env)).toEqual({
					ok: false,
					status: 404,
					reason: 'not_configured'
				});
			}
		}
	});
});

describe('cronRefusal', () => {
	it('answers JSON with no-store, and 405 names the one method served', async () => {
		for (const status of [401, 404, 405] as const) {
			const response = cronRefusal(status);
			expect(response.status).toBe(status);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(Object.keys(await response.json())).toEqual(['error', 'message']);
		}
		expect(cronRefusal(405).headers.get('allow')).toBe('GET');
		expect(cronRefusal(401).headers.get('allow')).toBeNull();
	});
});
