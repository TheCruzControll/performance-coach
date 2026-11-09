/**
 * /design → Charts → Trend tiles: five metrics on a fixed Wednesday, in the shape the M6
 * services send a screen, for whichever period ?period names. The period's words, the previous
 * period and the trend window come from periods.ts, as a real screen's do: at 4w each verdict
 * reads the last 12 weeks and says so. The figures stay the same at every period; only their
 * context changes. The words are the metric catalogue's (domain/analytics/metrics.ts, which the
 * browser never loads).
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import {
	PERIOD_LABEL,
	periodWindow,
	trendWindow,
	type Period
} from '#lib/domain/analytics/periods.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import type { Tile, TileDelta } from '#lib/ui/analytics/words.ts';

/** A Wednesday: the week so far runs Monday to Wednesday. */
export const TILE_TODAY: IsoDate = '2026-11-04';
const FIRST_ACTIVITY: IsoDate = '2025-03-03';

/** Twelve complete weeks ending the Sunday before TILE_TODAY, then the week in progress. */
const weekly = (values: readonly (number | null)[]): SeriesPoint[] =>
	values.map((value, index) => {
		const at = new Date(Date.UTC(2026, 7, 10 + 7 * index)).toISOString().slice(0, 10);
		return { at, value, inProgress: index === values.length - 1 };
	});

export const TILE_IDS = ['tile-squat', 'tile-pace', 'tile-sets', 'tile-weight', 'tile-empty'];

export interface TileFixture {
	id: string;
	tile: Tile;
}

/** The tiles and the squat's context line for `period`. */
export function tileFixtures(period: Period) {
	const window = periodWindow(TILE_TODAY, period, FIRST_ACTIVITY);
	const trend = trendWindow(window);
	const verdictWindow = { sameAsPeriod: trend.sameAsPeriod, weeks: trend.weeks?.count ?? null };
	const against = window.previous ? `the ${window.previous.count} weeks before` : null;
	const delta = (value: number, text: string, change: TileDelta['change']) =>
		against ? { value, text, change, against } : null;

	const tiles: TileFixture[] = [
		{
			id: 'tile-squat',
			tile: {
				label: 'Squat · Estimated 1RM',
				value: '142.5',
				unit: 'kg',
				canonical: 142.5,
				kind: 'estimated',
				delta: delta(5, '+5 kg', 'better'),
				soFar: { value: '140 kg', lastWeek: '137.5 kg', through: TILE_TODAY },
				verdict: { verdict: 'real_trend', direction: 'up', good: true },
				window: verdictWindow,
				sparkline: sparkline(
					weekly([127.5, 130, 130, null, 132.5, 135, 135, 137.5, 137.5, 140, 140, 142.5, 140])
				)
			}
		},
		{
			id: 'tile-pace',
			tile: {
				label: 'Easy run pace',
				value: '5:42',
				unit: '/km',
				canonical: 342,
				kind: 'calculated',
				delta: delta(-8, '−0:08 /km', 'better'),
				soFar: { value: '5:39 /km', lastWeek: '5:50 /km', through: TILE_TODAY },
				verdict: { verdict: 'real_trend', direction: 'down', good: true },
				window: verdictWindow,
				sparkline: sparkline(
					weekly([366, 362, 361, 358, 356, 355, 352, 350, 349, 346, 344, 342, 339])
				)
			}
		},
		{
			id: 'tile-sets',
			tile: {
				label: 'Hard sets',
				value: '14',
				unit: 'sets',
				canonical: 14,
				kind: 'calculated',
				delta: delta(-3, '−3 sets', 'worse'),
				soFar: { value: '9 sets', lastWeek: '11 sets', through: TILE_TODAY },
				verdict: { verdict: 'normal_variation' },
				window: verdictWindow,
				sparkline: sparkline(weekly([16, 15, 17, 14, 16, 18, 15, 16, 17, 15, 16, 14, 9]))
			}
		},
		{
			id: 'tile-weight',
			tile: {
				label: 'Body weight',
				value: '81.4',
				unit: 'kg',
				canonical: 81.4,
				kind: 'measured',
				delta: delta(0.4, '+0.4 kg', 'up'),
				verdict: { verdict: 'insufficient_data', have: 2, need: 6, unit: 'weeks' },
				window: verdictWindow,
				sparkline: sparkline(weekly([81, 81.4, null]))
			}
		},
		{
			id: 'tile-empty',
			tile: {
				label: 'Long run',
				value: null,
				unit: 'km',
				canonical: null,
				kind: 'measured',
				delta: null,
				// A first week: no complete period yet, but the week in progress has a run.
				soFar: { value: '5 km', lastWeek: null, through: TILE_TODAY },
				verdict: { verdict: 'insufficient_data', have: 0, need: 6, unit: 'weeks' },
				window: verdictWindow
			}
		}
	];

	const context = {
		period: PERIOD_LABEL[period],
		comparison: window.previous ? `Compared with the ${window.previous.count} weeks before` : null,
		trend: trend.sameAsPeriod ? null : trend.label,
		good: 'Good is a real rise over the trend window',
		method:
			'The best one-rep max estimated from each session’s working sets of the lift, from the RPE chart when a set has an RPE and the Epley–Brzycki mean when not.',
		caveat: 'An estimate from your sets, not a tested max.'
	};

	return { tiles, context };
}
