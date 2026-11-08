/**
 * The cycle review (PRD §11; M6): one finished block judged against the owner's goals and what was
 * planned, composed into the stored snapshot (cycle-snapshot.ts) and the same findings brief the
 * weekly review writes (brief.ts). Code alone, no LLM: the same input gives the same bytes.
 *
 * Every figure comes from the analytics and programming functions (adherence, strength, running,
 * workload, prescribed, trend, results), never a formula of its own; src/lib/domain/README.md
 * lists each section's source. The next block's directives read this (cycle-directives). Pure and
 * server-only at runtime, like all of domain/programming.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { localDay } from '../../dates.ts';
import { adherenceByWeekday, periodAdherence } from '../../analytics/adherence.ts';
import type { AdherenceCounts } from '../../analytics/adherence.ts';
import { METRICS } from '../../analytics/metrics.ts';
import type { MetricId } from '../../analytics/metrics.ts';
import { formatCanonical, goodness } from '../../analytics/overview.ts';
import type { Format } from '../../analytics/overview.ts';
import { consistency, exposure, matchPrescription } from '../../analytics/prescribed.ts';
import type { Exposure } from '../../analytics/prescribed.ts';
import { paceByType, weeklyRunning } from '../../analytics/running.ts';
import type { RunFact } from '../../analytics/running.ts';
import { mean } from '../../analytics/series.ts';
import * as strength from '../../analytics/strength.ts';
import type { StrengthFact } from '../../analytics/strength.ts';
import { classifyTrend } from '../../analytics/trend.ts';
import { ANALYTICS_VERSION } from '../../analytics/version.ts';
import * as workload from '../../analytics/workload.ts';
import type { RecoveryEntry } from '../../analytics/workload.ts';
import {
	LIFT_LABEL,
	RACE_DISTANCE_INFO,
	RUNNING_DISCIPLINES,
	WEEKDAY_INFO
} from '../../profile/catalog.ts';
import type { Discipline, Lift } from '../../profile/catalog.ts';
import type { Goal } from '../../profile/types.ts';
import { MUSCLE_GROUP_LABEL, MUSCLE_GROUPS, PHASE_LABEL } from '../../training/vocabulary.ts';
import type * as v from '../../training/vocabulary.ts';
import { cleanFloat, convertWeight, parseDuration } from '../../units.ts';
import type { WeightUnit } from '../../units.ts';
import { fatigueLevel, rpeCreep } from '../results.ts';
import { RESULT_RULES } from '../rules/results.ts';
import { SUMMARY_MAX } from './brief.ts';
import type { Finding, FindingFigure, FindingSection } from './brief.ts';
import { CYCLE_SNAPSHOT_VERSION } from './cycle-snapshot.ts';
import type {
	CycleReviewSnapshot,
	DeloadNeed,
	EffectivenessVerdict,
	GoalMeasure
} from './cycle-snapshot.ts';
import { inputsDigest } from './digest.ts';
import type { DigestFacts } from './digest.ts';
import { LIGHT_WEEK_KINDS } from './next-week.ts';
import { clip, plural, scaledTargets, trendCall } from './weekly.ts';
import type {
	Call,
	PrescribedExercise,
	ReviewExercise,
	ReviewPlannedSession,
	ReviewWorkout,
	VolumeTargets
} from './weekly.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/** Under this adherence (percentage points) the block is too thin to judge: verdicts are withheld. */
export const VERDICT_MIN_ADHERENCE = 70;

/**
 * Exercise effectiveness by estimated 1RM: too few under `minExposures` sessions; otherwise the
 * best of the later half of its sessions against the best of the earlier half, a change of at
 * least the catalogue's e1RM MPC (2.5 %) either way. Held or regressed over `stallExposures` or
 * more sessions is stalled.
 */
export const EFFECTIVENESS = { minExposures: 3, stallExposures: 4 } as const;

/** Recovery notes are read over the block's last weeks: accumulated fatigue shows at its end. */
export const FATIGUE_WEEKS = 2;

