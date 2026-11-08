import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	generateSetupToken,
	generateToken,
	generateUserHandle,
	hashToken,
	parseSetupToken,
	SETUP_TOKEN_SKEW_MS,
	setupTokenExpired,
	tokenMatchesHash
} from './tokens';

describe('opaque tokens', () => {
	it('are 256-bit base64url strings, never repeated', () => {
		const tokens = new Set(Array.from({ length: 1_000 }, () => generateToken()));
		expect(tokens.size).toBe(1_000);
		for (const t of [...tokens].slice(0, 20)) {
			expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(Buffer.from(t, 'base64url')).toHaveLength(32);
		}
		expect(generateUserHandle()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('are stored as their lower-case hex SHA-256', () => {
		expect(hashToken('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
		const t = generateToken();
		expect(hashToken(t)).toBe(createHash('sha256').update(t).digest('hex'));
		expect(hashToken(t)).not.toContain(t);
	});

	it('match their hash, and nothing else does', () => {
		const t = generateToken();
		const hash = hashToken(t);
		expect(tokenMatchesHash(t, hash)).toBe(true);
		expect(tokenMatchesHash(`${t}x`, hash)).toBe(false);
		expect(tokenMatchesHash('', hash)).toBe(false);
		expect(tokenMatchesHash(hash, hash)).toBe(false); // the hash is not the secret
	});

	it('refuse malformed configured hashes instead of throwing', () => {
		const t = generateToken();
		for (const bad of ['', 'abc', 'Z'.repeat(64), hashToken(t).slice(0, 63)]) {
			expect(tokenMatchesHash(t, bad)).toBe(false);
		}
	});
});

describe('setup tokens', () => {
	const expiresAt = new Date('2026-11-08T12:00:00Z');
	const seconds = expiresAt.getTime() / 1000;

	it('carry their expiry in base36 seconds before a 256-bit random part', () => {
		const token = generateSetupToken(expiresAt);
		const [expiry, random] = token.split('.');
		expect(expiry).toBe(seconds.toString(36));
		expect(random).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(random!, 'base64url')).toHaveLength(32);
		expect(parseSetupToken(token)).toEqual({ expiresAt });
		// Rounded down to the second, and never the same random part twice.
		const later = generateSetupToken(new Date(expiresAt.getTime() + 999));
		expect(parseSetupToken(later)).toEqual({ expiresAt });
		expect(later).not.toBe(token);
	});

	it('refuse a malformed expiry, a missing dot and the legacy form', () => {
		const random = generateToken();
		const expiry = seconds.toString(36);
		for (const bad of [
			random, // the legacy form: the random part alone
			`${expiry}${random}`, // no dot
			`.${random}`,
			`0.${random}`,
			`0${expiry}.${random}`, // not canonical
			`${expiry.toUpperCase()}.${random}`,
			`-${expiry}.${random}`,
			`${expiry}x!.${random}`,
			`zzzzzzzzz.${random}`, // past what a Date holds
			`${expiry}.${random}.x`,
			`${expiry}.${random.slice(1)}`,
			`${expiry}.${random}A`,
			`${expiry}.${random.slice(1)}=`,
			''
		]) {
			expect(parseSetupToken(bad), bad).toBeNull();
		}
		expect(() => generateSetupToken(new Date(0))).toThrow(RangeError);
		expect(() => generateSetupToken(new Date(Number.NaN))).toThrow(RangeError);
	});

	it(`expire only once ${SETUP_TOKEN_SKEW_MS / 1000} s of clock skew have passed`, () => {
		const at = (ms: number) => new Date(expiresAt.getTime() + ms);
		expect(SETUP_TOKEN_SKEW_MS).toBe(60_000);
		expect(setupTokenExpired(expiresAt, at(-86_400_000))).toBe(false);
		expect(setupTokenExpired(expiresAt, at(0))).toBe(false);
		expect(setupTokenExpired(expiresAt, at(SETUP_TOKEN_SKEW_MS))).toBe(false);
		expect(setupTokenExpired(expiresAt, at(SETUP_TOKEN_SKEW_MS + 1))).toBe(true);
		expect(setupTokenExpired(expiresAt, at(86_400_000))).toBe(true);
	});

	it('cannot have their expiry changed: the hash covers it', () => {
		const token = generateSetupToken(expiresAt);
		const random = token.split('.')[1]!;
		const extended = `${(seconds + 7 * 86_400).toString(36)}.${random}`;
		expect(parseSetupToken(extended)).not.toBeNull();
		expect(hashToken(extended)).not.toBe(hashToken(token));
		expect(tokenMatchesHash(extended, hashToken(token))).toBe(false);
		expect(tokenMatchesHash(random, hashToken(token))).toBe(false);
	});
});
