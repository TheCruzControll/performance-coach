import { describe, expect, it } from 'vitest';
import { STACK_ORDER } from './palette.ts';
import {
	areaPath,
	column,
	endLabels,
	hitBands,
	linePath,
	markers,
	stack,
	type Point
} from './geometry.ts';
import { linearScale } from './scale.ts';

/** Every number in an SVG path, as [x, y] pairs. */
const coordinates = (path: string) =>
	[...path.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
const inPlot = (v: number) => v >= 0 && v <= 100;

describe('linePath', () => {
	it('draws in the 0–100 viewBox, y flipped to run down', () => {
		expect(
			linePath([
				{ x: 0, y: 0 },
				{ x: 50, y: 25 },
				{ x: 100, y: 100 }
			])
		).toBe('M0 100L50 75L100 0');
	});

	it('breaks at a gap instead of bridging it', () => {
		const path = linePath([
			{ x: 10, y: 10 },
			{ x: 30, y: 20 },
			null,
			{ x: 70, y: 40 },
			{ x: 90, y: 50 }
		]);
		expect(path).toBe('M10 90L30 80M70 60L90 50');
		expect(linePath([null, null])).toBe('');
		expect(linePath([{ x: 50, y: 50 }])).toBe('M50 50');
	});

	it('keeps a point outside the plot on its edge', () => {
		expect(
			linePath([
				{ x: -5, y: 120 },
				{ x: 105, y: -3 }
			])
		).toBe('M0 0L100 100');
	});
});

describe('areaPath', () => {
	it('fills down to the baseline, closed, and breaks at a gap', () => {
		const top: (Point | null)[] = [{ x: 0, y: 40 }, { x: 50, y: 60 }, null, { x: 100, y: 20 }];
		expect(areaPath(top)).toBe('M0 60L50 40L50 100L0 100ZM100 80L100 100Z');
	});

	it('fills between two edges, as for a target range', () => {
		const hi = [
			{ x: 0, y: 80 },
			{ x: 100, y: 80 }
		];
		const lo = [{ x: 0, y: 40 }, null];
		expect(
			areaPath(hi, [
				{ x: 0, y: 40 },
				{ x: 100, y: 40 }
			])
		).toBe('M0 20L100 20L100 60L0 60Z');
		expect(areaPath(hi, lo)).toBe('M0 20L0 60Z');
	});
});

describe('columns and stacks', () => {
	const scale = linearScale([0, 30], 'bar'); // 0, 10, 20, 30

	it('stands a column on zero, its height its value', () => {
		expect(column(12.5, 15, scale)).toEqual({ left: 12.5, bottom: 0, height: 50, negative: false });
		expect(column(50, 0, scale)).toBeNull();
		expect(column(50, null, scale)).toBeNull();
	});

	it('hangs a negative column from zero', () => {
		const signed = linearScale([-10, 10], 'bar');
		expect(column(50, -5, signed)).toEqual({ left: 50, bottom: 25, height: 25, negative: true });
	});

	it('stacks parts in the given order, a zero part drawing nothing', () => {
		const segments = stack(
			25,
			{ running: 3, hypertrophy: 9, strength: 6, conditioning: 0, combat: null },
			STACK_ORDER,
			scale
		);
		expect(segments.map((s) => s.key)).toEqual(['strength', 'hypertrophy', 'running']);
		expect(segments.map((s) => [s.bottom, s.height])).toEqual([
			[0, 20],
			[20, 30],
			[50, 10]
		]);
		expect(segments.map((s) => [s.first, s.last])).toEqual([
			[true, false],
			[false, false],
			[false, true]
		]);
		expect(stack(25, { strength: 0 }, STACK_ORDER, scale)).toEqual([]);
		const one = stack(25, { hypertrophy: 4 }, STACK_ORDER, scale);
		expect(one.map((s) => [s.key, s.first, s.last])).toEqual([['hypertrophy', true, true]]);
	});

	it('keeps an overflowing stack inside the plot', () => {
		const segments = stack(110, { strength: 25, hypertrophy: 25 }, STACK_ORDER, scale);
		for (const s of segments) {
			expect(inPlot(s.left)).toBe(true);
			expect(inPlot(s.bottom)).toBe(true);
			expect(inPlot(s.bottom + s.height)).toBe(true);
		}
	});
});

describe('markers', () => {
	it('puts one at each point, skipping gaps, with its value’s index', () => {
		expect(markers([{ x: 10, y: 20 }, null, { x: 90, y: 140 }])).toEqual([
			{ index: 0, left: 10, bottom: 20 },
			{ index: 2, left: 90, bottom: 100 }
		]);
	});
});

describe('endLabels', () => {
	it('leaves labels that do not collide where they are, with no leader', () => {
		const labels = endLabels(
			[
				{ key: 'a', y: 20 },
				{ key: 'b', y: 60 }
			],
			10
		);
		expect(labels).toEqual([
			{ key: 'a', y: 20, labelY: 20, leader: false },
			{ key: 'b', y: 60, labelY: 60, leader: false }
		]);
	});

	it('pushes colliding labels apart, in their order, with leaders, and keeps input order', () => {
		const labels = endLabels(
			[
				{ key: 'top', y: 52 },
				{ key: 'low', y: 50 },
				{ key: 'far', y: 10 }
			],
			8
		);
		expect(labels.map((l) => l.key)).toEqual(['top', 'low', 'far']);
		expect(labels.map((l) => l.labelY)).toEqual([58, 50, 10]);
		expect(labels.map((l) => l.leader)).toEqual([true, false, false]);
	});

	it('pulls labels at the top back inside, and shares the height when they cannot fit', () => {
		const top = endLabels(
			[
				{ key: 'a', y: 99 },
				{ key: 'b', y: 98 }
			],
			10
		);
		expect(top.map((l) => l.labelY)).toEqual([100, 90]);
		const crowded = endLabels(
			Array.from({ length: 6 }, (_, i) => ({ key: `s${i}`, y: 50 })),
			30
		);
		const ys = crowded.map((l) => l.labelY);
		expect(ys).toEqual([0, 20, 40, 60, 80, 100]);
		expect(ys.every(inPlot)).toBe(true);
	});
});

describe('hitBands', () => {
	it('splits the plot halfway between points, edge to edge', () => {
		expect(hitBands([12.5, 37.5, 62.5, 87.5])).toEqual([
			{ left: 0, width: 25, center: 12.5 },
			{ left: 25, width: 25, center: 37.5 },
			{ left: 50, width: 25, center: 62.5 },
			{ left: 75, width: 25, center: 87.5 }
		]);
		expect(hitBands([50])).toEqual([{ left: 0, width: 100, center: 50 }]);
	});
});

describe('every position stays within 0–100 %', () => {
	it('for paths, boxes, labels and bands built from wild values', () => {
		const scale = linearScale([5, 15], 'line');
		const values = [-50, 0, 7, 15, 300, null];
		const points = values.map((v, i) => (v === null ? null : { x: i * 30 - 10, y: scale.at(v) }));
		for (const [x, y] of coordinates(linePath(points) + areaPath(points))) {
			expect(inPlot(x!) && inPlot(y!)).toBe(true);
		}
		for (const m of markers(points)) expect(inPlot(m.left) && inPlot(m.bottom)).toBe(true);
		for (const b of hitBands([-20, 40, 140])) {
			expect(inPlot(b.left) && inPlot(b.left + b.width) && inPlot(b.center)).toBe(true);
		}
		const bars = linearScale([-3, 40], 'bar');
		for (const v of [-3, 40, 1_000]) {
			const c = column(150, v, bars)!;
			expect(inPlot(c.left) && inPlot(c.bottom) && inPlot(c.bottom + c.height)).toBe(true);
		}
		for (const l of endLabels(
			[
				{ key: 'x', y: -40 },
				{ key: 'y', y: 400 }
			],
			10
		)) {
			expect(inPlot(l.y) && inPlot(l.labelY)).toBe(true);
		}
	});
});
