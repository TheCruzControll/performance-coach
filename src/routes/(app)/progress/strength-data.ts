/**
 * What Progress → Strength renders (StrengthView.svelte), arranged on the server from the
 * strength service's figures (getStrengthDashboard), which come in the profile's units. Nothing
 * is computed again here: values, verdicts, ranges and PRs are the service's; this module only
 * shapes them into tiles, chart data with table twins and the words around them.
 *
 * - Key lifts (at most KEY_LIFTS_MAX, the service's): an e1RM small multiple each, with its best
 *   estimate and verdict; any other lift of the period is listed apart, each linking to its page.
 * - Tonnage and hard sets: two bar charts on their own axes (never one dual axis), the week in
 *   progress the outlined 'so far' column, and the tiles' 'This week so far' line.
 * - Muscle groups: the shown week (the last complete one, else this week) against its range
 *   scaled by the week's volume factor, with the planned tick and the range's source named; then
 *   the range of each recent week (RANGE_WEEKS), so a deload's scaled range reads beside a full
 *   week's.
 * - RPE: the average and the deviation from target as tiles, then each lift's deviation as
 *   diverging bars: its mean RPE done and planned over the same sets (the service's).
 * - PRs: the period's, this week's included, newest first, at most the service's PRS_MAX.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { METRICS, type MetricId } from '#lib/domain/analytics/metrics.ts';
import { PERIOD_LABEL } from '#lib/domain/analytics/periods.ts';
import type { Availability } from '#lib/domain/analytics/types.ts';
import { MUSCLE_GROUP_LABEL } from '#lib/domain/training/vocabulary.ts';
import { cleanFloat, convertWeight } from '#lib/domain/units.ts';
import { formatIn } from '#lib/server/services/analytics/format.ts';
import type {
	Figure,
	GroupWeekFigure,
	StrengthDashboard,
	WeeklyFigure
} from '#lib/server/services/analytics/strength.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import {
	KIND_WORD,
	type Tile,
	type TileVerdict,
	type VerdictWindow
} from '#lib/ui/analytics/words.ts';
import {
	barTable,
	divergingTable,
	formatTotal,
	rangeTable,
	rowsHeight,
	type BarChartData,
	type DivergingBarsData,
	type RangeBarsData
} from '#lib/ui/charts/bar-model.ts';
import { lineTable, type LineChartData } from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { slotOf, tileVerdict, type OverviewChart } from './load.ts';

/**
 * The recent weeks whose range the muscle-group section lists, newest first. The page carries
 * them all, so a long period ('all') stays small; raise it to list more.
 */
export const RANGE_WEEKS = 12;

/** What MetricContext shows for a section. */
export interface SectionContext {
	period: string;
	comparison: string | null;
	trend: string | null;
	good: string;
	method: string;
	caveat: string | null;
}

export interface StrengthSection {
	context: SectionContext;
	/** 'Available after 4 weeks · 1 so far' until the figure has its least data; else null. */
	waiting: string | null;
}

export interface LiftView {
	id: string;
	name: string;
	/** The best estimate over the period's complete weeks; null until there is one. */
	best: { text: string; value: number } | null;
	verdict: TileVerdict;
	chart: OverviewChart<LineChartData> & { plotted: boolean };
}

export interface WeeklyView extends StrengthSection {
	tile: Tile;
	chart: OverviewChart<BarChartData>;
}

export interface GroupWeekRow {
	weekStart: IsoDate;
	/** 'Week of 2 Nov'. */
	label: string;
	/** '6–12 sets'; null when the week has no range. */
	range: string | null;
	/** 'From the profile this block was planned with · 60 % volume'. */
	source: string;
	/** '4 of 6 within range'; null without a range. */
	judged: string | null;
}

