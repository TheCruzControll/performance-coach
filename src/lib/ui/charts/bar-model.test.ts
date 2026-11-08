import { describe, expect, it } from 'vitest';
import {
	barModel,
	barReadout,
	barTable,
	CAP_HEADROOM,
	markName,
	stepMark,
	type BarChartData,
	type BarSeries
} from './bar-model.ts';
import { STACK_ORDER } from './palette.ts';

const slots = (n: number, inProgressLast = false) =>
	Array.from({ length: n }, (_, i) => ({
		tick: `${i + 1} Oct`,
		label: `Week of ${i + 1} Oct`,
		inProgress: inProgressLast && i === n - 1 ? true : undefined
	}));
const v = (value: number | null) => (value === null ? null : { value, text: String(value) });
const series = (key: string, values: (number | null)[]): BarSeries => ({
	key,
	label: key[0]!.toUpperCase() + key.slice(1),
	token: `--chart-${key}`,
	values: values.map(v)
});
const chart = (s: BarSeries[], extra: Partial<BarChartData> = {}): BarChartData => ({
	title: 'Test',
	slots: slots(s[0]!.values.length),
	series: s,
	unit: 'sets',
	...extra
});
const keysOf = (data: BarChartData, slot: number) => {
	const model = barModel(data);
	return model.marks.filter((m) => m.slot === slot).map((m) => model.series[m.series]!.key);
};

describe('barModel: stacks', () => {
	it('stacks disciplines in STACK_ORDER whatever order they come in', () => {
		const data = chart([
			series('running', [2]),
			series('combat', [3]),
			series('strength', [4]),
			series('conditioning', [1]),
			series('hypertrophy', [5])
		]);
		expect(barModel(data).series.map((s) => s.key)).toEqual([...STACK_ORDER]);
		expect(keysOf(data, 0)).toEqual([...STACK_ORDER]);
		expect(barTable(data).columns.map((c) => c.label)).toEqual([
			'Strength',
			'Hypertrophy',
			'Conditioning',
			'Combat',
			'Running',
			'Total'
		]);
	});

	it('draws nothing for a zero, missing or negative part and leaves no gap for it', () => {
		const data = chart([
			series('strength', [4]),
			series('hypertrophy', [0]),
			series('conditioning', [null]),
			series('combat', [-2]),
			series('running', [6])
		]);
		const model = barModel(data);
		expect(keysOf(data, 0)).toEqual(['strength', 'running']);
		const [low, high] = model.marks;
		expect(low).toMatchObject({ first: true, last: false });
		expect(high).toMatchObject({ first: false, last: true });
		expect(high!.bottom).toBeCloseTo(low!.bottom + low!.height, 9);
		// The total and the scale count the drawn parts only.
		expect(barTable(data).rows[0]!.values.at(-1)).toBe('10');
		expect(high!.bottom + high!.height).toBeCloseTo(model.scale.at(10), 9);
	});

	it('puts each complete stack’s total on its cap, above its planned outline when that is higher', () => {
		const data = chart([series('strength', [6, 4, 3]), series('hypertrophy', [8, 5, 2])], {
			slots: slots(3, true),
			planned: [v(10), v(12), v(14)]
		});
		const model = barModel(data);
		expect(model.caps.map(({ slot, text }) => ({ slot, text }))).toEqual([
			{ slot: 0, text: '14' },
			{ slot: 1, text: '9' }
		]);
		expect(model.caps[0]!.bottom).toBeCloseTo(model.scale.at(14), 9);
		expect(model.caps[1]!.bottom).toBeCloseTo(model.scale.at(12), 9);
		expect(model.caps.map((cap) => cap.beforeSoFar)).toEqual([false, true]);
	});

	it('leaves room over the tallest column for the label on its cap', () => {
		const model = barModel(chart([series('strength', [10]), series('running', [10])]));
		expect(model.scale.max).toBeGreaterThanOrEqual(20 * CAP_HEADROOM);
	});

	it('alternates forced-colors hatches along the stack', () => {
		const model = barModel(
			chart([series('strength', [1]), series('hypertrophy', [1]), series('combat', [1])])
		);
		expect(model.hatches).toEqual(['a', 'b', 'a']);
	});
});

