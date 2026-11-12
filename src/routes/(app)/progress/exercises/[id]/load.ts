/**
 * What the exercise detail (/progress/exercises/[id]) renders on the server (+page.server.ts),
 * kept apart so a test runs the real load. The exercise service (getExerciseAnalytics) gives the
 * lift's canonical numbers with their words in the profile's units; this module arranges them
 * into what the screen shows: the e1RM tile and verdict, the e1RM chart (the estimated series,
 * the profile's maxes marked apart as their own kind) with its table twin, top sets, the 1–10
 * rep-max table, the PR timelines newest first, RPE against target and the recent sessions.
 *
 * - An unknown, malformed or another owner's id is the 404 page in the shell (TrainingNotFoundError).
 * - Any other failure is recorded as a server error (kind 'load') and the screen shows its
 *   load-failed notice with Retry, inside the shell, instead of the 500 page.
 * - Trends need TREND_SESSIONS counted sessions of the lift (the e1RM metric's least data); before
 *   that the screen says so and shows what there is.
 */
import { error } from '@sveltejs/kit';
import { mondayOf } from '#lib/domain/calendar.ts';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import { PERIOD_LABEL, type Period } from '#lib/domain/analytics/periods.ts';
import { MOVEMENT_PATTERN_LABEL, MUSCLE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { cleanFloat, convertWeight, roundEstimate } from '#lib/domain/units.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import {
	getExerciseAnalytics,
	type ExerciseAnalytics,
	type ExercisePr
} from '#lib/server/services/analytics/exercise.ts';
import { formatIn, weight } from '#lib/server/services/analytics/format.ts';
import type { Figure } from '#lib/server/services/analytics/strength.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import {
	resolveDeps,
	TrainingNotFoundError,
	type TrainingDeps
} from '#lib/server/services/training/shared.ts';
import { sparkline } from '#lib/ui/analytics/sparkline.ts';
import {
	spanSentence,
	type Tile,
	type TileVerdict,
	type VerdictWindow
} from '#lib/ui/analytics/words.ts';
import { lineTable, type LineChartData, type LinePoint } from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { slotOf, tileVerdict, type OverviewChart } from '../../load.ts';

/** Sessions of the lift before trends show: the e1RM metric's least data (metrics.ts). */
export const TREND_SESSIONS = METRICS.e1rm.minData.need;

/** At most this many primary muscles name the lift in the header's tags. */
const MUSCLE_TAGS = 2;

export interface RecordRowView {
	reps: number;
	/** The record in kg, for data-value; null when the rep count was never lifted with a load. */
	kg: number | null;
	text: string | null;
	on: string | null;
	/** 'was 95 kg · Mon 2 Nov'; null for a first lift. */
	previous: string | null;
}

export interface PrView {
	key: string;
	label: string;
	/** kg (reps for 'Most reps'), for data-value. */
	value: number;
	text: string;
	previous: string;
	on: string;
	estimated: boolean;
}

export interface MaxMarkerView {
	/** 'Measured', or 'Estimated · from your profile'. */
	label: string;
	kind: 'measured' | 'estimated';
	kg: number;
	text: string;
	/** 'Sun 1 Nov'; null when the profile gives no date. */
	on: string | null;
}

export interface ExerciseDetail {
	id: string;
	name: string;
	tags: string[];
	/** Sessions counted against TREND_SESSIONS while below it (the empty state); null once met. */
	waiting: { have: number; need: number } | null;
	context: {
		period: string;
		comparison: string | null;
		trend: string | null;
		good: string;
		method: string;
		caveat: string | null;
	};
	verdict: TileVerdict;
	window: VerdictWindow;
	e1rm: Tile;
	/** The e1RM chart; `plotted` false when no week of the period has an estimate. */
	chart: OverviewChart<LineChartData> & { plotted: boolean };
	markers: MaxMarkerView[];
	topSets: { key: string; on: string; text: string; inProgress: boolean }[];
	repMaxes: RecordRowView[];
	/** Newest first. */
	prs: { e1rm: PrView[]; volume: PrView[] };
	rpe: Tile;
	recent: { id: string; title: string; on: string; summary: string }[];
}

export type ExerciseDetailData =
	{ failed: true; period: Period } | { failed: false; period: Period; detail: ExerciseDetail };

