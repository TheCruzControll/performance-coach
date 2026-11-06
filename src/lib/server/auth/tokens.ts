/**
 * Opaque secrets: random generation, hashing at rest and constant-time comparison.
 *
 * Only `node:crypto` primitives are used (CSPRNG, SHA-256, timingSafeEqual); no protocol or
 * cryptography of our own. Every secret the server hands out — session tokens, recovery codes,
 * the one-time setup token — carries at least 80 bits of entropy from the CSPRNG, so a single
 * unsalted SHA-256 is the right storage hash: there is nothing to brute-force that a slow,
 * salted password hash would protect (it exists for low-entropy, human-chosen secrets).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url (43 characters): session tokens and the setup token. */
export function generateToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

/** Lower-case hex SHA-256 of a secret (64 characters). What the database stores. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Does `token` hash to `expectedHex`? Constant time with respect to the token: both sides are
 * fixed-length SHA-256 digests compared with `timingSafeEqual`, so neither the length nor the
 * content of the presented token leaks through timing.
 */
export function tokenMatchesHash(token: string, expectedHex: string): boolean {
	if (!HEX_SHA256.test(expectedHex)) return false;
	const actual = createHash('sha256').update(token, 'utf8').digest();
	return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

/** A random WebAuthn user handle (64 bytes max per spec; 32 is plenty), base64url. */
export function generateUserHandle(): string {
	return randomBytes(32).toString('base64url');
}
