import { describe, expect, it } from 'vitest';
import {
	barModel,
	barReadout,
	barTable,
	BRACKET_REACH,
	CAP_HEADROOM,
	DIVERGE_MIN_EXTENT,
	divergingModel,
	divergingReadout,
	divergingTable,
	markName,
	ON_TARGET_RPE,
	rangeModel,
	rangeReadout,
	rangeTable,
	rowName,
	rowsHeight,
	stepMark,
	stepRow,
	type BarChartData,
	type BarSeries,
	type DivergingRow,
	type RangeRow
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
		const data = chart([series('strength', [6, 4, 4, 3]), series('hypertrophy', [8, 5, 1, 2])], {
			slots: slots(4, true),
			planned: [v(10), v(12), v(12), v(14)]
		});
		const model = barModel(data);
		expect(model.caps.map(({ slot, text }) => ({ slot, text }))).toEqual([
			{ slot: 0, text: '14' },
			{ slot: 2, text: '5' }
		]);
		expect(model.caps[0]!.bottom).toBeCloseTo(model.scale.at(14), 9);
		expect(model.caps[1]!.bottom).toBeCloseTo(model.scale.at(12), 9);
		expect(model.caps.map((cap) => cap.beforeSoFar)).toEqual([false, true]);
	});

	it('labels only the highest complete stack and the latest, so totals never collide', () => {
		const data = chart(
			[series('strength', [6, 9, 4, 5, 3, 1]), series('running', [2, 3, 2, 4, 3, 1])],
			{ slots: slots(6, true) }
		);
		const model = barModel(data);
		// Slot 1 is the highest (12); slot 4 the latest complete one; slot 5 is so far.
		expect(model.caps.map(({ slot, text }) => ({ slot, text }))).toEqual([
			{ slot: 1, text: '12' },
			{ slot: 4, text: '6' }
		]);
		expect(model.caps.map((cap) => cap.beforeSoFar)).toEqual([false, true]);
	});

	it('gives one label when the latest complete stack is the highest, and the latest of a tie', () => {
		const latest = barModel(chart([series('strength', [2, 3, 8]), series('running', [1, 1, 2])]));
		expect(latest.caps.map((cap) => cap.slot)).toEqual([2]);
		const tie = barModel(
			chart([series('strength', [7, 2, 7, 1]), series('running', [1, 1, 1, 1])])
		);
		expect(tie.caps.map((cap) => cap.slot)).toEqual([3]);
	});

	it('drops the highest stack’s total when it sits right next to the latest, so the two never overlap', () => {
		const next = barModel(
			chart([series('strength', [2, 1, 9, 3]), series('running', [1, 1, 1, 1])])
		);
		expect(next.caps.map((cap) => cap.slot)).toEqual([3]);
		const apart = barModel(
			chart([series('strength', [9, 1, 2, 3]), series('running', [1, 1, 1, 1])])
		);
		expect(apart.caps.map((cap) => cap.slot)).toEqual([0, 3]);
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

const group = (
	label: string,
	value: number | null,
	range: [number, number] = [10, 20],
	planned?: number
): RangeRow => ({
	key: label.toLowerCase(),
	label,
	value: v(value),
	range,
	...(planned === undefined ? {} : { planned: v(planned) })
});
const ranges = (rows: RangeRow[]) => ({
	title: 'Hard sets by muscle group',
	unit: 'sets',
	token: '--chart-hypertrophy' as const,
	rows
});

describe('rangeModel: order', () => {
	it('ranks the groups largest first, equal values by name and missing ones last', () => {
		const data = ranges([
			group('Quads', 12),
			group('Back', 18),
			group('Calves', null),
			group('Chest', 12),
			group('Abs', null),
			group('Biceps', 12)
		]);
		const order = ['Back', 'Biceps', 'Chest', 'Quads', 'Abs', 'Calves'];
		expect(rangeModel(data).marks.map((m) => m.row.label)).toEqual(order);
		// The table twin reads in the chart's order.
		expect(rangeTable(data).rows.map((row) => row.label)).toEqual(order);
	});

	it('names each status in words: below, within (both ends included) and above', () => {
		const data = ranges([
			group('A', 9),
			group('B', 10),
			group('C', 20),
			group('D', 21),
			group('E', null)
		]);
		expect(rangeModel(data).marks.map((m) => [m.row.label, m.status])).toEqual([
			['D', 'above'],
			['C', 'within'],
			['B', 'within'],
			['A', 'below'],
			['E', null]
		]);
		expect(rangeTable(data).rows.map((row) => row.values.at(-1))).toEqual([
			'Above range',
			'Within range',
			'Within range',
			'Below range',
			null
		]);
	});
});

describe('rangeModel: bars, brackets and the planned tick', () => {
	it('draws each bar from zero and its range as a bracket on one shared axis', () => {
		const { marks, ticks } = rangeModel(ranges([group('Chest', 15), group('Back', 5)]));
		// 0–20 on a step of 5.
		expect(ticks.map((t) => t.text)).toEqual(['0', '5', '10', '15', '20']);
		expect(ticks.map((t) => t.at)).toEqual([0, 25, 50, 75, 100]);
		expect(marks.map((m) => m.width)).toEqual([75, 25]);
		for (const m of marks) expect(m.bracket).toEqual({ left: 50, width: 50, open: false });
	});

	it('clips a range reaching far past every value at the axis end, and draws it open', () => {
		// Largest value, plan or low: 6; the axis reaches for highs up to 6 × BRACKET_REACH.
		const { marks, ticks } = rangeModel(
			ranges([group('Calves', 6, [4, 30]), group('Abs', 2, [4, 8])])
		);
		expect(BRACKET_REACH).toBe(1.5);
		expect(ticks.at(-1)!.text).toBe('10');
		const calves = marks.find((m) => m.row.label === 'Calves')!;
		expect(calves.bracket).toEqual({ left: 40, width: 60, open: true });
		expect(calves.width).toBe(60);
		// A range that ends inside the axis stays closed.
		expect(marks.find((m) => m.row.label === 'Abs')!.bracket).toEqual({
			left: 40,
			width: 40,
			open: false
		});
	});

	it('stretches the axis to a high within reach, so its bracket closes', () => {
		const { marks } = rangeModel(ranges([group('Chest', 14, [10, 20])]));
		expect(marks[0]!.bracket.open).toBe(false);
		expect(marks[0]!.bracket.left + marks[0]!.bracket.width).toBe(100);
	});

	it('puts the planned tick at the plan on the same axis, and the plan counts in the axis', () => {
		const { marks, ticks } = rangeModel(
			ranges([group('Chest', 12, [10, 20], 16), group('Back', 8, [10, 20], 30), group('Arms', 4)])
		);
		expect(ticks.at(-1)!.text).toBe('30');
		const tick = (label: string) => marks.find((m) => m.row.label === label)!.tick;
		expect(tick('Chest')).toBeCloseTo((16 / 30) * 100);
		expect(tick('Back')).toBe(100);
		expect(tick('Arms')).toBeNull();
	});

	it('draws nothing for a missing value but keeps its bracket, and says No data', () => {
		const data = ranges([group('Chest', 14), group('Back', null, [10, 20], 12)]);
		const back = rangeModel(data).marks[1]!;
		expect(back.width).toBe(0);
		expect(back.bracket.width).toBeGreaterThan(0);
		expect(rangeReadout(data, 1)).toEqual({
			heading: 'Back',
			rows: [
				{ label: 'Done', value: 'No data' },
				{ label: 'Target', value: '10–20 sets' },
				{ label: 'Planned', value: '12 sets' },
				{ label: 'Status', value: 'No data' }
			]
		});
	});
});

describe('rangeReadout and the table twin', () => {
	it('says what was done, the range, the plan and the status in the table’s words', () => {
		const data = ranges([group('Chest', 22, [10, 20], 18)]);
		expect(rangeTable(data)).toEqual({
			rowHeader: 'Muscle group',
			columns: [
				{ label: 'Done', unit: 'sets' },
				{ label: 'Target', unit: 'sets' },
				{ label: 'Planned', unit: 'sets' },
				{ label: 'Status' }
			],
			rows: [{ label: 'Chest', values: ['22', '10–20', '18', 'Above range'] }]
		});
		expect(rowName(rangeReadout(data, 0))).toBe(
			'Chest. Done 22 sets, Target 10–20 sets, Planned 18 sets, Status Above range'
		);
	});

	it('has no Planned column when nothing was planned', () => {
		const columns = rangeTable(ranges([group('Chest', 12)])).columns.map((c) => c.label);
		expect(columns).toEqual(['Done', 'Target', 'Status']);
	});
});

const lift = (label: string, actual: number | null, target: number | null = 8): DivergingRow => ({
	key: label.toLowerCase(),
	label,
	actual,
	target
});
const diverging = (rows: DivergingRow[]) => ({ title: 'RPE against target', rows });

describe('divergingModel: around zero', () => {
	it('starts every bar at zero in the middle, below it to the left and above it to the right', () => {
		const { zero, marks, ticks } = divergingModel(
			diverging([lift('Squat', 9), lift('Bench', 7), lift('Row', 8)])
		);
		expect(zero).toBe(50);
		expect(ticks.map((t) => t.text)).toEqual(['−2', '−1', '0', '1', '2']);
		expect(ticks.filter((t) => t.zero).map((t) => t.at)).toEqual([50]);
		const [squat, bench, row] = marks;
		expect([squat!.left, squat!.width]).toEqual([50, 25]);
		expect([bench!.left, bench!.width]).toEqual([25, 25]);
		expect([row!.left, row!.width]).toEqual([50, 0]);
	});

	it('keeps the axis symmetric and at least ±DIVERGE_MIN_EXTENT, widening for a bigger miss', () => {
		expect(DIVERGE_MIN_EXTENT).toBe(2);
		const small = divergingModel(diverging([lift('Squat', 8.5)]));
		expect([small.ticks[0]!.text, small.ticks.at(-1)!.text]).toEqual(['−2', '2']);
		const big = divergingModel(diverging([lift('Squat', 5)]));
		expect([big.ticks[0]!.text, big.ticks.at(-1)!.text]).toEqual(['−4', '4']);
		expect(big.zero).toBe(50);
		expect(big.marks[0]!.left).toBeCloseTo(12.5);
	});

	it('maps a difference within ±0.5 to the midpoint, and past it to a pole', () => {
		expect(ON_TARGET_RPE).toBe(0.5);
		const { marks } = divergingModel(
			diverging([
				lift('A', 7.4),
				lift('B', 7.5),
				lift('C', 8),
				lift('D', 8.5),
				lift('E', 8.6),
				lift('F', null),
				lift('G', 8, null)
			])
		);
		expect(marks.map((m) => [m.tone, m.text])).toEqual([
			['below', '−0.6'],
			['zero', '−0.5'],
			['zero', '0'],
			['zero', '+0.5'],
			['above', '+0.6'],
			[null, null],
			[null, null]
		]);
	});

	it('classifies the unrounded difference, so ±0.54 is past the band though it reads ±0.5', () => {
		const { marks } = divergingModel(
			diverging([lift('A', 7.46), lift('B', 8.54), lift('C', 2.2, 1.7), lift('D', 1.7, 2.2)])
		);
		expect(marks.map((m) => [m.tone, m.text])).toEqual([
			['below', '−0.5'],
			['above', '+0.5'],
			['zero', '+0.5'],
			['zero', '−0.5']
		]);
	});

	it('keeps the rows in the order given', () => {
		const { marks } = divergingModel(diverging([lift('Squat', 9), lift('Bench', 6)]));
		expect(marks.map((m) => m.row.label)).toEqual(['Squat', 'Bench']);
	});
});

describe('divergingReadout and the table twin', () => {
	it('says actual, target, the signed difference and its side in words', () => {
		const data = diverging([lift('Squat', 9.5), lift('Bench', null)]);
		expect(divergingTable(data).rows).toEqual([
			{ label: 'Squat', values: ['9.5', '8', '+1.5', 'Harder'] },
			{ label: 'Bench', values: [null, '8', null, null] }
		]);
		expect(rowName(divergingReadout(data, 0))).toBe(
			'Squat. Actual RPE 9.5, Target RPE 8, Difference RPE +1.5, Status Harder'
		);
		expect(divergingReadout(data, 1).rows.map((row) => row.value)).toEqual([
			'No data',
			'RPE 8',
			'No data',
			'No data'
		]);
		expect(divergingTable(diverging([lift('Row', 6.5)])).rows[0]!.values.at(-1)).toBe('Easier');
	});
});

describe('stepRow and rowsHeight', () => {
	it('moves up and down the rows, stops at the ends, and Home and End jump there', () => {
		expect(stepRow(4, 1, 'ArrowDown')).toBe(2);
		expect(stepRow(4, 1, 'ArrowRight')).toBe(2);
		expect(stepRow(4, 1, 'ArrowUp')).toBe(0);
		expect(stepRow(4, 1, 'ArrowLeft')).toBe(0);
		expect(stepRow(4, 0, 'ArrowUp')).toBe(0);
		expect(stepRow(4, 3, 'ArrowDown')).toBe(3);
		expect(stepRow(4, 2, 'Home')).toBe(0);
		expect(stepRow(4, 0, 'End')).toBe(3);
		expect(stepRow(4, 0, 'Enter')).toBeNull();
	});

	it('reserves a row’s room for each row plus the legend and the axis band', () => {
		expect(rowsHeight(5)).toBe('18.25rem');
	});
});