export interface GroupsView extends StrengthSection {
	/** The week the chart shows: the last complete one, else this week; null with no week. */
	shown:
		| (GroupWeekRow & {
				chart: (OverviewChart<RangeBarsData> & { height: string }) | null;
				/** Groups with sets but no range, in words: 'Biceps 6 sets · Triceps 3 sets'. */
				unjudged: string | null;
		  })
		| null;
	/** Complete weeks newest first, at most RANGE_WEEKS. */
	weeks: GroupWeekRow[];
}

export interface PrView {
	key: string;
	exerciseId: string;
	name: string;
	/** 'Estimated 1RM', 'Rep max · 5'. */
	label: string;
	/** kg (reps for 'Most reps'), for data-value. */
	value: number;
	text: string;
	/** 'was 95 kg'. */
	previous: string;
	on: string;
	estimated: boolean;
}

export interface StrengthData {
	/** new: nothing lifted in these weeks or this one; first_week: only this week so far. */
	stage: 'new' | 'first_week' | 'history';
	context: { period: string; comparison: string | null; trend: string | null };
	window: VerdictWindow;
	/** What an estimated 1RM is and what counts as good, over the small multiples. */
	liftsContext: SectionContext;
	lifts: LiftView[];
	/** Lifts of the period that are not key lifts, by name. */
	others: { id: string; name: string }[];
	tonnage: WeeklyView;
	hardSets: WeeklyView;
	groups: GroupsView;
	rpe: StrengthSection & {
		average: Tile;
		deviation: Tile;
		chart: (OverviewChart<DivergingBarsData> & { height: string }) | null;
	};
	prs: { items: PrView[]; total: number };
}

const number = (value: number, decimals: number) =>
	(cleanFloat(value, decimals) + 0).toLocaleString('en-US', { maximumFractionDigits: decimals });

const waitingOf = (availability: Availability) =>
	availability.ready
		? null
		: `Available after ${availability.need} ${availability.unit} · ${availability.have} so far`;

