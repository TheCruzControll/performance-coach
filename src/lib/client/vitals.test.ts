import type { Metric } from 'web-vitals';
import { describe, expect, it } from 'vitest';
import { attributeMetric } from './vitals';
import { noteNavigation } from './visits';

const entry = (startTime: number, value?: number) =>
	({ startTime, value }) as unknown as PerformanceEntry;

const metric = (name: Metric['name'], entries: PerformanceEntry[]) =>
	({ name, entries }) as Pick<Metric, 'name' | 'entries'>;

describe('RUM attribution', () => {
	noteNavigation('/today', '/(app)/today', 0);
	noteNavigation('/train', '/(app)/train', 1_000);
	noteNavigation('/profile', '/(app)/profile', 5_000);

	it('attributes load metrics to the landing page', () => {
		for (const name of ['TTFB', 'FCP', 'LCP'] as const) {
			expect(attributeMetric(metric(name, [entry(400)])).path).toBe('/today');
		}
	});

	it('attributes INP to the screen showing when the interaction started', () => {
		expect(attributeMetric(metric('INP', [entry(2_400)]))).toMatchObject({
			path: '/train',
			route: '/(app)/train'
		});
		expect(attributeMetric(metric('INP', [entry(900)])).path).toBe('/today');
		expect(attributeMetric(metric('INP', [entry(6_000)])).path).toBe('/profile');
	});

	it('attributes CLS to the screen of its largest shift', () => {
		const cls = metric('CLS', [entry(300, 0.01), entry(5_500, 0.2), entry(1_200, 0.05)]);
		expect(attributeMetric(cls).route).toBe('/(app)/profile');
	});
});
