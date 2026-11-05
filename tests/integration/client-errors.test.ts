import { describe, expect, it } from 'vitest';
import {
	ClientErrorRateLimited,
	createRateLimiter,
	InvalidClientErrorReport,
	recordClientError
} from '../../src/lib/server/services/client-errors';
import { findErrorsByRequestId } from '../../src/lib/server/services/errors';
import { withRollback } from './helpers';

const report = {
	source: 'unhandledrejection',
	name: 'TypeError',
	message: 'Failed to execute transaction on IDBDatabase',
	stack: 'TypeError: Failed to execute transaction\n    at sync (/_app/immutable/chunks/x.js:1:2)',
	path: '/train',
	route: '/(app)/train',
	version: '0.1.0+abc1234'
} as const;

const unlimited = { take: () => true };

describe('client error reporting service', () => {
	it('stores a browser error as an app_errors row of kind client', async () => {
		await withRollback(async (tx) => {
			await recordClientError(
				report,
				{ requestId: 'req-client-1', userAgent: 'Mozilla/5.0 (iPhone)' },
				{ db: tx, limiter: unlimited }
			);
			const [row] = await findErrorsByRequestId('req-client-1', { db: tx });
			expect(row).toMatchObject({
				kind: 'client',
				status: null,
				path: '/train',
				routeId: '/(app)/train',
				message: 'TypeError: Failed to execute transaction on IDBDatabase',
				stack: report.stack,
				appVersion: '0.1.0+abc1234',
				context: { source: 'unhandledrejection', userAgent: 'Mozilla/5.0 (iPhone)' }
			});
		});
	});

	it('rejects malformed and oversized reports', async () => {
		await withRollback(async (tx) => {
			const deps = { db: tx, limiter: unlimited };
			for (const bad of [
				{},
				{ ...report, source: 'console' },
				{ ...report, path: 'https://evil.example/' },
				{ ...report, message: '' },
				{ ...report, message: 'x'.repeat(1_001) },
				{ ...report, stack: 'y'.repeat(8_001) }
			]) {
				await expect(recordClientError(bad, {}, deps)).rejects.toBeInstanceOf(
					InvalidClientErrorReport
				);
			}
		});
	});

	it('refuses reports beyond the per-instance rate limit', async () => {
		await withRollback(async (tx) => {
			const limiter = createRateLimiter(2, 60_000);
			const deps = { db: tx, limiter };
			await recordClientError(report, {}, deps);
			await recordClientError({ ...report, message: 'second' }, {}, deps);
			await expect(recordClientError({ ...report, message: 'third' }, {}, deps)).rejects.toThrow(
				ClientErrorRateLimited
			);
		});
	});

	it('rate limiter: fixed window resets after the window elapses', () => {
		let t = 0;
		const limiter = createRateLimiter(2, 1_000, () => t);
		expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false]);
		t = 999;
		expect(limiter.take()).toBe(false);
		t = 1_000;
		expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false]);
	});
});
