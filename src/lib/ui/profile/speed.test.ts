import { describe, expect, it } from 'vitest';
import type { VitalSummary } from '#lib/domain/vitals.ts';
import { duration, rate, speedAnswer, speedNote, speedRows } from './speed';

const vital = (
	name: VitalSummary['name'],
	p75: number,
	samples = 30,
	start: VitalSummary['start'] = null
): VitalSummary => ({ name, p75, samples, start });

const values = (vitals: VitalSummary[] | null) => speedRows(vitals).map((r) => r.value);

describe('speedRows, speedAnswer and speedNote', () => {
	it('a launch measured: opening the app from the start route, each question rated', () => {
		const vitals = [
			vital('LCP', 2400, 30, { p75: 1180, samples: 12 }),
			vital('INP', 40),
			vital('CLS', 0.01)
		];
		expect(speedRows(vitals)).toEqual([
			{ key: 'open', title: 'Opening the app', value: '1.2 s, good' },
			{ key: 'tap', title: 'Answering a tap', value: '40 ms, good' },
			{ key: 'stable', title: 'Things staying put', value: 'Good' }
		]);
		expect(speedAnswer(vitals)).toBe('Good');
		expect(speedNote(vitals)).toBe('From 12 launches.');
	});

	it('no launch: opening the app from any page load, and the worst rating is the answer', () => {
		const vitals = [vital('LCP', 4200, 27), vital('INP', 250), vital('CLS', 0.3)];
		expect(values(vitals)).toEqual(['4.2 s, poor', '250 ms, needs work', 'Poor']);
		expect(speedAnswer(vitals)).toBe('Poor');
		expect(speedNote(vitals)).toBe('From 27 visits.');
	});

	it('needs work is worse than good', () => {
		expect(speedAnswer([vital('LCP', 1000), vital('INP', 300)])).toBe('Needs work');
	});

	it('nothing measured, or the summary failed', () => {
		for (const vitals of [[], null]) {
			expect(values(vitals)).toEqual(['Not measured yet', 'Not measured yet', 'Not measured yet']);
			expect(speedAnswer(vitals)).toBeUndefined();
			expect(speedNote(vitals)).toBe(
				'Nothing measured yet. It shows here once you’ve used the app for a while.'
			);
		}
	});

	it('one missing question says so, and the answer is the others’', () => {
		const vitals = [vital('INP', 40), vital('CLS', 0.01), vital('TTFB', 900), vital('FCP', 4000)];
		expect(values(vitals)).toEqual(['Not measured yet', '40 ms, good', 'Good']);
		expect(speedAnswer(vitals)).toBe('Good');
	});

	it('one launch, and one visit', () => {
		expect(speedNote([vital('LCP', 1000, 5, { p75: 900, samples: 1 })])).toBe('From 1 launch.');
		expect(speedNote([vital('LCP', 1000, 1)])).toBe('From 1 visit.');
	});
});

describe('duration and rate', () => {
	it('milliseconds below a second, seconds to a tenth from one', () => {
		expect(duration(999)).toBe('999 ms');
		expect(duration(1000)).toBe('1.0 s');
		expect(duration(999.6)).toBe('1.0 s');
		expect(duration(40.4)).toBe('40 ms');
	});

	it('rates at the Core Web Vitals thresholds, each limit inclusive', () => {
		expect(rate('LCP', 2500)).toBe('good');
		expect(rate('LCP', 2501)).toBe('needs work');
		expect(rate('LCP', 4001)).toBe('poor');
		expect(rate('INP', 200)).toBe('good');
		expect(rate('INP', 500)).toBe('needs work');
		expect(rate('CLS', 0.1)).toBe('good');
		expect(rate('CLS', 0.26)).toBe('poor');
	});
});
