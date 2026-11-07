import { describe, expect, it } from 'vitest';
import { GOOD, METRIC_AREAS, METRIC_IDS, METRICS } from './metrics';
import type { Metric } from './metrics';
import { ACWR_CAVEAT } from './workload';

const KINDS = ['measured', 'estimated', 'calculated', 'reported'];
const DIRECTIONS = ['up', 'down', 'none'];
const AVAILABILITY = ['days', 'weeks', 'sessions', 'runs', 'sets', 'points'];
const UNITS = [
	'kg',
	'sets',
	'rpe',
	'm',
	's/km',
	'runs',
	'sessions',
	's',
	'pct',
	'AU',
	'ratio',
	'h',
	'scale'
];
const all = METRIC_IDS.map((id) => METRICS[id]);
const nonEmpty = (text: unknown) => typeof text === 'string' && text.trim().length > 0;

describe('the metric catalogue', () => {
	it('holds exactly the plan’s metrics, by area, in order', () => {
		const byArea = Object.fromEntries(
			METRIC_AREAS.map((area) => [
				area,
				all.filter((metric) => metric.area === area).map((m) => m.id)
			])
		);
		expect(byArea).toEqual({
			strength: [
				'e1rm',
				'top_set',
				'tonnage',
				'hard_sets',
				'group_sets',
				'avg_rpe',
				'rpe_deviation'
			],
			running: [
				'mileage',
				'pace_easy',
				'pace_long',
				'pace_tempo',
				'pace_intervals',
				'long_run',
				'run_frequency'
			],
			general: [
				'sessions',
				'training_time',
				'adherence',
				'srpe_load',
				'acwr',
				'monotony',
				'strain',
				'muay_thai_load'
			],
			recovery: ['sleep', 'soreness', 'energy', 'stress']
		});
		expect(METRIC_IDS).toEqual(Object.values(byArea).flat());
	});

	it.each(all)('$id has every field', (metric: Metric) => {
		expect(Object.keys(metric).sort()).toEqual(
			[
				'area',
				'caveat',
				'caveatAlways',
				'direction',
				'good',
				'id',
				'kind',
				'label',
				'method',
				'minData',
				'mpc',
				'unit'
			].sort()
		);
		expect(METRICS[metric.id].id).toBe(metric.id);
		expect(nonEmpty(metric.label)).toBe(true);
		expect(UNITS).toContain(metric.unit);
		expect(KINDS).toContain(metric.kind);
		expect(DIRECTIONS).toContain(metric.direction);
		expect(metric.minData.need).toBeGreaterThan(0);
		expect(Number.isInteger(metric.minData.need)).toBe(true);
		expect(AVAILABILITY).toContain(metric.minData.unit);
		expect(nonEmpty(metric.good.words)).toBe(true);
		if (metric.good.type === 'bands' || metric.good.type === 'target') {
			for (const level of ['good', 'watch', 'low'] as const)
				expect(nonEmpty(metric.good.levels[level])).toBe(true);
		}
		// One sentence: a capital first, a full stop last, and no sentence break inside.
		expect(metric.method).toMatch(/^[A-Z0-9].*\.$/);
		expect(metric.method).not.toMatch(/[.!?]\s+[A-Z]/);
		expect(metric.caveat === null || nonEmpty(metric.caveat)).toBe(true);
		expect(typeof metric.caveatAlways).toBe('boolean');
	});

	it.each(all)('$id has a positive minimal practical change', ({ mpc }: Metric) => {
		const parts = [mpc.abs, mpc.rel].filter((part) => part !== undefined);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) expect(part).toBeGreaterThan(0);
	});

	it('uses the plan’s minimal practical changes', () => {
		const mpc = (id: keyof typeof METRICS) => METRICS[id].mpc;
		expect(mpc('e1rm')).toEqual({ rel: 0.025 });
		expect(mpc('top_set')).toEqual({ rel: 0.025 });
		for (const id of [
			'tonnage',
			'mileage',
			'long_run',
			'run_frequency',
			'sessions',
			'training_time'
		] as const)
			expect(mpc(id)).toEqual({ rel: 0.1 });
		for (const id of ['pace_easy', 'pace_long', 'pace_tempo', 'pace_intervals'] as const)
			expect(mpc(id)).toEqual({ rel: 0.02 });
		for (const id of ['srpe_load', 'acwr', 'monotony', 'strain', 'muay_thai_load'] as const)
			expect(mpc(id)).toEqual({ rel: 0.15 });
		expect(mpc('adherence')).toEqual({ abs: 10 });
		expect(mpc('hard_sets')).toEqual({ abs: 2 });
		expect(mpc('group_sets')).toEqual({ abs: 2 });
		expect(mpc('sleep')).toEqual({ abs: 0.5 });
		for (const id of ['soreness', 'energy', 'stress', 'avg_rpe', 'rpe_deviation'] as const)
			expect(mpc(id)).toEqual({ abs: 0.5 });
	});

	it('labels the e1RM estimated and a top set measured, and paces lower-is-better', () => {
		expect(METRICS.e1rm.kind).toBe('estimated');
		expect(METRICS.e1rm.caveat).toMatch(/estimate/i);
		expect(METRICS.top_set.kind).toBe('measured');
		for (const id of ['pace_easy', 'pace_long', 'pace_tempo', 'pace_intervals'] as const) {
			expect(METRICS[id].direction).toBe('down');
			expect(METRICS[id].unit).toBe('s/km');
		}
	});

	it('never judges a metric with no better way by its trend', () => {
		for (const metric of all) {
			if (metric.direction === 'none') expect(metric.good.type).not.toBe('trend');
			if (metric.good.type === 'none') expect(metric.direction).toBe('none');
		}
	});

	it('carries the ACWR caveat on the ACWR alone, and its bands are the caveat’s', () => {
		expect(METRICS.acwr.caveat).toBe(ACWR_CAVEAT.text);
		expect(all.filter((metric) => metric.caveatAlways).map((metric) => metric.id)).toEqual([
			'acwr'
		]);
		expect(METRICS.acwr.minData).toEqual({ need: 28, unit: 'days' });
		const rule = METRICS.acwr.good;
		expect(rule.type === 'bands' && rule.good).toEqual(ACWR_CAVEAT.typical);
	});

	it('keeps the good thresholds as named constants', () => {
		const rule = METRICS.adherence.good;
		expect(rule.type === 'bands' && rule.good).toEqual({ from: GOOD.adherencePct.good });
		expect(METRICS.sleep.good.words).toContain(String(GOOD.sleepHours.good));
	});
});