export interface ExerciseDetailRequest {
	exerciseId: string;
	period: Period;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface ExerciseDetailDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
	/** The exercise read; getExerciseAnalytics unless given. */
	analytics?: typeof getExerciseAnalytics;
	record?: typeof recordServerError;
	today?: typeof ownerToday;
}

const oneDecimal = (value: number) =>
	(cleanFloat(value, 1) + 0).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** A figure as a TrendTile shows it: its value, change on the previous period and verdict. */
function tileOf(a: ExerciseAnalytics, figure: Figure, label: string): Tile {
	const format = formatIn(a.units);
	const metric = METRICS[figure.metric];
	const { delta, change } = figure.comparison;
	const previous = a.window.previous;
	const signed = (value: number) =>
		`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(metric, Math.abs(value), 'delta')}`;
	return {
		label,
		value: figure.value?.text ?? null,
		canonical: figure.value?.value ?? null,
		kind: figure.kind,
		delta:
			delta !== null && change !== null && previous
				? {
						value: delta,
						text: signed(delta),
						change,
						against: `the ${previous.count} weeks before`
					}
				: null,
		verdict: tileVerdict(figure.trend.result, a.window.bucket === 'month' ? 'months' : 'weeks'),
		window: { sameAsPeriod: a.trendWindow.sameAsPeriod, weeks: a.trendWindow.weeks?.count ?? null },
		sparkline: sparkline(figure.series)
	};
}

const prView = (pr: ExercisePr, i: number): PrView => ({
	key: `${pr.kind}-${pr.workoutId}-${i}`,
	label: pr.reps === null ? pr.label : `${pr.label} · ${pr.reps}`,
	value: pr.value,
	text: pr.text,
	previous: `was ${pr.previousText} · ${shortDate(pr.previous.on)}`,
	on: shortDate(pr.on),
	estimated: pr.estimated
});

/** The e1RM chart: each week's best estimate, and the profile's maxes dated in a shown week. */
function e1rmChart(a: ExerciseAnalytics, period: string): ExerciseDetail['chart'] {
	const unit = a.units.weight;
	const { bucket } = a.window;
	/** An estimate to 0.5 kg or 1 lb; a measured max as it was lifted, to 0.1. */
	const display = (kg: number, kind: LinePoint['kind']) =>
		kind === 'estimated'
			? roundEstimate(convertWeight(kg, 'kg', unit), unit)
			: cleanFloat(convertWeight(kg, 'kg', unit), 1);
	const point = (kg: number, kind: LinePoint['kind']): LinePoint => ({
		value: display(kg, kind),
		text: oneDecimal(display(kg, kind)),
		kind
	});
	const series = a.e1rm.series;
	const slotKey = (day: string) => (bucket === 'month' ? day.slice(0, 7) : mondayOf(day));
	const slotIndex = new Map(series.map((p, i) => [slotKey(p.at), i]));
	const maxes = series.map<LinePoint | null>(() => null);
	for (const marker of a.e1rm.markers) {
		const i = marker.on === null ? undefined : slotIndex.get(slotKey(marker.on));
		if (i === undefined || (maxes[i] && maxes[i].value >= display(marker.kg, marker.kind)))
			continue;
		maxes[i] = point(marker.kg, marker.kind);
	}
	const title = `${a.exercise.name} · estimated 1RM`;
	const data: LineChartData = {
		title,
		unit,
		slots: series.map((p) => slotOf(p, bucket)),
		series: [
			{
				key: 'e1rm',
				label: 'Estimated 1RM',
				token: SERIES_TOKEN.strength,
				points: series.map((p) => (p.value === null ? null : point(p.value, 'estimated')))
			},
			...(maxes.some(Boolean)
				? [{ key: 'profile', label: 'Profile 1RM', token: '--chart-muted' as const, points: maxes }]
				: [])
		]
	};
	const complete = series.filter((p) => !p.inProgress && p.value !== null);
	const [first, last] = [complete[0], complete.at(-1)];
	const summary =
		!first || !last
			? 'No estimate in these weeks yet.'
			: complete.length === 1
				? `One estimate in these weeks: ${last.text}.`
				: spanSentence('Estimated 1RM', first.text!, last.text!, a.e1rm.value?.text);
	const trend = a.trendWindow.sameAsPeriod ? [] : [a.trendWindow.label];
	return {
		id: 'e1rm',
		title,
		context: [period, 'Estimated from your sets', ...trend],
		summary,
		table: lineTable(data, bucket === 'month' ? 'Month' : 'Week'),
		data,
		plotted: series.some((p) => p.value !== null)
	};
}

