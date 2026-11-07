/**
 * domain/coach/proposals.ts may not import this service or domain/programming at runtime, so it
 * keeps two copies of theirs. This pins both to the originals, where both are importable.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../../tests/fixtures/coach-proposals';
import { canonicalJson, NEW_PROGRAM_STARTS, payloadHash } from '../../../domain/coach/proposals';
import {
	canonicalJson as programmingCanonicalJson,
	fnv1a64
} from '../../../domain/programming/random';
import { PROGRAM_STARTS } from './start';

describe('the copies proposals.ts keeps', () => {
	it('a new_program starts as a program can', () => {
		expect(NEW_PROGRAM_STARTS).toEqual(PROGRAM_STARTS);
	});

	it('hashes a payload as M3 hashes its fingerprints', () => {
		const values: unknown[] = [
			...Object.values(FIXTURES),
			{ b: [1, 'é', null, true], a: { z: 0.5, y: undefined } },
			'',
			[]
		];
		for (const value of values) {
			expect(canonicalJson(value)).toBe(programmingCanonicalJson(value));
			expect(payloadHash(value)).toBe(fnv1a64(programmingCanonicalJson(value)));
		}
	});
});
