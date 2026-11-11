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
	path: '/today',
	route: '/(app)/today'
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
				routeId: '/(app)/today',
				appVersion: '0.1.0+test',
				userAgent: 'Vitest'
			});
		});
	});

	it('de-duplicates re-reports of the same metric instance (latest value wins)', async () => {
		await withRollback(async (tx) => {
			const cls = { ...lcp, id: 'v6-cls-1', name: 'CLS', value: 0.01, rating: 'good' } as const;
			await recordVitals([cls], {}, { db: tx });
			// The largest shift now happened on another screen: where it happened moves too.
			await recordVitals(
				[
					{
						...cls,
						value: 0.12,
						rating: 'needs-improvement',
						path: '/train',
						route: '/(app)/train'
					}
				],
				{},
				{ db: tx }
			);
			const rows = (await createWebVitalsRepository(tx).recent(10)).filter(
				(r) => r.metricId === 'v6-cls-1'
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				value: 0.12,
				rating: 'needs-improvement',
				path: '/train',
				routeId: '/(app)/train'
			});
		});
	});

	it('accepts a batch that repeats a metric instance (last report wins)', async () => {
		await withRollback(async (tx) => {
			const cls = { ...lcp, id: 'v6-dup-1', name: 'CLS', value: 0.02, rating: 'good' } as const;
			const written = await recordVitals(
				[cls, { ...lcp, id: 'v6-dup-2' }, { ...cls, value: 0.3, rating: 'poor' }],
				{},
				{ db: tx }
			);
			expect(written).toBe(2);
			const rows = (await createWebVitalsRepository(tx).recent(10)).filter(
				(r) => r.metricId === 'v6-dup-1'
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ name: 'CLS', value: 0.3, rating: 'poor' });
		});
	});

	it('rejects invalid payloads before touching the database', async () => {
		await expect(recordVitals({ ...lcp, name: 'FID' })).rejects.toBeInstanceOf(InvalidVitalsError);
		await expect(recordVitals({ ...lcp, path: 'https://evil.example' })).rejects.toThrow(
			InvalidVitalsError
		);
		await expect(recordVitals(new Array(21).fill(lcp))).rejects.toThrow(InvalidVitalsError);
		await expect(recordVitals('nope')).rejects.toThrow(InvalidVitalsError);
		await expect(recordVitals({ ...lcp, route: 'today' })).rejects.toThrow(InvalidVitalsError);
	});

	it('names the offending field for a single metric and for a batch', async () => {
		const issues = async (payload: unknown) => {
			try {
				await recordVitals(payload);
			} catch (error) {
				if (error instanceof InvalidVitalsError) return error.issues;
				throw error;
			}
			throw new Error('expected InvalidVitalsError');
		};
		const single = await issues({ ...lcp, name: 'FID', value: -1 });
		expect(single.some((i) => i.startsWith('name:'))).toBe(true);
		expect(single.some((i) => i.startsWith('value:'))).toBe(true);
		expect(single.join(' ')).not.toContain('(root)');
		expect(await issues([lcp, { ...lcp, name: 'FID' }])).toEqual([
			expect.stringMatching(/^1\.name:/)
		]);
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
	it('summarises TTFB, LCP and INP on the start route on their own', async () => {
		await withRollback(async (tx) => {
			const on = (route: string, path: string) => ({ ...lcp, route, path });
			const today = on('/(app)/today', '/today');
			const train = on('/(app)/train', '/train');
			// TTFB: cold launches of Today are slow, Train is fast.
			await recordVitals(
				[
					...[2400, 2600, 2800, 3000].map((value, i) => ({
						...today,
						id: `t-today-${i}`,
						name: 'TTFB',
						value
					})),
					...[100, 110, 120, 130].map((value, i) => ({
						...train,
						id: `t-train-${i}`,
						name: 'TTFB',
						value
					})),
					{ ...today, id: 'inp-today', name: 'INP', value: 88 },
					{ ...train, id: 'inp-train', name: 'INP', value: 400 },
					{ ...train, id: 'lcp-train', name: 'LCP', value: 900 },
					{ ...today, id: 'cls-today', name: 'CLS', value: 0.02 }
				],
				{},
				{ db: tx }
			);
			const summary = await getVitalsSummary(7, { db: tx });
			const by = Object.fromEntries(summary.map((s) => [s.name, s]));
			expect(by.TTFB).toMatchObject({ samples: 8, start: { p75: 2850, samples: 4 } });
			expect(by.INP).toMatchObject({ p75: 322, samples: 2, start: { p75: 88, samples: 1 } });
			// LCP only on another route: no start-route figure, rather than a zero.
			expect(by.LCP).toMatchObject({ p75: 900, samples: 1, start: null });
			// CLS is not a start-route metric, even with samples there.
			expect(by.CLS!.start).toBeNull();
		});
	});
});