/** The lift's figures as the screen shows them, in the profile's units. */
export function exerciseDetail(a: ExerciseAnalytics): ExerciseDetail {
	const period = PERIOD_LABEL[a.window.period];
	const { exercise, availability } = a;
	const metric = METRICS.e1rm;
	const tags = [
		MOVEMENT_PATTERN_LABEL[exercise.pattern],
		...exercise.primaryMuscles.slice(0, MUSCLE_TAGS).map((m) => MUSCLE_LABEL[m]),
		...(exercise.custom ? ['Your exercise'] : []),
		...(exercise.retired ? ['Retired'] : [])
	];
	const e1rm = tileOf(a, a.e1rm, 'Best estimated 1RM');
	return {
		id: exercise.id,
		name: exercise.name,
		tags,
		waiting: availability.ready ? null : { have: availability.have, need: availability.need },
		context: {
			period,
			// The tile's own comparison: none when it has no earlier period to show a change on.
			comparison: e1rm.delta ? `Compared with ${e1rm.delta.against}` : null,
			trend: a.trendWindow.sameAsPeriod ? null : a.trendWindow.label,
			good: metric.good.words,
			method: metric.method,
			caveat: metric.caveat ?? null
		},
		verdict: e1rm.verdict!,
		window: e1rm.window!,
		e1rm,
		chart: e1rmChart(a, period),
		markers: a.e1rm.markers.map((m) => ({
			...{ label: m.label, kind: m.kind, kg: m.kg, text: m.text },
			on: m.on === null ? null : shortDate(m.on)
		})),
		topSets: a.topSets.sessions.toReversed().map((top) => ({
			...{ key: top.workoutId, text: top.text, inProgress: top.inProgress },
			on: shortDate(top.on)
		})),
		repMaxes: a.repMaxes.map(({ reps, record, previous }) => ({
			reps,
			kg: record?.value ?? null,
			text: record?.text ?? null,
			on: record ? shortDate(record.on) : null,
			previous: previous ? `was ${previous.text} · ${shortDate(previous.on)}` : null
		})),
		prs: {
			e1rm: a.prs.e1rm.map(prView).toReversed(),
			volume: a.prs.volume.map(prView).toReversed()
		},
		rpe: tileOf(a, a.rpeDeviation, 'RPE against target'),
		recent: a.recent.map((session) => {
			const working = session.sets.filter((set) => !set.isWarmup && !set.isSkipped);
			const top = working.reduce<(typeof working)[number] | null>(
				(best, set) =>
					!best ||
					(set.weightKg ?? 0) > (best.weightKg ?? 0) ||
					((set.weightKg ?? 0) === (best.weightKg ?? 0) && (set.reps ?? 0) > (best.reps ?? 0))
						? set
						: best,
				null
			);
			const best =
				top === null
					? null
					: top.weightKg === null
						? `${top.reps ?? 0} reps`
						: `${weight(top.weightKg, a.units).text}${top.reps === null ? '' : ` × ${top.reps}`}`;
			const sets = `${working.length} ${working.length === 1 ? 'set' : 'sets'}`;
			return {
				id: session.workoutId,
				title: session.title ?? exercise.name,
				on: shortDate(session.on),
				summary: best ? `${sets} · best ${best}` : sets
			};
		})
	};
}

/** The exercise detail on the owner's day at `now`: 404 for an unknown id, failing soft otherwise. */
export async function loadExerciseDetail(
	ownerId: string,
	{ exerciseId, period, origin }: ExerciseDetailRequest,
	now: Date,
	{
		db,
		errorsDb,
		analytics = getExerciseAnalytics,
		record = recordServerError,
		today: dayOf = ownerToday
	}: ExerciseDetailDeps = {}
): Promise<ExerciseDetailData> {
	try {
		const today = await dayOf(ownerId, now, { db });
		const a = await analytics(resolveDeps({ db }).db, ownerId, exerciseId, { period, today });
		return { failed: false, period, detail: exerciseDetail(a) };
	} catch (err) {
		if (err instanceof TrainingNotFoundError) error(404, 'Not found');
		await record(
			{
				...{ error: err, kind: 'load', status: 500, ...origin },
				context: { load: 'progress-exercise', period }
			},
			{ db: errorsDb }
		);
		return { failed: true, period };
	}
}
