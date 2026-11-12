/**
 * What Progress → General renders (GeneralView.svelte), arranged on the server from the general
 * service's figures (getGeneralDashboard), which come in the profile's units. Nothing is computed
 * again here: counts, loads, ratios, verdicts and notes are the service's; this module only
 * shapes them into tiles, chart data with table twins and words.
 *
 * - Was the plan done? Adherence: its tile, the period's counts (completed, skipped, missed, off
 *   plan), each week's rate as a column against the good band, and this week so far.
 * - How much was done: sessions and training time by week, stacked by discipline in STACK_ORDER.
 * - How much load, and is it rising fast? Weekly session-RPE load stacked the same way; the
 *   acute:chronic ratio as a line over its typical band, with its caveat always in words beside
 *   it; monotony and strain tiles. Sessions without an RPE or a duration are named, never 0.
 * - Muay Thai: its load tile, sessions, minutes, hard sessions and rounds.
 * - Recovery: a small multiple each for sleep, soreness, energy and stress, and the latest notes,
 *   which are untrusted text: the view prints them as text, never as markup.
 * - Monthly periods ('all' past 104 weeks) chart each month's average week (series.ts byMonth).
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { GOOD, METRICS, type MetricId } from '#lib/domain/analytics/metrics.ts';
import { PERIOD_LABEL } from '#lib/domain/analytics/periods.ts';
import { byMonth } from '#lib/domain/analytics/series.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import {
	ACWR_CAVEAT,
	CHRONIC_DAYS,
	HARD_RPE,
	type AcwrZone,
	type LoadGroup,
	type UnknownLoad
} from '#lib/domain/analytics/workload.ts';
import { DISCIPLINE_INFO, type Discipline } from '#lib/domain/profile/catalog.ts';
import { cleanFloat } from '#lib/domain/units.ts';
import { formatIn } from '#lib/server/services/analytics/format.ts';
import type {
	GeneralDashboard,
	GeneralFigure,
	GeneralMetric
} from '#lib/server/services/analytics/general.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import type { Tile, VerdictWindow } from '#lib/ui/analytics/words.ts';
import { barTable, type BarChartData } from '#lib/ui/charts/bar-model.ts';
import { lineTable, type LineChartData } from '#lib/ui/charts/line-model.ts';
import { FURNITURE, SERIES_TOKEN, STACK_ORDER } from '#lib/ui/charts/palette.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { LOAD_LABEL, slotOf, tileVerdict, type OverviewChart } from './load.ts';
import type { SectionContext } from './strength-data.ts';

/** The ratio's zone in words, beside its number (the bands are ACWR_CAVEAT's rules of thumb). */
export const ZONE_WORDS: Readonly<Record<AcwrZone, string>> = {
	low: 'Below the typical range',
	typical: 'Within the typical range',
	raised: 'Above the typical range',
	sharp: 'A sharp rise'
};

/** What the adherence section says with no plan in these weeks or this one. */
export const NO_PLAN_HINT =
	'Adherence needs a plan: build a program in Train and each week’s sessions are counted here.';

/** What a new owner and a first week are told: what appears and when. */
export const INTRO = {
	new: {
		title: 'Your training trends start with your first session',
		description:
			'Log a workout, a run or a Muay Thai class and your sessions, adherence, load and recovery appear here.'
	},
	first_week: {
		title: 'Your first week of training is under way',
		description:
			'Totals, load and trends count complete weeks, so they start after Sunday. This week so far is below.'
	}
} as const;

/** What the recovery section says before any note. */
export const NO_NOTES = {
	title: 'No recovery notes yet',
	description:
		'Note how you slept and felt after a session, and your sleep, soreness, energy and stress show here by week.'
} as const;

/** The recovery small multiples, in this order. */
const RECOVERY = ['sleep', 'soreness', 'energy', 'stress'] as const satisfies GeneralMetric[];

/** A figure with its tile and the context under it. */
export interface FigureView {
	context: SectionContext;
	tile: Tile;
}

export interface ChartedView extends FigureView {
	chart: OverviewChart<BarChartData>;
}

export interface CountView {
	key: string;
	label: string;
	value: number;
	text: string;
}