/** A block this many weeks or longer with no light week (LIGHT_WEEK_KINDS) suggests a deload. */
export const DELOAD_AFTER_WEEKS = 5;

/** A hypertrophy goal is on target when this share of its group-weeks is within range. */
export const HARD_SETS_ON_TARGET = 0.75;

/** The everyday pace a running goal's target race pace is compared with (open question). */
export const GOAL_PACE_TYPE: v.SessionType = 'tempo_run';

/** What each goal area measures, by the M2 disciplines that train it. */
export const GOAL_AREAS = {
	strength: ['powerlifting', 'weightlifting', 'strength', 'athletic'],
	hypertrophy: ['hypertrophy'],
	running: RUNNING_DISCIPLINES,
	muay_thai: ['muay_thai']
} as const satisfies Record<string, readonly Discipline[]>;
type GoalArea = keyof typeof GOAL_AREAS;

/** The race distances a running goal's words may name, the longest name first. */
const RACE_WORDS: readonly [RegExp, keyof typeof RACE_DISTANCE_INFO][] = [
	[/\bhalf[ -]?marathon\b/i, 'half_marathon'],
	[/\bmarathon\b/i, 'marathon'],
	[/\b10 ?k\b/i, '10k'],
	[/\b5 ?k\b/i, '5k']
];

// ---- Input -----------------------------------------------------------------------------------

/** One week of the block, with its targets from services/analytics/targets.ts. */
export interface CycleWeek {
	startsOn: IsoDate;
	kind: v.WeekKind | null;
	targets: VolumeTargets;
}

/** An M2 goal, as far as the review reads it. */
export type CycleGoal = Pick<
	Goal,
	'id' | 'title' | 'disciplines' | 'eventType' | 'eventDate' | 'targetPerformance' | 'measure'
>;

export interface CycleReviewInput {
	block: { lineage: string; name: string; phase: v.Phase; weeks: readonly CycleWeek[] };
	today: IsoDate;
	timeZone: string;
	unit: WeightUnit;
	distanceUnit: 'km' | 'mi';
	/** The block's planned sessions. */
	sessions: readonly ReviewPlannedSession[];
	completedLineages: ReadonlySet<string>;
	/** Every completed, undeleted workout through the block's end: the ACWR reads from the first. */
	workouts: readonly ReviewWorkout[];
	sets: readonly StrengthFact[];
	runs: readonly RunFact[];
	recovery: readonly RecoveryEntry[];
	prescriptions: readonly PrescribedExercise[];
	exercises: ReadonlyMap<string, ReviewExercise>;
	goals: readonly CycleGoal[];
	previous: { from: IsoDate; to: IsoDate; summary: string; adherencePct: number | null } | null;
	/** The next outline block, or null when none is left. */
	next: {
		name: string;
		phase: v.Phase;
		startsOn: IsoDate;
		firstWeekKind: v.WeekKind | null;
	} | null;
	digest: DigestFacts;
	format?: Format;
}

export interface CycleReview {
	snapshot: CycleReviewSnapshot;
	summary: string;
	findings: Finding[];
	effectiveness: CycleReviewSnapshot['effectiveness'];
	fatigue: CycleReviewSnapshot['fatigue'];
	deloadNeed: CycleReviewSnapshot['deloadNeed'];
	inputsDigest: string;
}

// ---- Goal targets ------------------------------------------------------------------------------

/**
 * A strength goal's target, read only from words that are one profile lift's name and one load
 * ('Bench press 140 kg'); null otherwise ('Incline bench press 80 kg'), so it is never guessed.
 */
export function strengthTarget(text: string | null): { lift: Lift; kg: number } | null {
	if (!text) return null;
	const loads = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|lbs?)\b/gi)];
	if (loads.length !== 1) return null;
	const [load, value, unit] = loads[0]!;
	const rest = text
		.replace(load, ' ')
		.replace(/[\s:,.]+/g, ' ')
		.trim()
		.toLowerCase();
	const lift = (Object.keys(LIFT_LABEL) as Lift[]).find(
		(l) => l !== 'custom' && LIFT_LABEL[l].toLowerCase() === rest
	);
	if (!lift) return null;
	const kg = convertWeight(Number(value), unit!.toLowerCase() === 'kg' ? 'kg' : 'lb', 'kg');
	return { lift, kg: cleanFloat(kg, 2) };
}

