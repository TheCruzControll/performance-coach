/**
 * The exercise detail's load (load.ts) on a hand-built analytics result: the e1RM chart's
 * estimated series in the profile's units with the profile's maxes plotted apart as their own
 * kind, the rep-max table with dates and the record beaten, PRs newest first, the empty state
 * before two sessions, the recent sessions in words, and an unknown id (404) set apart from a
 * failed read (recorded, then the load-failed state).
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { periodWindow, trendWindow } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type { ExerciseAnalytics } from '#lib/server/services/analytics/exercise.ts';
import type { Figure } from '#lib/server/services/analytics/strength.ts';
import { TrainingNotFoundError, type TrainingDeps } from '#lib/server/services/training/shared.ts';
import { exerciseDetail, loadExerciseDetail, type ExerciseDetailRequest } from './load.ts';

/** A Wednesday; the 12 complete weeks run 10 Aug – 1 Nov, this week from 2 Nov. */
const TODAY = '2026-11-04';
const FIRST = '2026-01-05';
const LB = 2.20462;

const rising = {
	verdict: 'real_trend',
	direction: 'up',
	good: true,
	n: 12
} as unknown as TrendResult;

/** Three complete weeks with estimates (100, gap, 110 kg) and this week's 112 kg, so far. */
function e1rmFigure(): Figure {
	const window = periodWindow(TODAY, '12w', FIRST);
	const series = [
		{ at: '2026-10-12', value: 100, inProgress: false, text: '220.5 lb' },
		{ at: '2026-10-19', value: null, inProgress: false, text: null },
		{ at: '2026-10-26', value: 110, inProgress: false, text: '242.5 lb' },
		{ at: '2026-11-02', value: 112, inProgress: true, text: '246.9 lb' }
	];
	return {
		metric: 'e1rm',
		label: 'Estimated 1RM',
		kind: 'estimated',
		method: 'How it is worked out.',
		caveat: 'An estimate.',
		availability: { ready: true },
		value: { text: '242.5 lb', value: 110 },
		comparison: {
			metric: 'e1rm',
			value: 110,
			previous: 100,
			delta: 10,
			pct: 10,
			change: 'better',
			words: ''
		},
		trend: { metric: 'e1rm', window: trendWindow(window), result: rising },
		goodness: null,
		series
	};
}