/** The Strength view's figures as the screen shows them, in the dashboard's (the profile's) units. */
export function strengthData(d: StrengthDashboard): StrengthData {
	const format = formatIn(d.units);
	const { window, trendWindow: trend } = d;
	const period = PERIOD_LABEL[window.period];
	const pointUnit = window.bucket === 'month' ? 'months' : 'weeks';
	const rowHeader = window.bucket === 'month' ? 'Month' : 'Week';
	const verdictWindow = { sameAsPeriod: trend.sameAsPeriod, weeks: trend.weeks?.count ?? null };
	const context = {
		period,
		comparison: window.previous ? `Compared with the ${window.previous.count} weeks before` : null,
		trend: trend.sameAsPeriod ? null : trend.label
	};
	const sectionOf = (id: MetricId, availability: Availability): StrengthSection => {
		const { good, method, caveat } = METRICS[id];
		return {
			context: { ...context, good: good.words, method, caveat: caveat ?? null },
			waiting: waitingOf(availability)
		};
	};
	const shown = (id: MetricId, value: number | null) =>
		value === null ? null : format(METRICS[id], value, 'value');

	function tileOf(figure: Figure, label: string): Tile {
		const { delta, change } = figure.comparison;
		const signed = (value: number) =>
			`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(METRICS[figure.metric], Math.abs(value), 'delta')}`;
		return {
			label,
			value: figure.value?.text ?? null,
			canonical: figure.value?.value ?? null,
			kind: figure.kind,
			delta:
				delta !== null && change !== null && window.previous
					? {
							value: delta,
							text: signed(delta),
							change,
							against: `the ${window.previous.count} weeks before`
						}
					: null,
			verdict: tileVerdict(figure.trend.result, pointUnit),
			window: verdictWindow,
			sparkline: sparkline(figure.series)
		};
	}

	const weight = (kg: number) => cleanFloat(convertWeight(kg, 'kg', d.units.weight), 1);

	const lifts = d.keyLifts.map((lift): LiftView => {
		const title = `${lift.name} · estimated 1RM`;
		const data: LineChartData = {
			title,
			unit: d.units.weight,
			slots: lift.series.map((p) => slotOf(p, window.bucket)),
			series: [
				{
					key: lift.exerciseId,
					label: lift.name,
					token: SERIES_TOKEN.strength,
					points: lift.series.map((p) =>
						p.value === null
							? null
							: { value: weight(p.value), text: number(weight(p.value), 1), kind: 'estimated' }
					)
				}
			]
		};
		const complete = lift.series.filter((p) => !p.inProgress && p.value !== null);
		const [first, last] = [complete[0], complete.at(-1)];
		const summary =
			!first || !last
				? 'No estimate in these weeks yet.'
				: complete.length === 1
					? `One estimate in these weeks: ${last.text}.`
					: `Estimated 1RM went from ${first.text} to ${last.text}.`;
		return {
			id: lift.exerciseId,
			name: lift.name,
			best: lift.value,
			verdict: tileVerdict(lift.trend.result, pointUnit),
			chart: {
				id: lift.exerciseId,
				title,
				context: [period, 'Estimated from your sets'],
				summary,
				table: lineTable(data, rowHeader),
				data,
				plotted: lift.series.some((p) => p.value !== null)
			}
		};
	});
	const keyIds = new Set(lifts.map((lift) => lift.id));
	const others = d.rpe.byLift
		.filter((lift) => !keyIds.has(lift.exerciseId))
		.map((lift) => ({ id: lift.exerciseId, name: lift.name }));

	function weeklyView(
		figure: WeeklyFigure,
		label: string,
		unit: string,
		value: (raw: number) => { value: number; text: string }
	): WeeklyView {
		const data: BarChartData = {
			title: `${label} by ${window.bucket}`,
			unit,
			slots: figure.series.map((p) => slotOf(p, window.bucket)),
			series: [
				{
					key: figure.metric,
					label,
					token: SERIES_TOKEN.strength,
					values: figure.series.map((p) => (p.value === null ? null : value(p.value)))
				}
			]
		};
		const complete = figure.series.filter((p) => !p.inProgress && p.value !== null);
		const mean = complete.reduce((sum, p) => sum + p.value!, 0) / (complete.length || 1);
		const { soFar } = figure;
		return {
			...sectionOf(figure.metric, figure.availability),
			tile: {
				...tileOf(figure, label),
				soFar: {
					value: shown(figure.metric, soFar.value),
					lastWeek: shown(figure.metric, soFar.lastWeek),
					through: window.inProgress.through
				}
			},
			chart: {
				id: figure.metric,
				title: data.title,
				context: [period, KIND_WORD[figure.kind]],
				summary: complete.length
					? `About ${shown(figure.metric, mean)} a ${window.bucket}; this week so far is outlined.`
					: 'Nothing in a complete week yet; this week so far is outlined.',
				table: barTable(data, rowHeader),
				data
			}
		};
	}

	const groupRow = (week: GroupWeekFigure): GroupWeekRow => {
		const judged = week.groups.filter((g) => g.target !== null);
		const [low, high] = judged[0]?.target ?? [];
		const scaled =
			week.volumeFactor === 1 ? [] : [`${number(week.volumeFactor * 100, 0)} % volume`];
		return {
			weekStart: week.weekStart,
			label: slotOf({ at: week.weekStart, value: null, inProgress: false }, 'week').label,
			range:
				low === undefined || high === undefined
					? null
					: `${formatTotal(low)}–${formatTotal(high)} sets`,
			source: [week.label || 'No range for this week', ...scaled].join(' · '),
			judged: judged.length
				? `${judged.filter((g) => g.status === 'within').length} of ${judged.length} within range`
				: null
		};
	};
	const complete = d.muscleGroups.weeks.filter((week) => !week.inProgress);
	const focus = complete.at(-1) ?? d.muscleGroups.weeks.at(-1);
	const groupsShown: GroupsView['shown'] = focus
		? (() => {
				const row = groupRow(focus);
				const data: RangeBarsData = {
					title: `Hard sets by muscle group · ${row.label}`,
					unit: 'sets',
					token: SERIES_TOKEN.strength,
					rows: focus.groups.flatMap((g) =>
						g.target === null
							? []
							: [
									{
										key: g.group,
										label: MUSCLE_GROUP_LABEL[g.group],
										value: { value: g.sets, text: number(g.sets, 1) },
										range: g.target,
										planned:
											g.planned === null ? null : { value: g.planned, text: number(g.planned, 1) }
									}
								]
					)
				};
				const unjudged = focus.groups
					.filter((g) => g.target === null && g.sets > 0)
					.map((g) => `${MUSCLE_GROUP_LABEL[g.group]} ${number(g.sets, 1)} sets`);
				const within = data.rows.filter(
					(r) => r.value && r.value.value >= r.range[0] && r.value.value <= r.range[1]
				).length;
				return {
					...row,
					chart: data.rows.length
						? {
								id: 'groups',
								title: data.title,
								context: [row.source, KIND_WORD[d.muscleGroups.kind]],
								summary: `${within} of ${data.rows.length} muscle groups within ${row.range ?? 'range'}${focus.inProgress ? ' so far' : ''}.`,
								table: rangeTable(data),
								data,
								height: rowsHeight(data.rows.length)
							}
						: null,
					unjudged: unjudged.length ? unjudged.join(' · ') : null
				};
			})()
		: null;

	const deviations = d.rpe.byLift.flatMap((lift) =>
		lift.againstTarget ? [{ key: lift.exerciseId, label: lift.name, ...lift.againstTarget }] : []
	);
	const divergingData: DivergingBarsData = {
		title: 'RPE against target by lift',
		rows: deviations
	};

	const tonnage = weeklyView(d.tonnage, 'Tonnage', d.units.weight, (kg) => ({
		value: weight(kg),
		text: number(weight(kg), 0)
	}));
	const hardSets = weeklyView(d.hardSets, 'Hard sets', 'sets', (n) => ({
		value: n,
		text: number(n, 1)
	}));
	const lifted = (figure: WeeklyFigure) =>
		figure.series.some((p) => !p.inProgress && (p.value ?? 0) > 0);

	return {
		stage:
			lifted(d.tonnage) || lifted(d.hardSets)
				? 'history'
				: (d.tonnage.soFar.value ?? 0) > 0 || (d.hardSets.soFar.value ?? 0) > 0
					? 'first_week'
					: 'new',
		context,
		window: verdictWindow,
		liftsContext: sectionOf('e1rm', { ready: true }).context,
		lifts,
		others,
		tonnage,
		hardSets,
		groups: {
			...sectionOf('group_sets', d.muscleGroups.availability),
			shown: groupsShown,
			weeks: complete.slice(-RANGE_WEEKS).toReversed().map(groupRow)
		},
		rpe: {
			...sectionOf('rpe_deviation', d.rpe.deviation.availability),
			average: tileOf(d.rpe.average, 'Average RPE'),
			deviation: tileOf(d.rpe.deviation, 'RPE against target'),
			chart: deviations.length
				? {
						id: 'rpe',
						title: divergingData.title,
						context: [period, KIND_WORD[d.rpe.deviation.kind]],
						summary: `Each lift’s RPE against the RPE it was planned at, ${deviations.length} ${deviations.length === 1 ? 'lift' : 'lifts'}.`,
						table: divergingTable(divergingData),
						data: divergingData,
						height: rowsHeight(deviations.length)
					}
				: null
		},
		prs: {
			total: d.prs.total,
			items: d.prs.items.map((pr, i) => ({
				key: `${pr.kind}-${pr.workoutId}-${pr.reps ?? 0}-${i}`,
				exerciseId: pr.exerciseId,
				name: pr.name,
				label: pr.reps === null ? pr.label : `${pr.label} · ${pr.reps}`,
				value: pr.value,
				text: pr.text,
				previous: `was ${pr.previousText}`,
				on: shortDate(pr.on),
				estimated: pr.estimated
			}))
		}
	};
}