describe('barModel: columns', () => {
	it('stands a column on zero, its rounded end up; a zero value draws nothing', () => {
		const model = barModel(chart([series('running', [12, 0, null, 30])]));
		expect(model.stacked).toBe(false);
		expect(model.marks.map((m) => m.slot)).toEqual([0, 3]);
		for (const mark of model.marks) {
			expect(mark).toMatchObject({ first: true, last: true, negative: false, series: 0 });
			expect(mark.bottom).toBe(model.scale.at(0));
		}
		expect(model.marks[1]!.height).toBeCloseTo(model.scale.at(30) - model.scale.at(0), 9);
		expect(model.caps).toEqual([]);
	});

	it('hangs a negative value below zero, its rounded end down', () => {
		const model = barModel(chart([series('running', [8, -6])]));
		expect(model.scale.min).toBeLessThan(0);
		const zero = model.scale.at(0);
		const [up, down] = model.marks;
		expect(up).toMatchObject({ negative: false, bottom: zero });
		expect(down!.negative).toBe(true);
		expect(down!.bottom).toBeCloseTo(model.scale.at(-6), 9);
		expect(down!.bottom + down!.height).toBeCloseTo(zero, 9);
	});

	it('centres each slot’s column in its band', () => {
		const model = barModel(chart([series('running', [1, 2, 3, 4])]));
		expect(model.band).toBe(25);
		expect(model.xs).toEqual([12.5, 37.5, 62.5, 87.5]);
		expect(model.marks.map((m) => m.left)).toEqual(model.xs);
	});
});

describe('barModel: planned outlines', () => {
	it('outlines each slot’s plan from zero, and makes a missed week reachable through its plan', () => {
		const data = chart([series('running', [3, 0, 4])], { planned: [v(4), v(4), null] });
		const model = barModel(data);
		expect(model.plans.map(({ slot, height }) => ({ slot, height }))).toEqual([
			{ slot: 0, height: model.scale.at(4) },
			{ slot: 1, height: model.scale.at(4) }
		]);
		// Nothing done in week 2: its plan is the mark, so the keyboard and a tap still reach it.
		expect(model.marks.map(({ slot, series }) => ({ slot, series }))).toEqual([
			{ slot: 0, series: 0 },
			{ slot: 1, series: -1 },
			{ slot: 2, series: 0 }
		]);
		expect(model.marks[1]!.height).toBe(model.plans[1]!.height);
		expect(barReadout(data, model, 1)).toEqual({
			heading: 'Week of 2 Oct',
			rows: [
				{ label: 'Running', value: '0 sets', series: 0 },
				{ label: 'Planned', value: '4 sets' }
			]
		});
	});

	it('counts the plan in the scale, so an outline taller than every column still fits', () => {
		const model = barModel(chart([series('running', [2])], { planned: [v(40)] }));
		expect(model.scale.max).toBeGreaterThanOrEqual(40);
		expect(model.plans[0]!.height).toBeLessThan(100);
	});
});

describe('barModel: target band', () => {
	it('draws the band between its low and high, inside the scale', () => {
		const model = barModel(chart([series('hypertrophy', [12, 16])], { target: [10, 20] }));
		expect(model.scale.max).toBeGreaterThanOrEqual(20);
		const top = +(100 - model.scale.at(20)).toFixed(3);
		const bottom = +(100 - model.scale.at(10)).toFixed(3);
		expect(model.targetPath).toBe(`M0 ${top}L100 ${top}L100 ${bottom}L0 ${bottom}Z`);
	});

	it('runs an open-ended band (at least low) to the top of the plot', () => {
		const model = barModel(chart([series('hypertrophy', [12, 16])], { target: [10, null] }));
		const bottom = +(100 - model.scale.at(10)).toFixed(3);
		expect(model.targetPath).toBe(`M0 0L100 0L100 ${bottom}L0 ${bottom}Z`);
	});

	it('clips a band reaching below the axis to the plot', () => {
		const model = barModel(chart([series('running', [-4, 8])], { target: [-20, 4] }));
		const coords = model.targetPath.match(/-?\d+(\.\d+)?/g)!.map(Number);
		for (const c of coords) expect(c).toBeGreaterThanOrEqual(0);
		for (const c of coords) expect(c).toBeLessThanOrEqual(100);
	});

	it('has no band without a target', () => {
		expect(barModel(chart([series('running', [1])])).targetPath).toBe('');
	});
});