function analytics(parts: Partial<ExerciseAnalytics> = {}): ExerciseAnalytics {
	const window = periodWindow(TODAY, '12w', FIRST);
	const e1rm = e1rmFigure();
	return {
		window,
		trendWindow: trendWindow(window),
		units: { weight: 'lb', distance: 'mi' },
		exercise: {
			id: 'ex-bench',
			key: 'bench_press',
			name: 'Bench press',
			pattern: 'horizontal_push',
			primaryMuscles: ['chest', 'triceps', 'front_delts'],
			custom: false,
			retired: false
		} as unknown as ExerciseAnalytics['exercise'],
		availability: { ready: true },
		e1rm: {
			...e1rm,
			markers: [
				// Tested on Thursday 29 Oct: the week of 26 Oct, beside that week's 110 kg estimate.
				{ kind: 'measured', label: 'Measured', on: '2026-10-29', kg: 120, text: '264.6 lb' },
				// Undated: listed, never plotted.
				{
					kind: 'estimated',
					label: 'Estimated · from your profile',
					on: null,
					kg: 125,
					text: '275.6 lb'
				}
			] as unknown as ExerciseAnalytics['e1rm']['markers']
		},
		topSets: {
			...e1rm,
			sessions: [
				{
					workoutId: 'w1',
					on: '2026-10-12',
					inProgress: false,
					kg: 90,
					reps: 5,
					text: '198.4 lb × 5'
				},
				{
					workoutId: 'w3',
					on: '2026-11-02',
					inProgress: true,
					kg: 95,
					reps: 5,
					text: '209.4 lb × 5'
				}
			]
		},
		repMaxes: [
			{
				reps: 1,
				record: { value: 105, text: '231.5 lb', on: '2026-10-26', workoutId: 'w2', setId: 's1' },
				previous: { value: 100, text: '220.5 lb', on: '2026-10-12', workoutId: 'w1' }
			},
			{ reps: 2, record: null, previous: null }
		],
		prs: {
			e1rm: [
				{ on: '2026-10-19', text: '231.5 lb' },
				{ on: '2026-10-26', text: '242.5 lb' }
			].map(({ on, text }, i) => ({
				kind: 'e1rm',
				label: 'Estimated 1RM',
				workoutId: `w${i + 2}`,
				on,
				setId: 's',
				reps: null,
				value: 105 + 5 * i,
				previous: { value: 100 + 5 * i, on: '2026-10-12', workoutId: 'w1' },
				estimated: true,
				text,
				previousText: i === 0 ? '220.5 lb' : '231.5 lb'
			})),
			volume: []
		},
		rpeDeviation: { ...e1rm, metric: 'rpe_deviation', kind: 'calculated', value: null },
		recent: [
			{
				workoutId: 'w3',
				title: 'Strength A',
				status: 'completed',
				startedAt: new Date('2026-11-02T15:00:00Z'),
				on: '2026-11-02',
				sets: [
					{ isWarmup: true, isSkipped: false, weightKg: 60, reps: 5 },
					{ isWarmup: false, isSkipped: false, weightKg: 95, reps: 5 },
					{ isWarmup: false, isSkipped: false, weightKg: 95, reps: 6 },
					{ isWarmup: false, isSkipped: true, weightKg: 140, reps: 5 }
				]
			}
		] as unknown as ExerciseAnalytics['recent'],
		...parts
	};
}

