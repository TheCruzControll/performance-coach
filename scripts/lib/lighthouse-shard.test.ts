/**
 * The --shard option of scripts/lighthouse.ts: CI's Lighthouse shards between them audit every
 * route exactly once, whatever routes later slices add.
 */
import { describe, expect, it } from 'vitest';
import { parseShard, shardReportDir, shardUrls } from './lighthouse-shard.ts';

/** Today's audited screens in CI: the default routes, then the seeded program screens. */
const TODAY = [
	'/',
	'/today · build card',
	'/train',
	'/progress',
	'/coach',
	'/profile',
	'/profile/security',
	'/today · program',
	'/train · program',
	'/train/session/[key]',
	'/train/history'
];

describe('parseShard', () => {
	it('reads i/N', () => {
		expect(parseShard('1/1')).toEqual({ index: 1, count: 1 });
		expect(parseShard('2/2')).toEqual({ index: 2, count: 2 });
		expect(parseShard(' 3/12 ')).toEqual({ index: 3, count: 12 });
	});

	it.each(['0/2', '3/2', 'x', '', '1/0', '1', '1/2/3', '-1/2', '1.5/2', '1/ 2x'])(
		'refuses %j',
		(text) => {
			expect(() => parseShard(text)).toThrow(/--shard/);
		}
	);
});

describe('shardUrls', () => {
	it('1/1 is the whole list, in order', () => {
		expect(shardUrls(TODAY, 1, 1)).toEqual(TODAY);
	});

	it.each([1, 2, 3, 4, 5])('puts every URL in exactly one of %i shards, in order', (n) => {
		const shards = Array.from({ length: n }, (_, i) => shardUrls(TODAY, i + 1, n));
		expect(shards.flat().sort()).toEqual([...TODAY].sort());
		for (const shard of shards) {
			expect(shard).toEqual(TODAY.filter((url) => shard.includes(url)));
		}
	});

	it('sends the k-th URL to shard (k mod n) + 1, so shards differ in size by at most one', () => {
		expect(shardUrls(TODAY, 1, 2)).toEqual([
			'/',
			'/train',
			'/coach',
			'/profile/security',
			'/train · program',
			'/train/history'
		]);
		expect(shardUrls(TODAY, 2, 2)).toEqual([
			'/today · build card',
			'/progress',
			'/profile',
			'/today · program',
			'/train/session/[key]'
		]);
	});

	it('leaves a shard empty when there are more shards than URLs', () => {
		expect(shardUrls(['/'], 2, 3)).toEqual([]);
	});

	it('refuses a shard outside 1..n', () => {
		expect(() => shardUrls(TODAY, 0, 2)).toThrow(/--shard/);
		expect(() => shardUrls(TODAY, 3, 2)).toThrow(/--shard/);
	});
});

describe('shardReportDir', () => {
	it("keeps today's directory for a single shard", () => {
		expect(shardReportDir('lighthouse-reports', 'mobile', { index: 1, count: 1 })).toBe(
			'lighthouse-reports'
		);
	});

	it('gives each shard of a form factor a directory of its own', () => {
		expect(shardReportDir('lighthouse-reports', 'mobile', { index: 2, count: 2 })).toBe(
			'lighthouse-reports/mobile/shard-2'
		);
		expect(shardReportDir('lighthouse-reports/desktop', 'desktop', { index: 1, count: 2 })).toBe(
			'lighthouse-reports/desktop/shard-1'
		);
	});
});
