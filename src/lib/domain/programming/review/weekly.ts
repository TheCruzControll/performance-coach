/**
 * The weekly review (PRD §11; M6): one completed week of facts composed into the stored snapshot
 * and findings brief that snapshot.ts and brief.ts define. Code alone, no LLM: the same input
 * gives the same bytes. Every figure comes from the analytics and programming functions (adherence,
 * trend, strength, prescribed, running, workload, results, interference), never a formula of its
 * own; src/lib/domain/README.md lists each section's source. The week is reviewed as complete, so
 * an early review counts its remaining days as rest. Pure and server-only, like domain/programming.
 */
import { addDays, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { localDay } from '../../dates.ts';
import { weekAdherence } from '../../analytics/adherence.ts';
import type { PlannedSession, WeekAdherence } from '../../analytics/adherence.ts';
import { METRICS } from '../../analytics/metrics.ts';
import type { MetricId } from '../../analytics/metrics.ts';
import { formatCanonical, goodness } from '../../analytics/overview.ts';
import type { Format } from '../../analytics/overview.ts';
import {
	CONSISTENCY,
	consistency,
	exposure,
	matchPrescription
} from '../../analytics/prescribed.ts';
import type { Exposure, PlannedLines, PrescriptionMatch } from '../../analytics/prescribed.ts';
import { LONG_RUN_JUMP_PCT, longRuns, paceByType, weeklyRunning } from '../../analytics/running.ts';
import type { RunFact } from '../../analytics/running.ts';
import { fillWeeks, mean } from '../../analytics/series.ts';
import * as strength from '../../analytics/strength.ts';
import type { GroupTargets, StrengthExercise, StrengthFact } from '../../analytics/strength.ts';
import { classifyTrend } from '../../analytics/trend.ts';
import type { TrendResult } from '../../analytics/trend.ts';
import type { SeriesPoint } from '../../analytics/types.ts';
import { ANALYTICS_VERSION } from '../../analytics/version.ts';
import * as workload from '../../analytics/workload.ts';
import type { LoggedSession, RecoveryEntry } from '../../analytics/workload.ts';
import type { SourceRef } from '../../coach/sources.ts';
import type { Discipline } from '../../profile/catalog.ts';
import type { SessionSource } from '../../training/types.ts';
import {
	MUSCLE_GROUP_LABEL,
	MUSCLE_GROUPS,
	SESSION_TYPE_LABEL,
	WEEK_KIND_LABEL
} from '../../training/vocabulary.ts';
import type * as v from '../../training/vocabulary.ts';
import { cleanFloat, convertWeight } from '../../units.ts';
import type { WeightUnit } from '../../units.ts';
import type { ExerciseTraits, InterferenceSession } from '../interference.ts';
import { checkWeek, INTERFERENCE_RULES } from '../interference.ts';
import { fatigueLevel, rpeCreep } from '../results.ts';
import { RESULT_RULES } from '../rules/results.ts';
import { SUMMARY_MAX } from './brief.ts';
import type { Finding, FindingFigure, FindingLevel, FindingSection } from './brief.ts';
import { inputsDigest } from './digest.ts';
import type { DigestFacts } from './digest.ts';
import { SNAPSHOT_VERSION } from './snapshot.ts';
import type { NextWeekState, NoProposalReason, WeeklyReviewSnapshot } from './snapshot.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/** Complete weeks before the reviewed one that the verdicts read (the M6 plan: 8). */
export const TRAILING_WEEKS = 8;

/** Mileage at this share of the plan or more is on plan. */
export const MILEAGE_ON_PLAN = 0.9;

/**
 * How a logged workout's session RPE reads as a planned intensity for the interference rules:
 * the first band it reaches, moderate without an RPE. M3's rules were written for plans; this is
 * the one bridge from a performed week to them.
 */
export const PERFORMED_INTENSITY: readonly (readonly [number, v.SessionIntensity])[] = [
	[9, 'very_hard'],
	[7, 'hard'],
	[5, 'moderate'],
	[0, 'easy']
];

/** The most records a finding cites. */
export const SOURCES_MAX = 8;

// ---- Input -----------------------------------------------------------------------------------

/** A session the reviewed week plans (M3's SessionView fits), with what the review reads of it. */
export type ReviewPlannedSession = PlannedSession & {
	title: string;
	type: v.SessionType;
	source: SessionSource;
	/** A run's planned distance; null for other sessions or a run planned by time. */
	plannedMetres: number | null;
};

/** A completed, undeleted workout with its record, its discipline and its planned lineage. */
export type ReviewWorkout = LoggedSession & {
	discipline: Discipline;
	plannedLineage: string | null;
};

/** What the review reads of an exercise: a catalogue entry fits. */
export type ReviewExercise = StrengthExercise & ExerciseTraits & { name: string };

/** One planned exercise of one completed workout, with the lines it was logged against. */
export type PrescribedExercise = PlannedLines & { workoutId: string; day: IsoDate };

/**
 * The week's muscle-group targets as services/analytics/targets.ts gives them: the block's
 * hard-set band per major group (unscaled; null without a stored target), the week's volume
 * factor, the planned hard sets per group, and the words for where the band came from.
 */
export interface VolumeTargets {
	band: GroupTargets | null;
	volumeFactor: number;
	planned: Partial<Record<v.MuscleGroup, number>> | null;
	label: string;
}

export interface WeeklyReviewInput {
	/** The reviewed week's Monday. */
	weekStartsOn: IsoDate;
	today: IsoDate;
	timeZone: string;
	/** The owner's weight unit (prescribed loads were shown in it) and distance unit. */
	unit: WeightUnit;
	distanceUnit: 'km' | 'mi';
	week: { kind: v.WeekKind | null; sessions: readonly ReviewPlannedSession[] };
	next: { state: NextWeekState; kind: v.WeekKind | null };
	/** Facts of the reviewed week and the TRAILING_WEEKS before it. */
	completedLineages: ReadonlySet<string>;
	workouts: readonly ReviewWorkout[];
	/**
	 * Every set through the reviewed week: the sections read the weeks above, the PRs all of them,
	 * so a record set before those weeks still stands.
	 */
	sets: readonly StrengthFact[];
	runs: readonly RunFact[];
	recovery: readonly RecoveryEntry[];
	prescriptions: readonly PrescribedExercise[];
	exercises: ReadonlyMap<string, ReviewExercise>;
	targets: VolumeTargets;
	digest: DigestFacts;
	/** Words in the profile's units; canonical units by default. */
	format?: Format;
}

export interface WeeklyReview {
	snapshot: WeeklyReviewSnapshot;
	summary: string;
	findings: Finding[];
	/** Every planned exercise's exposure in the weeks read, by day: what next week's rules read. */
	exposures: Exposure[];
	inputsDigest: string;
}

// ---- Helpers ---------------------------------------------------------------------------------

/** `text` cut to `max` characters with an ellipsis: a title the owner typed can be long. */
export const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The block's band scaled by the week's volume factor: a deload at 0.6 makes 10–20 into 6–12. */
export function scaledTargets(band: GroupTargets, factor: number): GroupTargets {
	return Object.fromEntries(
		Object.entries(band).map(([group, [lo, hi]]) => [
			group,
			[cleanFloat(lo * factor, 1), cleanFloat(hi * factor, 1)]
		])
	);
}

function intensityOf(rpe: number | null): v.SessionIntensity {
	if (rpe === null) return 'moderate';
	return PERFORMED_INTENSITY.find(([from]) => rpe >= from)?.[1] ?? 'easy';
}

/**
 * The week's completed workouts as the interference rules read a session: a run with its
 * segments, an other session with its kind, a strength session with one line per set done (its
 * RPE as the target, its load as an absolute load). The intensity comes from the session RPE
 * (PERFORMED_INTENSITY); the source from the planned session it completed.
 */
export function performedSessions(
	workouts: readonly (ReviewWorkout & { date: IsoDate })[],
	sets: readonly StrengthFact[],
	runs: readonly RunFact[],
	planned: readonly ReviewPlannedSession[]
): (InterferenceSession & { id: string })[] {
	const sorted = [...workouts].sort(
		(a, b) => a.startedAt.getTime() - b.startedAt.getTime() || byText(a.id, b.id)
	);
	return sorted.map((w): InterferenceSession & { id: string } => {
		const seconds =
			w.durationSeconds ?? w.run?.durationSeconds ?? (w.other?.durationMinutes ?? 0) * 60;
		const rpe = w.sessionRpe ?? w.run?.rpe ?? w.other?.rpe ?? null;
		const base = {
			id: w.id,
			date: w.date,
			timeOfDay: null,
			orderInDay: sorted.filter((o) => o.date === w.date).indexOf(w) + 1,
			type: w.sessionType,
			title: w.title,
			discipline: w.discipline,
			intensity: intensityOf(rpe),
			estMinutes: Math.round(seconds / 60),
			source: planned.find((s) => s.lineage === w.plannedLineage)?.source ?? 'generator'
		} as const;
		const run = runs.find((r) => r.workout === w.id);
		if (run || w.run) return { ...base, kind: 'run', segments: run?.segments ?? [] };
		if (w.other) return { ...base, kind: 'other', details: { kind: w.other.kind } };
		const done = sets.filter((s) => s.workoutId === w.id && !s.isSkipped && s.deletedAt === null);
		const exercises = [...new Set(done.map((s) => s.exercise))].map((key) => ({
			exercise: key.startsWith('custom:') ? { customId: key.slice(7) } : { key },
			sets: done
				.filter((s) => s.exercise === key)
				.map((s) => ({
					role: s.isWarmup ? ('warm_up' as const) : ('working' as const),
					sets: 1,
					targetRpe: s.rpe,
					loadKind: 'absolute' as const,
					loadValue: s.weight === null ? null : convertWeight(s.weight, s.unit, 'kg')
				}))
		}));
		return { ...base, kind: 'strength', exercises };
	});
}

/** A finding's verdict: its level and words. */
export type Call = readonly [FindingLevel, string];

/** A trend verdict as a finding's level and words. */
export function trendCall(result: TrendResult): Call {
	if (result.verdict === 'insufficient_data')
		return ['not_enough_data', `Not enough data yet: ${plural(result.needs.points, 'more week')}`];
	if (result.verdict === 'normal_variation') return ['neutral', 'Within normal variation'];
	const way = result.direction === 'up' ? 'Trending up' : 'Trending down';
	if (result.good === null) return ['neutral', way];
	return result.good ? ['good', `${way}, improving`] : ['watch', `${way}, declining`];
}

function adherenceWords(a: WeekAdherence, logged: number, onPlan: string | undefined): string {
	if (logged === 0 && a.planned === 0) return 'Nothing planned or logged this week';
	if (logged === 0) return `Nothing logged this week: 0 of ${plural(a.planned, 'session')} done`;
	if (a.planned === 0) return `${plural(logged, 'session')} logged, none planned`;
	return `${a.completed} of ${plural(a.planned, 'session')} done · ${onPlan ?? 'nothing due'}`;
}

const GROUP_LEVEL = { below: 'low', within: 'good', above: 'watch', no_target: 'neutral' } as const;
const FATIGUE_LEVEL = { none: 'good', watch: 'watch', high: 'low' } as const;
const PACE_METRIC: Partial<Record<v.SessionType, MetricId>> = {
	easy_run: 'pace_easy',
	long_run: 'pace_long',
	tempo_run: 'pace_tempo',
	interval_run: 'pace_intervals'
};
const RECOVERY = [
	['sleepHours', 'sleep'],
	['soreness', 'soreness'],
	['energy', 'energy'],
	['stress', 'stress']
] as const;
const WORDS = {
	baseline: 'This baseline week sets your starting point: trends start from the weeks after it',
	noIntensity: 'No loaded working set of a lift with an estimated 1RM',
	steadyLongRun: 'Within a steady step of the long run before',
	noFatigue: 'No fatigue signals this week',
	deload: '. A deload is worth considering'
};
const NEXT_WORDS: Record<NextWeekState, string> = {
	planned: 'Next week is planned',
	outline: 'Next week starts the next block of your outline: your cycle review plans it',
	new_block: 'Next week starts a new block: your cycle review plans it',
	unplanned: 'Nothing is planned for next week'
};

// ---- Compose ---------------------------------------------------------------------------------

/** The week's review: its snapshot, summary, findings, exposures and inputs digest. */
export function composeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
	const { weekStartsOn: monday, today, timeZone: tz, exercises, targets } = input;
	const format = input.format ?? formatCanonical;
	const sunday = addDays(monday, 6);
	const next = addDays(monday, 7);
	// The weeks read, oldest first: index `last` is the reviewed week.
	const last = TRAILING_WEEKS;
	const weeks = { from: addDays(monday, -7 * last), to: sunday, count: last + 1 };
	const window = { weeks, inProgress: { weekStart: next, through: next, days: 1 } };
	const dayOf = (at: Date) => localDay(at, tz);
	const inWeek = (day: IsoDate) => day >= monday && day <= sunday;
	const inWindow = (day: IsoDate) => day >= weeks.from && day <= sunday;

	const workouts = input.workouts
		.map((w) => ({ ...w, date: dayOf(w.startedAt) }))
		.filter((w) => inWindow(w.date));
	const sets = input.sets.filter((s) => s.deletedAt === null && inWindow(dayOf(s.performedAt)));
	const runs = input.runs.filter((r) => inWindow(dayOf(r.startedAt)));
	const weekWorkouts = workouts.filter((w) => inWeek(w.date));
	const weekSets = sets.filter((s) => inWeek(dayOf(s.performedAt)));
	const weekRuns = runs.filter((r) => inWeek(dayOf(r.startedAt)));
	const setsOf = Map.groupBy(sets, (s) => s.exercise);
	const everSetsOf = Map.groupBy(
		input.sets.filter((s) => s.deletedAt === null && dayOf(s.performedAt) <= sunday),
		(s) => s.exercise
	);
	const exerciseOf = (id: string) => exercises.get(id)!;
	const nameOf = (id: string) => exercises.get(id)?.name ?? id;
	const refs = (ids: Iterable<string>): SourceRef[] =>
		[...new Set(ids)]
			.sort()
			.flatMap((id) => workouts.filter((w) => w.id === id))
			.map((w) => ({ type: 'workout' as const, id: w.id, label: clip(w.title, 80), date: w.date }))
			.slice(0, SOURCES_MAX);
	const figure = (
		label: string,
		value: number | null,
		unit: FindingFigure['unit'],
		kind: FindingFigure['kind'],
		words: string
	): FindingFigure => ({
		label,
		value: value === null ? null : cleanFloat(value),
		unit,
		kind,
		words
	});
	const fig = (label: string, id: MetricId, value: number | null) => {
		const words = value === null ? 'No data' : clip(format(METRICS[id], value, 'value'), 120);
		return figure(label, value, METRICS[id].unit, METRICS[id].kind, words);
	};
	const tally = (label: string, value: number, one: string) =>
		figure(label, value, one === 'session' ? 'sessions' : null, 'calculated', plural(value, one));
	const findings: Finding[] = [];
	/** A finding; its section is its id's first part ('rpe:bench_press' → rpe). */
	const add = (
		id: string,
		label: string,
		figures: FindingFigure[],
		call: Call,
		metricId: MetricId | null = null,
		more: Partial<Finding> = {}
	) =>
		findings.push({
			id,
			section: id.split(':')[0] as FindingSection,
			label: clip(label, 120),
			figures,
			verdict: { level: call[0], words: clip(call[1], 300) },
			window: { from: monday, to: sunday, label: 'This week' },
			metricId,
			sources: [],
			...more
		});

	// Planned against completed.
	const adherence = weekAdherence(
		monday,
		{ planned: input.week.sessions, completed: input.completedLineages, workouts: weekWorkouts },
		today
	);
	const onPlan = goodness('adherence', adherence.pct);
	const counts = (['Planned', 'Completed', 'Skipped', 'Missed'] as const).map((label) =>
		tally(label, adherence[label.toLowerCase() as Lowercase<typeof label>], 'session')
	);
	const adherenceCall: Call = [
		onPlan?.level ?? 'neutral',
		adherenceWords(adherence, weekWorkouts.length, onPlan?.words)
	];
	add(
		'adherence',
		'Planned against completed',
		[...counts, fig('Adherence', 'adherence', adherence.pct)],
		adherenceCall,
		'adherence',
		{ sources: refs(weekWorkouts.map((w) => w.id)) }
	);

	// Each planned exercise's exposures, by day, and the workout each was logged in.
	const setsIn = Map.groupBy(sets, (s) => s.workoutId);
	const workoutOf = new Map<Exposure, string>();
	const matchOf = new Map<Exposure, PrescriptionMatch>();
	const exposures = input.prescriptions
		.filter((p) => inWindow(p.day))
		.map((p) => {
			const logged = (setsIn.get(p.workoutId) ?? []).map((s) => ({ ...s, exerciseId: s.exercise }));
			const match = matchPrescription(p, logged, { unit: input.unit });
			const e = exposure(match, p.day);
			workoutOf.set(e, p.workoutId);
			matchOf.set(e, match);
			return e;
		})
		.sort(
			(a, b) =>
				byText(a.day, b.day) ||
				byText(a.exerciseId, b.exerciseId) ||
				byText(workoutOf.get(a)!, workoutOf.get(b)!)
		);
	const exposuresOf = Map.groupBy(exposures, (e) => e.exerciseId);
	const weekExposures = exposures.filter((e) => inWeek(e.day) && !e.substituted);

	// A verdict per key metric over the weeks read; none in a baseline week.
	const trendOf = (id: MetricId, points: SeriesPoint[]) =>
		classifyTrend(points, { direction: METRICS[id].direction, mpc: METRICS[id].mpc });
	const e1rmTrend = new Map(
		strength.keyLifts(sets, exercises).map(({ exercise }) => {
			const best = new Map<IsoDate, number>();
			for (const p of strength.e1rmSeries(setsOf.get(exercise)!, exerciseOf(exercise), tz))
				best.set(mondayOf(p.on), Math.max(best.get(mondayOf(p.on)) ?? 0, p.value));
			return [exercise, trendOf('e1rm', fillWeeks(best, weeks, 'gap'))] as const;
		})
	);
	const tonnage = strength.weeklyTonnage(sets, exercises, tz, window);
	const mileage = weeklyRunning(runs, window, input.distanceUnit, tz);
	const loads = workload.sessionLoads(workouts, tz);
	const load = workload.weeklyLoad(loads, window);
	const baseline = input.week.kind === 'baseline';
	const trendWindow = {
		from: weeks.from,
		to: sunday,
		label: `Trend over the last ${last + 1} weeks`
	};
	const verdict = (id: string, metric: MetricId, label: string, result: TrendResult) => {
		const size = result.change === null ? null : Math.abs(result.change);
		const words = size === null ? 'No change measured' : format(METRICS[metric], size, 'delta');
		const change = figure('Change', result.change, METRICS[metric].unit, 'calculated', words);
		add(`verdicts:${id}`, label, [change], trendCall(result), metric, { window: trendWindow });
	};
	const complete = (points: SeriesPoint[]) => points.filter((p) => !p.inProgress);
	if (baseline) add('verdicts:baseline', 'Baseline established', [], ['neutral', WORDS.baseline]);
	else {
		for (const [lift, result] of e1rmTrend)
			verdict(`e1rm:${lift}`, 'e1rm', `${nameOf(lift)} estimated 1RM`, result);
		if (sets.length)
			verdict('tonnage', 'tonnage', 'Weekly tonnage', trendOf('tonnage', complete(tonnage)));
		if (runs.length)
			verdict(
				'mileage',
				'mileage',
				'Weekly distance',
				trendOf('mileage', complete(mileage.points))
			);
		const points = load.weeks.map((w) => ({ at: w.weekStart, value: w.load, inProgress: false }));
		if (workouts.length)
			verdict('srpe_load', 'srpe_load', 'Training load', trendOf('srpe_load', points));
	}

	// RPE: the week's average, and each lift against its target over its last sessions.
	const rpe = strength.rpeSummary(weekSets);
	const avg = goodness('avg_rpe', rpe.mean) ?? {
		level: 'not_enough_data',
		words: 'No RPEs logged'
	};
	if (rpe.sets > 0)
		add(
			'rpe:average',
			'Average RPE',
			[fig('Mean', 'avg_rpe', rpe.mean)],
			[avg.level, avg.words],
			'avg_rpe'
		);
	for (const lift of new Set(weekExposures.map((e) => e.exerciseId))) {
		const deviations = weekExposures
			.filter((e) => e.exerciseId === lift)
			.flatMap((e) => e.rpeDeviations);
		const deviation = mean(deviations);
		// The sets each deviation came from (exposure's own rule), so actual − target = deviation.
		const compared = weekExposures
			.filter((e) => e.exerciseId === lift)
			.flatMap((e) => matchOf.get(e)!.sets)
			.filter((m) => m.status === 'done' && m.target?.warmUp === false && !m.substitute)
			.flatMap((m) => (m.rpeDeviation === null ? [] : [[m.actual!.rpe!, m.target!.rpe!] as const]));
		const read = consistency(exposuresOf.get(lift)!);
		const good = goodness('rpe_deviation', deviation);
		const sessions = plural(read.exposures.length, 'session');
		const sign = read.verdict === 'below' ? -1 : 1;
		const times = read.exposures.filter(
			(e) => (e.meanRpeDeviation ?? 0) * sign >= CONSISTENCY.rpe
		).length;
		const way = read.verdict === 'below' ? 'easier' : 'harder';
		const call: Call =
			read.verdict === 'below' || read.verdict === 'above'
				? [
						'watch',
						`Felt about an RPE or more ${way} than prescribed in ${times} of the last ${sessions}`
					]
				: [good?.level ?? 'not_enough_data', good?.words ?? 'No RPE against a target this week'];
		add(
			`rpe:${lift}`,
			`${nameOf(lift)} RPE against target`,
			[
				fig('Mean deviation', 'rpe_deviation', deviation),
				fig('Actual', 'avg_rpe', mean(compared.map(([actual]) => actual))),
				fig('Target', 'avg_rpe', mean(compared.map(([, target]) => target)))
			],
			call,
			'rpe_deviation',
			{
				window: { from: read.exposures[0]!.day, to: sunday, label: `The last ${sessions}` },
				sources: refs(read.exposures.map((e) => workoutOf.get(e)!))
			}
		);
	}

	// Volume and intensity: tonnage, the mean % of each lift's best e1RM, hard sets per group.
	if (weekSets.length > 0) {
		const kg = [
			fig('This week', 'tonnage', tonnage[last]!.value),
			fig('The week before', 'tonnage', tonnage[last - 1]!.value)
		];
		const sources = refs(weekSets.map((s) => s.workoutId));
		add('volume:tonnage', 'Tonnage', kg, ['neutral', METRICS.tonnage.method], 'tonnage', {
			sources
		});
		const bests = new Map(
			[...setsOf].map(([id, theirs]) => [
				id,
				Math.max(0, ...strength.e1rmSeries(theirs, exerciseOf(id), tz).map((p) => p.value))
			])
		);
		const shares = weekSets.flatMap((s) => {
			const best = bests.get(s.exercise)!;
			const working = !s.isWarmup && !s.isSkipped && s.weight !== null && best > 0;
			return working ? [(convertWeight(s.weight!, s.unit, 'kg') / best) * 100] : [];
		});
		const pct = mean(shares);
		const words = pct === null ? 'No data' : `${Math.round(pct)} % of e1RM`;
		const mean1rm = figure('Mean', pct, 'pct', 'estimated', words);
		const said =
			pct === null
				? WORDS.noIntensity
				: `Working sets averaged ${words}: each lift's best in these weeks`;
		add('volume:intensity', 'Mean % of estimated 1RM', [mean1rm], ['neutral', said]);
	}
	const { band, volumeFactor: factor, planned } = targets;
	const scaled = band === null ? {} : scaledTargets(band, factor);
	const hard = strength.weeklyHardSets(sets, exercises, tz, window)[last]!;
	const done = strength.muscleGroupWeeks([hard], new Map([[monday, scaled]]))[0]!.groups;
	// A planned group with nothing done and no band still shows its planned line.
	const groups = MUSCLE_GROUPS.flatMap((group) => {
		const g = done.find((d) => d.group === group);
		if (g || planned?.[group] === undefined) return g ? [g] : [];
		return [{ group, sets: 0, target: null, status: 'no_target' as const }];
	});
	for (const g of groups) {
		const usual = band?.[g.group];
		const scaling = usual && factor !== 1 ? ` (${usual[0]}–${usual[1]} × ${factor})` : '';
		const range = g.target && `${g.target[0]}–${g.target[1]}${scaling}`;
		const words = range
			? `${goodness('group_sets', g.sets, g.target!)!.words}: ${range}`
			: targets.label;
		const plan = planned?.[g.group];
		const figures = [
			fig('Done', 'group_sets', g.sets),
			...(plan === undefined ? [] : [fig('Planned', 'group_sets', plan)]),
			...(g.target
				? [
						fig('Target low', 'group_sets', g.target[0]),
						fig('Target high', 'group_sets', g.target[1])
					]
				: [])
		];
		const label = `${MUSCLE_GROUP_LABEL[g.group]} hard sets`;
		add(`volume:sets:${g.group}`, label, figures, [GROUP_LEVEL[g.status], words], 'group_sets');
	}

	// Running: distance against the plan and the week before, pace by type, the long run.
	const plannedRuns = input.week.sessions.flatMap((s) => s.plannedMetres ?? []);
	if (weekRuns.length > 0 || plannedRuns.length > 0) {
		const done = mileage.weeks[last]!.metres;
		const plan = plannedRuns.length ? plannedRuns.reduce((a, b) => a + b, 0) : null;
		const before = mileage.weeks[last - 1]!.metres;
		const km = [
			fig('Done', 'mileage', done),
			fig('Planned', 'mileage', plan),
			fig('The week before', 'mileage', before)
		];
		const level = plan === null ? 'neutral' : done >= plan * MILEAGE_ON_PLAN ? 'good' : 'watch';
		const words = plan === null ? km[0]!.words : `${km[0]!.words} of ${km[1]!.words} planned`;
		add('running:mileage', 'Distance', km, [level, words], 'mileage', {
			sources: refs(weekRuns.map((r) => r.workout))
		});
		for (const pace of paceByType(runs, window, tz)) {
			const metric = PACE_METRIC[pace.sessionType];
			const [before, now] = [pace.points[last - 1]!.value, pace.points[last]!.value];
			if (now === null || !metric) continue;
			const paces = [fig('This week', metric, now), fig('The week before', metric, before)];
			const label = `${SESSION_TYPE_LABEL[pace.sessionType]} pace`;
			add(
				`running:pace:${pace.sessionType}`,
				label,
				paces,
				['neutral', METRICS[metric].method],
				metric
			);
		}
		const long = longRuns(runs, window, tz)[last]!;
		if (long.run) {
			const lengths = [
				fig('This week', 'long_run', long.run.metres),
				fig('The one before', 'long_run', long.previousMetres)
			];
			const jump = `${Math.round(long.changePct ?? 0)} % longer than the long run before: more than ${LONG_RUN_JUMP_PCT} %`;
			const call: Call = long.jump ? ['watch', jump] : ['neutral', WORDS.steadyLongRun];
			add('running:long_run', 'Long run', lengths, call, 'long_run', {
				sources: refs([long.run.workout])
			});
		}
	}

	// Muay Thai, recovery and fatigue.
	const thai = workload.muayThaiLoad(workouts, tz, window).weeks[last]!;
	if (thai.sessions > 0) {
		const rounds = thai.rounds.total;
		const said = rounds === null ? 'No rounds recorded' : plural(rounds, 'round');
		const figures = [
			tally('Sessions', thai.sessions, 'session'),
			fig('Time', 'training_time', thai.minutes === null ? null : thai.minutes * 60),
			fig('Load', 'muay_thai_load', thai.load),
			figure('Rounds', rounds, null, 'reported', said)
		];
		const words = `${plural(thai.sessions, 'session')}, ${thai.hard} hard (RPE ${workload.HARD_RPE} or more)`;
		add('muay_thai:load', 'Muay Thai load', figures, ['neutral', words], 'muay_thai_load');
	}
	const recovery = workload.recoverySummary(input.recovery, window).weeks[last]!;
	for (const [measure, metric] of RECOVERY) {
		const { mean: value } = recovery[measure];
		const good = goodness(metric, value);
		if (good)
			add(
				`recovery:${metric}`,
				METRICS[metric].label,
				[fig('Mean', metric, value)],
				[good.level, good.words],
				metric
			);
	}
	const first = loads.map((l) => l.date).sort()[0];
	const ratio = first
		? (workload.acwr(workload.dailyLoads(loads, first, sunday))?.ratio ?? null)
		: null;
	const acwr = goodness('acwr', ratio);
	if (acwr)
		add(
			'fatigue:acwr',
			METRICS.acwr.label,
			[fig('Ratio', 'acwr', ratio)],
			[acwr.level, acwr.words],
			'acwr'
		);
	const creep = (lift: string) => rpeCreep(exposuresOf.get(lift) ?? []);
	const creeps = [...exposuresOf.keys()].flatMap((lift) => creep(lift) ?? []);
	const declining = [...e1rmTrend].filter(
		([lift, t]) =>
			t.verdict === 'real_trend' && t.good === false && (creep(lift) ?? 0) >= RESULT_RULES.rpeCreep
	);
	const missing = new Set(weekExposures.filter((e) => e.missedReps > 0).map((e) => e.exerciseId));
	const fatigue = fatigueLevel({
		acwr: ratio,
		monotony: load.weeks[last]!.monotony,
		soreness: recovery.soreness.mean,
		sleepHours: recovery.sleepHours.mean,
		rpeCreep: creeps.length ? Math.max(...creeps) : null,
		liftsMissingReps: missing.size,
		decliningLifts: declining.length
	});
	const reasons = fatigue.reasons.map((r) => clip(r.text, 200));
	const why = reasons.length
		? reasons.join('. ') + (fatigue.deload ? WORDS.deload : '')
		: WORDS.noFatigue;
	add(
		'fatigue',
		'Fatigue',
		[tally('Signals', reasons.length, 'signal')],
		[FATIGUE_LEVEL[fatigue.level], why]
	);

	// Conflicts in the week as it was performed.
	const performed = performedSessions(weekWorkouts, weekSets, weekRuns, input.week.sessions);
	const traitsOf = (ref: { key: string } | { customId: string }) =>
		exercises.get('key' in ref ? ref.key : `custom:${ref.customId}`);
	const conflicts = checkWeek(performed, { traitsOf });
	conflicts.forEach((c, n) => {
		const [headline, where] = c.message.split(/: (.*)/s) as [string, string];
		const days = { from: c.days[0]!, to: c.days.at(-1)!, label: plural(c.days.length, 'day') };
		const call: Call = ['watch', `${where} ${INTERFERENCE_RULES[c.rule].why}`];
		add(`conflicts:${n + 1}:${c.rule}`, headline, [], call, null, {
			window: days,
			sources: refs(c.sessions.map((s) => s.id))
		});
	});

	// PRs this week, then next week.
	const prs = [...setsOf.keys()]
		.sort()
		.flatMap((lift) =>
			strength
				.prTimeline(everSetsOf.get(lift)!, exerciseOf(lift), tz)
				.flatMap((pr) => (inWeek(pr.on) ? [{ lift, pr }] : []))
		);
	for (const { lift, pr } of prs) {
		const reps = pr.reps === null ? '' : ` (${pr.reps} reps)`;
		const [unit, words] =
			pr.kind === 'most_reps'
				? [null, plural(pr.value, 'rep')]
				: [
						'kg' as const,
						format(METRICS[pr.kind === 'volume' ? 'tonnage' : 'e1rm'], pr.value, 'value')
					];
		const record = figure(pr.label, pr.value, unit, pr.estimated ? 'estimated' : 'measured', words);
		const call: Call = ['good', `A new record on ${pr.on}${pr.estimated ? ', an estimate' : ''}`];
		add(
			`prs:${pr.workoutId}:${lift}:${pr.kind}${pr.reps ?? ''}`,
			`${nameOf(lift)}: ${pr.label}${reps}`,
			[record],
			call,
			null,
			{
				window: null,
				sources: refs([pr.workoutId])
			}
		);
	}
	const { state, kind } = input.next;
	const nextWords =
		state === 'planned' && kind ? `Next week: ${WEEK_KIND_LABEL[kind]}` : NEXT_WORDS[state];
	add('next', 'Next week', [], ['neutral', nextWords], null, {
		window: { from: next, to: addDays(next, 6), label: 'Next week' }
	});

	// The summary, the most important first: short fixed parts, cut to SUMMARY_MAX all the same.
	const parts = [
		adherenceCall[1].split(' · ')[0]!,
		...(baseline ? ['Baseline established'] : []),
		...(fatigue.level === 'none' ? [] : [`Fatigue: ${fatigue.level}`]),
		...(conflicts.length ? [plural(conflicts.length, 'conflict')] : []),
		...(prs.length ? [plural(prs.length, 'PR')] : []),
		...(state === 'outline' || state === 'new_block' ? ['Next week: your cycle review'] : [])
	];
	const summary = clip(`${parts.join('. ')}.`, SUMMARY_MAX);

	let noProposal: NoProposalReason | null = null;
	if (state === 'unplanned' && input.week.sessions.length === 0) noProposal = 'no_program';
	else if (state !== 'planned') noProposal = 'boundary';
	else if (today > addDays(next, 6)) noProposal = 'late';
	const digest = inputsDigest(input.digest);
	const { planned: due, completed, skipped, missed, pct } = adherence;
	const snapshot: WeeklyReviewSnapshot = {
		version: SNAPSHOT_VERSION,
		weekStartsOn: monday,
		computedOn: today,
		timeZone: tz,
		analyticsVersion: ANALYTICS_VERSION,
		inputsDigest: digest,
		adherence: { planned: due, completed, skipped, missed, pct },
		fatigue: { level: fatigue.level, reasons },
		next: { weekStartsOn: next, state, kind },
		noProposal,
		brief: { kind: 'weekly', from: monday, to: sunday, summary, findings }
	};
	return { snapshot, summary, findings, exposures, inputsDigest: digest };
}
