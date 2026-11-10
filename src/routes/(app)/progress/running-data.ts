/**
 * What Progress → Running renders (RunningView.svelte), arranged on the server from the running
 * service's figures (getRunningDashboard), which come in the profile's units. Nothing is computed
 * again here: distances, paces, verdicts, jumps and efforts are the service's; this module only
 * converts them for the charts and shapes them into tiles, chart data with table twins and words.
 *
 * - Weekly mileage: a bar chart with each week's planned distance as an outline (by week only: a
 *   month has no single plan), the week in progress the outlined 'so far' column, and a tile.
 * - Pace by run type: a small multiple each on one axis, minutes per km or mile, lower faster,
 *   with the type's verdict. Never a dual axis, never one chart of mixed types.
 * - Long runs: their progression, every jump over LONG_RUN_JUMP_PCT named.
 * - Best efforts and reported races, labelled Best effort or Reported, dated in the owner's zone.
 * - Runs per week, and heart rate by type when tracked, otherwise one line saying so.
 */
import { METRICS, type MetricId } from '#lib/domain/analytics/metrics.ts';
import type { Kpi, MetricTrend, SoFarLine } from '#lib/domain/analytics/overview.ts';
import { PERIOD_LABEL } from '#lib/domain/analytics/periods.ts';
import { LONG_RUN_JUMP_PCT } from '#lib/domain/analytics/running.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import { SESSION_TYPE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { cleanFloat, convertPace, formatDuration, fromMetres } from '#lib/domain/units.ts';
import { formatIn } from '#lib/server/services/analytics/format.ts';
import {
	HR_NOT_TRACKED,
	type RunningDashboard,
	type ShownEffort
} from '#lib/server/services/analytics/running.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import type { Tile, TileVerdict, VerdictWindow } from '#lib/ui/analytics/words.ts';
import { barTable, type BarChartData } from '#lib/ui/charts/bar-model.ts';
import { lineTable, type LineChartData } from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { slotOf, tileVerdict, type OverviewChart } from './load.ts';
import type { SectionContext } from './strength-data.ts';

/** How a pace multiple's figures are worked out, for the section's context. */
export const PACE_METHOD =
	'Total time ÷ total distance of each run type every week, from the part of the run that shows its type.';

/** What the heart-rate section says when no run carries a heart rate. */
export const HR_HINT = 'log a run with its average heart rate and it shows here by run type';

export interface PaceView {
	id: string;
	label: string;
	/** The pace over the period's complete weeks, in s/km behind its words; null without a run. */
	pace: { text: string; value: number } | null;
	/** Null for a type no pace metric judges. */
	verdict: TileVerdict | null;
	chart: OverviewChart<LineChartData>;
}

export interface EffortView {
	key: string;
	/** '10 km · Best effort'. */
	title: string;
	label: 'Best effort' | 'Reported';
	/** 'Sat 7 Nov · 5:30 /km · Riverside 10K'. */
	subtitle: string;
	/** Seconds, for data-value. */
	seconds: number;
	time: string;
}

export interface RunningData {
	/** new: no run in these weeks or this one; first_week: only this week so far. */
	stage: 'new' | 'first_week' | 'history';
	window: VerdictWindow;
	mileage: { context: SectionContext; tile: Tile; chart: OverviewChart<BarChartData> };
	pace: { context: SectionContext; axis: string; types: PaceView[] };
	longRuns: {
		context: SectionContext;
		verdict: TileVerdict;
		/** The period's longest run, in metres behind its words; null without one. */
		longest: { text: string; value: number } | null;
		chart: OverviewChart<LineChartData>;
		/** 'Week of 2 Nov: 14 km, 16.7 % longer than the long run before'. */
		jumps: string[];
	};
	efforts: EffortView[];
	frequency: {
		/** 'Runs per week', or per month when the period buckets by month. */
		title: string;
		context: SectionContext;
		tile: Tile;
		chart: OverviewChart<BarChartData>;
	};
	heartRate: { tracked: boolean; text: string; rows: { label: string; value: string }[] };
}

const number = (value: number, decimals: number) =>
	(cleanFloat(value, decimals) + 0).toLocaleString('en-US', { maximumFractionDigits: decimals });

