/**
 * Progress's load (load.ts) on a hand-built overview: figures in the profile's units, the week in
 * progress kept apart, verdicts as tiles say them, the stage a new owner sees, the headline charts'
 * data, and a failed read recorded and turned into the load-failed state.
 */
import { describe, expect, it, vi } from 'vitest';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import { periodWindow, trendWindow, type Period } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import type { OverviewKpi, ProgressOverview } from '#lib/server/services/analytics/overview.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import type { ReviewPromptView } from '#lib/ui/analytics/review-prompt.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import { loadProgress, overviewData, tileVerdict, type ProgressRequest } from './load.ts';

/** A Wednesday: Monday to Wednesday are the week in progress. */
const TODAY = '2026-11-04';
const FIRST = '2026-01-05';

const figures = {
	method: 'theil-sen',
	n: 12,
	spanDays: 77,
	slopePerWeek: 1,
	change: 11,
	changePct: 10,
	noise: 1,
	minChange: 2
} as unknown as Omit<TrendResult, 'verdict'>;
const rising = { verdict: 'real_trend', direction: 'up', good: true, ...figures } as TrendResult;
const steady = { verdict: 'normal_variation', ...figures } as TrendResult;
const short = {
	verdict: 'insufficient_data',
	needs: { points: 6, days: 35 },
	...figures,
	n: 2
} as TrendResult;