export interface GeneralData {
	/** new: nothing logged in these weeks or this one; first_week: only this week so far. */
	stage: 'new' | 'first_week' | 'history';
	/** The intro a new owner or a first week sees (INTRO); null with history. */
	intro: { title: string; description: string } | null;
	/** NO_PLAN_HINT when nothing is planned in these weeks or this one; else null. */
	noPlan: string | null;
	window: VerdictWindow;
	adherence: ChartedView & { counts: CountView[]; soFar: string };
	sessions: ChartedView;
	/** `missing` names the sessions without a duration. */
	time: ChartedView & { missing: string | null };
	/** `missing` names the sessions without an RPE or a duration. */
	load: ChartedView & { missing: string | null };
	/** Null when the owner chose to drop the ratio (ACWR_PLACEMENT). */
	acwr: {
		/** Behind 'More' instead of in the open. */
		more: boolean;
		caveat: string;
		/** Today's ratio with its zone; null before CHRONIC_DAYS days of training. */
		current: { value: number; text: string; zone: string | null } | null;
		waiting: string;
		chart: OverviewChart<LineChartData>;
	} | null;
	monotony: FigureView;
	strain: FigureView;
	muayThai: FigureView & { trained: boolean; counts: CountView[] };
	recovery: {
		context: SectionContext;
		multiples: { id: string; chart: OverviewChart<LineChartData> }[];
		/** The latest notes, newest first: untrusted text, printed as text. */
		notes: { id: string; on: string; text: string }[];
		logged: boolean;
		/** What shows before any note (NO_NOTES). */
		empty: { title: string; description: string };
	};
}

const number = (value: number, decimals: number) =>
	(cleanFloat(value, decimals) + 0).toLocaleString('en-US', { maximumFractionDigits: decimals });

/** 'Strength A (Mon 2 Nov), Tempo run (Thu 5 Nov)' and how many more. */
function named(items: readonly { title: string; date: IsoDate }[], what: string): string | null {
	if (items.length === 0) return null;
	const shown = items.slice(0, 3).map((s) => `${s.title} (${shortDate(s.date)})`);
	const more = items.length > 3 ? ` and ${items.length - 3} more` : '';
	const count = items.length === 1 ? '1 session' : `${items.length} sessions`;
	return `${count} without ${what}, left out: ${shown.join(', ')}${more}`;
}

