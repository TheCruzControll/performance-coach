/**
 * Progress → Strength's shaping (strength-data.ts) on a hand-built strength dashboard, and the
 * load reading the strength service for ?view=strength: lifts as small multiples with their best
 * estimate and the other lifts apart, tonnage and hard sets as two charts in the profile's units
 * with the week so far outlined, the shown week's muscle groups against its scaled range with
 * every recent week's range, RPE against target per lift, the PRs, and the stage a new owner sees.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MetricId } from '#lib/domain/analytics/metrics.ts';
import { periodWindow, trendWindow, type Period } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type {
	Figure,
	GroupWeekFigure,
	ShownPoint,
	StrengthDashboard,
	WeeklyFigure
} from '#lib/server/services/analytics/strength.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { loadProgress, type ProgressRequest } from './load.ts';
import { RANGE_WEEKS, strengthData } from './strength-data.ts';

/** A Wednesday: Monday to Wednesday are the week in progress. */
const TODAY = '2026-11-04';
const FIRST = '2026-01-05';
const WINDOW = periodWindow(TODAY, '12w', FIRST);

const addWeeks = (monday: string, n: number) =>
	new Date(Date.parse(`${monday}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);

const rising = {
	verdict: 'real_trend',
	direction: 'up',
	good: true,
	n: 12
} as unknown as TrendResult;

/** The period's twelve complete weeks, then this week, flagged; text as the service gives it. */
function weekly(values: (number | null)[], unit = 'kg'): ShownPoint[] {
	return values.map((value, i) => ({
		at: addWeeks(WINDOW.weeks!.from, i),
		value,
		text: value === null ? null : `${value} ${unit}`,
		...(i === values.length - 1 ? { inProgress: true } : { inProgress: false })
	}));
}

function figure(metric: MetricId, parts: Partial<Figure> = {}): Figure {
	return {
		metric,
		label: metric,
		kind: metric === 'e1rm' ? 'estimated' : 'calculated',
		method: `How ${metric} is worked out.`,
		caveat: null,
		availability: { ready: true },
		value: null,
		comparison: {
			metric,
			value: null,
			previous: null,
			delta: null,
			pct: null,
			change: null,
			words: ''
		},
		trend: { metric, window: trendWindow(WINDOW), result: rising },
		goodness: null,
		series: weekly(Array(13).fill(null)),
		...parts
	};
}

const weeklyFigure = (metric: MetricId, values: (number | null)[], soFar: number | null) =>
	({
		...figure(metric, { series: weekly(values) }),
		soFar: { metric, value: soFar, lastWeek: null, text: '' }
	}) satisfies WeeklyFigure;

function groupWeek(i: number, parts: Partial<GroupWeekFigure> = {}): GroupWeekFigure {
	return {
		weekStart: addWeeks(WINDOW.weeks!.from, i),
		inProgress: i === 12,
		source: 'block',
		label: 'From the profile this block was planned with',
		band: 'the 10–20 that suits building muscle',
		volumeFactor: 1,
		groups: [
			{ group: 'chest', sets: 12, target: [10, 20], status: 'within', planned: 12, goodness: null },
			{ group: 'quads', sets: 8, target: [10, 20], status: 'below', planned: 10, goodness: null },
			{ group: 'biceps', sets: 6, target: null, status: 'no_target', planned: 6, goodness: null }
		],
		...parts
	};
}

/** Twelve weeks of squats and benches, a deload in week 8, the profile in lb. */
function dashboard(
	parts: Partial<StrengthDashboard> = {},
	period: Period = '12w'
): StrengthDashboard {
	const window = periodWindow(TODAY, period, FIRST);
	const squat = figure('e1rm', {
		value: { text: '130 kg', value: 130 },
		series: weekly([100, 102.5, null, 105, 107.5, 110, 112.5, 115, 117.5, 120, 125, 130, 140])
	});
	return {
		window,
		trendWindow: trendWindow(window),
		units: { weight: 'lb', distance: 'mi' },
		keyLifts: [
			{
				...squat,
				exerciseId: 'squat-id',
				name: 'Back squat',
				baselineLift: 'back_squat',
				markers: []
			}
		],
		tonnage: weeklyFigure('tonnage', [...Array(12).fill(1000), 400], 400),
		hardSets: weeklyFigure('hard_sets', [...Array(12).fill(16.5), 6], 6),
		muscleGroups: {
			...figure('group_sets'),
			weeks: Array.from({ length: 13 }, (_, i) =>
				groupWeek(
					i,
					i === 7
						? {
								volumeFactor: 0.6,
								groups: [
									{
										...{ group: 'chest', sets: 7, target: [6, 12], status: 'within' },
										...{ planned: 7, goodness: null }
									}
								]
							}
						: {}
				)
			)
		},
		rpe: {
			average: figure('avg_rpe', { value: { text: '8', value: 8 } }),
			deviation: figure('rpe_deviation', { value: { text: '+0.5', value: 0.5 } }),
			byLift: [
				{
					...{ exerciseId: 'squat-id', name: 'Back squat', rated: 36 },
					// Its extra, unplanned sets at RPE 6 pull the average under the planned sets' 8.5.
					average: { text: '7.8', value: 7.8 },
					deviation: { text: '+0.5', value: 0.5 },
					deviations: 36,
					againstTarget: { actual: 8.5, target: 8 }
				},
				{
					...{ exerciseId: 'curl-id', name: 'Dumbbell curl', rated: 30 },
					average: { text: '8', value: 8 },
					deviation: null,
					deviations: 0,
					againstTarget: null
				}
			]
		},
		prs: {
			total: 11,
			items: [
				{
					...{ kind: 'rep_max', label: 'Rep max', workoutId: 'w-12', on: '2026-10-26' },
					...{ setId: 's-1', reps: 5, value: 127.5, estimated: false },
					previous: { value: 125, on: '2026-10-19', workoutId: 'w-11' },
					...{ exerciseId: 'squat-id', name: 'Back squat' },
					...{ text: '281.1 lb', previousText: '275.6 lb' }
				}
			] as StrengthDashboard['prs']['items']
		},
		...parts
	};
}

describe('strengthData', () => {
	it('says a lift that ended where it started held there, beside the headline best', () => {
		const d = dashboard();
		const flat = {
			...d.keyLifts[0]!,
			value: { text: '105 kg', value: 105 },
			series: weekly([100, 105, 102.5, ...Array(8).fill(null), 100, 101])
		};
		const [lift] = strengthData({ ...d, keyLifts: [flat] }).lifts;
		expect(lift!.best).toEqual({ text: '105 kg', value: 105 });
		expect(lift!.chart.summary).toBe('Estimated 1RM held at 100 kg, with a best of 105 kg.');
	});

	it('charts each key lift as a small multiple in the profile’s units, the others listed apart', () => {
		const s = strengthData(dashboard());
		expect(s.stage).toBe('history');
		const [squat] = s.lifts;
		expect(squat).toMatchObject({
			id: 'squat-id',
			name: 'Back squat',
			best: { text: '130 kg', value: 130 },
			verdict: { verdict: 'real_trend', direction: 'up', good: true }
		});
		expect(squat!.chart.data.unit).toBe('lb');
		// 100 kg is 220.46 lb, an estimate to the pound; a missing week is a gap; this week is
		// the flagged last slot.
		expect(squat!.chart.data.series[0]!.points[0]).toEqual({
			value: 220,
			text: '220',
			kind: 'estimated'
		});
		expect(squat!.chart.data.series[0]!.points[2]).toBeNull();
		expect(squat!.chart.data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(squat!.chart.summary).toBe('Estimated 1RM went from 100 kg to 130 kg.');
		expect(squat!.chart.plotted).toBe(true);
		expect(s.others).toEqual([{ id: 'curl-id', name: 'Dumbbell curl' }]);
		expect(s.liftsContext).toMatchObject({
			period: 'Last 12 weeks',
			comparison: 'Compared with the 12 weeks before'
		});
	});

	it('gives tonnage and hard sets a chart each, this week the outlined slot and the tile’s so-far line', () => {
		const s = strengthData(dashboard());
		expect(s.tonnage.chart.id).not.toBe(s.hardSets.chart.id);
		expect(s.tonnage.chart.data.unit).toBe('lb');
		expect(s.tonnage.chart.data.series).toHaveLength(1);
		expect(s.tonnage.chart.data.series[0]!.values[0]).toEqual({ value: 2204.6, text: '2,205' });
		expect(s.tonnage.chart.data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(s.tonnage.chart.table.rows.at(-1)).toMatchObject({ inProgress: true });
		expect(s.tonnage.tile.soFar).toEqual({
			value: '881.8\u00a0lb',
			lastWeek: null,
			through: TODAY
		});
		expect(s.hardSets.chart.data.unit).toBe('sets');
		expect(s.hardSets.chart.data.series[0]!.values[0]).toEqual({ value: 16.5, text: '16.5' });
		expect(s.hardSets.chart.summary).toContain('this week so far is outlined');
	});

	it('names the weeks before over a section only when one of its tiles shows a change against them', () => {
		// No earlier figure to compare with: no delta, so no 'Compared with…' over the tile.
		const empty = strengthData(dashboard());
		expect(empty.tonnage.tile.delta).toBeNull();
		expect(empty.tonnage.context.comparison).toBeNull();
		expect(empty.hardSets.context.comparison).toBeNull();
		expect(empty.rpe.context.comparison).toBeNull();
		const d = dashboard();
		const compared = (f: Figure): Figure => ({
			...f,
			value: { text: '8', value: 8 },
			comparison: {
				...f.comparison,
				value: 8,
				previous: 7.5,
				delta: 0.5,
				pct: 6.7,
				change: 'worse'
			}
		});
		const s = strengthData({
			...d,
			tonnage: { ...d.tonnage, ...compared(d.tonnage) },
			rpe: { ...d.rpe, average: compared(d.rpe.average) }
		});
		expect(s.tonnage.context.comparison).toBe('Compared with the 12 weeks before');
		expect(s.hardSets.context.comparison).toBeNull();
		// Either RPE tile's change is enough for the section's shared context.
		expect(s.rpe.context.comparison).toBe('Compared with the 12 weeks before');
	});

	it('shows the last complete week against its range, the plan ticked, with each week’s range', () => {
		const s = strengthData(dashboard());
		const shown = s.groups.shown!;
		expect(shown.weekStart).toBe(addWeeks(WINDOW.weeks!.from, 11));
		expect(shown.chart!.data.rows).toEqual([
			{
				key: 'chest',
				label: 'Chest',
				value: { value: 12, text: '12' },
				range: [10, 20],
				planned: { value: 12, text: '12' }
			},
			{
				key: 'quads',
				label: 'Quads',
				value: { value: 8, text: '8' },
				range: [10, 20],
				planned: { value: 10, text: '10' }
			}
		]);
		expect(shown.chart!.summary).toBe('1 of 2 muscle groups within 10–20 sets.');
		expect(shown.chart!.context[0]).toBe('From the profile this block was planned with');
		expect(shown.unjudged).toBe('Biceps 6 sets');

		// Complete weeks only, newest first; the deload's range is its scaled one.
		expect(s.groups.weeks).toHaveLength(12);
		expect(s.groups.weeks[0]!.weekStart).toBe(shown.weekStart);
		const deload = s.groups.weeks.find((w) => w.weekStart === addWeeks(WINDOW.weeks!.from, 7))!;
		expect(deload).toMatchObject({
			range: '6–12 sets',
			source: 'From the profile this block was planned with · 60 % volume',
			judged: '1 of 1 within range'
		});
		expect(s.groups.weeks[0]).toMatchObject({ range: '10–20 sets', judged: '1 of 2 within range' });
	});

	it(`lists at most ${RANGE_WEEKS} weeks of ranges, and names a week with no range`, () => {
		const weeks = Array.from({ length: 30 }, (_, i) =>
			groupWeek(i, { inProgress: i === 29, weekStart: addWeeks('2026-01-05', i) })
		);
		weeks[28] = { ...weeks[28]!, source: 'none', label: '', groups: [] };
		const d = dashboard({ muscleGroups: { ...figure('group_sets'), weeks } });
		const s = strengthData(d);
		expect(s.groups.weeks).toHaveLength(RANGE_WEEKS);
		expect(s.groups.weeks[0]).toMatchObject({
			range: null,
			source: 'No range for this week',
			judged: null
		});
		expect(s.groups.shown!.chart).toBeNull();
	});

	it('sets each lift’s RPE against its target over the same sets, leaving out a lift with no target', () => {
		const s = strengthData(dashboard());
		expect(s.rpe.chart!.data.rows).toEqual([
			{ key: 'squat-id', label: 'Back squat', actual: 8.5, target: 8 }
		]);
		expect(s.rpe.chart!.table.rows[0]!.values).toEqual(['8.5', '8', '+0.5', 'On target']);
		expect(s.rpe.average.value).toBe('8');
		expect(s.rpe.deviation.value).toBe('+0.5');

		const none = dashboard();
		none.rpe.byLift = none.rpe.byLift.map((lift) => ({ ...lift, againstTarget: null }));
		expect(strengthData(none).rpe.chart).toBeNull();
	});

	it('lists the PRs with what they beat, and says when a figure is not ready', () => {
		const s = strengthData(dashboard());
		expect(s.prs.total).toBe(11);
		expect(s.prs.items[0]).toMatchObject({
			name: 'Back squat',
			label: 'Rep max · 5',
			text: '281.1 lb',
			previous: 'was 275.6 lb',
			on: 'Mon 26 Oct',
			value: 127.5
		});

		const d = dashboard();
		d.muscleGroups.availability = { ready: false, have: 1, need: 2, unit: 'weeks' };
		expect(strengthData(d).groups.waiting).toBe('Available after 2 weeks · 1 so far');
		expect(strengthData(dashboard()).groups.waiting).toBeNull();
	});

	it('is a first week with only this week lifted, and new with nothing', () => {
		const first = dashboard({
			tonnage: weeklyFigure('tonnage', [...Array(12).fill(0), 400], 400),
			hardSets: weeklyFigure('hard_sets', [...Array(12).fill(0), 6], 6)
		});
		expect(strengthData(first).stage).toBe('first_week');
		const none = dashboard({
			tonnage: weeklyFigure('tonnage', Array(13).fill(0), 0),
			hardSets: weeklyFigure('hard_sets', Array(13).fill(0), null)
		});
		expect(strengthData(none).stage).toBe('new');
	});
});

describe('loadProgress, the Strength view', () => {
	const request: ProgressRequest = {
		view: 'strength',
		period: '12w',
		origin: { requestId: 'req-1', method: 'GET', path: '/progress', routeId: '/(app)/progress' }
	};
	const db = {} as NonNullable<TrainingDeps['db']>;
	const NOW = new Date('2026-11-04T12:00:00Z');
	const today = vi.fn(async () => TODAY);

	it('reads the strength dashboard, not the overview, for the asked period', async () => {
		const strength = vi.fn(async () => dashboard());
		const overview = vi.fn();
		const data = await loadProgress('owner-1', request, NOW, { db, strength, overview, today });
		expect(strength).toHaveBeenCalledWith(db, 'owner-1', {
			period: '12w',
			today: TODAY,
			lastGroupWeeks: RANGE_WEEKS
		});
		expect(overview).not.toHaveBeenCalled();
		expect(data).toMatchObject({ failed: false, view: 'strength', period: '12w' });
		expect(data.failed === false && data.view === 'strength' && data.strength.lifts).toHaveLength(
			1
		);
	});

	it('records a failed read with its view and fails soft', async () => {
		const record = vi.fn(async () => null);
		const failure = new Error('connection reset');
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			strength: async () => {
				throw failure;
			},
			record,
			today
		});
		expect(data).toEqual({ failed: true, view: 'strength', period: '12w' });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: failure,
				context: { load: 'progress', view: 'strength', period: '12w' }
			}),
			{ db: undefined }
		);
	});
});
