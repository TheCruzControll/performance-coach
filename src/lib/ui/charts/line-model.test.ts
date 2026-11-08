import { describe, expect, it } from 'vitest';
import {
	announce,
	END_LABEL_GAP,
	lineModel,
	lineTable,
	MAX_LINE_SERIES,
	pointText,
	readout,
	type LineChartData,
	type LinePoint,
	type LineSeries
} from './line-model.ts';

const slots = (n: number, inProgressLast = false) =>
	Array.from({ length: n }, (_, i) => ({
		tick: `${i + 1} Oct`,
		label: `Week of ${i + 1} Oct`,
		inProgress: inProgressLast && i === n - 1 ? true : undefined
	}));
const p = (value: number, kind?: LinePoint['kind']): LinePoint => ({
	value,
	text: String(value),
	kind
});
const series = (key: string, points: (LinePoint | null)[]): LineSeries => ({
	key,
	label: key,
	token: '--chart-strength',
	points
});
const chart = (s: LineSeries[], extra: Partial<LineChartData> = {}): LineChartData => ({
	title: 'Test',
	slots: slots(s[0]!.points.length),
	series: s,
	unit: 'kg',
	...extra
});
const marksOf = (data: LineChartData) =>
	lineModel(data).marks.map(({ series, index, kind }) => ({ series, index, kind }));
const inPlot = (v: number) => v >= 0 && v <= 100;

describe('lineModel markers', () => {
	it('rings estimated points and diamonds measured ones, on every point that has a kind', () => {
		const data = chart([
			series('Squat', [p(100, 'estimated'), p(105, 'measured'), p(110, 'estimated')])
		]);
		expect(marksOf(data)).toEqual([
			{ series: 0, index: 0, kind: 'estimated' },
			{ series: 0, index: 1, kind: 'measured' },
			{ series: 0, index: 2, kind: 'estimated' }
		]);
		expect(lineModel(data).shapes).toEqual({ estimated: true, measured: true, soFar: false });
	});

	it('marks a plain series only at its end, with the end dot', () => {
		const data = chart([series('Volume', [p(1), p(2), p(3), p(4)])]);
		expect(marksOf(data)).toEqual([{ series: 0, index: 3, kind: 'end' }]);
		expect(lineModel(data).shapes).toEqual({ estimated: false, measured: false, soFar: false });
	});

	it('keeps a kinded end point in its own shape: an estimate never wears the solid dot', () => {
		const data = chart([series('Squat', [p(100), p(110, 'estimated')])]);
		expect(marksOf(data)).toEqual([{ series: 0, index: 1, kind: 'estimated' }]);
	});

	it('draws the week in progress as a dashed ring, whatever its kind, and ends the series before it', () => {
		const data: LineChartData = {
			...chart([series('Sets', [p(10), p(12), p(5, 'estimated')])]),
			slots: slots(3, true)
		};
		const model = lineModel(data);
		expect(marksOf(data)).toEqual([
			{ series: 0, index: 1, kind: 'end' },
			{ series: 0, index: 2, kind: 'so-far' }
		]);
		expect(model.shapes.soFar).toBe(true);
		expect(model.shapes.estimated).toBe(false);
		// The line stops at the last complete week; a link joins the week in progress.
		const x = model.xs;
		expect(model.paths[0]!.line).not.toContain(`${+x[2]!.toFixed(3)} `);
		expect(model.paths[0]!.link).toMatch(
			new RegExp(`^M${+x[1]!.toFixed(3)} .*L${+x[2]!.toFixed(3)} `)
		);
		const ring = model.marks.find((m) => m.kind === 'so-far')!;
		expect(model.soFar).toEqual({ x: ring.left, y: ring.bottom, below: false });
	});

	it('puts one so-far label over the highest ring, under it near the top', () => {
		const data: LineChartData = {
			...chart([series('A', [p(0), p(10)]), series('B', [p(0), p(100)])]),
			slots: slots(2, true)
		};
		const model = lineModel(data);
		expect(model.marks.filter((m) => m.kind === 'so-far')).toHaveLength(2);
		expect(model.soFar).toEqual({ x: model.xs[1], y: 100, below: true });
	});
});

describe('lineModel gaps and a single point', () => {
	it('breaks the line at a gap and dots a point standing alone', () => {
		const data = chart([series('Bodyweight', [p(80), p(81), null, p(82), null, p(83), p(84)])]);
		const model = lineModel(data);
		expect(model.paths[0]!.line.match(/M/g)).toHaveLength(3);
		expect(marksOf(data)).toEqual([
			{ series: 0, index: 3, kind: 'lone' },
			{ series: 0, index: 6, kind: 'end' }
		]);
		expect(model.paths[0]!.link).toBe('');
	});

	it('draws a single point as an end dot mid-plot, with ticks around it', () => {
		const data = chart([series('Deadlift', [p(180)])]);
		const model = lineModel(data);
		expect(model.paths[0]!.line).toBe('M50 50');
		expect(marksOf(data)).toEqual([{ series: 0, index: 0, kind: 'end' }]);
		expect(model.marks[0]).toMatchObject({ left: 50, bottom: 50 });
		expect(model.ticks).toEqual([{ index: 0, minor: false }]);
		expect(model.scale.min).toBeLessThan(180);
		expect(model.scale.max).toBeGreaterThan(180);
	});

	it('draws nothing for a series that is all gaps', () => {
		const data = chart([series('Empty', [null, null, null])]);
		const model = lineModel(data);
		expect(model.paths[0]).toEqual({ line: '', link: '' });
		expect(model.marks).toEqual([]);
		expect(model.soFar).toBeNull();
	});
});

