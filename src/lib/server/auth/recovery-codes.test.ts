import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	generateRecoveryCode,
	generateRecoveryCodes,
	hashRecoveryCode,
	normalizeRecoveryCode,
	RECOVERY_CODE_BITS,
	RECOVERY_CODE_COUNT,
	RECOVERY_CODE_PATTERN
} from './recovery-codes';

const SIX_GROUPS = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

describe('recovery codes', () => {
	it('come in sets of 10 distinct six-group Crockford base32 codes', () => {
		const codes = generateRecoveryCodes();
		expect(RECOVERY_CODE_COUNT).toBe(10);
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(SIX_GROUPS);
			expect(code).toMatch(RECOVERY_CODE_PATTERN);
			expect(code).not.toMatch(/[ILOU]/); // never ambiguous on paper
		}
	});

	it('carry at least 112 bits (ASVS 2.6.2): 24 symbols each, unique across 10,000', () => {
		expect(RECOVERY_CODE_BITS).toBeGreaterThanOrEqual(112);
		expect(RECOVERY_CODE_BITS).toBe(120);
		const many = Array.from({ length: 10_000 }, generateRecoveryCode);
		for (const code of many) {
			expect(code).toMatch(SIX_GROUPS);
			expect(code.replace(/-/g, '')).toHaveLength(24);
		}
		expect(new Set(many).size).toBe(many.length);
		const symbols = new Set(many.join('').replace(/-/g, ''));
		expect(symbols.size).toBe(32);
	});

	it('the pattern describes six groups only', () => {
		expect('7KQ2-M9XD-4TPA-HC3R-W8NB-5FJE').toMatch(RECOVERY_CODE_PATTERN);
		for (const other of [
			'7KQ2-M9XD-4TPA-HC3R',
			'7KQ2-M9XD-4TPA-HC3R-W8NB',
			'7KQ2-M9XD-4TPA-HC3R-W8NB-5FJE-0000',
			'7KQ2M9XD4TPAHC3RW8NB5FJE'
		]) {
			expect(other).not.toMatch(RECOVERY_CODE_PATTERN);
		}
	});

	it('normalise forgiving input of a new code: case, spaces, dashes and look-alikes', () => {
		const canonical = '7KQ2M9XD4TPAHC3RW8NB5FJE';
		expect(normalizeRecoveryCode('7kq2-m9xd-4tpa-hc3r-w8nb-5fje')).toBe(canonical);
		expect(normalizeRecoveryCode(' 7KQ2 M9XD 4TPA HC3R W8NB 5FJE ')).toBe(canonical);
		expect(normalizeRecoveryCode('O1IL-0000-0000-0000-0000-0000')).toBe('011100000000000000000000');
	});

	it('still normalise a legacy 16-character code, the same forgiving way', () => {
		expect(normalizeRecoveryCode('7kq2-m9xd-4tpa-hc3r')).toBe('7KQ2M9XD4TPAHC3R');
		expect(normalizeRecoveryCode(' 7KQ2 M9XD 4TPA HC3R ')).toBe('7KQ2M9XD4TPAHC3R');
		expect(normalizeRecoveryCode('O1IL-0000-0000-0000')).toBe('0111000000000000');
	});

	it('reject anything that cannot be a code, a 20-character one included', () => {
		for (const bad of [
			'',
			'short',
			'7KQ2-M9XD-4TPA',
			'7KQ2-M9XD-4TPA-HC3R-X',
			'7KQ2-M9XD-4TPA-HC3R-W8NB', // 20 characters: neither length
			'7KQ2-M9XD-4TPA-HC3R-W8NB-5FJE-X',
			'7KQ2-M9XD-4TPA-HC3R-W8NB-5FJE-0000',
			'UUUU-UUUU-UUUU-UUUU',
			'UUUU-UUUU-UUUU-UUUU-UUUU-UUUU'
		]) {
			expect(normalizeRecoveryCode(bad), bad).toBeNull();
			expect(hashRecoveryCode(bad), bad).toBeNull();
		}
	});

	it('hash the normalised form, so any accepted spelling finds the same row', () => {
		const code = generateRecoveryCode();
		const hash = hashRecoveryCode(code)!;
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hashRecoveryCode(code.toLowerCase())).toBe(hash);
		expect(hashRecoveryCode(code.replace(/-/g, ' '))).toBe(hash);
		expect(hashRecoveryCode(generateRecoveryCode())).not.toBe(hash);
	});

	it('hash a legacy code exactly as it was stored, so a saved set keeps working', () => {
		const stored = createHash('sha256').update('recovery:7KQ2M9XD4TPAHC3R', 'utf8').digest('hex');
		expect(hashRecoveryCode('7kq2 m9xd 4tpa hc3r')).toBe(stored);
	});
});
