/**
 * /design → Charts: the line chart's fixtures, each the data a server would send and its frame
 * (title, context, summary and table twin, from lineTable so the table holds every value the
 * chart shows). e2e/design-charts.e2e.ts reads the same numbers.
 */
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import {
	lineTable,
	type LineChartData,
	type LinePoint,
	type LineSeries,
	type LineSlot
} from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `count` weeks back from the week of 9 Nov 2026, the last one in progress when asked. */
function weeks(count: number, inProgress = false): LineSlot[] {
	return Array.from({ length: count }, (_, i) => {
		const day = new Date(Date.UTC(2026, 10, 9 - 7 * (count - 1 - i)));
		const tick = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
		return {
			tick,
			label: `Week of ${tick}`,
			inProgress: inProgress && i === count - 1 ? true : undefined
		};
	});
}

/** Values to points, one decimal where asked; null is a gap. */
const points = (values: (number | null)[], kind?: (i: number) => LinePoint['kind'], decimals = 0) =>
	values.map((value, i) =>
		value === null ? null : { value, text: value.toFixed(decimals), kind: kind?.(i) }
	);

export interface LineFixture {
	id: string;
	data: LineChartData;
	context: string[];
	summary: string;
	height?: string;
}

/** A series coloured by its discipline's token. */
const line = (
	key: DisciplineTone,
	label: string,
	values: (number | null)[],
	kind?: (i: number) => LinePoint['kind'],
	decimals = 0
): LineSeries => ({ key, label, token: SERIES_TOKEN[key], points: points(values, kind, decimals) });

const chart = (title: string, unit: string, slots: LineSlot[], series: LineSeries[]) => ({
	title,
	unit,
	slots,
	series
});

export const LINE_FIXTURES: LineFixture[] = [
	{
		id: 'line-single',
		data: chart('Running distance', 'km', weeks(8), [
			line('running', 'Distance', [18, 21, 19, 24, 26, 22, 28, 30])
		]),
		context: ['Last 8 weeks', 'Measured'],
		summary: 'Weekly distance rose from 18 km to 30 km over eight weeks.'
	},
	{
		id: 'line-kinds',
		data: chart('Back squat, top strength', 'kg', weeks(8), [
			line(
				'strength',
				'Back squat',
				[132.5, 135, 136, 140, 138.5, 141, 143, 145],
				(i) => (i === 3 || i === 7 ? 'measured' : 'estimated'),
				1
			)
		]),
		context: ['Last 8 weeks', 'Estimated from your sets, measured when tested'],
		summary: 'Your squat went from an estimated 132.5 kg to a tested 145.0 kg.'
	},
	{
		id: 'line-converging',
		height: '15rem',
		data: chart('Hard sets a week by discipline', 'sets', weeks(8), [
			line('strength', 'Strength', [14, 13, 12, 11, 10, 9, 9, 8]),
			line('hypertrophy', 'Hypertrophy', [2, 3, 4, 5, 6, 7, 8, 8]),
			line('conditioning', 'Conditioning', [10, 10, 9, 9, 9, 8, 8, 7]),
			line('combat', 'Combat', [4, 5, 5, 6, 6, 7, 7, 7])
		]),
		context: ['Last 8 weeks', 'Measured'],
		summary: 'The four disciplines converged on 7 to 8 hard sets a week.'
	},
	{
		id: 'line-gaps',
		data: {
			...chart('Bodyweight', 'kg', weeks(8), [
				line(
					'conditioning',
					'Bodyweight',
					[82, 81.6, null, 81.2, null, 80.8, 80.5, 80.4],
					undefined,
					1
				)
			]),
			baseline: 82
		},
		context: ['Last 8 weeks', 'Measured', 'Against 82.0 kg at the start'],
		summary: 'Bodyweight fell from 82.0 kg to 80.4 kg; two weeks have no weigh-in.'
	},
	{
		id: 'line-single-point',
		data: chart('Deadlift, top strength', 'kg', weeks(1), [
			line('strength', 'Deadlift', [180], () => 'estimated')
		]),
		context: ['This block', 'Estimated'],
		summary: 'One week logged so far: an estimated 180 kg.'
	},
	{
		id: 'line-so-far',
		data: {
			...chart('Hard sets a week', 'sets', weeks(6, true), [
				line('hypertrophy', 'Hard sets', [16, 16, 20, 9, 22, 7])
			]),
			target: [10, 20]
		},
		context: ['Last 6 weeks', 'Against a target of 10–20', 'Measured'],
		summary:
			'Four of five complete weeks were within or above the target of 10–20. This week so far: 7.'
	}
];

/** A frame's props for a fixture: its table twin is lineTable of the same data. */
export const lineFrame = (fixture: LineFixture) => ({
	title: fixture.data.title,
	context: fixture.context,
	summary: fixture.summary,
	table: lineTable(fixture.data)
});

/** A line chart with nothing to draw yet: its availability takes the plot's place. */
export const EMPTY_LINE = {
	title: 'Bench press, top strength',
	context: ['Last 8 weeks', 'Estimated'],
	summary: 'No bench press logged in the last 8 weeks.',
	table: lineTable(
		chart('Bench press, top strength', 'kg', weeks(1, true), [
			line('strength', 'Bench press', [null])
		])
	)
};
