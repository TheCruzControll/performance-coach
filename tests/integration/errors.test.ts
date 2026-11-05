import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId, recordServerError } from '../../src/lib/server/services/errors';
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