/** The Running view's figures as the screen shows them, in the dashboard's (the profile's) units. */
export function runningData(d: RunningDashboard): RunningData {
	const format = formatIn(d.units);
	const { window, trendWindow: trend } = d;
	const unit = d.units.distance;
	const period = PERIOD_LABEL[window.period];
	const pointUnit = window.bucket === 'month' ? 'months' : 'weeks';
	const rowHeader = window.bucket === 'month' ? 'Month' : 'Week';
	const against = window.previous ? `the ${window.previous.count} weeks before` : null;
	const verdictWindow = { sameAsPeriod: trend.sameAsPeriod, weeks: trend.weeks?.count ?? null };
	const contextOf = (id: MetricId, method = METRICS[id].method): SectionContext => ({
		period,
		comparison: against && `Compared with ${against}`,
		trend: trend.sameAsPeriod ? null : trend.label,
		good: METRICS[id].good.words,
		method,
		caveat: METRICS[id].caveat ?? null
	});
	const shown = (id: MetricId, value: number | null) =>
		value === null ? null : format(METRICS[id], value, 'value');
	const dist = (metres: number) => cleanFloat(fromMetres(metres, unit), 1);
	const distValue = (metres: number) => ({ value: dist(metres), text: number(dist(metres), 1) });
	const slots = (points: SeriesPoint[]) => points.map((p) => slotOf(p, window.bucket));

	function tileOf(k: Kpi, t: MetricTrend, points: SeriesPoint[], soFar?: SoFarLine): Tile {
		const { delta, change } = k;
		const signed = (value: number) =>
			`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(METRICS[k.metric], Math.abs(value), 'delta')}`;
		return {
			label: METRICS[k.metric].label,
			value: shown(k.metric, k.value),
			canonical: k.value,
			kind: METRICS[k.metric].kind,
			delta:
				delta !== null && change !== null && against
					? { value: delta, text: signed(delta), change, against }
					: null,
			...(soFar && {
				soFar: {
					value: shown(k.metric, soFar.value),
					lastWeek: shown(k.metric, soFar.lastWeek),
					through: window.inProgress.through
				}
			}),
			verdict: tileVerdict(t.result, pointUnit),
			window: verdictWindow,
			sparkline: sparkline(points)
		};
	}

	// ---- Mileage, against the plan by week.
	const m = d.mileage;
	const mileageData: BarChartData = {
		title: `Distance by ${window.bucket}`,
		unit,
		slots: slots(m.points),
		series: [
			{
				key: 'mileage',
				label: 'Distance',
				token: SERIES_TOKEN.running,
				values: m.points.map((p) => (p.value === null ? null : distValue(p.value)))
			}
		],
		...(window.bucket === 'week' && {
			planned: [...m.weeks, m.inProgress].map((w) => w.planned && distValue(w.planned.value))
		})
	};
	const byTime = m.weeks.some((w) => w.plannedByTime > 0)
		? ['Runs planned by time aren’t in the planned distance']
		: [];

	// ---- Pace by type: minutes per km or mile, so lower is faster on every multiple.
	const axis = `min/${unit} (lower is faster)`;
	const perUnit = (secondsPerKm: number) => convertPace(secondsPerKm, 'km', unit);
	const types = d.pace.map((t): PaceView => {
		const label = SESSION_TYPE_LABEL[t.sessionType];
		const data: LineChartData = {
			title: `${label} pace`,
			unit: `min/${unit}`,
			slots: slots(t.points),
			series: [
				{
					key: t.sessionType,
					label,
					token: SERIES_TOKEN.running,
					points: t.points.map((p) =>
						p.value === null
							? null
							: {
									value: cleanFloat(perUnit(p.value) / 60, 4),
									text: formatDuration(perUnit(p.value))
								}
					)
				}
			]
		};
		const complete = t.points.filter((p) => !p.inProgress && p.value !== null);
		const [first, last] = [complete[0], complete.at(-1)];
		const words = (p: SeriesPoint) => `${formatDuration(perUnit(p.value!))} /${unit}`;
		return {
			id: t.sessionType,
			label,
			pace: t.period,
			verdict: t.trend && tileVerdict(t.trend.result, pointUnit),
			chart: {
				id: `pace-${t.sessionType}`,
				title: data.title,
				context: [period, axis],
				summary:
					!first || !last
						? 'Only this week so far.'
						: complete.length === 1
							? `One ${window.bucket} in these weeks: ${words(last)}.`
							: `From ${words(first)} to ${words(last)}.`,
				table: lineTable(data, rowHeader),
				data
			}
		};
	});

	// ---- Long runs.
	const lr = d.longRuns;
	const longData: LineChartData = {
		title: `Long run by ${window.bucket}`,
		unit,
		slots: slots(lr.points),
		series: [
			{
				key: 'long_run',
				label: 'Long run',
				token: SERIES_TOKEN.running,
				points: lr.points.map((p) =>
					p.value === null ? null : { ...distValue(p.value), kind: 'measured' }
				)
			}
		]
	};
	const jumps = lr.weeks.flatMap((w) =>
		w.jump && w.distance
			? [
					`${slotOf({ at: w.weekStart, value: null, inProgress: false }, 'week').label}: ${w.distance.text}, ${number(w.changePct!, 1)} % longer than the long run before`
				]
			: []
	);

	// ---- Best efforts, then reported races.
	const effortView = (e: ShownEffort, title: string): EffortView => {
		const label = e.label === 'reported' ? 'Reported' : 'Best effort';
		return {
			key: `${e.label}-${e.id}`,
			title: `${title} · ${label}`,
			label,
			subtitle: [e.day ? shortDate(e.day) : 'Undated', e.pace.text, e.eventName ?? []]
				.flat()
				.join(' · '),
			seconds: e.durationSeconds,
			time: e.time
		};
	};
	const efforts = d.efforts.flatMap((x) => [
		...(x.best ? [effortView(x.best, x.label)] : []),
		...x.reported.map((e) => effortView(e, x.label))
	]);

	// ---- Runs per week.
	const f = d.frequency;
	const runsData: BarChartData = {
		title: `Runs by ${window.bucket}`,
		unit: 'runs',
		slots: slots(f.points),
		series: [
			{
				key: 'runs',
				label: 'Runs',
				token: SERIES_TOKEN.running,
				values: f.points.map((p) =>
					p.value === null ? null : { value: p.value, text: number(p.value, 1) }
				)
			}
		]
	};

	const ran = m.points.some((p) => !p.inProgress && (p.value ?? 0) > 0);
	return {
		stage: ran ? 'history' : m.inProgress.runs > 0 ? 'first_week' : 'new',
		window: verdictWindow,
		mileage: {
			context: contextOf('mileage'),
			tile: tileOf(m.kpi, m.trend, m.points, m.soFar),
			chart: {
				id: 'mileage',
				title: mileageData.title,
				context: [period, ...(mileageData.planned ? ['Planned outlined'] : []), ...byTime],
				summary: m.mean
					? `About ${m.mean.text} a week; this week so far is outlined.`
					: 'No complete week yet; this week so far is outlined.',
				table: barTable(mileageData, rowHeader),
				data: mileageData
			}
		},
		pace: { context: contextOf('pace_easy', PACE_METHOD), axis, types },
		longRuns: {
			context: contextOf('long_run'),
			verdict: tileVerdict(lr.trend.result, pointUnit),
			longest: m.longestRun,
			chart: {
				id: 'long-run',
				title: longData.title,
				context: [period, `Jumps over ${LONG_RUN_JUMP_PCT} % flagged`],
				summary: jumps.length
					? `${jumps.length} ${jumps.length === 1 ? 'jump' : 'jumps'} over ${LONG_RUN_JUMP_PCT} %.`
					: `No jump over ${LONG_RUN_JUMP_PCT} % in these weeks.`,
				table: lineTable(longData, rowHeader),
				data: longData
			},
			jumps
		},
		efforts,
		frequency: {
			title: `Runs per ${window.bucket}`,
			context: contextOf('run_frequency'),
			tile: tileOf(f.kpi, f.trend, f.points),
			chart: {
				id: 'runs',
				title: runsData.title,
				context: [period],
				summary:
					f.perWeek === null
						? 'No complete week yet.'
						: `About ${number(f.perWeek, 1)} runs a week.`,
				table: barTable(runsData, rowHeader),
				data: runsData
			}
		},
		heartRate: {
			tracked: d.heartRate.tracked,
			text: d.heartRate.tracked ? d.heartRate.text : `${HR_NOT_TRACKED}: ${HR_HINT}`,
			rows: d.heartRate.byType.map((h) => ({
				label: SESSION_TYPE_LABEL[h.sessionType],
				value:
					h.avgHr !== null
						? `${number(h.avgHr, 0)} bpm`
						: h.availability.ready
							? '—'
							: `Available after ${h.availability.need} ${h.availability.unit} · ${h.availability.have} so far`
			}))
		}
	};
}