/** A running goal's target race pace in s/km, from a race distance and one finish time. */
export function racePaceTarget(goal: CycleGoal): number | null {
	const target = goal.targetPerformance ?? goal.measure;
	const words = [goal.eventType, goal.title, target].join(' ');
	const race = RACE_WORDS.find(([pattern]) => pattern.test(words))?.[1];
	const times = (target ?? '').match(/\b\d{1,2}(?::\d{2}){1,2}\b/g) ?? [];
	const seconds = times.length === 1 ? parseDuration(times[0]!) : null;
	const metres = race ? RACE_DISTANCE_INFO[race].metres : null;
	return seconds && metres ? cleanFloat((seconds / metres) * 1000, 1) : null;
}

// ---- Compose -----------------------------------------------------------------------------------

const VERDICT_CALL: Record<EffectivenessVerdict, Call[0]> = {
	progressed: 'good',
	held: 'neutral',
	regressed: 'watch',
	too_few: 'not_enough_data'
};
const FATIGUE_CALL = { none: 'good', watch: 'watch', high: 'low' } as const;
const DELOAD_CALL = { needed: 'low', consider: 'watch', not_needed: 'good' } as const;
const DELOAD_WORDS: Record<DeloadNeed, string> = {
	needed: 'A deload is needed',
	consider: 'A deload is worth considering',
	not_needed: 'No deload needed'
};

