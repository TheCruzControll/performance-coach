import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId, recordServerError } from '../../src/lib/server/services/errors';
import { webVitals } from '../../src/lib/server/db';
import { unreachableDb, withRollback } from './helpers';

describe('error recording service', () => {
	it('persists an unexpected server error with its request id', async () => {
		await withRollback(async (tx) => {
			const row = await recordServerError(
				{
					error: new Error('kaboom'),
					kind: 'unknown',
					status: 500,
					requestId: 'req-123',
					method: 'GET',
					path: '/api/test-support/error',
					routeId: '/api/test-support/error',
					appVersion: '0.1.0+test'
				},
				{ db: tx }
			);
			expect(row).not.toBeNull();
			const found = await findErrorsByRequestId('req-123', { db: tx });
			expect(found).toHaveLength(1);
			expect(found[0]).toMatchObject({
				kind: 'unknown',
				status: 500,
				message: 'kaboom',
				method: 'GET',
				path: '/api/test-support/error'
			});
			expect(found[0]?.stack).toContain('kaboom');
		});
	});

	it('records a failed query without its parameter values', async () => {
		await withRollback(async (tx) => {
			// A real constraint violation from Drizzle; the nested transaction is a savepoint, so
			// the outer transaction stays usable for recording the error.
			const failure = await tx
				.transaction((sp) =>
					sp.insert(webVitals).values({
						metricId: 'secret-metric-id',
						name: 'FID' as 'LCP',
						value: 1,
						rating: 'good',
						path: '/private/secret-path'
					})
				)
				.catch((err: unknown) => err);
			expect(failure).toBeInstanceOf(Error);

			const row = await recordServerError(
				{ error: failure, kind: 'unknown', status: 500, requestId: 'req-query' },
				{ db: tx }
			);
			expect(row?.message).toMatch(/^Failed query: insert into "web_vitals"/);
			expect(row?.message).toMatch(/params: \[\d+ redacted\]/);
			for (const text of [row?.message, row?.stack, JSON.stringify(row?.context)]) {
				expect(text).not.toContain('secret-metric-id');
				expect(text).not.toContain('/private/secret-path');
			}
			expect(row?.context).toMatchObject({ cause: { code: '23514' } });
		});
	});

	it('never throws when the database is unavailable', async () => {
		const broken = unreachableDb();
		try {
			const row = await recordServerError(
				{ error: 'string error', kind: 'unknown', status: 500 },
				{ db: broken.db }
			);
			expect(row).toBeNull();
		} finally {
			await broken.close();
		}
	});
});
