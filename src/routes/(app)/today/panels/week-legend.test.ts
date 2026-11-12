import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STRIP_DOTS, weekLegend } from './week-legend';

const day = (...dots: [tone: string, skipped?: boolean][]) => ({
	dots: dots.map(([tone, skipped = false]) => ({
		tone: tone as 'strength',
		skipped
	}))
});

describe('the week strip’s legend', () => {
	it('names each discipline the week has once, in a fixed order, whatever the days’ order', () => {
		const keys = weekLegend([
			day(['conditioning']),
			day(['combat'], ['strength']),
			day(),
			day(['strength'], ['running'])
		]);
		expect(keys).toEqual([
			{ tone: 'strength', label: 'Strength' },
			{ tone: 'running', label: 'Running' },
			{ tone: 'combat', label: 'Muay Thai' },
			{ tone: 'conditioning', label: 'Conditioning' }
		]);
	});

	it('ends with the skipped ring only when a session was skipped', () => {
		expect(weekLegend([day(['running', true]), day(['running'])])).toEqual([
			{ tone: 'running', label: 'Running' },
			{ tone: null, label: 'Skipped' }
		]);
		expect(weekLegend([day(['hypertrophy'])]).map((k) => k.label)).toEqual(['Hypertrophy']);
	});

	it('is empty for a week with no sessions', () => {
		expect(weekLegend([day(), day()])).toEqual([]);
	});

	it('keys only the dots the strip draws, not a session past its limit', () => {
		const full = day(['running'], ['running'], ['running'], ['running'], ['combat']);
		expect(weekLegend([full]).map((k) => k.label)).toEqual(['Running']);
		const strip = readFileSync(
			new URL('../../../../lib/ui/program/WeekStrip.svelte', import.meta.url),
			'utf8'
		);
		expect(strip).toContain(`const MAX_DOTS = ${STRIP_DOTS};`);
	});
});
