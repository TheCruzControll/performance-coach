/**
 * db:explain's page-load measure: warm-ups untimed, the median and p95 of the timed runs, page
 * data serialised as SvelteKit does and gzipped, and the gate at 300 ms and 32 KB gzip.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { parse } from 'devalue';
import { describe, expect, it, vi } from 'vitest';
import {
	kb,
	loadProblems,
	median,
	PAGE_DATA_LIMIT_BYTES,
	PAGE_LIMIT_MS,
	PAGE_TARGET_MS,
	percentile,
	serialise,
	TIMED_RUNS,
	timeLoad,
	WARM_UPS
} from './page-load';

describe('the m6-plan decisions', () => {
	it('targets 150 ms, fails above 300 ms or 32 KB gzip, after 3 warm-ups and 15 timed runs', () => {
		expect([PAGE_TARGET_MS, PAGE_LIMIT_MS, PAGE_DATA_LIMIT_BYTES]).toEqual([150, 300, 32_768]);
		expect([WARM_UPS, TIMED_RUNS]).toEqual([3, 15]);
	});
});

describe('median and percentile', () => {
	it('takes the middle value, or the mean of the two middle ones, whatever the order', () => {
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(() => median([])).toThrow(RangeError);
	});

	it('takes p95 by nearest rank: the 15th of 15 runs and the 19th of 20', () => {
		const fifteen = Array.from({ length: 15 }, (_, i) => 15 - i);
		expect(percentile(fifteen, 95)).toBe(15);
		expect(
			percentile(
				Array.from({ length: 20 }, (_, i) => i + 1),
				95
			)
		).toBe(19);
		expect(percentile([7], 95)).toBe(7);
		expect(percentile([1, 2, 3, 4], 0)).toBe(1);
		expect(() => percentile([], 95)).toThrow(RangeError);
	});
});

describe('serialise', () => {
	it('is devalue’s string, which keeps dates, maps and repeated references, and its gzip size', () => {
		const when = new Date('2026-11-04T07:30:00Z');
		const shared = { kg: 100 };
		const data = { when, byLift: new Map([['squat', shared]]), again: shared };
		const { text, size } = serialise(data);
		const back = parse(text) as typeof data;
		expect(back.when).toEqual(when);
		expect(back.byLift.get('squat')).toBe(back.again);
		expect(size.raw).toBe(Buffer.byteLength(text));
		expect(size.gzip).toBe(gzipSync(text).byteLength);
		expect(gunzipSync(gzipSync(text)).toString()).toBe(text);
	});
});

describe('timeLoad', () => {
	it('runs the warm-ups untimed, then times each timed run with its serialisation', async () => {
		const load = vi.fn(async () => ({ rows: [1, 2, 3] }));
		const now = vi.spyOn(performance, 'now');
		// Each run reads the clock twice: before the load, after its serialisation.
		const clock = [0, 1, 0, 1, 0, 1, 10, 20, 30, 70, 100, 130];
		for (const at of clock) now.mockReturnValueOnce(at);
		const timing = await timeLoad(load, { warmUps: 3, timed: 3 });
		now.mockRestore();
		expect(load).toHaveBeenCalledTimes(6);
		expect(timing.runs).toEqual([10, 40, 30]);
		expect(timing.median).toBe(30);
		expect(timing.p95).toBe(40);
		expect(timing.size).toEqual(serialise({ rows: [1, 2, 3] }).size);
	});

	it('runs 3 warm-ups and 15 timed runs by default', async () => {
		const load = vi.fn(async () => null);
		const timing = await timeLoad(load);
		expect(load).toHaveBeenCalledTimes(18);
		expect(timing.runs).toHaveLength(15);
	});

	it('fails when a load fails, and refuses to time no run', async () => {
		await expect(timeLoad(() => Promise.reject(new Error('read failed')))).rejects.toThrow(
			'read failed'
		);
		await expect(timeLoad(async () => null, { timed: 0 })).rejects.toThrow(RangeError);
	});
});

describe('loadProblems', () => {
	const size = (gzip: number) => ({ raw: gzip * 6, gzip });

	it('passes a median up to 300 ms, the 150 ms target being reported only', () => {
		expect(loadProblems({ median: 151, size: size(1_000) })).toEqual([]);
		expect(loadProblems({ median: PAGE_LIMIT_MS, size: size(1_000) })).toEqual([]);
	});

	it('fails a median above 300 ms', () => {
		expect(loadProblems({ median: 300.4, size: size(1_000) })).toEqual([
			'median 300.4 ms is over 300 ms'
		]);
	});

	it('fails page data above 32 KB gzip, and says both when both fail', () => {
		expect(loadProblems({ median: 20, size: size(PAGE_DATA_LIMIT_BYTES) })).toEqual([]);
		expect(loadProblems({ median: 400, size: size(PAGE_DATA_LIMIT_BYTES + 1) })).toEqual([
			'median 400.0 ms is over 300 ms',
			'page data 32769 B gzip is over 32768 B'
		]);
	});

	it('writes KB of 1,024 B', () => {
		expect(kb(1_536)).toBe('1.5 KB');
	});
});
