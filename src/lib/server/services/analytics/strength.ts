/**
 * The Strength view's figures (PRD §10) in one call: key lifts, weekly tonnage and hard sets,
 * muscle groups against their block's range, RPE and its deviation from target, and the period's
 * PRs. Every number comes from domain/analytics on the facts loader's rows; nothing is redefined.
 *
 * - Each figure carries its metric id, kind, method and caveat (metrics.ts), its availability,
 *   its value over the period's complete weeks, its comparison with the previous period (kpi),
 *   its verdict over trendWindow(period) (trendOf, which names that window) and display strings
 *   in the profile's units (format.ts). Until a figure has its metric's least data it has no value.
 * - Totals, verdicts and comparisons read complete weeks only. The week in progress is the last
 *   point of each series, flagged, and tonnage and hard sets add a 'This week so far' line against
 *   the same days of last week.
 * - Facts are read over the longer of the period and its trend window, with the previous period
 *   before them and the week in progress after.
 * - PRs: a record is judged against every earlier completed workout (RECORDS_FROM), so the sets
 *   before those weeks are read too; the period's PRs, the week in progress included, are listed
 *   newest first, at most PRS_MAX.
 * - `headline` (the overview) stops at the key lifts and tonnage, and skips the reads only the
 *   rest needs: sessions, prescriptions, earlier sets and muscle targets.
 * - Reads run one at a time, so `db` may be a transaction.
 */
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import { METRICS, type MetricId } from '../../../domain/analytics/metrics';
import {
	goodness,
	kpi,
	soFarLine,
	trendOf,
	type Goodness,
	type Kpi,
	type MetricTrend,
	type SoFarLine
} from '../../../domain/analytics/overview';
import {
	periodWindow,
	sameDaysLastWeek,
	trendWindow,
	type Period,
	type PeriodWindow,
	type TrendWindow,
	type WeekRange
} from '../../../domain/analytics/periods';
import {
	exposure,
	matchPrescription,
	rpeDeviationSummary,
	type Exposure,
	type PlannedLines
} from '../../../domain/analytics/prescribed';
import {
	byMonth,
	fillWeeks,
	mean,
	soFar,
	totalOf,
	type Timed
} from '../../../domain/analytics/series';
import {
	keyLifts,
	measuredMaxes,
	muscleGroupWeeks,
	prTimeline,
	rpeSummary,
	weeklyHardSets,
	weeklyRpe,
	weeklyTonnage,
	e1rmSeries,
	type GroupSets,
	type GroupWeek,
	type MaxPoint,
	type StrengthPr
} from '../../../domain/analytics/strength';
import type { Availability, MetricKind, SeriesPoint } from '../../../domain/analytics/types';
import { isHardSet } from '../../../domain/training/metrics';
import { MUSCLE_GROUPS } from '../../../domain/training/vocabulary';
import { cleanFloat } from '../../../domain/units';
import { isWorking, volumeOf } from '../../../domain/workout/logging';
import type { SetFact } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { factsSource, type DashboardDeps } from './facts';
import { displayUnits, formatIn, weight, type DisplayUnits, type Shown } from './format';
import { getMuscleTargets, type WeekTarget } from './targets';

/** The most PRs the view lists, newest first; `prs.total` counts them all. */
export const PRS_MAX = 8;

/**
 * Which earlier training a PR must beat: every completed workout ever, not only the weeks the
 * figures read, so a lift back to an old best after a break is no PR. Change it to 'loaded' to
 * judge records over the weeks read for the figures only (cheaper on a long history).
 */
export const RECORDS_FROM: 'all' | 'loaded' = 'all';

export interface StrengthDashboardOptions {
	period: Period;
	/** The owner's calendar day (ownerToday). */
	today: IsoDate;
	/** Only what the overview shows (StrengthHeadline): no muscle groups, RPE or PRs to read. */
	headline?: boolean;
	/**
	 * Muscle groups for the period's last `lastGroupWeeks` complete weeks and the week in progress
	 * only, so their targets are read for those weeks alone (Progress lists RANGE_WEEKS of them);
	 * every week of the period unless given.
	 */
	lastGroupWeeks?: number;
}

export type StrengthDashboardDeps = DashboardDeps;

