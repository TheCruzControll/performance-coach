import { describe, expect, it } from 'vitest';
import {
	generateRecoveryCode,
	generateRecoveryCodes,
	hashRecoveryCode,
	normalizeRecoveryCode,
	RECOVERY_CODE_COUNT,
	RECOVERY_CODE_PATTERN
} from './recovery-codes';

describe('recovery codes', () => {
	it('come in sets of 10 distinct XXXX-XXXX-XXXX-XXXX Crockford base32 codes', () => {
		const codes = generateRecoveryCodes();
		expect(RECOVERY_CODE_COUNT).toBe(10);
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(RECOVERY_CODE_PATTERN);
			expect(code).not.toMatch(/[ILOU]/); // never ambiguous on paper
		}
	});

	it('carry 80 bits: no collisions across many codes, every symbol used', () => {
		const many = Array.from({ length: 5_000 }, generateRecoveryCode);
		expect(new Set(many).size).toBe(many.length);
		const symbols = new Set(many.join('').replace(/-/g, ''));
		expect(symbols.size).toBe(32);
	});

	it('normalise forgiving input: case, spaces, dashes and look-alikes', () => {
		expect(normalizeRecoveryCode('7kq2-m9xd-4tpa-hc3r')).toBe('7KQ2M9XD4TPAHC3R');
		expect(normalizeRecoveryCode(' 7KQ2 M9XD 4TPA HC3R ')).toBe('7KQ2M9XD4TPAHC3R');
		expect(normalizeRecoveryCode('O1IL-0000-0000-0000')).toBe('0111000000000000');
	});

	it('reject anything that cannot be a code', () => {
		for (const bad of [
			'',
			'short',
			'7KQ2-M9XD-4TPA',
			'7KQ2-M9XD-4TPA-HC3R-X',
			'UUUU-UUUU-UUUU-UUUU'
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
});
