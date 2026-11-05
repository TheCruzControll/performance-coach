/**
 * Recovery codes: format, generation and normalisation (pure apart from the CSPRNG).
 *
 * A code is 80 random bits written as 16 Crockford base32 characters in four groups,
 * `7KQ2-M9XD-4TPA-HC3R`. Crockford's alphabet drops I, L, O and U, so a code read back from
 * paper cannot be misread, and input is forgiving: case, spaces and dashes are ignored, and the
 * look-alikes O→0, I/L→1 are mapped. 80 bits makes online guessing pointless (and every attempt
 * is rate-limited), so codes are stored as plain SHA-256 hashes of the normalised form.
 */
import { randomBytes } from 'node:crypto';
import { hashToken } from './tokens';

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const GROUPS = 4;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH; // 16 chars × 5 bits = 80 bits

export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

function encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	return out;
}

const group = (raw: string) => raw.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g'))!.join('-');

/** One fresh code in display form (`XXXX-XXXX-XXXX-XXXX`). */
export function generateRecoveryCode(): string {
	return group(encode(randomBytes((CODE_LENGTH * 5) / 8)));
}

/** A full set of distinct codes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
	const codes = new Set<string>();
	while (codes.size < count) codes.add(generateRecoveryCode());
	return [...codes];
}

/**
 * Canonical form of user input, or null when it cannot be a code: upper case, separators
 * removed, Crockford look-alikes mapped, exactly 16 alphabet characters.
 */
export function normalizeRecoveryCode(input: string): string | null {
	const cleaned = input
		.toUpperCase()
		.replace(/[\s\-_.]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
	if (cleaned.length !== CODE_LENGTH) return null;
	for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
	return cleaned;
}

/** What the database stores for a code (hash of the normalised form), or null if malformed. */
export function hashRecoveryCode(input: string): string | null {
	const normalized = normalizeRecoveryCode(input);
	return normalized ? hashToken(`recovery:${normalized}`) : null;
}
