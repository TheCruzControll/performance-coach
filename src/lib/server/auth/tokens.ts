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

/**
 * Clock skew a setup token's expiry tolerates (the minting machine's clock against the
 * server's): a token is refused only once `now` is more than this past its expiry.
 */
export const SETUP_TOKEN_SKEW_MS = 60_000;

/**
 * A setup token: `<expiresAt as base36 Unix seconds>.<43-character random part>`. The
 * configured hash covers the whole string, so the expiry cannot be edited without the hash no
 * longer matching (ASVS 2.3.1). At most 8 base36 digits keeps the expiry a valid Date.
 */
const SETUP_TOKEN_SHAPE = /^([0-9a-z]{1,8})\.[A-Za-z0-9_-]{43}$/;

/** A one-time setup token that expires at `expiresAt` (rounded down to the second). */
export function generateSetupToken(expiresAt: Date): string {
	const seconds = Math.floor(expiresAt.getTime() / 1000);
	if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds >= 36 ** 8) {
		throw new RangeError('A setup token expiry must be a valid time after 1970');
	}
	return `${seconds.toString(36)}.${generateToken()}`;
}

/**
 * The expiry a setup token carries, or null when it is not one: a malformed expiry (not
 * canonical base36, or zero), a missing dot, or the legacy form (the random part alone) are
 * all refused. Says nothing about whether the token is the configured one.
 */
export function parseSetupToken(token: string): { expiresAt: Date } | null {
	const digits = SETUP_TOKEN_SHAPE.exec(token)?.[1];
	if (digits === undefined) return null;
	const seconds = Number.parseInt(digits, 36);
	if (seconds <= 0 || seconds.toString(36) !== digits) return null;
	return { expiresAt: new Date(seconds * 1000) };
}

/** Past its expiry by more than the allowed skew? */
export function setupTokenExpired(expiresAt: Date, now: Date): boolean {
	return now.getTime() > expiresAt.getTime() + SETUP_TOKEN_SKEW_MS;
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