describe('exerciseDetail', () => {
	it('plots each week’s estimate in the profile’s units, rings for estimates', () => {
		const { chart } = exerciseDetail(analytics());
		const [estimated] = chart.data.series;
		expect(chart.data.unit).toBe('lb');
		expect(chart.data.slots.map((s) => s.tick)).toEqual(['12 Oct', '19 Oct', '26 Oct', '2 Nov']);
		expect(chart.data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(estimated!.points[0]).toEqual({ value: 220.5, text: '220.5', kind: 'estimated' });
		expect(estimated!.points[1]).toBeNull();
		expect(estimated!.points[2]!.value).toBeCloseTo(110 * LB, 1);
		expect(chart.summary).toBe('Estimated 1RM went from 220.5 lb to 242.5 lb.');
		expect(chart.plotted).toBe(true);
		// The table twin carries every week, the estimate named as one.
		expect(chart.table.rows[0]!.values[0]).toBe('220.5, estimated');
	});

	it('marks a dated profile max in its week as measured, apart from the estimates', () => {
		const detail = exerciseDetail(analytics());
		const profile = detail.chart.data.series[1]!;
		expect(profile.label).toBe('Profile 1RM');
		expect(profile.points.map((p) => p?.kind ?? null)).toEqual([null, null, 'measured', null]);
		expect(profile.points[2]!.value).toBeCloseTo(120 * LB, 1);
		// Both maxes are listed with their kind; the undated one is never plotted.
		expect(detail.markers).toEqual([
			{ label: 'Measured', kind: 'measured', kg: 120, text: '264.6 lb', on: 'Thu 29 Oct' },
			{
				label: 'Estimated · from your profile',
				kind: 'estimated',
				kg: 125,
				text: '275.6 lb',
				on: null
			}
		]);
	});

	it('draws one series when no profile max falls in a shown week', () => {
		const a = analytics();
		const detail = exerciseDetail({ ...a, e1rm: { ...a.e1rm, markers: [] } });
		expect(detail.chart.data.series).toHaveLength(1);
	});

	it('says the e1RM in a tile with its change and verdict, and tags the lift', () => {
		const detail = exerciseDetail(analytics());
		expect(detail.e1rm).toMatchObject({
			label: 'Best estimated 1RM',
			value: '242.5 lb',
			canonical: 110,
			kind: 'estimated',
			delta: { value: 10, change: 'better', against: 'the 12 weeks before' }
		});
		expect(detail.verdict).toEqual({ verdict: 'real_trend', direction: 'up', good: true });
		expect(detail.tags).toEqual(['Horizontal push', 'Chest', 'Triceps']);
		expect(detail.waiting).toBeNull();
	});

	it('lists rep maxes with their date and the record beaten, PRs newest first', () => {
		const detail = exerciseDetail(analytics());
		expect(detail.repMaxes).toEqual([
			{
				reps: 1,
				kg: 105,
				text: '231.5 lb',
				on: 'Mon 26 Oct',
				previous: 'was 220.5 lb · Mon 12 Oct'
			},
			{ reps: 2, kg: null, text: null, on: null, previous: null }
		]);
		expect(detail.prs.e1rm.map((pr) => pr.on)).toEqual(['Mon 26 Oct', 'Mon 19 Oct']);
		expect(detail.prs.e1rm[0]).toMatchObject({ value: 110, previous: 'was 231.5 lb · Mon 12 Oct' });
		expect(detail.topSets.map((t) => t.on)).toEqual(['Mon 2 Nov', 'Mon 12 Oct']);
	});

	it('words a recent session from its working sets, warm-ups and skipped sets left out', () => {
		const [session] = exerciseDetail(analytics()).recent;
		expect(session).toEqual({
			id: 'w3',
			title: 'Strength A',
			on: 'Mon 2 Nov',
			summary: '2 sets · best 209.4 lb × 6'
		});
	});

	it('waits for two sessions before trends', () => {
		const a = analytics({ availability: { ready: false, have: 1, need: 2, unit: 'sessions' } });
		expect(exerciseDetail(a).waiting).toEqual({ have: 1, need: 2 });
	});
});

describe('loadExerciseDetail', () => {
	const request: ExerciseDetailRequest = {
		exerciseId: 'ex-bench',
		period: '4w',
		origin: { requestId: 'req-1', method: 'GET', path: '/progress/exercises/ex-bench' }
	};
	const db = {} as NonNullable<TrainingDeps['db']>;
	const NOW = new Date('2026-11-04T12:00:00Z');
	const today = vi.fn(async () => TODAY);

	it('reads the lift for the asked period on the owner’s day', async () => {
		const read = vi.fn(async () => analytics());
		const data = await loadExerciseDetail('owner-1', request, NOW, { db, analytics: read, today });
		expect(read).toHaveBeenCalledWith(db, 'owner-1', 'ex-bench', { period: '4w', today: TODAY });
		expect(data).toMatchObject({ failed: false, period: '4w', detail: { name: 'Bench press' } });
	});

	it('turns an unknown or foreign id into a 404, recording nothing', async () => {
		const record = vi.fn(async () => null);
		const thrown = await loadExerciseDetail('owner-1', request, NOW, {
			db,
			analytics: async () => {
				throw new TrainingNotFoundError('exercise');
			},
			record,
			today
		}).catch((error: unknown) => error);
		expect(isHttpError(thrown, 404)).toBe(true);
		expect(record).not.toHaveBeenCalled();
	});

	it('records a failed read and returns the failed state, never throwing', async () => {
		const error = new Error('connection reset');
		const record = vi.fn(async () => null);
		const data = await loadExerciseDetail('owner-1', request, NOW, {
			db,
			analytics: async () => {
				throw error;
			},
			record,
			today
		});
		expect(data).toEqual({ failed: true, period: '4w' });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error,
				kind: 'load',
				status: 500,
				requestId: 'req-1',
				context: { load: 'progress-exercise', period: '4w' }
			}),
			{ db: undefined }
		);
	});
});
