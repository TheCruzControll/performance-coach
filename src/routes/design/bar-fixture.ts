/**
 * /design → Charts: the bar chart's fixtures, each the data a server would send and its frame
 * (title, context, summary and table twin, from barTable so the table holds every value the
 * chart shows). Then the horizontal ones: a week's hard sets by muscle group against their target
 * ranges, and a session's RPE against target. e2e/design-charts.e2e.ts reads the same numbers.
 */
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import {
	barTable,
	divergingTable,
	rangeTable,
	rowsHeight,
	type BarChartData,
	type BarSeries,
	type DivergingBarsData,
	type RangeBarsData
} from '#lib/ui/charts/bar-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import { weeks } from './line-fixture.ts';

const values = (list: (number | null)[]) =>
	list.map((value) => (value === null ? null : { value, text: String(value) }));

const part = (key: DisciplineTone, label: string, list: number[]): BarSeries => ({
	key,
	label,
	token: SERIES_TOKEN[key],
	values: values(list)
});

export interface BarFixture {
	id: string;
	data: BarChartData;
	context: string[];
	summary: string;
	height?: string;
}

export const BAR_FIXTURES: BarFixture[] = [
	{
		id: 'bar-adherence',
		data: {
			title: 'Runs a week',
			unit: 'runs',
			slots: weeks(8, true),
			series: [part('running', 'Done', [3, 4, 3, 0, 4, 4, 3, 1])],
			planned: values([4, 4, 4, 4, 4, 4, 4, 4])
		},
		context: ['Last 8 weeks', 'Against your plan', 'Measured'],
		summary:
			'You ran 21 of 28 planned runs in seven complete weeks; the week of 12 Oct was missed. This week so far: 1 of 4.'
	},
	{
		id: 'bar-stacked',
		height: '16rem',
		data: {
			title: 'Training time by discipline',
			unit: 'min',
			slots: weeks(8, true),
			// Given in no particular order: the chart stacks them in STACK_ORDER.
			series: [
				part('running', 'Running', [90, 100, 110, 60, 120, 120, 130, 45]),
				part('combat', 'Combat', [45, 60, 0, 30, 60, 75, 60, 0]),
				part('strength', 'Strength', [120, 130, 140, 70, 150, 140, 160, 60]),
				part('hypertrophy', 'Hypertrophy', [150, 160, 150, 90, 170, 180, 180, 75]),
				part('conditioning', 'Conditioning', [60, 0, 75, 30, 80, 0, 90, 0])
			],
			planned: values([480, 480, 480, 300, 560, 560, 600, 600])
		},
		context: ['Last 8 weeks', 'Against your plan', 'Measured'],
		summary:
			'Training time ran from 450 to 620 minutes a week, with a lighter week of 12 Oct at 280. This week so far: 180.'
	},
	{
		id: 'bar-target',
		data: {
			title: 'Chest hard sets a week',
			unit: 'sets',
			slots: weeks(8),
			series: [part('hypertrophy', 'Hard sets', [12, 14, 16, 8, 18, 22, 16, 15])],
			target: [10, 20]
		},
		context: ['Last 8 weeks', 'Against a target of 10–20', 'Measured'],
		summary:
			'Six of eight weeks were within the target of 10–20; the week of 12 Oct had 8 and the week of 26 Oct had 22.'
	}
];

/** A frame's props for a fixture: its table twin is barTable of the same data. */
export const barFrame = (fixture: BarFixture) => ({
	title: fixture.data.title,
	context: fixture.context,
	summary: fixture.summary,
	table: barTable(fixture.data)
});

const sets = (
	label: string,
	value: number,
	planned: number,
	range: [number, number] = [10, 20]
) => ({
	key: label.toLowerCase(),
	label,
	value: { value, text: String(value) },
	range,
	planned: { value: planned, text: String(planned) }
});

/** Given unranked: the chart and its table put the largest first, Glutes before Hamstrings. */
const RANGE_DATA: RangeBarsData = {
	title: 'Hard sets by muscle group',
	unit: 'sets',
	token: SERIES_TOKEN.hypertrophy,
	rows: [
		sets('Shoulders', 9, 12),
		sets('Hamstrings', 12, 12),
		sets('Back', 18, 18),
		sets('Quads', 22, 16),
		sets('Glutes', 12, 12),
		sets('Chest', 14, 16)
	]
};

export const RANGE_FIXTURE = {
	id: 'range-bars',
	data: RANGE_DATA,
	height: rowsHeight(RANGE_DATA.rows.length),
	frame: {
		title: RANGE_DATA.title,
		context: ['Week of 9 Nov', 'Against your target ranges', 'Measured'],
		summary:
			'Four of six groups were within 10–20 hard sets; quads were above at 22 and shoulders below at 9.',
		table: rangeTable(RANGE_DATA)
	}
};

const rpe = (label: string, actual: number | null, target = 8) => ({
	key: label.toLowerCase(),
	label,
	actual,
	target
});

const DIVERGING_DATA: DivergingBarsData = {
	title: 'RPE against target',
	rows: [
		rpe('Back squat', 8.5),
		rpe('Bench press', 9.5),
		rpe('Romanian deadlift', 7),
		rpe('Pull-up', 8),
		rpe('Leg press', null)
	]
};

export const DIVERGING_FIXTURE = {
	id: 'diverging-bars',
	data: DIVERGING_DATA,
	height: rowsHeight(DIVERGING_DATA.rows.length),
	frame: {
		title: DIVERGING_DATA.title,
		context: ['Upper and lower, 12 Nov', 'Against target RPE', 'Measured'],
		summary:
			'Bench press felt 1.5 harder than planned and the Romanian deadlift 1 easier; squat and pull-ups were on target.',
		table: divergingTable(DIVERGING_DATA)
	}
};