/** Twelve complete weeks ending last Sunday, then this week, flagged. */
function weekly(values: (number | null)[], period: Period = '12w'): SeriesPoint[] {
	const { weeks, inProgress } = periodWindow(TODAY, period, FIRST);
	return values.map((value, i) =>
		i === values.length - 1
			? { at: inProgress.weekStart, value, inProgress: true }
			: { at: addWeeks(weeks!.from, i), value, inProgress: false }
	);
}
const addWeeks = (monday: string, n: number) =>
	new Date(Date.parse(`${monday}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);

function kpi(id: OverviewKpi['metric'], parts: Partial<OverviewKpi> = {}): OverviewKpi {
	return {
		metric: id,
		label: id,
		kind: 'calculated',
		method: `How ${id} is worked out.`,
		caveat: null,
		value: null,
		shown: null,
		comparison: {
			metric: id,
			value: null,
			previous: null,
			delta: null,
			pct: null,
			change: null,
			words: ''
		},
		trend: { metric: id, window: trendWindow(periodWindow(TODAY, '12w', FIRST)), result: short },
		soFar: null,
		series: weekly(Array(13).fill(null)),
		...parts
	};
}

function overview(parts: Partial<ProgressOverview> = {}, period: Period = '12w'): ProgressOverview {
	const window = periodWindow(TODAY, period, FIRST);
	const trend = trendWindow(window);
	return {
		period,
		window,
		trendWindow: trend,
		units: { weight: 'lb', distance: 'mi' },
		headline: {
			verdict: 'not_enough_data',
			text: 'Not enough data yet for a verdict: keep logging'
		},
		verdicts: [],
		kpis: [kpi('tonnage'), kpi('sessions')],
		series: { keyLifts: [], load: [] },
		availability: {} as ProgressOverview['availability'],
		timeline: [
			{
				section: 'prs',
				label: 'Personal records',
				rule: 'After your first strength session',
				on: '2026-11-06',
				ready: false
			},
			{
				section: 'cycle_review',
				label: 'First cycle review',
				rule: 'At the end of your first block',
				on: null,
				ready: false
			}
		],
		...parts
	};
}

/** The overview of an owner with twelve weeks of squats, in kg on the way in. */
function trained(period: Period = '12w') {
	const tonnage = kpi('tonnage', {
		kind: 'calculated',
		value: 12_000,
		shown: '26,455.5 lb',
		comparison: {
			metric: 'tonnage',
			value: 12_000,
			previous: 11_990,
			delta: 10,
			pct: 0.1,
			change: 'better',
			words: ''
		},
		trend: {
			metric: 'tonnage',
			window: trendWindow(periodWindow(TODAY, period, FIRST)),
			result: rising
		},
		soFar: { metric: 'tonnage', value: 100, lastWeek: null, text: '' },
		series: weekly([900, 950, 1000, 1000, 1050, 1000, 1100, 1000, 1000, 1000, 1000, 1000, 100])
	});
	const squat = weekly([
		100,
		102.5,
		null,
		105,
		107.5,
		110,
		112.5,
		115,
		117.5,
		120,
		122.5,
		125,
		150
	]);
	return overview(
		{
			kpis: [tonnage, kpi('sessions')],
			headline: { verdict: 'improving', text: 'Strength improving' },
			verdicts: [
				{
					area: 'strength',
					verdict: 'improving',
					counts: { better: 1, worse: 0, steady: 1, moving: 0, insufficient: 0, judged: 2 },
					sentence: '1 of 2 main lifts trending up',
					window: trendWindow(periodWindow(TODAY, period, FIRST)),
					evidence: [
						{
							subject: 'Back squat',
							call: 'better',
							words: '',
							trend: { ...tonnage.trend, metric: 'e1rm' }
						},
						{
							subject: 'Bench press',
							call: 'steady',
							words: '',
							trend: { ...tonnage.trend, metric: 'e1rm', result: steady }
						}
					]
				}
			],
			series: {
				keyLifts: [
					{ exerciseId: 'squat', name: 'Back squat', points: squat },
					{ exerciseId: 'curl', name: 'Curl', points: weekly([...Array(12).fill(null), 14]) }
				],
				load: [
					{
						group: 'strength',
						points: weekly([300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 90])
					},
					{
						group: 'running',
						points: weekly([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 0])
					}
				]
			}
		},
		period
	);
}

describe('overviewData', () => {
	it("formats every figure in the profile's units, the device's never consulted", () => {
		const { tiles } = overviewData(trained());
		const tonnage = tiles.find((t) => t.id === 'tonnage')!.tile;
		expect(tonnage.value).toBe('26,455.5 lb');
		expect(tonnage.canonical).toBe(12_000);
		expect(tonnage.delta).toEqual({
			value: 10,
			text: '+22\u00a0lb',
			change: 'better',
			against: 'the 12 weeks before'
		});
		expect(tonnage.soFar).toEqual({ value: '220.5\u00a0lb', lastWeek: null, through: TODAY });
	});

	it('draws the sparkline on the server from complete weeks only', () => {
		const o = trained();
		const tonnage = overviewData(o).tiles.find((t) => t.id === 'tonnage')!.tile;
		expect(tonnage.sparkline).toEqual(sparkline(o.kpis[0]!.series));
		expect(tonnage.sparkline!.points.split(' ')).toHaveLength(12);
	});

	it("says a 4-week period's verdict reads the last 12 weeks, and drops 'all''s comparison", () => {
		const four = overviewData(trained('4w'));
		expect(four.tiles[0]!.tile.window).toEqual({ sameAsPeriod: false, weeks: 12 });
		expect(four.context).toEqual({
			period: 'Last 4 weeks',
			comparison: 'Compared with the 4 weeks before',
			trend: 'Trend over the last 12 weeks'
		});
		expect(four.tiles[0]!.tile.delta!.against).toBe('the 4 weeks before');
		const all = overviewData(trained('all'));
		expect(all.tiles[0]!.tile.delta).toBeNull();
		expect(all.context.comparison).toBeNull();
	});

	it('names no earlier period over tiles none of which has a change against it', () => {
		const o = trained();
		const noEarlier = { ...o.kpis[0]!.comparison, previous: null, delta: null, change: null };
		const fresh = overviewData({ ...o, kpis: [{ ...o.kpis[0]!, comparison: noEarlier }] });
		expect(fresh.tiles[0]!.tile.delta).toBeNull();
		expect(fresh.context.comparison).toBeNull();
		expect(fresh.context.period).toBe('Last 12 weeks');
	});

	it('words a lift that ended where it began as held, with its best, each to the pound', () => {
		const o = trained();
		// 44.7 kg is 98.55 lb and 46 kg 101.4 lb: an estimate shows to the pound.
		const points = weekly([44.7, 46, 44.8, ...Array(9).fill(null), 45]);
		const flat = overviewData({
			...o,
			series: { ...o.series, keyLifts: [{ exerciseId: 'bench', name: 'Bench press', points }] }
		});
		const [bench] = flat.charts.lifts;
		expect(bench!.summary).toBe('Estimated 1RM held at 99\u00a0lb, with a best of 101\u00a0lb.');
		expect(bench!.data.series[0]!.points.slice(0, 3).map((p) => p?.text)).toEqual([
			'99',
			'101',
			'99'
		]);
	});

	it('gives each discipline a card with its verdict words, window and evidence badges', () => {
		const [card] = overviewData(trained()).cards;
		expect(card).toEqual({
			area: 'strength',
			title: 'Strength',
			verdict: 'improving',
			word: 'Improving',
			sentence: '1 of 2 main lifts trending up',
			window: 'Trend over the last 12 weeks',
			evidence: [
				{
					subject: 'Back squat',
					verdict: { verdict: 'real_trend', direction: 'up', good: true },
					hint: null
				},
				{ subject: 'Bench press', verdict: { verdict: 'normal_variation' }, hint: null }
			]
		});
	});

	it('says under a jargon measure’s name what it means, in plain words', () => {
		const input = trained();
		const [verdict] = input.verdicts;
		const [first] = verdict!.evidence;
		const measures = (['srpe_load', 'muay_thai_load', 'monotony', 'strain'] as const).map(
			(metric) => ({
				...first!,
				subject: METRICS[metric].label,
				trend: { ...first!.trend, metric }
			})
		);
		const [card] = overviewData({
			...input,
			verdicts: [{ ...verdict!, area: 'general', evidence: measures }]
		}).cards;
		expect(card!.evidence.map(({ subject, hint }) => [subject, hint])).toEqual([
			['Training load', 'Minutes × how hard each session felt, added up'],
			['Muay Thai load', 'Minutes × how hard each class felt, added up'],
			['Monotony', 'How alike your days are; lower means more varied'],
			['Strain', 'Load × monotony; high when a big week has no easy days']
		]);
	});

	it('charts each key lift in the profile units, the week in progress as its last slot', () => {
		const { charts } = overviewData(trained());
		expect(charts.lifts.map((c) => c.id)).toEqual(['squat']); // the curl has no complete week
		const squat = charts.lifts[0]!;
		expect(squat.data.unit).toBe('lb');
		const points = squat.data.series[0]!.points;
		// 100 kg is 220.46 lb: an estimate shows to the pound.
		expect(points[0]).toEqual({ value: 220, text: '220', kind: 'estimated' });
		expect(points[2]).toBeNull();
		expect(squat.data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(squat.data.slots.filter((s) => s.inProgress)).toHaveLength(1);
		expect(squat.summary).toBe('Estimated 1RM went from 220\u00a0lb to 276\u00a0lb.');
		expect(squat.table.rows).toHaveLength(13);
	});

	it('stacks the load by discipline and sums only complete weeks in its summary', () => {
		const { load } = overviewData(trained()).charts;
		expect(load!.data.series.map((s) => s.key)).toEqual(['strength', 'running']);
		expect(load!.summary).toBe('About 400 AU a week, stacked by discipline.');
		expect(load!.table.rows.at(-1)).toMatchObject({ inProgress: true });
		expect(overviewData(overview()).charts.load).toBeNull();
	});

	it('tells a new owner, a first week and a history apart', () => {
		expect(overviewData(overview()).stage).toBe('new');
		const firstWeek = overview({
			kpis: [kpi('sessions', { soFar: { metric: 'sessions', value: 2, lastWeek: null, text: '' } })]
		});
		expect(overviewData(firstWeek).stage).toBe('first_week');
		expect(overviewData(trained()).stage).toBe('history');
	});

	it('dates the timeline in words, undated entries saying so', () => {
		expect(overviewData(overview()).timeline).toEqual([
			{
				section: 'prs',
				label: 'Personal records',
				rule: 'After your first strength session',
				on: 'Fri 6 Nov',
				ready: false
			},
			{
				section: 'cycle_review',
				label: 'First cycle review',
				rule: 'At the end of your first block',
				on: null,
				ready: false
			}
		]);
	});

	it('gives each figure what counts as good from the metric catalogue', () => {
		const metric = overviewData(trained()).metrics[0]!;
		expect(metric).toMatchObject({ id: 'tonnage', method: 'How tonnage is worked out.' });
		expect(metric.good).toMatch(/^Good is|^Neither/);
	});
});

describe('tileVerdict', () => {
	it('keeps only what a tile says, counting points in the bucket given', () => {
		expect(tileVerdict(rising)).toEqual({ verdict: 'real_trend', direction: 'up', good: true });
		expect(tileVerdict(short)).toEqual({
			verdict: 'insufficient_data',
			have: 2,
			need: 6,
			unit: 'weeks'
		});
		expect(tileVerdict(short, 'months')).toMatchObject({ unit: 'months' });
	});
});

describe('loadProgress', () => {
	const request: ProgressRequest = {
		view: 'overview',
		period: '4w',
		origin: { requestId: 'req-1', method: 'GET', path: '/progress', routeId: '/(app)/progress' }
	};
	const db = {} as NonNullable<TrainingDeps['db']>;
	const NOW = new Date('2026-11-04T12:00:00Z');
	const today = vi.fn(async () => TODAY);

	const review: ReviewPromptView = {
		...{ kind: 'weekly', state: 'reviewed', title: 'Your week in review', summary: 'A hard week.' },
		...{ href: '/progress/reviews/w-2026-10-26', create: null, notReady: 'Ready after Sunday' }
	};

	it('reads the overview for the asked period on the owner today, then its review prompt', async () => {
		const read = vi.fn(async () => trained('4w'));
		const prompt = vi.fn(async () => review);
		const data = await loadProgress('owner-1', request, NOW, { db, overview: read, today, prompt });
		expect(today).toHaveBeenCalledWith('owner-1', NOW, { db });
		expect(read).toHaveBeenCalledWith(db, 'owner-1', { period: '4w', today: TODAY });
		expect(prompt).toHaveBeenCalledWith('owner-1', TODAY, { db });
		expect(data).toMatchObject({ failed: false, view: 'overview', period: '4w' });
		expect(data.failed === false && data.view === 'overview' && data.overview.review).toEqual(
			review
		);
	});

	it('records a failed prompt read and shows the overview without it', async () => {
		const error = new Error('lock timeout');
		const record = vi.fn(async () => null);
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			overview: async () => trained('4w'),
			prompt: async () => {
				throw error;
			},
			record,
			today
		});
		expect(data).toMatchObject({ failed: false, view: 'overview', overview: { review: null } });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error,
				kind: 'load',
				context: { load: 'progressReviewPrompt' }
			}),
			{ db: undefined }
		);
	});

	it('records a failed read and returns the failed state, never throwing', async () => {
		const error = new Error('connection reset');
		const record = vi.fn(async () => null);
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			overview: async () => {
				throw error;
			},
			record,
			today
		});
		expect(data).toEqual({ failed: true, view: 'overview', period: '4w' });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error,
				kind: 'load',
				status: 500,
				requestId: 'req-1',
				context: { load: 'progress', view: 'overview', period: '4w' }
			}),
			{ db: undefined }
		);
	});

	it("fails soft when the owner's day cannot be read (the profile read fails)", async () => {
		const record = vi.fn(async () => null);
		const overview = vi.fn(async () => trained('4w'));
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			overview,
			record,
			today: async () => {
				throw new Error('database down');
			}
		});
		expect(data).toEqual({ failed: true, view: 'overview', period: '4w' });
		expect(overview).not.toHaveBeenCalled();
		expect(record).toHaveBeenCalledOnce();
	});
});