/** A series point with its value as shown; null for a gap. */
export type ShownPoint = SeriesPoint & { text: string | null };

/** What every figure says about itself: the catalogue's context and whether it can show yet. */
export interface FigureContext {
	metric: MetricId;
	label: string;
	kind: MetricKind;
	method: string;
	caveat: string | null;
	availability: Availability;
}

export interface Figure extends FigureContext {
	/** Over the period's complete weeks; null until available or with nothing logged. */
	value: Shown | null;
	comparison: Kpi;
	/** The verdict and the weeks it read (trendWindow: 'Trend over the last 12 weeks'). */
	trend: MetricTrend;
	goodness: Goodness | null;
	/** The period's complete weeks (by month for a long 'all'), then the week in progress. */
	series: ShownPoint[];
}

export interface WeeklyFigure extends Figure {
	soFar: SoFarLine;
}

export interface KeyLiftFigure extends Figure {
	exerciseId: string;
	name: string;
	baselineLift: ExerciseDef['baselineLift'];
	/** The profile's 1RMs of the lift, never part of the e1RM series. */
	markers: (MaxPoint & { text: string })[];
}

export interface GroupWeekFigure extends GroupWeek, Pick<WeekTarget, 'source' | 'label' | 'band'> {
	volumeFactor: number;
	groups: (GroupSets & { planned: number | null; goodness: Goodness | null })[];
}

export interface LiftRpe {
	exerciseId: string;
	name: string;
	average: Shown | null;
	rated: number;
	deviation: Shown | null;
	deviations: number;
	/** Mean RPE done and planned over the deviation's own sets; null without one. */
	againstTarget: { actual: number; target: number } | null;
}

export type DashboardPr = StrengthPr & {
	exerciseId: string;
	name: string;
	text: string;
	previousText: string;
};

export interface StrengthDashboard {
	window: PeriodWindow;
	trendWindow: TrendWindow;
	units: DisplayUnits;
	keyLifts: KeyLiftFigure[];
	tonnage: WeeklyFigure;
	hardSets: WeeklyFigure;
	muscleGroups: FigureContext & { weeks: GroupWeekFigure[] };
	rpe: { average: Figure; deviation: Figure; byLift: LiftRpe[] };
	prs: { items: DashboardPr[]; total: number };
}

/** What the overview shows of strength: the key lifts and tonnage, worked out as the view does. */
export type StrengthHeadline = Pick<
	StrengthDashboard,
	'window' | 'trendWindow' | 'units' | 'keyLifts' | 'tonnage'
>;

const within = (day: IsoDate, range: Pick<WeekRange, 'from' | 'to'> | null) =>
	range !== null && range.from <= day && day <= range.to;

const earliest = (...days: (IsoDate | undefined)[]) =>
	days.filter((day) => day !== undefined).sort()[0]!;

function availabilityOf(id: MetricId, have: number): Availability {
	const { need, unit } = METRICS[id].minData;
	return have >= need ? { ready: true } : { ready: false, have, need, unit };
}

function contextOf(id: MetricId, have: number): FigureContext {
	const { label, kind, method, caveat } = METRICS[id];
	return { metric: id, label, kind, method, caveat, availability: availabilityOf(id, have) };
}

/** `of` for a range, worked out once per range (by its dates) and kept for the call. */
function byRange<T>(of: (range: WeekRange | null) => T): (range: WeekRange | null) => T {
	const known = new Map<string, T>();
	return (range) => {
		const key = range ? `${range.from}/${range.to}` : '';
		if (!known.has(key)) known.set(key, of(range));
		return known.get(key)!;
	};
}

/** The highest of dated values in each week, keyed by its Monday. */
function weeklyBest(values: readonly { on: IsoDate; value: number }[]): Map<IsoDate, number> {
	const best = new Map<IsoDate, number>();
	for (const { on, value } of values) {
		const week = mondayOf(on);
		best.set(week, Math.max(best.get(week) ?? value, value));
	}
	return best;
}

