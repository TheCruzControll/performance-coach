/**
 * /design → Charts: one fixture chart drawn with every part of the chart kit (a target band and a
 * planned line in the SVG; stacked columns, markers, ticks, hit areas and the 'so far' week as
 * HTML marks), and the frame props a server would send for it. e2e/design-charts.e2e.ts and
 * ChartFrame.test.ts read the same numbers.
 */
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import type { ChartTableData } from '#lib/ui/charts/table.ts';
import { STACK_ORDER } from '#lib/ui/charts/palette.ts';

export interface FixtureWeek {
	monday: string;
	sets: Partial<Record<DisciplineTone, number>>;
	planned: number;
	inProgress?: boolean;
}

export interface ChartFixture {
	weeks: FixtureWeek[];
	/** The target range of hard sets a week, low and high. */
	target: readonly [number, number];
}

export const CHART_FIXTURE: ChartFixture = {
	weeks: [
		{ monday: '2026-10-05', sets: { strength: 6, hypertrophy: 8, conditioning: 2 }, planned: 16 },
		{ monday: '2026-10-12', sets: { strength: 7, hypertrophy: 9, conditioning: 0 }, planned: 16 },
		{ monday: '2026-10-19', sets: { strength: 8, hypertrophy: 10, conditioning: 2 }, planned: 18 },
		{ monday: '2026-10-26', sets: { strength: 4, hypertrophy: 5, conditioning: 0 }, planned: 10 },
		{ monday: '2026-11-02', sets: { strength: 8, hypertrophy: 11, conditioning: 3 }, planned: 18 },
		{
			monday: '2026-11-09',
			sets: { strength: 3, hypertrophy: 4, conditioning: 0 },
			planned: 18,
			inProgress: true
		}
	],
	target: [10, 20]
};

/** The disciplines the fixture has, in the one stack order. */
export const FIXTURE_SERIES = STACK_ORDER.filter((key) =>
	CHART_FIXTURE.weeks.some((week) => week.sets[key] !== undefined)
);

const SERIES_LABEL: Record<DisciplineTone, string> = {
	strength: 'Strength',
	hypertrophy: 'Hypertrophy',
	conditioning: 'Conditioning',
	combat: 'Combat',
	running: 'Running'
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekOf = (monday: string) =>
	`Week of ${Number(monday.slice(8))} ${MONTHS[Number(monday.slice(5, 7)) - 1]}`;
const total = (week: FixtureWeek) => Object.values(week.sets).reduce((a, b) => a + (b ?? 0), 0);

/** The table twin: every value the plot draws, the planned line included. */
export const FIXTURE_TABLE: ChartTableData = {
	rowHeader: 'Week',
	columns: [
		...FIXTURE_SERIES.map((key) => ({ label: SERIES_LABEL[key], unit: 'sets' })),
		{ label: 'Total', unit: 'sets' },
		{ label: 'Planned', unit: 'sets' }
	],
	rows: CHART_FIXTURE.weeks.map((week) => ({
		label: weekOf(week.monday),
		values: [
			...FIXTURE_SERIES.map((key) => String(week.sets[key] ?? 0)),
			String(total(week)),
			String(week.planned)
		],
		inProgress: week.inProgress
	}))
};

export const FIXTURE_FRAME = {
	title: 'Hard sets a week',
	context: ['Last 6 weeks', 'Against your plan', 'Measured', 'Trend needs 6 complete weeks'],
	summary:
		'Four of five complete weeks had 16 to 22 hard sets, against a target of 10–20; the lighter week of 26 Oct had 9. This week so far: 7.',
	table: FIXTURE_TABLE
};

/** A chart with nothing to draw yet: its availability takes the plot's place. */
export const UNAVAILABLE_FRAME = {
	title: 'Running distance',
	context: ['Last 6 weeks', 'Measured'],
	summary: 'No runs logged in the last 6 weeks.',
	table: {
		rowHeader: 'Week',
		columns: [{ label: 'Distance', unit: 'km' }],
		rows: [{ label: 'Week of 9 Nov', values: [null], inProgress: true }]
	} satisfies ChartTableData
};
