/**
 * The metric catalogue (PRD §10): every figure Progress, the reviews and the coach show, with its
 * context as data, so a tile, a review line and a coach answer never describe one number two ways.
 * Each metric has its label, its canonical unit, whether it is measured, estimated, calculated or
 * reported, which way is better, the least data it is shown with, what counts as good (with the
 * words a tile shows), a one-sentence method, any caveat, and its minimal practical change: the
 * smallest change classifyTrend may call a real trend (trend.ts).
 *
 * The 'good' bands and the minimal practical changes are coaching judgements, still open questions
 * for the owner (M6 plan): change them here, in GOOD and in each metric's `mpc`.
 *
 * Conventions for src/lib/domain/analytics (M6): pure, imported by path (no index file), no zod,
 * no runtime import of domain/programming or domain/exercises. Server-only at runtime: this is not
 * in scripts/analytics-client-imports.test.ts's CLIENT_SAFE; screens receive its words.
 */
import { HARD_SET_MIN_RPE } from '../training/metrics.ts';
import { CONSISTENCY, RPE_WITHIN } from './prescribed.ts';
import type { MinimalChange } from './trend.ts';
import type { AvailabilityUnit, Direction, MetricKind } from './types.ts';
import { ACWR_CAVEAT, CHRONIC_DAYS } from './workload.ts';

export const METRIC_AREAS = ['strength', 'running', 'general', 'recovery'] as const;
export type MetricArea = (typeof METRIC_AREAS)[number];

/**
 * Canonical units, as the services keep them: kg, metres, seconds, s/km, AU, counts, percentage
 * points, hours of sleep and the recovery notes' 1–5 scales.
 */
export type MetricUnit =
	| 'kg'
	| 'sets'
	| 'rpe'
	| 'm'
	| 's/km'
	| 'runs'
	| 'sessions'
	| 's'
	| 'pct'
	| 'AU'
	| 'ratio'
	| 'h'
	| 'scale';

export type GoodLevel = 'good' | 'watch' | 'low';

/** A closed range of values; an end left out is open. */
export interface Range {
	from?: number;
	to?: number;
}

/**
 * What counts as good, with the words a tile shows (`words`) and, for a judged value, the words
 * of each level:
 * - trend: good is a real trend the metric's better way; judged by its verdict, never by a value.
 * - bands: good within `good`, watch within any `watch` range, low otherwise (good wins on an edge).
 * - target: good within the week's target range, watch above it, low below it.
 * - none: neither more nor less is better on its own; nothing judges it.
 */
export type GoodRule =
	| { type: 'trend'; words: string }
	| {
			type: 'bands';
			words: string;
			good: Range;
			watch: readonly Range[];
			levels: Readonly<Record<GoodLevel, string>>;
	  }
	| { type: 'target'; words: string; levels: Readonly<Record<GoodLevel, string>> }
	| { type: 'none'; words: string };

export interface Metric {
	id: MetricId;
	area: MetricArea;
	label: string;
	unit: MetricUnit;
	kind: MetricKind;
	direction: Direction;
	/** The least data the metric is shown with; until then it shows what it has and needs. */
	minData: { need: number; unit: AvailabilityUnit };
	good: GoodRule;
	/** How the figure is computed, in one sentence. */
	method: string;
	caveat: string | null;
	/** True when every sentence about the metric must carry its caveat (the ACWR). */
	caveatAlways: boolean;
	/** The smallest change worth calling a trend, for classifyTrend. */
	mpc: MinimalChange;
}

/** The 'good' thresholds: coaching judgements, an open question for the owner. */
export const GOOD = {
	/** Mean working-set RPE: hard but sustainable. */
	avgRpe: { from: 6, to: 8.5 },
	/** Completed ÷ due sessions, in %: good from 80, watch from 60. */
	adherencePct: { good: 80, watch: 60 },
	/** Weekly monotony (Foster): good to 1.5, watch to 2, low above. */
	monotony: { good: 1.5, watch: 2 },
	/** Mean hours of sleep: good from 7, watch from 6. */
	sleepHours: { good: 7, watch: 6 },
	/** Mean 1–5 scales: good on the better side of 2.5, watch to 3.5 the other way. */
	scale: { good: 2.5, watch: 3.5 }
} as const;