/** The General view's figures as the screen shows them, in the dashboard's (the profile's) units. */
export function generalData(d: GeneralDashboard): GeneralData {
	const format = formatIn(d.units);
	const { window, trendWindow: trend, figures } = d;
	const period = PERIOD_LABEL[window.period];
	const bucket = window.bucket;
	const pointUnit = bucket === 'month' ? 'months' : 'weeks';
	const rowHeader = bucket === 'month' ? 'Month' : 'Week';
	const per = bucket === 'month' ? 'Average week of each month' : null;
	const against = window.previous ? `the ${window.previous.count} weeks before` : null;
	const verdictWindow = { sameAsPeriod: trend.sameAsPeriod, weeks: trend.weeks?.count ?? null };
	const contextOf = (id: MetricId): SectionContext => ({
		period,
		comparison: against && `Compared with ${against}`,
		trend: trend.sameAsPeriod ? null : trend.label,
		good: METRICS[id].good.words,
		method: METRICS[id].method,
		caveat: METRICS[id].caveat
	});
	const shown = (id: MetricId, value: number | null) =>
		value === null ? null : format(METRICS[id], value, 'value');

	function tileOf(f: GeneralFigure): Tile {
		const { delta, change } = f.comparison;
		const signed = (value: number) =>
			`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(METRICS[f.metric], Math.abs(value), 'delta')}`;
		return {
			label: f.label,
			value: f.shown,
			canonical: f.value,
			kind: f.kind,
			delta:
				delta !== null && change !== null && against
					? { value: delta, text: signed(delta), change, against }
					: null,
			soFar: f.soFar && {
				value: shown(f.metric, f.soFar.value),
				lastWeek: shown(f.metric, f.soFar.lastWeek),
				through: window.inProgress.through
			},
			verdict: tileVerdict(f.trend.result, pointUnit),
			window: verdictWindow,
			sparkline: sparkline(f.series)
		};
	}
	/** The context names the earlier period only when the tile shows a change against it. */
	const view = (id: GeneralMetric): FigureView => {
		const tile = tileOf(figures[id]);
		const context = contextOf(id);
		return { context: tile.delta ? context : { ...context, comparison: null }, tile };
	};

	/** Weekly points, the week in progress last, regrouped by month when the period is. */
	const bucketed = (points: SeriesPoint[]) => (bucket === 'month' ? byMonth(points) : points);
	const weekly = <W extends { weekStart: IsoDate; inProgress: boolean }>(
		weeks: readonly W[],
		value: (w: W) => number | null
	) => bucketed(weeks.map((w) => ({ at: w.weekStart, value: value(w), inProgress: w.inProgress })));

	/**
	 * A bar chart stacked by discipline, the groups with anything to draw in STACK_ORDER. A group
	 * absent from a week did nothing (0); only an explicit null (no duration recorded) is a gap.
	 */
	function stacked<W extends { weekStart: IsoDate; inProgress: boolean }>(
		title: string,
		unit: string,
		weeks: readonly W[],
		byGroup: (w: W) => Partial<Record<LoadGroup, number | null>>,
		decimals: number
	): BarChartData {
		const series = STACK_ORDER.map((group) => ({
			group,
			points: weekly(weeks, (w) => byGroup(w)[group] ?? 0)
		})).filter(({ points }) => points.some((p) => (p.value ?? 0) > 0));
		const slots = (series[0]?.points ?? weekly(weeks, () => null)).map((p) => slotOf(p, bucket));
		return {
			title,
			unit,
			slots,
			series: series.map(({ group, points }) => ({
				key: group,
				label: LOAD_LABEL[group],
				token: SERIES_TOKEN[group],
				values: points.map((p) =>
					p.value === null
						? null
						: { value: cleanFloat(p.value, 2), text: number(p.value, decimals) }
				)
			}))
		};
	}
	const frame =
		<D>(id: string, data: D & { title: string }, table: OverviewChart<D>['table']) =>
		(summary: string, context: string[] = []): OverviewChart<D> => ({
			id,
			title: data.title,
			context: [period, ...(per ? [per] : []), ...context],
			summary,
			table,
			data
		});
	const bar = (id: string, data: BarChartData) => frame(id, data, barTable(data, rowHeader));
	const line = (id: string, data: LineChartData) => frame(id, data, lineTable(data, rowHeader));

	/** Disciplines added up by their colour group (athletic and custom are conditioning). */
	const byTone = (values: Partial<Record<Discipline, number | null>>, scale = 1) => {
		const out: Partial<Record<LoadGroup, number | null>> = {};
		for (const [discipline, value] of Object.entries(values) as [Discipline, number | null][]) {
			const tone = DISCIPLINE_INFO[discipline].tone;
			if (value !== null) out[tone] = (out[tone] ?? 0) + value / scale;
			else out[tone] ??= null;
		}
		return out;
	};
	const all = <A, B>(w: { weeks: readonly A[]; inProgress: B }): (A | B)[] => [
		...w.weeks,
		w.inProgress
	];
	const meanOf = (id: GeneralMetric) => {
		const complete = figures[id].series.filter((p) => !p.inProgress && p.value !== null);
		return complete.length ? complete.reduce((s, p) => s + p.value!, 0) / complete.length : null;
	};

	// ---- Adherence.
	const a = d.adherence;
	const adherenceData: BarChartData = {
		title: `Adherence by ${bucket}`,
		unit: '%',
		slots: figures.adherence.series.map((p) => slotOf(p, bucket)),
		series: [
			{
				key: 'adherence',
				label: 'Adherence',
				token: FURNITURE.muted,
				values: figures.adherence.series.map((p) =>
					p.value === null ? null : { value: cleanFloat(p.value, 0), text: number(p.value, 0) }
				)
			}
		],
		target: [GOOD.adherencePct.good, null]
	};
	const count = (key: string, label: string, value: number): CountView => ({
		key,
		label,
		value,
		text: number(value, 0)
	});
	const week = a.inProgress;
	const soFarParts = [
		`${week.completed} of ${week.planned} done`,
		...(week.pending ? [`${week.pending} to come`] : []),
		...(week.skipped ? [`${week.skipped} skipped`] : []),
		...(week.missed ? [`${week.missed} missed`] : []),
		...(week.extra ? [`${week.extra} off plan`] : [])
	];

	// ---- Sessions, time and load by discipline.
	const sessionsData = stacked(
		`Sessions by ${bucket}`,
		'sessions',
		all(d.sessions),
		(w) => byTone(w.byDiscipline),
		1
	);
	const timeData = stacked(
		`Training time by ${bucket}`,
		'min',
		all(d.time),
		(w) => byTone(w.byDiscipline, 60),
		0
	);
	const loadData = stacked(
		`Training load by ${bucket}`,
		'AU',
		all(d.load),
		(w) => Object.fromEntries(w.byGroup.map((g) => [g.group, g.load])),
		0
	);
	/** The average complete week, in the chart's unit (`scale` canonical units to one). */
	const about = (id: GeneralMetric, unit: string, scale = 1, decimals = 0) => {
		const mean = meanOf(id);
		return mean === null
			? 'No complete week yet; this week so far is outlined.'
			: `About ${number(mean / scale, decimals)} ${unit} a week, stacked by discipline.`;
	};
	const unknown: UnknownLoad[] = d.load.total.unknown;

	// ---- The acute:chronic ratio, as of each complete week's Sunday and today.
	const ratio = d.acwr;
	const ratioData: LineChartData = {
		title: 'Acute:chronic load',
		slots: ratio.series.map((p) => slotOf(p, 'week')),
		series: [
			{
				key: 'acwr',
				label: 'Acute:chronic load',
				token: FURNITURE.muted,
				points: ratio.series.map((p) =>
					p.value === null ? null : { value: cleanFloat(p.value, 2), text: number(p.value, 2) }
				)
			}
		],
		target: [ACWR_CAVEAT.typical.from, ACWR_CAVEAT.typical.to]
	};
	const current = ratio.current?.ratio ?? null;

	// ---- Muay Thai.
	const mt = d.muayThai.total;

	// ---- Recovery.
	const r = d.recovery;
	const notes = r.total.notes + r.inProgress.notes;

	const logged = figures.sessions.series.some((p) => !p.inProgress && (p.value ?? 0) > 0);
	const stage = logged ? 'history' : d.sessions.inProgress.sessions > 0 ? 'first_week' : 'new';
	return {
		stage,
		intro: stage === 'history' ? null : INTRO[stage],
		noPlan: a.total.planned === 0 && a.inProgress.planned === 0 ? NO_PLAN_HINT : null,
		window: verdictWindow,
		adherence: {
			...view('adherence'),
			counts: [
				count('completed', 'Completed', a.total.completed),
				count('skipped', 'Skipped', a.total.skipped),
				count('missed', 'Missed', a.total.missed),
				count('extra', 'Off plan', a.total.extra)
			],
			soFar: `This week so far: ${soFarParts.join(' · ')}`,
			chart: bar(
				'adherence',
				adherenceData
			)(
				a.total.pct === null
					? 'No session was due in these weeks.'
					: `${a.total.completed} of ${a.total.completed + a.total.skipped + a.total.missed} sessions due were done.`
			)
		},
		sessions: {
			...view('sessions'),
			chart: bar('sessions', sessionsData)(about('sessions', 'sessions', 1, 1))
		},
		time: {
			...view('training_time'),
			chart: bar('time', timeData)(about('training_time', 'min', 60)),
			missing: named(d.time.total.untimed, 'a duration')
		},
		load: {
			...view('srpe_load'),
			chart: bar('load', loadData)(about('srpe_load', 'AU'), ['Calculated: minutes × session RPE']),
			missing: named(unknown, 'an RPE or a duration')
		},
		acwr:
			ratio.placement === 'dropped'
				? null
				: {
						more: ratio.placement === 'more',
						caveat: ACWR_CAVEAT.text,
						current:
							current === null
								? null
								: {
										value: current,
										text: number(current, 2),
										zone: ratio.current!.zone && ZONE_WORDS[ratio.current!.zone]
									},
						waiting: `Available after ${CHRONIC_DAYS} days of training`,
						chart: line('acwr', ratioData)(
							current === null
								? 'Not enough days yet for a ratio.'
								: `${number(current, 2)} today, against a typical ${ACWR_CAVEAT.typical.from}–${ACWR_CAVEAT.typical.to}.`,
							['Typical range shaded']
						)
					},
		monotony: view('monotony'),
		strain: view('strain'),
		muayThai: {
			...view('muay_thai_load'),
			trained: mt.sessions + d.muayThai.inProgress.sessions > 0,
			counts: [
				count('sessions', 'Sessions', mt.sessions),
				...(mt.minutes === null ? [] : [count('minutes', 'Minutes', mt.minutes)]),
				count('hard', `Hard (RPE ${HARD_RPE}+)`, mt.hard),
				...(mt.rounds.total === null ? [] : [count('rounds', 'Rounds', mt.rounds.total)])
			]
		},
		recovery: {
			context: contextOf('sleep'),
			multiples: RECOVERY.map((id) => {
				const f = figures[id];
				const data: LineChartData = {
					title: f.label,
					slots: f.series.map((p) => slotOf(p, bucket)),
					series: [
						{
							key: id,
							label: f.label,
							token: FURNITURE.muted,
							points: f.series.map((p) =>
								p.value === null
									? null
									: { value: cleanFloat(p.value, 1), text: number(p.value, 1) }
							)
						}
					]
				};
				return {
					id,
					chart: line(
						`recovery-${id}`,
						data
					)(f.shown === null ? 'No note gives it yet.' : `A mean of ${f.shown} in these weeks.`)
				};
			}),
			notes: r.latest.map((n) => ({
				id: n.id,
				on: shortDate(n.notedOn),
				text: n.text.untrusted_text
			})),
			logged: notes > 0,
			empty: NO_NOTES
		}
	};
}
