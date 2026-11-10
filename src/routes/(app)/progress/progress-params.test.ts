import { describe, expect, it } from 'vitest';
import { PERIODS } from '#lib/domain/analytics/periods.ts';
import { parseView, progressParams, progressQuery, PROGRESS_VIEWS } from './params.ts';

const params = (query: string) => progressParams(new URLSearchParams(query));

describe('progressParams', () => {
	it('opens on the overview over 12 weeks', () => {
		expect(params('')).toEqual({ view: 'overview', period: '12w' });
	});

	it.each(PERIODS)('reads ?period=%s', (period) => {
		expect(params(`period=${period}`)).toEqual({ view: 'overview', period });
	});

	it.each(PROGRESS_VIEWS)('reads ?view=%s', (view) => {
		expect(params(`view=${view}&period=4w`)).toEqual({ view, period: '4w' });
	});

	it.each([
		['a misspelt period', 'period=12', { period: '12w' }],
		['another case', 'period=4W&view=Overview', { period: '12w', view: 'overview' }],
		['an empty value', 'period=&view=', { period: '12w', view: 'overview' }],
		['an unknown view', 'view=strengthh&period=26w', { period: '26w', view: 'overview' }],
		['an inherited key', 'view=toString&period=constructor', { period: '12w', view: 'overview' }],
		['padding', 'period=%204w', { period: '12w' }]
	])('refuses %s and gives the default', (_name, query, expected) => {
		expect(params(query)).toMatchObject(expected);
	});

	it('takes the first of a repeated parameter', () => {
		expect(params('period=4w&period=52w')).toEqual({ view: 'overview', period: '4w' });
	});

	it('refuses anything but a string', () => {
		expect(parseView(null)).toBe('overview');
		expect(parseView(undefined)).toBe('overview');
	});
});

describe('progressQuery', () => {
	it('leaves the defaults out', () => {
		expect(progressQuery({ view: 'overview', period: '12w' })).toBe('');
	});

	it('names a period other than the default, and reads back the same', () => {
		for (const period of PERIODS) {
			const query = progressQuery({ view: 'overview', period });
			expect(params(query.slice(1))).toEqual({ view: 'overview', period });
		}
		expect(progressQuery({ view: 'overview', period: 'all' })).toBe('?period=all');
	});
});
