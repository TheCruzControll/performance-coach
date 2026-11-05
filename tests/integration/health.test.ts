import { describe, expect, it } from 'vitest';
import { checkHealth } from '../../src/lib/server/services/health';
import { unreachableDb } from './helpers';

describe('health service', () => {
	it('reports the database up after a real round-trip', async () => {
		const report = await checkHealth({ version: 'test' });
		expect(report).toMatchObject({ ok: true, db: 'up', version: 'test' });
		expect(report.dbLatencyMs).toBeGreaterThanOrEqual(0);
		expect(Date.parse(report.checkedAt)).not.toBeNaN();
	});

	it('reports the database down (without throwing) when it is unreachable', async () => {
		const broken = unreachableDb();
		try {
			const report = await checkHealth({ version: 'test', db: broken.db, timeoutMs: 3_000 });
			expect(report).toMatchObject({ ok: false, db: 'down', dbLatencyMs: null });
		} finally {
			await broken.close();
		}
	});
});
