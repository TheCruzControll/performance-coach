/**
 * payloadHash (./proposals.ts): M3's canonical JSON and FNV-1a 64 (programming/random.ts), which
 * this module may not import at runtime. The hash is checked against FNV-1a written the textbook
 * way here, with BigInt, and against the published test vectors M3's random.test.ts also uses.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../tests/fixtures/coach-proposals';
import { canonicalJson, payloadHash } from './proposals';

function referenceFnv(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, '0');
}

describe('payloadHash', () => {
	it('is FNV-1a 64 over the canonical JSON', () => {
		expect(referenceFnv('foobar')).toBe('85944171f73967e8');
		// A string payload's canonical JSON is the quoted string.
		expect(payloadHash('')).toBe(referenceFnv('""'));
		for (const { payload } of Object.values(FIXTURES)) {
			expect(payloadHash(payload)).toBe(referenceFnv(canonicalJson(payload)));
			expect(payloadHash(payload)).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it('does not depend on key order, at any depth', () => {
		const a = { ops: [{ op: 'skip', sessionLineage: 's', reason: 'r' }], z: { b: 1, a: [2, 3] } };
		const b = { z: { a: [2, 3], b: 1 }, ops: [{ reason: 'r', sessionLineage: 's', op: 'skip' }] };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe(
			'{"ops":[{"op":"skip","reason":"r","sessionLineage":"s"}],"z":{"a":[2,3],"b":1}}'
		);
		expect(payloadHash(a)).toBe(payloadHash(b));
	});

	it('changes with any value, array order included, and ignores undefined fields', () => {
		const base = { ops: [1, 2], title: 'x' };
		expect(payloadHash({ ...base, title: 'y' })).not.toBe(payloadHash(base));
		expect(payloadHash({ ...base, ops: [2, 1] })).not.toBe(payloadHash(base));
		expect(payloadHash({ ...base, reason: undefined })).toBe(payloadHash(base));
		expect(payloadHash({ ...base, reason: null })).not.toBe(payloadHash(base));
	});

	it('refuses anything that is not plain data', () => {
		expect(() => payloadHash({ at: new Date(0) })).toThrow(TypeError);
		expect(() => payloadHash({ n: Number.NaN })).toThrow(TypeError);
		expect(() => payloadHash(new Map())).toThrow(TypeError);
	});
});
