import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateToken, generateUserHandle, hashToken, tokenMatchesHash } from './tokens';

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
