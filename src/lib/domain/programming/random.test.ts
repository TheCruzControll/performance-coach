/**
 * random.ts: the hashes and the seeded generator a program's reproducibility rests on. Each is
 * checked against a plain reference written independently here (BigInt FNV-1a, the published
 * mulberry32), so a change to either algorithm, which would change every program, fails.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { OwnedExercise } from './input';
import {
	canonicalJson,
	catalogueDigest,
	compareText,
	exerciseContent,
	fnv1a64,
	seededRandom
} from './random';

/** FNV-1a 64 the textbook way, with BigInt. */
function referenceFnv(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, '0');
}

/** mulberry32 as published (bryc), with its own state handling. */
function referenceMulberry(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('fnv1a64', () => {
	it('gives the published FNV-1a 64 test vectors', () => {
		expect(fnv1a64('')).toBe('cbf29ce484222325');
		expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
		expect(fnv1a64('foobar')).toBe('85944171f73967e8');
	});

	it('hashes UTF-8 bytes, as the BigInt reference does', () => {
		for (const text of ['Muay Thai → 90 min', 'Ünïcödé', '🥊🏃', 'x'.repeat(5000)]) {
			expect(fnv1a64(text)).toBe(referenceFnv(text));
		}
	});
});

describe('canonicalJson', () => {
	it('sorts object keys at every depth, keeps list order and skips undefined fields', () => {
		const a = { b: 1, a: { d: [3, 1], c: 'x' }, e: undefined };
		const b = { a: { c: 'x', d: [3, 1] }, b: 1 };
		expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
		expect(canonicalJson(b)).toBe(canonicalJson(a));
		expect(canonicalJson({ list: [1, 3] })).not.toBe(canonicalJson({ list: [3, 1] }));
	});

	it('refuses anything that is not plain data, rather than hash it as {} or null', () => {
		for (const value of [new Date(0), new Map(), NaN, Infinity, () => 1, [undefined], 1n]) {
			expect(() => canonicalJson({ value })).toThrow(TypeError);
		}
	});
});

describe('compareText', () => {
	it('orders by code unit, the same in every locale', () => {
		expect(['b', 'B', 'a', 'é', 'A', 'e'].sort(compareText)).toEqual([
			'A',
			'B',
			'a',
			'b',
			'e',
			'é'
		]);
		expect(compareText('x', 'x')).toBe(0);
	});
});

describe('catalogueDigest', () => {
	const own: OwnedExercise = {
		id: '00000000-0000-4000-8000-000000000009',
		...exerciseContent(CATALOGUE[0]!),
		name: 'Sandbag shouldering'
	};
	const base = catalogueDigest(CATALOGUE, [own]);

	it('depends on the content, not on the order of either list', () => {
		expect(catalogueDigest([...CATALOGUE].reverse(), [own])).toBe(base);
		const other = { ...own, id: '00000000-0000-4000-8000-000000000010' };
		expect(catalogueDigest(CATALOGUE, [other, own])).toBe(catalogueDigest(CATALOGUE, [own, other]));
	});

	it('ignores what a stored row adds to an exercise: timestamps, retirement, a null key', () => {
		const row = { ...own, key: null, retiredAt: null, createdAt: new Date(), ownerId: 'x' };
		expect(catalogueDigest(CATALOGUE, [row])).toBe(base);
	});

	it('changes with any field of any entry, and with a custom exercise’s id', () => {
		const first = CATALOGUE[0]!;
		const edits: Record<string, unknown>[] = [
			{ name: 'Renamed' },
			{ aliases: ['Something'] },
			{ equipment: ['sled'] },
			{ tags: [] },
			{ skillLevel: 'advanced' },
			{ unilateral: !first.unilateral },
			{ baselineLift: first.baselineLift === null ? 'deadlift' : null },
			{ key: 'renamed_key' }
		];
		for (const edit of edits) {
			const edited = CATALOGUE.map((e) => (e === first ? { ...e, ...edit } : e));
			expect(catalogueDigest(edited, [own]), JSON.stringify(edit)).not.toBe(base);
		}
		expect(catalogueDigest(CATALOGUE.slice(1), [own])).not.toBe(base);
		expect(catalogueDigest(CATALOGUE, [])).not.toBe(base);
		expect(
			catalogueDigest(CATALOGUE, [{ ...own, id: '00000000-0000-4000-8000-000000000011' }])
		).not.toBe(base);
	});
});

describe('seededRandom', () => {
	it('is mulberry32: the same numbers as the published generator', () => {
		for (const seed of [0, 1, 42, 0x7fffffff, 0xffffffff, 123456789]) {
			const ours = seededRandom(seed);
			const reference = referenceMulberry(seed);
			const values = Array.from({ length: 1000 }, () => ours.next());
			expect(values).toEqual(Array.from({ length: 1000 }, reference));
		}
		const pinned = seededRandom(42);
		expect([pinned.next(), pinned.next(), pinned.next()]).toEqual([
			0.6011037519201636, 0.44829055899754167, 0.8524657934904099
		]);
	});

	it('is deterministic per seed, a text seed included, and differs between seeds', () => {
		const run = (seed: number | string) => {
			const random = seededRandom(seed);
			return Array.from({ length: 20 }, () => random.next());
		};
		expect(run(7)).toEqual(run(7));
		expect(run('slot:main_lower')).toEqual(run('slot:main_lower'));
		// A text seed is the low half of its FNV-1a hash: pinned, as every program depends on it.
		expect(run('slot:main_lower')[0]).toBe(0.935562597354874);
		expect(run('slot:main_lower')).not.toEqual(run('slot:main_upper'));
		expect(run(7)).not.toEqual(run(8));
		expect(run(7).every((n) => n >= 0 && n < 1)).toBe(true);
	});

	it('picks and shuffles the same way every time, never changing what it is given', () => {
		const items = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		const shuffled = seededRandom('week-1').shuffle(items);
		expect(shuffled).toEqual(['d', 'h', 'c', 'e', 'f', 'g', 'a', 'b']);
		expect(seededRandom('week-1').shuffle(items)).toEqual(shuffled);
		expect([...shuffled].sort()).toEqual([...items]);
		const picks = (seed: string) => {
			const random = seededRandom(seed);
			return Array.from({ length: 12 }, () => random.pick(items));
		};
		expect(picks('tie')).toEqual(['a', 'h', 'h', 'h', 'a', 'd', 'a', 'c', 'a', 'f', 'h', 'h']);
		expect(picks('tie')).toEqual(picks('tie'));
		expect(() => seededRandom(1).pick([])).toThrow(RangeError);
	});
});
