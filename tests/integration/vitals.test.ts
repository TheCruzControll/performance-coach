import { describe, expect, it } from 'vitest';
import { createWebVitalsRepository } from '../../src/lib/server/db';
import {
	getVitalsSummary,
	InvalidVitalsError,
	recordVitals
} from '../../src/lib/server/services/vitals';
import { withRollback } from './helpers';

const lcp = {
	id: 'v6-1730000000000-1',
	name: 'LCP',
	value: 1234.5,
	delta: 1234.5,
	rating: 'good',
	navigationType: 'navigate',
	path: '/today'
} as const;

describe('web vitals service', () => {
	it('stores a posted metric with request metadata', async () => {
		await withRollback(async (tx) => {
			const written = await recordVitals(
				lcp,
				{ appVersion: '0.1.0+test', userAgent: 'Vitest' },
				{ db: tx }
			);
			expect(written).toBe(1);
			const [row] = await createWebVitalsRepository(tx).recent(1);
			expect(row).toMatchObject({
				metricId: lcp.id,
				name: 'LCP',
				value: 1234.5,
				rating: 'good',
				path: '/today',
				appVersion: '0.1.0+test',
				userAgent: 'Vitest'
			});
		});
	});

	it('de-duplicates re-reports of the same metric instance (latest value wins)', async () => {
		await withRollback(async (tx) => {
			const cls = { ...lcp, id: 'v6-cls-1', name: 'CLS', value: 0.01, rating: 'good' } as const;
			await recordVitals([cls], {}, { db: tx });
			await recordVitals([{ ...cls, value: 0.12, rating: 'needs-improvement' }], {}, { db: tx });
			const rows = (await createWebVitalsRepository(tx).recent(10)).filter(
				(r) => r.metricId === 'v6-cls-1'
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ value: 0.12, rating: 'needs-improvement' });
		});
	});

	it('rejects invalid payloads before touching the database', async () => {
		await expect(recordVitals({ ...lcp, name: 'FID' })).rejects.toBeInstanceOf(InvalidVitalsError);
		await expect(recordVitals({ ...lcp, path: 'https://evil.example' })).rejects.toThrow(
			InvalidVitalsError
		);
		await expect(recordVitals(new Array(21).fill(lcp))).rejects.toThrow(InvalidVitalsError);
		await expect(recordVitals('nope')).rejects.toThrow(InvalidVitalsError);
	});

	it('summarises metrics at p75 per metric', async () => {
		await withRollback(async (tx) => {
			const values = [1000, 2000, 3000, 4000, 5000];
			await recordVitals(
				values.map((value, i) => ({ ...lcp, id: `lcp-${i}`, value })),
				{},
				{ db: tx }
			);
			await recordVitals({ ...lcp, id: 'ttfb-1', name: 'TTFB', value: 120 }, {}, { db: tx });
			const summary = await getVitalsSummary(7, { db: tx });
			expect(summary.map((s) => s.name)).toEqual(['LCP', 'TTFB']);
			expect(summary[0]).toMatchObject({ name: 'LCP', p75: 4000, samples: 5 });
			expect(summary[1]).toMatchObject({ name: 'TTFB', p75: 120, samples: 1 });
		});
	});
});