/** The finished block's review: snapshot, summary, findings, effectiveness, fatigue, deload need. */
export function evaluateCycle(input: CycleReviewInput): CycleReview {
	const { block, today, timeZone: tz, exercises } = input;
	const format = input.format ?? formatCanonical;
	if (block.weeks.length === 0) throw new RangeError('A block has at least one week');
	const from = block.weeks[0]!.startsOn;
	const to = addDays(block.weeks.at(-1)!.startsOn, 6);
	const weeks = { from, to, count: block.weeks.length };
	const window = {
		weeks,
		inProgress: { weekStart: addDays(to, 1), through: addDays(to, 1), days: 1 }
	};
	const blockWindow = { from, to, label: `The block, ${plural(weeks.count, 'week')}` };
	const dayOf = (at: Date) => localDay(at, tz);
	const inBlock = (day: IsoDate) => day >= from && day <= to;

	const allWorkouts = input.workouts
		.map((w) => ({ ...w, date: dayOf(w.startedAt) }))
		.filter((w) => w.date <= to);
	const workouts = allWorkouts.filter((w) => inBlock(w.date));
	const sets = input.sets.filter((s) => s.deletedAt === null && inBlock(dayOf(s.performedAt)));
	const runs = input.runs.filter((r) => inBlock(dayOf(r.startedAt)));
	const nameOf = (id: string) => exercises.get(id)?.name ?? id;
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
	const fig = (label: string, id: MetricId, value: number | null, kind = METRICS[id].kind) =>
		figure(
			label,
			value,
			METRICS[id].unit,
			kind,
			value === null ? 'No data' : clip(format(METRICS[id], value, 'value'), 120)
		);
	const tally = (label: string, value: number, one: string) =>
		figure(label, value, one === 'session' ? 'sessions' : null, 'calculated', plural(value, one));
	const findings: Finding[] = [];
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
			window: blockWindow,
			metricId,
			sources: [],
			...more
		});

	// Adherence: the block, each week and each weekday.
	const facts = { planned: input.sessions, completed: input.completedLineages, workouts };
	const asOf = { ...window, inProgress: { weekStart: mondayOf(today), through: today, days: 1 } };
	const adherence = periodAdherence(facts, asOf);
	const weekdays = adherenceByWeekday(facts, weeks, today);
	const oftenMissed = weekdays.filter((d) => d.oftenMissed).map((d) => d.weekday);
	const { pct } = adherence.total;
	const withheld = pct === null || pct < VERDICT_MIN_ADHERENCE;
	const countsOf = (c: AdherenceCounts) => ({
		planned: c.planned,
		completed: c.completed,
		skipped: c.skipped,
		missed: c.missed,
		pct: c.pct
	});
	const done = `${adherence.total.completed} of ${plural(adherence.total.planned, 'session')} done`;
	const onPlan = goodness('adherence', pct);
	const previous = input.previous
		? [fig('Previous block', 'adherence', input.previous.adherencePct)]
		: [];
	add(
		'adherence',
		'Planned against completed',
		[fig('Adherence', 'adherence', pct), ...previous],
		[onPlan?.level ?? 'neutral', onPlan ? `${done} · ${onPlan.words}` : done],
		'adherence'
	);
	for (const [n, week] of adherence.weeks.entries()) {
		const words = `${week.completed} of ${plural(week.planned, 'session')} done`;
		add(
			`adherence:week:${n + 1}`,
			`Week ${n + 1}`,
			[fig('Adherence', 'adherence', week.pct)],
			[goodness('adherence', week.pct)?.level ?? 'neutral', words],
			'adherence',
			{
				window: { from: week.weekStart, to: addDays(week.weekStart, 6), label: `Week ${n + 1}` }
			}
		);
	}
	for (const day of oftenMissed) {
		const missed = weekdays.find((d) => d.weekday === day)!.missed;
		const label = `${WEEKDAY_INFO[day].label}s often missed`;
		add(
			`adherence:weekday:${day}`,
			label,
			[tally('Missed', missed, 'session')],
			['watch', `${plural(missed, 'session')} missed on ${WEEKDAY_INFO[day].label}s this block`]
		);
	}
	const WITHHELD: Call = [
		'not_enough_data',
		`Withheld: ${pct === null ? 'no sessions were due' : `only ${Math.round(pct)} % of sessions were done`}, too few to judge the block`
	];

	// Exercise effectiveness by estimated 1RM, for every exercise the block prescribed.
	const prescribed = input.prescriptions.filter((p) => inBlock(p.day));
	const setsIn = Map.groupBy(
		input.sets.filter((s) => s.deletedAt === null),
		(s) => s.workoutId
	);
	const exposures: Exposure[] = prescribed.map((p) =>
		exposure(
			matchPrescription(
				p,
				(setsIn.get(p.workoutId) ?? []).map((s) => ({ ...s, exerciseId: s.exercise })),
				{ unit: input.unit }
			),
			p.day
		)
	);
	const exposuresOf = Map.groupBy(exposures, (e) => e.exerciseId);
	const mpc = METRICS.e1rm.mpc.rel ?? 0;
	const effectiveness = [...new Set(prescribed.map((p) => p.exerciseId))].sort().flatMap((id) => {
		const exercise = exercises.get(id);
		const theirs = sets.filter((s) => s.exercise === id);
		if (!exercise) return [];
		const points = theirs.length ? strength.e1rmSeries(theirs, exercise, tz) : [];
		const main =
			exercise.baselineLift !== null &&
			prescribed.some((p) => p.exerciseId === id && p.lines.some((l) => l.role === 'top'));
		const half = Math.floor(points.length / 2);
		const best = (list: typeof points) =>
			list.length ? Math.max(...list.map((p) => p.value)) : null;
		const [firstKg, lastKg] = [
			best(points.slice(0, half)),
			best(points.slice(points.length - half))
		];
		const change = firstKg && lastKg ? (lastKg - firstKg) / firstKg : 0;
		const verdict: EffectivenessVerdict =
			points.length < EFFECTIVENESS.minExposures
				? 'too_few'
				: change >= mpc
					? 'progressed'
					: change <= -mpc
						? 'regressed'
						: 'held';
		const stalled =
			(verdict === 'held' || verdict === 'regressed') &&
			points.length >= EFFECTIVENESS.stallExposures;
		const round = (kg: number | null) => (kg === null ? null : cleanFloat(kg, 2));
		return [
			{
				exercise: id,
				main,
				verdict,
				exposures: points.length,
				firstKg: round(firstKg),
				lastKg: round(lastKg),
				stalled
			}
		];
	});
	for (const e of effectiveness) {
		const kg =
			e.firstKg === null
				? []
				: [fig('Earlier best', 'e1rm', e.firstKg), fig('Later best', 'e1rm', e.lastKg)];
		const delta =
			e.firstKg && e.lastKg ? format(METRICS.e1rm, Math.abs(e.lastKg - e.firstKg), 'delta') : '';
		const said: Record<EffectivenessVerdict, string> = {
			progressed: `Progressed: up ${delta} over ${plural(e.exposures, 'session')}`,
			held: `Held: ${delta} change over ${plural(e.exposures, 'session')}`,
			regressed: `Regressed: down ${delta} over ${plural(e.exposures, 'session')}`,
			too_few: `Too few sessions to judge: ${e.exposures} of ${EFFECTIVENESS.minExposures}`
		};
		const call: Call =
			withheld && e.verdict !== 'too_few'
				? WITHHELD
				: [VERDICT_CALL[e.verdict], said[e.verdict] + (e.stalled ? '. Stalled' : '')];
		add(
			`effectiveness:${e.exercise}`,
			`${nameOf(e.exercise)}${e.main ? ' (main lift)' : ''}`,
			[...kg, tally('Sessions', e.exposures, 'session')],
			call,
			'e1rm'
		);
		if (e.main)
			add(
				`verdicts:e1rm:${e.exercise}`,
				`${nameOf(e.exercise)} estimated 1RM`,
				kg,
				withheld ? WITHHELD : call,
				'e1rm'
			);
	}
	const mains = effectiveness.filter((e) => e.main);
	const progressed = mains.filter((e) => e.verdict === 'progressed').length;
	const liftsSaid = `${progressed} of ${plural(mains.length, 'main lift')} progressed`;
	if (mains.length)
		add(
			'verdicts:strength',
			'Strength progression',
			[],
			withheld ? WITHHELD : [progressed === mains.length ? 'good' : 'neutral', liftsSaid]
		);

	// Endurance progression: weekly distance over the block.
	const mileage = weeklyRunning(runs, window, input.distanceUnit, tz);
	if (runs.length) {
		const km = mileage.weeks.map((w) => w.metres);
		const trend = classifyTrend(mileage.points, {
			direction: METRICS.mileage.direction,
			mpc: METRICS.mileage.mpc
		});
		const figures = [
			fig('First week', 'mileage', km[0]!),
			fig('Last week', 'mileage', km.at(-1)!),
			fig('Weekly mean', 'mileage', mean(km))
		];
		add(
			'verdicts:mileage',
			'Weekly distance',
			figures,
			withheld ? WITHHELD : trendCall(trend),
			'mileage'
		);
	}

	// Volume and intensity: planned against achieved hard sets per group per week, against the range.
	const hard = strength.weeklyHardSets(sets, exercises, tz, window);
	const volume = block.weeks.flatMap(({ startsOn, targets }, n) => {
		const achieved = hard[n]!.groups;
		const range = targets.band === null ? {} : scaledTargets(targets.band, targets.volumeFactor);
		return MUSCLE_GROUPS.flatMap((group) => {
			const planned = targets.planned?.[group] ?? null;
			const band = range[group];
			const target: [number, number] | null = band ? [band[0], band[1]] : null;
			const sets = cleanFloat(achieved[group] ?? 0, 2);
			return sets === 0 && planned === null && target === null
				? []
				: [{ weekStartsOn: startsOn, group, planned, achieved: sets, target }];
		});
	});
	for (const group of MUSCLE_GROUPS) {
		const rows = volume.filter((r) => r.group === group);
		if (rows.length === 0) continue;
		const ranged = rows.filter((r) => r.target !== null);
		const within = ranged.filter(
			(r) => r.achieved >= r.target![0] && r.achieved <= r.target![1]
		).length;
		const planned = rows.some((r) => r.planned !== null)
			? rows.reduce((sum, r) => sum + (r.planned ?? 0), 0)
			: null;
		const figures = [
			fig(
				'Achieved',
				'group_sets',
				rows.reduce((sum, r) => sum + r.achieved, 0)
			),
			fig('Planned', 'group_sets', planned)
		];
		const call: Call = ranged.length
			? [
					within === ranged.length ? 'good' : 'watch',
					`Within range in ${within} of ${plural(ranged.length, 'week')}`
				]
			: ['neutral', block.weeks[0]!.targets.label];
		add(
			`volume:sets:${group}`,
			`${MUSCLE_GROUP_LABEL[group]} hard sets`,
			figures,
			call,
			'group_sets'
		);
	}
	const rpe = strength.rpeSummary(sets);
	const avg = goodness('avg_rpe', rpe.mean);
	if (avg)
		add(
			'volume:intensity',
			'Average RPE',
			[fig('Mean', 'avg_rpe', rpe.mean)],
			[avg.level, avg.words],
			'avg_rpe'
		);

	// Fatigue accumulated over the block: load trend, ACWR, monotony, RPE creep, soreness, sleep.
	const loads = workload.sessionLoads(allWorkouts, tz);
	const load = workload.weeklyLoad(loads, window);
	const loadPoints = load.weeks.map((w) => ({ at: w.weekStart, value: w.load, inProgress: false }));
	if (workouts.length)
		add(
			'fatigue:load',
			'Training load',
			[fig('Weekly mean', 'srpe_load', mean(load.weeks.flatMap((w) => w.load ?? [])))],
			trendCall(
				classifyTrend(loadPoints, {
					direction: METRICS.srpe_load.direction,
					mpc: METRICS.srpe_load.mpc
				})
			),
			'srpe_load'
		);
	const first = loads.map((l) => l.date).sort()[0];
	const ratio = first
		? (workload.acwr(workload.dailyLoads(loads, first, to))?.ratio ?? null)
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
	const lastWeeks = Math.min(FATIGUE_WEEKS, weeks.count);
	const recentFrom = addDays(to, -7 * lastWeeks + 1);
	const recovery = workload.recoverySummary(input.recovery, {
		...window,
		weeks: { from: recentFrom, to, count: lastWeeks }
	}).total;
	for (const [measure, metric] of [
		['sleepHours', 'sleep'],
		['soreness', 'soreness']
	] as const) {
		const good = goodness(metric, recovery[measure].mean);
		if (good)
			add(
				`recovery:${metric}`,
				METRICS[metric].label,
				[fig('Mean', metric, recovery[measure].mean)],
				[good.level, good.words],
				metric,
				{ window: { from: recentFrom, to, label: `The last ${plural(lastWeeks, 'week')}` } }
			);
	}
	const creepOf = new Map([...exposuresOf].map(([id, list]) => [id, rpeCreep(list)]));
	const creeps = [...creepOf.values()].flatMap((c) => c ?? []);
	const missing = [...exposuresOf.values()].filter(
		(list) => consistency(list).missed.length >= 2
	).length;
	const declining = effectiveness.filter(
		(e) => e.verdict === 'regressed' && (creepOf.get(e.exercise) ?? 0) >= RESULT_RULES.rpeCreep
	).length;
	const level = fatigueLevel({
		acwr: ratio,
		monotony: load.weeks.at(-1)!.monotony,
		soreness: recovery.soreness.mean,
		sleepHours: recovery.sleepHours.mean,
		rpeCreep: creeps.length ? Math.max(...creeps) : null,
		liftsMissingReps: missing,
		decliningLifts: declining
	});
	const nextLight = input.next?.firstWeekKind ?? null;
	const deloadPlanned = nextLight !== null && LIGHT_WEEK_KINDS.includes(nextLight);
	const fatigue = {
		level: level.level,
		reasons: level.reasons.map((r) => clip(r.text, 200)),
		deloadPlanned
	};
	const fatigueSaid =
		(fatigue.reasons.join('. ') || 'No fatigue signals this block') +
		(deloadPlanned ? '. A lighter week is already planned to open the next block' : '');
	add(
		'fatigue',
		'Accumulated fatigue',
		[
			tally('Signals', fatigue.reasons.length, 'signal'),
			fig('Monotony', 'monotony', load.weeks.at(-1)!.monotony),
			figure(
				'RPE creep',
				creeps.length ? Math.max(...creeps) : null,
				'rpe',
				'calculated',
				creeps.length ? `${cleanFloat(Math.max(...creeps), 2)} RPE` : 'No data'
			)
		],
		[FATIGUE_CALL[fatigue.level], fatigueSaid]
	);

	// Deload need, with its reasons.
	const regressedMains = mains.filter((e) => e.verdict === 'regressed');
	const reasons: string[] = [];
	if (fatigue.level !== 'none')
		reasons.push(`Fatigue is ${fatigue.level}: ${plural(fatigue.reasons.length, 'signal')}`);
	if (regressedMains.length)
		reasons.push(`${regressedMains.map((e) => nameOf(e.exercise)).join(', ')} regressed`);
	const light = block.weeks.some((w) => w.kind !== null && LIGHT_WEEK_KINDS.includes(w.kind));
	if (!light && weeks.count >= DELOAD_AFTER_WEEKS)
		reasons.push(`${plural(weeks.count, 'week')} without a lighter week`);
	const need: DeloadNeed =
		fatigue.level === 'high' || (fatigue.level === 'watch' && regressedMains.length > 0)
			? 'needed'
			: reasons.length
				? 'consider'
				: 'not_needed';
	if (deloadPlanned) reasons.push('Your next block already opens with a lighter week');
	const deloadNeed = { verdict: need, reasons: reasons.map((r) => clip(r, 200)) };
	add(
		'fatigue:deload',
		'Deload need',
		[],
		[DELOAD_CALL[need], [DELOAD_WORDS[need], ...reasons].join('. ')]
	);

	// Goal progress, per M2 goal and area; a goal with no readable target says 'no measure'.
	const goals = input.goals.flatMap((goal) => {
		const sessions = workouts.filter((w) => goal.disciplines.includes(w.discipline)).length;
		const areas = (Object.keys(GOAL_AREAS) as GoalArea[]).filter((area) =>
			goal.disciplines.some((d) => (GOAL_AREAS[area] as readonly Discipline[]).includes(d))
		);
		const counted = tally('Sessions', sessions, 'session');
		const noMeasure = (why: string): [GoalMeasure, FindingFigure[], Call] => [
			'none',
			[counted],
			['neutral', `No measure: ${why} · ${plural(sessions, 'session')} this block`]
		];
		const judged = areas.map((area): [string, GoalMeasure, FindingFigure[], Call] => {
			if (area === 'strength') {
				const target = strengthTarget(goal.targetPerformance ?? goal.measure);
				if (!target) return [area, ...noMeasure('no lift and load to read in its target')];
				const lift = effectiveness.find(
					(e) => exercises.get(e.exercise)?.baselineLift === target.lift
				);
				const kg = lift?.lastKg ?? null;
				const figures = [
					fig('Estimated 1RM', 'e1rm', kg),
					fig('Target', 'e1rm', target.kg, 'reported')
				];
				if (kg === null)
					return [
						area,
						'e1rm',
						figures,
						['not_enough_data', `No ${LIFT_LABEL[target.lift]} estimate this block`]
					];
				const gap = format(METRICS.e1rm, Math.abs(target.kg - kg), 'delta');
				return [
					area,
					'e1rm',
					figures,
					kg >= target.kg ? ['good', 'Target reached, as an estimate'] : ['neutral', `${gap} to go`]
				];
			}
			if (area === 'running') {
				const pace = racePaceTarget(goal);
				if (pace === null) return [area, ...noMeasure('no race distance and finish time to read')];
				const actual =
					paceByType(runs, window, tz).find((t) => t.sessionType === GOAL_PACE_TYPE)?.period ??
					null;
				const toEvent = goal.eventDate
					? Math.max(0, Math.floor(daysBetween(addDays(to, 1), goal.eventDate) / 7))
					: null;
				const figures = [
					fig('Weekly distance', 'mileage', mean(mileage.weeks.map((w) => w.metres))),
					fig('Tempo pace', 'pace_tempo', actual),
					fig('Target race pace', 'pace_tempo', pace, 'reported')
				];
				const when = toEvent === null ? '' : ` · ${plural(toEvent, 'week')} to the event`;
				return [
					area,
					'pace',
					figures,
					['neutral', `Target race pace ${format(METRICS.pace_tempo, pace, 'value')}${when}`]
				];
			}
			if (area === 'hypertrophy') {
				const ranged = volume.filter((r) => r.target !== null);
				if (ranged.length === 0) return [area, ...noMeasure('no stored hard-set range')];
				const within = ranged.filter(
					(r) => r.achieved >= r.target![0] && r.achieved <= r.target![1]
				).length;
				const share = within / ranged.length;
				return [
					area,
					'hard_sets',
					[tally('Within range', within, 'group-week')],
					[
						share >= HARD_SETS_ON_TARGET ? 'good' : 'watch',
						`Hard sets within range in ${within} of ${plural(ranged.length, 'group-week')}`
					]
				];
			}
			const thai = workload.muayThaiLoad(workouts, tz, window).total;
			return [
				area,
				'sessions',
				[tally('Sessions', thai.sessions, 'session'), fig('Load', 'muay_thai_load', thai.load)],
				['neutral', `${plural(thai.sessions, 'session')} this block`]
			];
		});
		if (judged.length === 0) judged.push(['none', ...noMeasure('its disciplines have no measure')]);
		return judged.map(([area, measure, figures, call]) => {
			add(`goals:${goal.id}:${area}`, clip(goal.title, 120), figures, call);
			return { goalId: goal.id, measure, sessions, level: call[0] };
		});
	});

	// What comes next.
	const next = input.next;
	add(
		'next',
		'Next block',
		[],
		[
			'neutral',
			next
				? `Next: ${next.name} (${PHASE_LABEL[next.phase]}) from ${next.startsOn}`
				: 'No outline block is left: the next block is planned by the rules'
		],
		null,
		{
			window: next ? { from: next.startsOn, to: next.startsOn, label: 'Next block' } : null
		}
	);

	const parts = [
		`${block.name}: ${done}`,
		withheld ? 'Verdicts withheld' : mains.length ? liftsSaid : null,
		fatigue.level === 'none' ? null : `Fatigue: ${fatigue.level}`,
		DELOAD_WORDS[need]
	].filter((part): part is string => part !== null);
	const summary = clip(`${parts.join('. ')}.`, SUMMARY_MAX);
	const digest = inputsDigest(input.digest);
	const snapshot: CycleReviewSnapshot = {
		version: CYCLE_SNAPSHOT_VERSION,
		block: {
			lineage: block.lineage,
			name: clip(block.name, 120),
			phase: block.phase,
			from,
			to,
			weeks: weeks.count
		},
		computedOn: today,
		timeZone: tz,
		analyticsVersion: ANALYTICS_VERSION,
		inputsDigest: digest,
		adherence: {
			...countsOf(adherence.total),
			verdictsWithheld: withheld,
			weeks: adherence.weeks.map((w) => ({ weekStartsOn: w.weekStart, ...countsOf(w) })),
			oftenMissed
		},
		goals,
		effectiveness,
		volume,
		fatigue,
		deloadNeed,
		previous: input.previous && {
			from: input.previous.from,
			to: input.previous.to,
			summary: clip(input.previous.summary, SUMMARY_MAX)
		},
		next: next && { name: clip(next.name, 120), phase: next.phase, startsOn: next.startsOn },
		brief: { kind: 'cycle', from, to, summary, findings }
	};
	return { snapshot, summary, findings, effectiveness, fatigue, deloadNeed, inputsDigest: digest };
}