const RISING: GoodRule = { type: 'trend', words: 'Good is a real rise over the trend window' };
const FASTER: GoodRule = {
	type: 'trend',
	words: 'Good is a real fall in pace (faster) over the trend window'
};
const CONTEXT: GoodRule = {
	type: 'none',
	words: 'Neither more nor less is better on its own: read it beside how training feels'
};

const lowerScale = (measure: string): GoodRule => ({
	type: 'bands',
	words: `Good is a mean ${measure} of ${GOOD.scale.good} or less on the 1–5 scale`,
	good: { to: GOOD.scale.good },
	watch: [{ to: GOOD.scale.watch }],
	levels: { good: `Low ${measure}`, watch: `Some ${measure}`, low: `High ${measure}` }
});

type Entry = Omit<Metric, 'id' | 'caveat' | 'caveatAlways'> &
	Partial<Pick<Metric, 'caveat' | 'caveatAlways'>>;
const week = { need: 1, unit: 'weeks' } as const;
const VOLUME: MinimalChange = { rel: 0.1 };
const PACE: MinimalChange = { rel: 0.02 };
const LOAD: MinimalChange = { rel: 0.15 };
const SCALE: MinimalChange = { abs: 0.5 };

const pace = (type: string, label: string): Entry => ({
	area: 'running',
	label: `${label} pace`,
	unit: 's/km',
	kind: 'calculated',
	direction: 'down',
	minData: { need: 1, unit: 'runs' },
	good: FASTER,
	method: `Total time ÷ total distance of your ${type} runs each week, from the part of the run that shows its type.`,
	mpc: PACE
});

/** A weekly amount that is better higher: calculated, shown from one week, a 10 % MPC. */
const volume = (area: MetricArea, label: string, unit: MetricUnit, method: string): Entry => ({
	area,
	label,
	unit,
	kind: 'calculated',
	direction: 'up',
	minData: week,
	good: RISING,
	method,
	mpc: VOLUME
});

/** A session-RPE load figure: neither more nor less is better on its own, a 15 % MPC. */
const load = (label: string, method: string, minData: Metric['minData']): Entry => ({
	area: 'general',
	label,
	unit: 'AU',
	kind: 'calculated',
	direction: 'none',
	minData,
	good: CONTEXT,
	method,
	mpc: LOAD
});

/** A recovery-note measure: the mean of what the notes report, blanks left out. */
const recovery = (
	label: string,
	unit: MetricUnit,
	direction: Direction,
	good: GoodRule,
	measure: string
): Entry => ({
	area: 'recovery',
	label,
	unit,
	kind: 'reported',
	direction,
	minData: { need: 1, unit: 'days' },
	good,
	method: `The mean of the ${measure} in your recovery notes, blanks left out.`,
	mpc: SCALE
});

