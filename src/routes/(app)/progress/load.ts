/**
 * What /progress renders on the server (+page.server.ts), kept apart so a test, and
 * analytics-explain's timing, run the real load. The overview service (getProgressOverview)
 * gives canonical numbers with their words in the profile's units; this module arranges them
 * into what the screen shows: tiles with their sparklines computed here, verdict cards, the
 * headline charts' data and table twins, and the dated timeline a new owner sees.
 *
 * - Units (m6-plan open question): every figure is formatted in the profile's units
 *   (services/analytics/format.ts UNITS_FROM), as workout logging uses them, no longer in the
 *   device's preference.
 * - The week in progress is never in a total or a chart's line; it is each tile's so-far line
 *   and each chart's 'so far' slot.
 * - It fails soft: a failed read is recorded as a server error (kind 'load') and the page shows
 *   its load-failed notice with Retry, inside the shell, instead of the 500 page.
 */
import { METRICS, type MetricArea } from '#lib/domain/analytics/metrics.ts';
import { VERDICT_WORDS, type Verdict } from '#lib/domain/analytics/overview.ts';
import { PERIOD_LABEL } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import type { LoadGroup } from '#lib/domain/analytics/workload.ts';
import { cleanFloat, convertWeight } from '#lib/domain/units.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { formatIn } from '#lib/server/services/analytics/format.ts';
import {
	getProgressOverview,
	type OverviewKpiId,
	type OverviewSection,
	type ProgressOverview
} from '#lib/server/services/analytics/overview.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { resolveDeps, type TrainingDeps } from '#lib/server/services/training/shared.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import type { Tile, TileVerdict } from '#lib/ui/analytics/words.ts';
import { barTable, type BarChartData } from '#lib/ui/charts/bar-model.ts';
import { lineTable, type LineChartData } from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import type { ChartTableData } from '#lib/ui/charts/table.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import type { ProgressParams, ProgressView } from './params.ts';

/** A discipline's card title (the services' areas: 'general' is training as a whole). */
const AREA_TITLE: Readonly<Record<MetricArea, string>> = {
	strength: 'Strength',
	running: 'Running',
	general: 'Training',
	recovery: 'Recovery'
};