describe('barModel: the week in progress', () => {
	it('marks the in-progress column so far, labels it, and gives it no cap total', () => {
		const data = chart([series('strength', [6, 3]), series('hypertrophy', [8, 4])], {
			slots: slots(2, true),
			planned: [v(12), v(16)]
		});
		const model = barModel(data);
		expect(model.marks.map((m) => [m.slot, m.soFar])).toEqual([
			[0, false],
			[0, false],
			[1, true],
			[1, true]
		]);
		expect(model.soFar).toEqual({ slot: 1, left: 75, bottom: model.scale.at(16) });
		expect(model.caps.map((cap) => cap.slot)).toEqual([0]);
		expect(barReadout(data, model, 2).heading).toBe('Week of 2 Oct so far');
		expect(barTable(data).rows[1]!.inProgress).toBe(true);
	});

	it('has no so-far label when every week is complete', () => {
		expect(barModel(chart([series('running', [1, 2])])).soFar).toBeNull();
	});
});

describe('stepMark: roving focus', () => {
	const data = chart(
		[series('strength', [2, null, 3, 1]), series('hypertrophy', [4, null, null, 2])],
		{ planned: [null, null, null, null] }
	);
	const model = barModel(data);
	// marks: 0 s@0, 1 h@0, 2 s@2, 3 s@3, 4 h@3
	it('moves across slots, skipping empty ones, keeping the series when it can', () => {
		expect(model.marks.map((m) => [m.slot, m.series])).toEqual([
			[0, 0],
			[0, 1],
			[2, 0],
			[3, 0],
			[3, 1]
		]);
		expect(stepMark(model, 1, 'ArrowRight')).toBe(2); // no hypertrophy in slot 2: nearest part
		expect(stepMark(model, 2, 'ArrowRight')).toBe(3);
		expect(stepMark(model, 4, 'ArrowLeft')).toBe(2);
		expect(stepMark(model, 1, 'ArrowLeft')).toBe(1); // the first slot: stays
		expect(stepMark(model, 4, 'ArrowRight')).toBe(4);
	});

	it('moves up and down the stack, and Home and End to the ends', () => {
		expect(stepMark(model, 3, 'ArrowUp')).toBe(4);
		expect(stepMark(model, 4, 'ArrowUp')).toBe(4);
		expect(stepMark(model, 4, 'ArrowDown')).toBe(3);
		expect(stepMark(model, 2, 'ArrowDown')).toBe(2);
		expect(stepMark(model, 2, 'Home')).toBe(0);
		expect(stepMark(model, 0, 'End')).toBe(4);
		expect(stepMark(model, 0, 'Enter')).toBeNull();
	});
});

describe('barReadout and the table twin', () => {
	it('says the part, the total and the plan in the table’s words', () => {
		const data = chart([series('strength', [6]), series('hypertrophy', [1250])], {
			planned: [{ value: 1300, text: '1,300' }]
		});
		const model = barModel(data);
		const table = barTable(data);
		expect(table.rows[0]!.values).toEqual(['6', '1250', '1,256', '1,300']);
		expect(barReadout(data, model, 1).rows).toEqual([
			{ label: 'Hypertrophy', value: '1250 sets', series: 1 },
			{ label: 'Total', value: '1,256 sets' },
			{ label: 'Planned', value: '1,300 sets' }
		]);
		expect(markName(data, model, 0)).toBe(
			'Week of 1 Oct. Strength 6 sets, Total 1,256 sets, Planned 1,300 sets'
		);
	});

	it('leaves a slot with no values empty in the table, with no total', () => {
		const data = chart([series('strength', [null, 2]), series('combat', [null, 1])]);
		expect(barTable(data).rows[0]!.values).toEqual([null, null, null]);
		expect(barModel(data).caps.map((cap) => cap.slot)).toEqual([1]);
	});
});