const ENTRIES = {
	// ---- Strength
	e1rm: {
		area: 'strength',
		label: 'Estimated 1RM',
		unit: 'kg',
		kind: 'estimated',
		direction: 'up',
		minData: { need: 2, unit: 'sessions' },
		good: RISING,
		method:
			'The best one-rep max estimated from each session’s working sets of the lift, from the RPE chart when a set has an RPE and the Epley–Brzycki mean when not.',
		caveat: 'An estimate from your sets, not a tested max.',
		mpc: { rel: 0.025 }
	},
	top_set: {
		area: 'strength',
		label: 'Top set',
		unit: 'kg',
		kind: 'measured',
		direction: 'up',
		minData: { need: 1, unit: 'sessions' },
		good: RISING,
		method: 'Each session’s heaviest working set of the lift, the most reps breaking a tie.',
		mpc: { rel: 0.025 }
	},
	tonnage: volume(
		'strength',
		'Weekly tonnage',
		'kg',
		'Load × reps of every loaded working set in the week, in kg, a bodyweight set counting its added weight.'
	),
	hard_sets: {
		area: 'strength',
		label: 'Hard sets',
		unit: 'sets',
		kind: 'calculated',
		direction: 'up',
		minData: week,
		good: RISING,
		method: `Working sets in the week at RPE ${HARD_SET_MIN_RPE} or more (three reps or fewer in reserve), a set without an RPE counted as hard.`,
		mpc: { abs: 2 }
	},
	group_sets: {
		area: 'strength',
		label: 'Hard sets per muscle group',
		unit: 'sets',
		kind: 'calculated',
		direction: 'none',
		minData: week,
		good: {
			type: 'target',
			words: 'Good is within the week’s target range for the group',
			levels: {
				good: 'Within the target range',
				watch: 'Above the target range',
				low: 'Below the target range'
			}
		},
		method:
			'Hard sets in the week credited 1 to each primary muscle group and 0.5 to each secondary one.',
		mpc: { abs: 2 }
	},
	avg_rpe: {
		area: 'strength',
		label: 'Average RPE',
		unit: 'rpe',
		kind: 'reported',
		direction: 'none',
		minData: { need: 1, unit: 'sets' },
		good: {
			type: 'bands',
			words: `Good is a mean working-set RPE of ${GOOD.avgRpe.from}–${GOOD.avgRpe.to}: hard but sustainable`,
			good: GOOD.avgRpe,
			watch: [{ from: GOOD.avgRpe.to }],
			levels: {
				good: 'Hard but sustainable',
				watch: 'Close to your limit on most sets',
				low: 'Mostly easy sets'
			}
		},
		method: 'The mean RPE you gave your working sets, over the sets that have one.',
		mpc: SCALE
	},
	rpe_deviation: {
		area: 'strength',
		label: 'RPE against target',
		unit: 'rpe',
		kind: 'calculated',
		direction: 'none',
		minData: { need: CONSISTENCY.agree, unit: 'sets' },
		good: {
			type: 'bands',
			words: `Good is within ±${RPE_WITHIN} of the target RPE`,
			good: { from: -RPE_WITHIN, to: RPE_WITHIN },
			watch: [{ from: -CONSISTENCY.rpe, to: CONSISTENCY.rpe }],
			levels: { good: 'On target', watch: 'A little off target', low: 'Well off target' }
		},
		method: 'The mean of each set’s RPE minus its target RPE: above 0 is harder than prescribed.',
		mpc: SCALE
	},
	// ---- Running
	mileage: volume(
		'running',
		'Weekly distance',
		'm',
		'The distance of every run in the week added up.'
	),
	pace_easy: pace('easy', 'Easy'),
	pace_long: pace('long', 'Long-run'),
	pace_tempo: pace('tempo', 'Tempo'),
	pace_intervals: pace('interval', 'Interval'),
	long_run: {
		area: 'running',
		label: 'Long run',
		unit: 'm',
		kind: 'measured',
		direction: 'up',
		minData: { need: 1, unit: 'runs' },
		good: RISING,
		method:
			'Each week’s longest long run, or its longest run when at least 1.5 times the week’s mean run.',
		mpc: VOLUME
	},
	run_frequency: volume('running', 'Runs a week', 'runs', 'The runs you logged in each week.'),
	// ---- General
	sessions: volume(
		'general',
		'Sessions',
		'sessions',
		'Completed workouts in each week, planned and off plan.'
	),
	training_time: volume(
		'general',
		'Training time',
		's',
		'The recorded duration of each week’s workouts added up; a workout without one is named, never counted as 0.'
	),
	adherence: {
		area: 'general',
		label: 'Adherence',
		unit: 'pct',
		kind: 'calculated',
		direction: 'up',
		minData: week,
		good: {
			type: 'bands',
			words: `Good is ${GOOD.adherencePct.good} % or more of the sessions due done`,
			good: { from: GOOD.adherencePct.good },
			watch: [{ from: GOOD.adherencePct.watch }],
			levels: { good: 'On plan', watch: 'Some sessions missed', low: 'Many sessions missed' }
		},
		method:
			'Completed sessions ÷ the sessions due (completed, skipped and missed) over the weeks, counts added before dividing.',
		mpc: { abs: 10 }
	},
	srpe_load: load(
		'Training load',
		'Minutes × session RPE (how hard it felt, out of 10) of each workout, added up by week in arbitrary units (AU), so an hour at RPE 7 is 420 AU; a session without either is named, never counted as 0.',
		{ need: 1, unit: 'sessions' }
	),
	acwr: {
		area: 'general',
		label: 'Acute:chronic load',
		unit: 'ratio',
		kind: 'calculated',
		direction: 'none',
		minData: { need: CHRONIC_DAYS, unit: 'days' },
		good: {
			type: 'bands',
			words: `About ${ACWR_CAVEAT.typical.from}–${ACWR_CAVEAT.typical.to} is typical`,
			good: ACWR_CAVEAT.typical,
			watch: [{}],
			levels: {
				good: 'Within the typical range',
				watch: 'Outside the typical range',
				low: 'Outside the typical range'
			}
		},
		method: 'The 7-day exponentially weighted load ÷ the 28-day one, over your daily loads.',
		caveat: ACWR_CAVEAT.text,
		caveatAlways: true,
		mpc: LOAD
	},
	monotony: {
		area: 'general',
		label: 'Monotony',
		unit: 'ratio',
		kind: 'calculated',
		direction: 'down',
		minData: week,
		good: {
			type: 'bands',
			words: `Good is ${GOOD.monotony.good} or less: hard and easy days that differ`,
			good: { to: GOOD.monotony.good },
			watch: [{ to: GOOD.monotony.watch }],
			levels: { good: 'Varied days', watch: 'Days becoming alike', low: 'Every day much the same' }
		},
		method:
			'How alike a week’s days are: the mean of its seven daily loads ÷ their standard deviation, lower when hard and easy days differ.',
		mpc: LOAD
	},
	strain: load(
		'Strain',
		'A week’s load × its monotony, in arbitrary units (AU): high when a big week has no easy days.',
		week
	),
	muay_thai_load: load(
		'Muay Thai load',
		'Minutes × session RPE (how hard it felt, out of 10) of each week’s Muay Thai sessions added up, in arbitrary units (AU).',
		{ need: 1, unit: 'sessions' }
	),
	// ---- Recovery
	sleep: recovery(
		'Sleep',
		'h',
		'up',
		{
			type: 'bands',
			words: `Good is ${GOOD.sleepHours.good} hours or more a night`,
			good: { from: GOOD.sleepHours.good },
			watch: [{ from: GOOD.sleepHours.watch }],
			levels: { good: 'Sleeping enough', watch: 'A little short', low: 'Short of sleep' }
		},
		'hours of sleep'
	),
	soreness: recovery('Soreness', 'scale', 'down', lowerScale('soreness'), '1–5 soreness'),
	energy: recovery(
		'Energy',
		'scale',
		'up',
		{
			type: 'bands',
			words: `Good is a mean energy of ${6 - GOOD.scale.good} or more on the 1–5 scale`,
			good: { from: 6 - GOOD.scale.good },
			watch: [{ from: 6 - GOOD.scale.watch }],
			levels: { good: 'Good energy', watch: 'Some fatigue', low: 'Low energy' }
		},
		'1–5 energy'
	),
	stress: recovery('Stress', 'scale', 'down', lowerScale('stress'), '1–5 stress')
} as const satisfies Record<string, Entry>;

export type MetricId = keyof typeof ENTRIES;

/** Every metric id, in the catalogue's order: strength, running, general, recovery. */
export const METRIC_IDS = Object.keys(ENTRIES) as MetricId[];

/** The catalogue, by id. */
export const METRICS: Readonly<Record<MetricId, Metric>> = Object.fromEntries(
	METRIC_IDS.map((id) => {
		const entry: Entry = ENTRIES[id];
		return [
			id,
			{ ...entry, id, caveat: entry.caveat ?? null, caveatAlways: entry.caveatAlways ?? false }
		];
	})
) as Record<MetricId, Metric>;