const LOAD_LABEL: Readonly<Record<LoadGroup, string>> = {
	strength: 'Strength',
	hypertrophy: 'Hypertrophy',
	conditioning: 'Conditioning',
	combat: 'Muay Thai',
	running: 'Running'
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface VerdictCard {
	area: MetricArea;
	title: string;
	verdict: Verdict;
	/** 'Improving', 'Holding steady', … */
	word: string;
	sentence: string;
	/** 'Trend over the last 12 weeks'. */
	window: string;
	evidence: { subject: string; verdict: TileVerdict }[];
}

export interface OverviewChart<D> {
	id: string;
	title: string;
	context: string[];
	summary: string;
	table: ChartTableData;
	data: D;
}

export interface TimelineEntry {
	section: OverviewSection;
	label: string;
	rule: string;
	/** 'Wed 4 Nov'; null when not known yet. */
	on: string | null;
	ready: boolean;
}

export interface OverviewData {
	/** new: nothing logged in these weeks or this one; first_week: only this week so far. */
	stage: 'new' | 'first_week' | 'history';
	context: { period: string; comparison: string | null; trend: string | null };
	headline: { verdict: Verdict; text: string };
	cards: VerdictCard[];
	tiles: { id: OverviewKpiId; tile: Tile }[];
	/** What each tile's figure is and what counts as good. */
	metrics: {
		id: OverviewKpiId;
		label: string;
		good: string;
		method: string;
		caveat: string | null;
	}[];
	charts: { load: OverviewChart<BarChartData> | null; lifts: OverviewChart<LineChartData>[] };
	timeline: TimelineEntry[];
}

export type ProgressData =
	| ({ failed: true } & ProgressParams)
	| ({ failed: false; view: 'overview'; overview: OverviewData } & Omit<ProgressParams, 'view'>);

export interface ProgressRequest extends ProgressParams {
	/** What a recorded failure carries: the request's id, method, path, route and app version. */
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface ProgressDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
	/** The overview read; getProgressOverview unless given. */
	overview?: typeof getProgressOverview;
	/** Where a failure goes; recordServerError unless given. */
	record?: typeof recordServerError;
	/** The owner's day at `now`; ownerToday unless given. */
	today?: typeof ownerToday;
}

const capitalise = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** A trend as a tile says it, without the figures behind it. */
export function tileVerdict(result: TrendResult, unit = 'weeks'): TileVerdict {
	switch (result.verdict) {
		case 'real_trend':
			return { verdict: 'real_trend', direction: result.direction, good: result.good };
		case 'normal_variation':
			return { verdict: 'normal_variation' };
		case 'insufficient_data':
			return { verdict: 'insufficient_data', have: result.n, need: result.needs.points, unit };
	}
}

/** A slot's tick and label: '5 Oct' and 'Week of 5 Oct', or 'Oct' and 'Oct 2026' by month. */
function slotOf({ at, inProgress }: SeriesPoint, bucket: 'week' | 'month') {
	const [year, month, day] = at.split('-').map(Number) as [number, number, number];
	const name = MONTHS[month - 1]!;
	const [tick, label] =
		bucket === 'month' ? [name, `${name} ${year}`] : [`${day} ${name}`, `Week of ${day} ${name}`];
	return { tick, label, ...(inProgress ? { inProgress: true } : {}) };
}

const number = (value: number, decimals: number) =>
	(cleanFloat(value, decimals) + 0).toLocaleString('en-US', { maximumFractionDigits: decimals });

/** The overview's figures as the screen shows them, in the overview's (the profile's) units. */
export function overviewData(o: ProgressOverview): OverviewData {
	const format = formatIn(o.units);
	const { window, trendWindow: trend } = o;
	const pointUnit = window.bucket === 'month' ? 'months' : 'weeks';
	const against = window.previous ? `the ${window.previous.count} weeks before` : null;
	const verdictWindow = { sameAsPeriod: trend.sameAsPeriod, weeks: trend.weeks?.count ?? null };

	const tiles = o.kpis.map((kpi) => {
		const metric = METRICS[kpi.metric];
		const { delta, change } = kpi.comparison;
		const signed = (value: number) =>
			`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(metric, Math.abs(value), 'delta')}`;
		const shown = (value: number | null) =>
			value === null ? null : format(metric, value, 'value');
		const tile: Tile = {
			label: kpi.label,
			value: kpi.shown,
			canonical: kpi.value,
			kind: kpi.kind,
			delta:
				delta !== null && change !== null && against
					? { value: delta, text: signed(delta), change, against }
					: null,
			soFar: kpi.soFar && {
				value: shown(kpi.soFar.value),
				lastWeek: shown(kpi.soFar.lastWeek),
				through: window.inProgress.through
			},
			verdict: tileVerdict(kpi.trend.result, pointUnit),
			window: verdictWindow,
			sparkline: sparkline(kpi.series)
		};
		return { id: kpi.metric, tile };
	});

	const logged = (p: SeriesPoint) => (p.value ?? 0) > 0;
	const history = o.kpis.some((k) => k.series.some((p) => !p.inProgress && logged(p)));
	const thisWeek = o.kpis.some((k) => (k.soFar?.value ?? 0) > 0);
	const periodWords = PERIOD_LABEL[o.period];

	const lifts = o.series.keyLifts.flatMap(({ exerciseId, name, points }) => {
		const complete = points.filter((p) => !p.inProgress && p.value !== null);
		if (complete.length === 0) return [];
		const unit = o.units.weight;
		const display = (kg: number) => cleanFloat(convertWeight(kg, 'kg', unit), 1);
		const title = `${name} · estimated 1RM`;
		const data: LineChartData = {
			title,
			unit,
			slots: points.map((p) => slotOf(p, window.bucket)),
			series: [
				{
					key: exerciseId,
					label: name,
					token: SERIES_TOKEN.strength,
					points: points.map((p) =>
						p.value === null
							? null
							: { value: display(p.value), text: number(display(p.value), 1), kind: 'estimated' }
					)
				}
			]
		};
		const [first, last] = [complete[0]!, complete.at(-1)!];
		const summary =
			complete.length === 1
				? `One estimate in these weeks: ${format(METRICS.e1rm, last.value!, 'value')}.`
				: `Estimated 1RM went from ${format(METRICS.e1rm, first.value!, 'value')} to ${format(METRICS.e1rm, last.value!, 'value')}.`;
		const context = [
			periodWords,
			'Estimated from your sets',
			...(trend.sameAsPeriod ? [] : [trend.label])
		];
		return [{ id: exerciseId, title, context, summary, table: lineTable(data), data }];
	});

	const loadSlots = o.series.load[0]?.points ?? [];
	const totals = loadSlots.flatMap((p, i) =>
		p.inProgress ? [] : [o.series.load.reduce((sum, s) => sum + (s.points[i]?.value ?? 0), 0)]
	);
	const loadData: BarChartData = {
		title: 'Training load by discipline',
		unit: 'AU',
		slots: loadSlots.map((p) => slotOf(p, window.bucket)),
		series: o.series.load.map(({ group, points }) => ({
			key: group,
			label: LOAD_LABEL[group],
			token: SERIES_TOKEN[group],
			values: points.map((p) =>
				p.value === null ? null : { value: p.value, text: number(p.value, 0) }
			)
		}))
	};
	const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
	const load: OverviewChart<BarChartData> | null =
		totals.length === 0
			? null
			: {
					id: 'load',
					title: loadData.title,
					context: [periodWords, 'Calculated: minutes × session RPE'],
					summary: `About ${number(mean, 0)} AU a ${window.bucket}, stacked by discipline.`,
					table: barTable(loadData, window.bucket === 'month' ? 'Month' : 'Week'),
					data: loadData
				};

	return {
		stage: history ? 'history' : thisWeek ? 'first_week' : 'new',
		context: {
			period: periodWords,
			comparison: window.previous
				? `Compared with the ${window.previous.count} weeks before`
				: null,
			trend: trend.sameAsPeriod ? null : trend.label
		},
		headline: o.headline,
		cards: o.verdicts.map((v) => ({
			area: v.area,
			title: AREA_TITLE[v.area],
			verdict: v.verdict,
			word: capitalise(VERDICT_WORDS[v.verdict]),
			sentence: v.sentence,
			window: v.window.label,
			evidence: v.evidence.map((e) => ({
				subject: e.subject,
				verdict: tileVerdict(e.trend.result, pointUnit)
			}))
		})),
		tiles,
		metrics: o.kpis.map(({ metric, label, method, caveat }) => ({
			...{ id: metric, label, method, caveat },
			good: METRICS[metric].good.words
		})),
		charts: { load, lifts },
		timeline: o.timeline.map(({ section, label, rule, on, ready }) => ({
			...{ section, label, rule, ready },
			on: on === null ? null : shortDate(on)
		}))
	};
}

/** /progress on the owner's day at `now` (its read fails soft too): the asked view and period. */
export async function loadProgress(
	ownerId: string,
	{ view, period, origin }: ProgressRequest,
	now: Date,
	{
		db,
		errorsDb,
		overview = getProgressOverview,
		record = recordServerError,
		today: dayOf = ownerToday
	}: ProgressDeps = {}
): Promise<ProgressData> {
	try {
		const today = await dayOf(ownerId, now, { db });
		const o = await overview(resolveDeps({ db }).db, ownerId, { period, today });
		return { failed: false, view, period, overview: overviewData(o) };
	} catch (error) {
		await record(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'progress', view, period } },
			{ db: errorsDb }
		);
		return { failed: true, view: view satisfies ProgressView, period };
	}
}
