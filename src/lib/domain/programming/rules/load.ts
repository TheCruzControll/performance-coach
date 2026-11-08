/**
 * The load model's shares (PRD §5; M7's load model in the periodisation engine ADR): how a
 * session's load, M1's sRPE as M6 counts it, splits across the five body systems, and the RPE a
 * planned session with no target is estimated at. load/systems.ts applies them.
 *
 * Every number is a coaching judgement and a default (m7-plan open question on the coaching
 * numbers), so each row carries its reason and a change is one edit here. The numbers are
 * weights: a session's weights are divided by their sum, so its shares add to 1 and the split
 * never adds load (custom's single weight makes all of it aerobic). Mobility has no weights: it
 * loads no system, though M6 still counts its sRPE in the day's total.
 */
import type { LoadSystem } from '../evaluate/types.ts';
import type { OtherSessionKind, SessionType } from '../../training/vocabulary.ts';

/** A system's weight in a session's split; a system left out weighs 0. */
export type Weights = Readonly<Partial<Record<LoadSystem, number>>>;

export type ShareRule =
	| {
			/** Strength: lower and upper by each region's share of the hard sets. */
			by: 'sets';
			/** CNS weight: the heavy sets' share of the hard sets, times this. */
			heavyCns: number;
			/** The weights when no hard set names a region (unknown exercises, no hard sets). */
			unplaced: Weights;
			why: string;
	  }
	| {
			/** A base split, plus what the session's format adds. */
			by: 'format';
			weights: Weights;
			formats: Readonly<Partial<Record<OtherSessionKind, Weights>>>;
			why: string;
	  }
	| { by: 'fixed'; weights: Weights; why: string };

const STRENGTH: ShareRule = {
	by: 'sets',
	heavyCns: 0.5,
	unplaced: { lower: 1, upper: 1 },
	why:
		'Lifting tires the region it works: the load splits between lower and upper body by where ' +
		'the hard sets are, and heavy sets (RPE 8 or 80 % of a 1RM on a compound lift) also tax the ' +
		'nervous system, at half their share.'
};

const EASY_RUN: ShareRule = {
	by: 'fixed',
	weights: { aerobic: 1, lower: 0.15 },
	why: 'An easy run is aerobic work, with a little impact on the legs.'
};

const CONDITIONING: Weights = { aerobic: 0.6, cns: 0.3 };
const STRENGTH_CLASS: Weights = { lower: 0.4, upper: 0.4, cns: 0.2 };

/** Half of each: S&C is strength and conditioning in one session. */
const blend = (a: Weights, b: Weights): Weights =>
	Object.fromEntries(
		[...new Set([...Object.keys(a), ...Object.keys(b)])].map((system) => [
			system,
			((a[system as LoadSystem] ?? 0) + (b[system as LoadSystem] ?? 0)) / 2
		])
	);

/**
 * Each session type's split. A run of the run kind reads the long run's row when it is long by
 * M3's interference rule (90 minutes or more) and the intervals' row when it holds intervals.
 */
export const SYSTEM_SHARES: Readonly<Record<SessionType, ShareRule>> = {
	strength: STRENGTH,
	hypertrophy: STRENGTH,
	power: STRENGTH,
	easy_run: EASY_RUN,
	recovery_run: { ...EASY_RUN, why: 'A recovery run loads like an easy run, only less of it.' },
	tempo_run: {
		by: 'fixed',
		weights: { aerobic: 1, lower: 0.2 },
		why: 'A tempo run is aerobic work at a faster pace, with more impact on the legs.'
	},
	long_run: {
		by: 'fixed',
		weights: { aerobic: 1, lower: 0.3 },
		why: 'A long run is aerobic work whose impact on the legs adds up over its length.'
	},
	interval_run: {
		by: 'fixed',
		weights: { aerobic: 1, lower: 0.35, cns: 0.3 },
		why: 'Intervals are fast running: the most impact on the legs, and near-maximal efforts that tax the nervous system.'
	},
	muay_thai: {
		by: 'format',
		weights: { combat: 1, lower: 0.2 },
		formats: { pad_work: { cns: 0.2 }, sparring: { cns: 0.5 } },
		why: 'Muay Thai loads its own system and the legs that kick and move; pads add fast, hard efforts, and sparring the most.'
	},
	strength_class: {
		by: 'fixed',
		weights: STRENGTH_CLASS,
		why: 'A strength class sets its own content, so its load is taken as split across the whole body.'
	},
	conditioning: {
		by: 'fixed',
		weights: CONDITIONING,
		why: 'Conditioning is mostly aerobic, with hard efforts that tax the nervous system.'
	},
	strength_conditioning: {
		by: 'fixed',
		weights: blend(CONDITIONING, STRENGTH_CLASS),
		why: 'S&C is half conditioning and half a strength class.'
	},
	mobility: {
		by: 'fixed',
		weights: {},
		why: 'Mobility work tires nothing, so it loads no system.'
	},
	custom: {
		by: 'fixed',
		weights: { aerobic: 0.5 },
		why: 'A custom session’s content is unknown, so its load counts as general aerobic work.'
	}
};

/**
 * The RPE a planned session with no target RPE is estimated at, by type: its load is kept in its
 * own 'estimated' series, never added to the known load. Each is a typical session of its type.
 */
export const DEFAULT_RPE: Readonly<Record<SessionType, number>> = {
	strength: 7,
	hypertrophy: 7,
	power: 7,
	easy_run: 4,
	recovery_run: 3,
	tempo_run: 7,
	long_run: 5,
	interval_run: 8,
	muay_thai: 7,
	strength_class: 6,
	conditioning: 7,
	strength_conditioning: 6,
	mobility: 2,
	custom: 5
};
