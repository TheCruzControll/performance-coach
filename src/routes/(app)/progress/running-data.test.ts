/**
 * Progress → Running's shaping (running-data.ts) on a hand-built running dashboard, and the load
 * reading the running service for ?view=running: weekly mileage in the profile's unit with the
 * plan outlined by week, pace small multiples in minutes per km or mile (lower faster), long-run
 * jumps named, best efforts and reported races labelled and dated, heart rate or its hint, and
 * the stage a new runner sees.
 */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { MetricId } from '#lib/domain/analytics/metrics.ts';
import { periodWindow, trendWindow, type Period } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import type {
	MileageWeek,
	RunningDashboard,
	ShownEffort
} from '#lib/server/services/analytics/running.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { loadProgress, type ProgressRequest } from './load.ts';
import { HR_HINT, runningData } from './running-data.ts';
import RunningTrends from './RunningTrends.svelte';
import RunningView from './RunningView.svelte';

/** A Wednesday: Monday to Wednesday are the week in progress. */
const TODAY = '2026-11-04';
const FIRST = '2026-01-05';
const MILE = 1609.344;

const addWeeks = (monday: string, n: number) =>
	new Date(Date.parse(`${monday}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);

const rising = { verdict: 'real_trend', direction: 'up', good: true, n: 12 } as TrendResult;
const faster = { verdict: 'real_trend', direction: 'down', good: true, n: 12 } as TrendResult;

function build(period: Period = '12w', first = FIRST) {
	const window = periodWindow(TODAY, period, first);
	const from = window.weeks!.from;
	const count = window.weeks!.count;
	/** The period's complete weeks, then this week, flagged. */
	const points = (values: (number | null)[]): SeriesPoint[] =>
		values.map((value, i) => ({
			at: addWeeks(from, i),
			value,
			inProgress: i === values.length - 1
		}));
	const trend = (metric: MetricId, result = rising) => ({
		metric,
		window: trendWindow(window),
		result
	});
	const kpi = (metric: MetricId, value: number | null, previous: number | null) => ({
		metric,
		value,
		previous,
		delta: value !== null && previous !== null ? value - previous : null,
		pct: null,
		change: value !== null && previous !== null ? ('better' as const) : null,
		words: ''
	});
	return { window, count, points, trend, kpi };
}

/** Twelve weeks of 16 km and a plan of 20 km, 3 runs a week, the profile in miles. */
function dashboard(parts: Partial<RunningDashboard> = {}, period: Period = '12w', first = FIRST) {
	const { window, count, points, trend, kpi } = build(period, first);
	const metres = [...Array(count).fill(16_000), 8_000];
	const week = (i: number): MileageWeek => ({
		weekStart: addWeeks(window.weeks!.from, i),
		inProgress: i === count,
		distance: { text: '', value: metres[i]! },
		runs: 3,
		longest: { text: '', value: 10_000 },
		planned: i === 2 ? null : { text: '', value: 20_000 },
		plannedByTime: 0
	});
	const effort = (parts: Partial<ShownEffort>): ShownEffort => ({
		id: 'w-1',
		label: 'best_effort',
		kind: 'measured',
		on: new Date('2026-10-04T15:00:00Z'),
		day: '2026-10-04',
		distanceMetres: 10_000,
		durationSeconds: 3300,
		paceSecondsPerKm: 330,
		eventName: null,
		pace: { text: '8:51 /mi', value: 330 },
		time: '55:00',
		...parts
	});
	const board: RunningDashboard = {
		period,
		window,
		trendWindow: trendWindow(window),
		units: { weight: 'lb', distance: 'mi' },
		mileage: {
			about: null as never,
			weeks: Array.from({ length: count }, (_, i) => week(i)),
			inProgress: week(count),
			points: points(metres),
			mean: { text: '9.9 mi', value: 16_000 },
			longestRun: { text: '6.2 mi', value: 10_000 },
			kpi: kpi('mileage', 16_000, 14_000),
			soFar: { metric: 'mileage', value: 8_000, lastWeek: 6_000, text: '' },
			trend: trend('mileage')
		},
		pace: [
			{
				sessionType: 'tempo_run',
				about: null,
				period: { text: '7:43 /mi', value: 288 },
				points: points([...Array(count - 1).fill(300), 288, null]),
				kpi: kpi('pace_tempo', 288, 300),
				trend: trend('pace_tempo', faster)
			},
			{
				sessionType: 'recovery_run',
				about: null,
				period: null,
				points: points([...Array(count).fill(null), 360]),
				kpi: null,
				trend: null
			}
		],
		longRuns: {
			about: null as never,
			weeks: [
				{
					...{ weekStart: addWeeks(window.weeks!.from, 4), inProgress: false, run: null },
					...{ found: 'long_run_session', previousMetres: 12_000, changePct: 16.7, jump: true },
					distance: { text: '8.7 mi', value: 14_000 }
				},
				{
					...{ weekStart: addWeeks(window.weeks!.from, 5), inProgress: false, run: null },
					...{ found: 'long_run_session', previousMetres: 14_000, changePct: 7.1, jump: false },
					distance: { text: '9.3 mi', value: 15_000 }
				}
			],
			points: points([...Array(count).fill(12_000), null]),
			trend: trend('long_run')
		},
		efforts: [
			{
				...{ distance: '5k', label: '5 km', metres: 5000, best: null, efforts: [] },
				reported: []
			},
			{
				...{ distance: '10k', label: '10 km', metres: 10_000 },
				best: effort({}),
				efforts: [effort({}), effort({ id: 'w-2', label: 'effort', durationSeconds: 3400 })],
				reported: [
					effort({
						...{ id: 'race-1', label: 'reported', kind: 'reported', on: null, day: null },
						...{ eventName: 'Riverside 10K', durationSeconds: 2880, time: '48:00' }
					})
				]
			}
		],
		frequency: {
			...{ runs: 36, perWeek: 3, byType: {}, inProgress: 1 },
			about: null as never,
			points: points([...Array(count).fill(3), 1]),
			kpi: kpi('run_frequency', 3, 3),
			trend: trend('run_frequency')
		},
		heartRate: {
			tracked: true,
			text: 'Average heart rate by run type, from the runs that carry one',
			byType: [
				{ sessionType: 'long_run', tracked: 8, availability: { ready: true }, avgHr: 146.4 },
				{
					sessionType: 'tempo_run',
					tracked: 2,
					availability: { ready: false, have: 2, need: 4, unit: 'runs' },
					avgHr: null
				}
			]
		},
		...parts
	};
	return board;
}

describe('runningData', () => {
	it('charts weekly mileage in the profile’s unit, each week’s plan outlined, this week so far last', () => {
		const r = runningData(dashboard());
		const { data, table } = r.mileage.chart;
		expect(data.unit).toBe('mi');
		expect(data.series[0]!.values[0]).toEqual({ value: 9.9, text: '9.9' });
		expect(data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(data.planned).toHaveLength(13);
		expect(data.planned![0]).toEqual({ value: 12.4, text: '12.4' });
		expect(data.planned![2]).toBeNull();
		expect(table.columns.map((c) => c.label)).toEqual(['Distance', 'Planned']);
		expect(r.mileage.tile).toMatchObject({
			label: 'Weekly distance',
			value: `${(16_000 / MILE).toFixed(1)} mi`,
			canonical: 16_000,
			delta: { against: 'the 12 weeks before' }
		});
		expect(r.mileage.tile.soFar).toMatchObject({ value: '5 mi', lastWeek: '3.7 mi' });
		expect(r.mileage.chart.context).toContain('Planned outlined');
	});

	it('leaves the plan out of a monthly chart, where no single plan fits a column', () => {
		// Over two years of 'all' the chart goes by month.
		const r = runningData(dashboard({}, 'all', '2023-01-02'));
		expect(r.mileage.chart.data.title).toBe('Distance by month');
		expect(r.mileage.chart.data.planned).toBeUndefined();
		expect(r.mileage.chart.context).not.toContain('Planned outlined');
		expect([r.longRuns.chart.data.title, r.frequency.title]).toEqual([
			'Long run by month',
			'Runs per month'
		]);
	});

	it('draws each run type’s pace in minutes per mile, lower faster, with its verdict', () => {
		const r = runningData(dashboard());
		expect(r.pace.axis).toBe('min/mi (lower is faster)');
		const [tempo, recovery] = r.pace.types;
		expect(tempo).toMatchObject({
			id: 'tempo_run',
			label: 'Tempo run',
			pace: { text: '7:43 /mi', value: 288 },
			verdict: { verdict: 'real_trend', direction: 'down', good: true }
		});
		const first = tempo!.chart.data.series[0]!.points[0]!;
		expect(first.value).toBeCloseTo((300 * MILE) / 1000 / 60, 4);
		expect(first.text).toBe('8:03');
		expect(tempo!.chart.data.unit).toBe('min/mi');
		expect(tempo!.chart.context).toContain('min/mi (lower is faster)');
		expect(tempo!.chart.summary).toBe('From 8:03 /mi to 7:43 /mi.');
		// A type no pace metric judges is drawn and never given a verdict.
		expect(recovery).toMatchObject({ id: 'recovery_run', verdict: null, pace: null });
		expect(recovery!.chart.summary).toBe('Only this week so far.');
	});

	it('names every long-run jump over 10 % and the longest run', () => {
		const r = runningData(dashboard());
		expect(r.longRuns.jumps).toEqual([
			'Week of 7 Sep: 8.7 mi, 16.7 % longer than the long run before'
		]);
		expect(r.longRuns.longest).toEqual({ text: '6.2 mi', value: 10_000 });
		expect(r.longRuns.chart.data.series[0]!.points[0]).toMatchObject({
			value: 7.5,
			kind: 'measured'
		});
		expect(r.longRuns.chart.summary).toBe('1 jump over 10 %.');
	});

	it('lists each distance’s best effort and its reported races, labelled and dated', () => {
		const r = runningData(dashboard());
		expect(r.efforts.map((e) => [e.title, e.label, e.subtitle, e.seconds, e.time])).toEqual([
			['10 km · Best effort', 'Best effort', 'Sun 4 Oct · 8:51 /mi', 3300, '55:00'],
			['10 km · Reported', 'Reported', 'Undated · 8:51 /mi · Riverside 10K', 2880, '48:00']
		]);
	});

	it('gives heart rate by type when tracked, else a one-line hint', () => {
		expect(runningData(dashboard()).heartRate.rows).toEqual([
			{ label: 'Long run', value: '146 bpm' },
			{ label: 'Tempo run', value: 'Available after 4 runs · 2 so far' }
		]);
		const untracked = runningData(
			dashboard({ heartRate: { tracked: false, text: 'Not tracked', byType: [] } })
		).heartRate;
		expect(untracked).toEqual({ tracked: false, text: `Not tracked: ${HR_HINT}`, rows: [] });
	});

	it('is a first week with only this week run, and new with nothing', () => {
		const base = dashboard();
		const { points } = build();
		const quiet = (runs: number, last: number) =>
			dashboard({
				mileage: {
					...base.mileage,
					points: points([...Array(12).fill(0), last]),
					inProgress: { ...base.mileage.inProgress, runs }
				}
			});
		expect(runningData(dashboard()).stage).toBe('history');
		expect(runningData(quiet(1, 5000)).stage).toBe('first_week');
		expect(runningData(quiet(0, 0)).stage).toBe('new');
	});

	it('lists a reported race for a new owner with no run yet', () => {
		const base = dashboard();
		const { points } = build();
		const r = runningData(
			dashboard({
				mileage: {
					...base.mileage,
					points: points(Array(13).fill(0)),
					inProgress: { ...base.mileage.inProgress, runs: 0 }
				},
				efforts: base.efforts.map((x) => ({ ...x, best: null, efforts: [] }))
			})
		);
		expect(r.stage).toBe('new');
		const served = render(RunningTrends, { props: { running: r } }).body;
		expect(served).toContain('data-testid="running-efforts"');
		expect(served).toContain('10 km · Reported');
		// The view keeps the intro in its own chunk, and the trends' markup the server sent.
		const html = render(RunningView, { props: { running: r, served } }).body;
		expect(html).toContain('Your running trends start with your first run');
		expect(html).toContain('10 km · Reported');
	});
});

describe('loadProgress, the Running view', () => {
	const request: ProgressRequest = {
		view: 'running',
		period: '12w',
		origin: { requestId: 'req-1', method: 'GET', path: '/progress', routeId: '/(app)/progress' }
	};
	const db = {} as NonNullable<TrainingDeps['db']>;
	const NOW = new Date('2026-11-04T12:00:00Z');
	const today = vi.fn(async () => TODAY);

	it('reads the running dashboard, not the overview, for the asked period', async () => {
		const running = vi.fn(async () => dashboard());
		const overview = vi.fn();
		const strength = vi.fn();
		const data = await loadProgress('owner-1', request, NOW, {
			...{ db, running, overview, strength, today }
		});
		expect(running).toHaveBeenCalledWith(db, 'owner-1', { period: '12w', today: TODAY });
		expect(overview).not.toHaveBeenCalled();
		expect(strength).not.toHaveBeenCalled();
		expect(data).toMatchObject({ failed: false, view: 'running', period: '12w' });
		expect(
			data.failed === false && data.view === 'running' && data.running.pace.types
		).toHaveLength(2);
	});

	it('records a failed read with its view and fails soft', async () => {
		const record = vi.fn(async () => null);
		const failure = new Error('connection reset');
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			running: async () => {
				throw failure;
			},
			record,
			today
		});
		expect(data).toEqual({ failed: true, view: 'running', period: '12w' });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: failure,
				context: { load: 'progress', view: 'running', period: '12w' }
			}),
			{ db: undefined }
		);
	});
});
