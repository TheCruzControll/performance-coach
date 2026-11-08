import { describe, expect, it } from 'vitest';
import { METRICS, type Metric } from '../../../domain/analytics/metrics';
import { formatCanonical } from '../../../domain/analytics/overview';
import { displayUnits, distance, formatIn, pace, weight, type DisplayUnits } from './format';

const METRIC: DisplayUnits = { weight: 'kg', distance: 'km' };
const IMPERIAL: DisplayUnits = { weight: 'lb', distance: 'mi' };

const withUnit = (unit: Metric['unit']) => Object.values(METRICS).find((m) => m.unit === unit)!;

describe('display strings in the profile units', () => {
	it('shows a weight in kg or lb, keeping the exact kg', () => {
		expect(weight(102.5, METRIC)).toEqual({ text: '102.5 kg', value: 102.5 });
		// 100 kg is 220.462… lb.
		expect(weight(100, IMPERIAL)).toEqual({ text: '220.5 lb', value: 100 });
		expect(weight(6200, METRIC)).toEqual({ text: '6,200 kg', value: 6200 });
	});

	it('shows a distance in km or mi, keeping the exact metres', () => {
		expect(distance(10_000, METRIC)).toEqual({ text: '10 km', value: 10_000 });
		// 8046.72 m is exactly 5 mi; 10 km is 6.2137… mi.
		expect(distance(8046.72, IMPERIAL)).toEqual({ text: '5 mi', value: 8046.72 });
		expect(distance(10_000, IMPERIAL)).toEqual({ text: '6.2 mi', value: 10_000 });
	});

	it('shows a pace per km or per mile, keeping the exact s/km', () => {
		expect(pace(330, METRIC)).toEqual({ text: '5:30 /km', value: 330 });
		// 300 s/km × 1.609344 = 482.8 s/mi.
		expect(pace(300, IMPERIAL)).toEqual({ text: '8:03 /mi', value: 300 });
	});

	it('words a metric in the owner units, and every other unit as the catalogue does', () => {
		const lb = formatIn(IMPERIAL);
		expect(lb(withUnit('kg'), 100, 'value')).toBe('220.5 lb');
		expect(lb(withUnit('m'), 8046.72, 'delta')).toBe('5 mi');
		expect(lb(withUnit('s/km'), 300, 'value')).toBe('8:03 /mi');
		// A pace change of 10 s/km is 16 s/mi.
		expect(lb(withUnit('s/km'), 10, 'delta')).toBe('16 s/mi');
		const kg = formatIn(METRIC);
		expect(kg(withUnit('s/km'), 10, 'delta')).toBe('10 s/km');
		for (const unit of ['sets', 'AU', 'pct', 's'] as const) {
			const metric = withUnit(unit);
			expect(lb(metric, 12, 'value')).toBe(formatCanonical(metric, 12, 'value'));
		}
	});

	it('reads the units from the profile', () => {
		expect(displayUnits({ weightUnit: 'lb', distanceUnit: 'km' })).toEqual({
			weight: 'lb',
			distance: 'km'
		});
	});
});