describe('lineModel labels', () => {
	it('has no legend and no end labels for one series', () => {
		const model = lineModel(chart([series('Squat', [p(1), p(2)])]));
		expect(model.legend).toBe(false);
		expect(model.endLabels).toEqual([]);
	});

	it('labels each series at its end, at its value where the labels fit', () => {
		const data = chart([series('Low', [p(0), p(10)]), series('High', [p(0), p(100)])]);
		const model = lineModel(data);
		expect(model.legend).toBe(true);
		expect(model.endLabels).toEqual([
			{ series: 0, x: model.xs[1], y: 10, labelY: 10, leader: null },
			{ series: 1, x: model.xs[1], y: 100, labelY: 100, leader: null }
		]);
	});

	it('moves colliding labels apart and draws a leader to each moved one', () => {
		const data = chart([
			series('A', [p(0), p(50)]),
			series('B', [p(100), p(51)]),
			series('C', [p(0), p(52)]),
			series('D', [p(100), p(53)])
		]);
		const model = lineModel(data);
		const ys = model.endLabels.map((l) => l.labelY).sort((a, b) => a - b);
		ys.slice(1).forEach((y, k) => expect(y - ys[k]!).toBeGreaterThanOrEqual(END_LABEL_GAP - 1e-6));
		const moved = model.endLabels.filter((l) => l.labelY !== l.y);
		expect(moved.length).toBeGreaterThan(0);
		for (const label of model.endLabels) {
			if (label.labelY === label.y) expect(label.leader).toBeNull();
			else expect(label.leader).toMatch(/^M[\d.]+ [\d.]+L100 [\d.]+$/);
		}
		expect(model.endLabels.map((l) => l.series)).toEqual([0, 1, 2, 3]);
	});

	it('labels a series by its last complete point, not the week in progress', () => {
		const data: LineChartData = {
			...chart([series('A', [p(0), p(100), p(0)]), series('B', [p(0), p(0), p(100)])]),
			slots: slots(3, true)
		};
		const [a, b] = lineModel(data).endLabels;
		expect(a).toMatchObject({ x: lineModel(data).xs[1], y: 100 });
		expect(b).toMatchObject({ x: lineModel(data).xs[1], y: 0 });
	});

	it('marks every other tick back from the newest as minor', () => {
		const model = lineModel(
			chart([
				series(
					'A',
					Array.from({ length: 5 }, (_, i) => p(i))
				)
			])
		);
		expect(model.ticks).toEqual([
			{ index: 0, minor: false },
			{ index: 1, minor: true },
			{ index: 2, minor: false },
			{ index: 3, minor: true },
			{ index: 4, minor: false }
		]);
	});

	it('keeps every position inside the plot, a target band and baseline included', () => {
		const data = chart(
			[series('A', [p(-5), p(130), null, p(60)]), series('B', [p(10), p(0), p(1), p(2)])],
			{ target: [10, 20], baseline: 40 }
		);
		const model = lineModel(data);
		for (const m of model.marks) expect([m.left, m.bottom].every(inPlot)).toBe(true);
		for (const l of model.endLabels) expect([l.x, l.y, l.labelY].every(inPlot)).toBe(true);
		expect(model.band).toMatch(/^M0 [\d.]+L100 [\d.]+L100 [\d.]+L0 [\d.]+Z$/);
		expect(model.baseline).toBe(model.scale.at(40));
	});

	it('refuses more series than a line chart takes', () => {
		const five = Array.from({ length: MAX_LINE_SERIES + 1 }, (_, i) => series(`S${i}`, [p(1)]));
		expect(() => lineModel(chart(five))).toThrow(RangeError);
	});
});

describe('the readout, the live region and the table twin', () => {
	const data: LineChartData = {
		...chart([
			series('Squat', [p(140, 'estimated'), p(145, 'measured'), p(120, 'estimated')]),
			series('Bench', [p(100), null, p(90)])
		]),
		slots: slots(3, true)
	};

	it('names the kind in words and every series at a slot, a gap included', () => {
		expect(readout(data, 1)).toEqual({
			heading: 'Week of 2 Oct',
			rows: [
				{ series: 0, label: 'Squat', value: '145 kg', kind: 'measured', cell: '145, measured' },
				{ series: 1, label: 'Bench', value: null, kind: null, cell: null }
			]
		});
		expect(readout(data, 2).heading).toBe('Week of 3 Oct so far');
		expect(announce(data, 1)).toBe('Week of 2 Oct: Squat 145 kg, measured; Bench no data.');
		expect(announce(data, 2)).toBe('Week of 3 Oct so far: Squat 120 kg, estimated; Bench 90 kg.');
	});

	it('holds in the table every cell a tooltip shows, word for word', () => {
		const table = lineTable(data);
		expect(table.columns).toEqual([
			{ label: 'Squat', unit: 'kg' },
			{ label: 'Bench', unit: 'kg' }
		]);
		expect(table.rows.map((r) => [r.label, ...r.values, r.inProgress ?? false])).toEqual([
			['Week of 1 Oct', '140, estimated', '100', false],
			['Week of 2 Oct', '145, measured', null, false],
			['Week of 3 Oct', '120, estimated', '90', true]
		]);
		data.slots.forEach((_, i) =>
			expect(readout(data, i).rows.map((r) => r.cell)).toEqual(table.rows[i]!.values)
		);
		expect(pointText(null)).toBeNull();
	});
});