export async function getStrengthDashboard(
	db: Executor,
	ownerId: string,
	options: StrengthDashboardOptions & { headline: true },
	deps?: StrengthDashboardDeps
): Promise<StrengthHeadline>;
export async function getStrengthDashboard(
	db: Executor,
	ownerId: string,
	options: StrengthDashboardOptions & { headline?: false },
	deps?: StrengthDashboardDeps
): Promise<StrengthDashboard>;
export async function getStrengthDashboard(
	db: Executor,
	ownerId: string,
	{ period, today, headline = false, lastGroupWeeks }: StrengthDashboardOptions,
	deps: StrengthDashboardDeps = {}
): Promise<StrengthHeadline | StrengthDashboard> {
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const units = displayUnits(profile);
	const format = formatIn(units);
	const loader = factsSource(db, ownerId, timeZone, deps);

	const first = await loader(today, today).firstActivity();
	const window = periodWindow(today, period, first);
	const trend = trendWindow(window);
	const { inProgress } = window;
	const from = earliest(
		window.weeks?.from,
		trend.weeks?.from,
		window.previous?.from,
		sameDaysLastWeek(inProgress).from
	);
	const facts = loader(from, today);
	const sets = await facts.sets();
	const sessions = headline ? [] : await facts.sessions();
	const prescriptions = headline ? new Map<string, PlannedLines[]>() : await facts.prescriptions();
	const baselines = await facts.baselines();
	const earlier =
		!headline && RECORDS_FROM === 'all' && first !== null && first < from
			? await loader(first, addDays(from, -1)).sets()
			: [];
	const ids = [...new Set([...earlier, ...sets].map((set) => set.exercise))];
	const exercises = await getExercisesByIds(ownerId, ids, { db });
	const shownFrom = earliest(window.weeks?.from, trend.weeks?.from, inProgress.weekStart);
	const periodFrom = window.weeks?.from ?? inProgress.weekStart;
	const lastWeeks =
		lastGroupWeeks === undefined ? periodFrom : addDays(inProgress.weekStart, -7 * lastGroupWeeks);
	const groupsFrom = lastWeeks > periodFrom ? lastWeeks : periodFrom;
	const targets = headline
		? []
		: await getMuscleTargets(ownerId, { from: groupsFrom, to: today }, { db });

	// ---- the weeks read and the figure builder
	const lastSunday = addDays(inProgress.weekStart, -1);
	const count = daysBetween(from, inProgress.weekStart) / 7;
	const loaded = { weeks: count > 0 ? { from, to: lastSunday, count } : null, inProgress };
	const dayOf = (set: SetFact) => localDay(set.performedAt, timeZone);
	// Each figure asks for the same few ranges again (its period, the one before, its trend): each
	// range's sets and active weeks are worked out once.
	const setsIn = byRange((range) => sets.filter((set) => within(dayOf(set), range)));
	const activeWeeksIn = byRange(
		(range) => new Set(setsIn(range).map((set) => mondayOf(dayOf(set)))).size
	);
	const setsOf = Map.groupBy(sets, (set) => set.exercise);
	const activeWeeks = activeWeeksIn(window.weeks);
	const nameOf = (id: string) => exercises.get(id)?.name ?? 'Unknown exercise';
	const show = (id: MetricId, value: number) => format(METRICS[id], value, 'value');
	const signed = (id: MetricId, value: number) =>
		`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(METRICS[id], Math.abs(value), 'delta')}`;

	function figure(
		id: MetricId,
		weekly: SeriesPoint[],
		valueOf: (range: WeekRange) => number | null,
		/** The metric's data in a range: the period's says whether it has a value, the trend's a verdict. */
		have: (range: WeekRange | null) => number,
		text: (id: MetricId, value: number) => string = show
	): Figure {
		const context = contextOf(id, have(window.weeks));
		const ready = context.availability.ready;
		const at = (range: WeekRange | null) => (ready && range ? valueOf(range) : null);
		const value = at(window.weeks);
		const { previous } = window;
		const comparison = kpi(
			id,
			{ value, weeks: window.weeks },
			previous && { value: at(previous), weeks: previous },
			format
		);
		const shown = weekly.filter((p) => p.inProgress || within(p.at, window.weeks));
		const bucketed = window.bucket === 'month' ? byMonth(shown) : shown;
		return {
			...context,
			value: value === null ? null : { text: text(id, value), value },
			comparison,
			trend: trendOf(id, availabilityOf(id, have(trend.weeks)).ready ? weekly : [], window),
			goodness: goodness(id, value),
			series: bucketed.map((p) => ({ ...p, text: p.value === null ? null : text(id, p.value) }))
		};
	}
	const sum = (weekly: SeriesPoint[]) => (range: WeekRange) =>
		totalOf(weekly.filter((p) => within(p.at, range)));
	const weeklyFigure = (id: MetricId, weekly: SeriesPoint[], timed: Timed[]): WeeklyFigure => ({
		...figure(id, weekly, sum(weekly), activeWeeksIn),
		soFar: soFarLine(id, soFar(timed, inProgress, { timeZone, direction: 'up' }), format)
	});

	// ---- key lifts
	const lifts = keyLifts(
		sets.filter((set) => dayOf(set) >= shownFrom),
		exercises
	).map(({ exercise: id, baselineLift }): KeyLiftFigure => {
		const lift = exercises.get(id)!;
		const points = e1rmSeries(setsOf.get(id) ?? [], lift, timeZone);
		const weekly = fillWeeks(weeklyBest(points), loaded.weeks, 'gap', inProgress);
		const valueOf = (range: WeekRange) =>
			points
				.filter((p) => within(p.on, range))
				.reduce<number | null>((top, p) => Math.max(top ?? p.value, p.value), null);
		const have = (range: WeekRange | null) => points.filter((p) => within(p.on, range)).length;
		const markers = measuredMaxes(baselines)
			.filter((max) => baselineLift !== null && max.lift === baselineLift)
			.map((max) => ({ ...max, text: weight(max.kg, units).text }));
		return {
			...figure('e1rm', weekly, valueOf, have),
			...{ exerciseId: id, name: lift.name, baselineLift, markers }
		};
	});

	// ---- tonnage, all the overview needs besides the key lifts
	const tonnage = weeklyTonnage(sets, exercises, timeZone, loaded);
	const lifted = sets.flatMap((set): Timed[] => {
		const kg = volumeOf(set, exercises.get(set.exercise)!);
		return kg === null ? [] : [{ at: set.performedAt, value: kg }];
	});
	const tonnageFigure = weeklyFigure('tonnage', tonnage, lifted);
	if (headline)
		return { window, trendWindow: trend, units, keyLifts: lifts, tonnage: tonnageFigure };

	// ---- hard sets: every week read, worked out once; the period's weeks are some of them
	const hardSets = weeklyHardSets(sets, exercises, timeZone, loaded);
	const hardWeekly = hardSets.map(({ weekStart, inProgress: open, sets: n }) => ({
		at: weekStart,
		value: n,
		inProgress: open
	}));
	const hard = sets.flatMap((set): Timed[] =>
		isHardSet(isWorking(set), set.rpe) ? [{ at: set.performedAt, value: 1 }] : []
	);

	// ---- muscle groups against their week's range, and every group the week plans
	const byWeek = new Map(targets.map((t) => [t.weekStart, t]));
	const groupWeeks = muscleGroupWeeks(
		hardSets.filter(
			(week) =>
				week.inProgress || (within(week.weekStart, window.weeks) && week.weekStart >= groupsFrom)
		),
		new Map(targets.map((t) => [t.weekStart, t.targets]))
	).map(({ weekStart, inProgress: open, groups }): GroupWeekFigure => {
		const target = byWeek.get(weekStart);
		const planned = target?.planned?.groups ?? {};
		const judged = new Map(groups.map((g) => [g.group, g]));
		const rows = MUSCLE_GROUPS.flatMap((group): GroupSets[] => {
			const row = judged.get(group);
			if (row) return [row];
			return planned[group] ? [{ group, sets: 0, target: null, status: 'no_target' }] : [];
		});
		return {
			weekStart,
			inProgress: open,
			source: target?.source ?? 'none',
			label: target?.label ?? '',
			band: target?.band ?? null,
			volumeFactor: target?.volumeFactor ?? 1,
			groups: rows.map((g) => ({
				...g,
				planned: planned[g.group] ?? null,
				goodness: g.target === null ? null : goodness('group_sets', g.sets, g.target)
			}))
		};
	});

	// ---- RPE, and RPE against each set's target
	const rated = (range: WeekRange | null) =>
		setsIn(range).filter((set) => isWorking(set) && set.rpe !== null).length;
	const average = figure(
		'avg_rpe',
		weeklyRpe(sets, timeZone, loaded),
		(range) => rpeSummary(setsIn(range)).mean,
		rated
	);
	const byWorkout = Map.groupBy(sets, (set) => set.workoutId);
	const exposures: Exposure[] = sessions.flatMap((session) => {
		const planned = session.plannedSessionId && prescriptions.get(session.plannedSessionId);
		if (session.kind !== 'strength' || !planned) return [];
		const logged = (byWorkout.get(session.id) ?? []).toSorted(
			(a, b) => a.setIndex - b.setIndex || a.performedAt.getTime() - b.performedAt.getTime()
		);
		const context = { unit: profile.weightUnit };
		return planned.map((lines) =>
			exposure(matchPrescription(lines, logged, context), session.date)
		);
	});
	const exposuresIn = byRange((range) => exposures.filter((e) => within(e.day, range)));
	const deviationIn = byRange((range) => rpeDeviationSummary(exposuresIn(range)).overall);
	const deviationWeeks = Object.entries(rpeDeviationSummary(exposures).byWeek).flatMap(
		([week, { mean }]) => (mean === null ? [] : [[week, mean] as const])
	);
	const deviation = figure(
		'rpe_deviation',
		fillWeeks(new Map(deviationWeeks), loaded.weeks, 'gap', inProgress),
		(range) => deviationIn(range).mean,
		(range) => deviationIn(range).count,
		signed
	);
	const periodSets = setsIn(window.weeks);
	const periodExposures = exposuresIn(window.weeks);
	const periodDeviation = rpeDeviationSummary(periodExposures).byExercise;
	const periodExposuresOf = Map.groupBy(periodExposures, (e) => e.exerciseId);
	const byLift = [...Map.groupBy(periodSets, (set) => set.exercise)]
		.map(([id, liftSets]): LiftRpe => {
			const summary = rpeSummary(liftSets);
			const dev = periodDeviation[id];
			const target = mean(
				(periodExposuresOf.get(id) ?? []).flatMap((e) => (e.substituted ? [] : e.rpeTargets))
			);
			return {
				...{ exerciseId: id, name: nameOf(id), rated: summary.rated },
				average:
					summary.mean === null
						? null
						: { text: show('avg_rpe', summary.mean), value: summary.mean },
				deviation:
					dev?.mean == null ? null : { text: signed('rpe_deviation', dev.mean), value: dev.mean },
				deviations: dev?.count ?? 0,
				againstTarget:
					dev?.mean == null || target === null
						? null
						: { actual: cleanFloat(target + dev.mean, 2), target: cleanFloat(target, 2) }
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	// ---- PRs: every record broken in the period or this week, against all earlier training
	const prFrom = window.weeks?.from ?? inProgress.weekStart;
	const history = Map.groupBy([...earlier, ...sets], (set) => set.exercise);
	const shownPr = (pr: StrengthPr, value: number) =>
		pr.kind === 'most_reps' ? `${value} reps` : weight(value, units).text;
	const prs = [...history]
		.flatMap(([id, facts]) =>
			prTimeline(facts, exercises.get(id)!, timeZone)
				.filter((pr) => pr.on >= prFrom)
				.map((pr) => ({ ...pr, exerciseId: id, name: nameOf(id) }))
		)
		.sort((a, b) => (a.on === b.on ? a.name.localeCompare(b.name) : a.on < b.on ? 1 : -1));
	// Only the listed PRs are put in words: 'all' holds thousands.
	const listed = prs.slice(0, PRS_MAX).map((pr): DashboardPr => ({
		...pr,
		text: shownPr(pr, pr.value),
		previousText: shownPr(pr, pr.previous.value)
	}));

	return {
		window,
		trendWindow: trend,
		units,
		keyLifts: lifts,
		tonnage: tonnageFigure,
		hardSets: weeklyFigure('hard_sets', hardWeekly, hard),
		muscleGroups: { ...contextOf('group_sets', activeWeeks), weeks: groupWeeks },
		rpe: { average, deviation, byLift },
		prs: { items: listed, total: prs.length }
	};
}
