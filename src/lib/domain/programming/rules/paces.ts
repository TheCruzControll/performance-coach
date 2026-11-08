/**
 * Training paces and heart-rate zones (m7-plan training-paces; PRD §5). paces.ts applies them:
 * a VDOT from the owner's best recent race by the Daniels–Gilbert equations, the five training
 * intensities as shares of that VDOT, the segment kind each runs at, and heart-rate zones from
 * whatever heart rates the owner gave. Every number names its source; changing one is a one-line
 * edit here. Nothing generates from this file until generator-running.
 */
import type { RunSegment } from '../../training/types.ts';
import type { RunSegmentKind } from '../../training/vocabulary.ts';

type HrZone = NonNullable<RunSegment['hrZone']>;

// ---- VDOT ------------------------------------------------------------------------------------

/**
 * The Daniels–Gilbert equations (Daniels & Gilbert, Oxygen Power, 1979; Daniels' Running
 * Formula). At a velocity v in metres a minute, running costs
 *   VO2 = vo2[0] + vo2[1]·v + vo2[2]·v²   (ml/kg/min),
 * and a race lasting t minutes is run at a share of VO2max of
 *   %VO2max = share[0] + share[1]·e^(share[2]·t) + share[3]·e^(share[4]·t).
 * A race's VDOT is VO2 / %VO2max: the VO2max its time implies.
 */
export const DANIELS_GILBERT = {
	vo2: [-4.6, 0.182258, 0.000104],
	share: [0.8, 0.1894393, -0.012778, 0.2989558, -0.1932605]
} as const;

/**
 * The distances the equations read, in metres: Daniels' tables run from 1500 m to the marathon.
 * A race outside them is first carried to the nearer end by Riegel's formula
 * (rules/running.ts RIEGEL_EXPONENT), the only place Riegel still applies.
 */
export const VDOT_DISTANCES = { min: 1500, max: 42195 } as const;

// ---- Training intensities --------------------------------------------------------------------

/** Daniels' five training intensities: easy, marathon, threshold, interval and repetition. */
export const PACE_INTENSITIES = ['E', 'M', 'T', 'I', 'R'] as const;
export type PaceIntensity = (typeof PACE_INTENSITIES)[number];

/**
 * Each intensity as a share of VDOT, [low, high] (Daniels' Running Formula, the training-intensity
 * table): the pace whose running cost is that share of the VDOT. The high share gives the fast
 * end of the range. E 59–74 % builds the aerobic base at a conversational effort; M 75–84 % is
 * marathon race effort; T 83–88 % is comfortably hard, about an hour's race effort; I 95–100 %
 * is VO2max work; R 105–110 % is short, fast running for economy.
 */
export const TRAINING_INTENSITIES = {
	E: [0.59, 0.74],
	M: [0.75, 0.84],
	T: [0.83, 0.88],
	I: [0.95, 1],
	R: [1.05, 1.1]
} as const satisfies Record<PaceIntensity, readonly [number, number]>;

/**
 * The pace each run segment kind is set at. Easy, long, recovery, warm-up and cool-down running
 * are all aerobic, at E. Marathon-pace work runs on the steady kind at M (m7-contract: no new
 * segment kind, so logging and Progress need none; m7-plan open question 'Marathon-pace work').
 * Tempo is threshold work at T and intervals are VO2max work at I. R is computed for the coach's
 * tools and assigned to no generated segment.
 */
export const SEGMENT_PACES = {
	warm_up: 'E',
	easy: 'E',
	steady: 'M',
	tempo: 'T',
	interval: 'I',
	recovery: 'E',
	long: 'E',
	cool_down: 'E'
} as const satisfies Record<RunSegmentKind, PaceIntensity>;

/**
 * Each segment kind's heart-rate zone, as M3's rules/running.ts EFFORTS and COMMITMENT_RUN set
 * them: recovery jogs in zone 1, aerobic running in 2, marathon-pace work in 3, threshold in 4
 * and intervals in 5.
 */
export const SEGMENT_ZONES = {
	warm_up: 2,
	easy: 2,
	steady: 3,
	tempo: 4,
	interval: 5,
	recovery: 1,
	long: 2,
	cool_down: 2
} as const satisfies Record<RunSegmentKind, HrZone>;

/**
 * A told easy pace stands for the middle of the E range (as M3 read it), so it implies a VDOT:
 * the one whose pace at this share of VDOT is the told pace.
 */
export const EASY_PACE_SHARE = (TRAINING_INTENSITIES.E[0] + TRAINING_INTENSITIES.E[1]) / 2;

/** Paces are kept inside the run-segment contract's bounds, in seconds per km (schemas.ts). */
export const PACE_LIMITS = { fastest: 120, slowest: 1500 } as const;

// ---- Recency ---------------------------------------------------------------------------------

/**
 * Which race sets the paces (m7-plan open question 'Training paces'), in order:
 * 1. a dated race within `fullDays` (26 weeks) counts in full: it is current fitness
 * 2. failing that, a dated race within `lowDays` (52 weeks) counts at low confidence
 * 3. failing that, a race with no date counts at low confidence. M3 counted an undated race as the
 *    oldest, so an owner whose races carry no date keeps race-based paces. It counts when no dated
 *    race counts, so a dated race older than 52 weeks never shuts it out.
 * 4. failing that, the told easy pace (low confidence); with neither, runs are set by RPE and
 *    heart-rate zone alone
 * A dated race older than `lowDays` never counts. Within a step the best VDOT wins, the newest on
 * a tie, so a newer, slower race beats an older, faster one only across steps. A race dated after
 * the day the paces are for counts as run that day.
 */
export const RECENCY = { fullDays: 26 * 7, lowDays: 52 * 7 } as const;

// ---- Heart rate ------------------------------------------------------------------------------

/**
 * The heart-rate methods, in the order they are tried: threshold heart-rate bands (Friel), then
 * heart-rate reserve (Karvonen), then a share of max. Lactate threshold anchors zones to the
 * runner's own physiology best; heart-rate reserve accounts for fitness through the resting
 * rate; a share of max needs only one number.
 */
export const HR_METHODS = ['threshold', 'reserve', 'max'] as const;
export type HrMethod = (typeof HR_METHODS)[number];

/**
 * Zones 1 to 5 as shares, [low, high], each zone's high the next one's low.
 * - threshold: Friel's running zones as shares of lactate-threshold heart rate (Z1 under 85 %,
 *   Z2 85–89 %, Z3 90–94 %, Z4 95–99 %, Z5 100 % and over). Friel leaves zone 1 and zone 5 open;
 *   they close at 65 % and at 106 %, the top of his zone 5b, so each zone is a range.
 * - reserve: Karvonen, resting + share × (max − resting), in 10 % steps from 50 % of reserve.
 * - max: the same five 10 % bands as shares of max heart rate.
 */
export const HR_ZONE_BANDS = {
	threshold: [
		[0.65, 0.85],
		[0.85, 0.9],
		[0.9, 0.95],
		[0.95, 1],
		[1, 1.06]
	],
	reserve: [
		[0.5, 0.6],
		[0.6, 0.7],
		[0.7, 0.8],
		[0.8, 0.9],
		[0.9, 1]
	],
	max: [
		[0.5, 0.6],
		[0.6, 0.7],
		[0.7, 0.8],
		[0.8, 0.9],
		[0.9, 1]
	]
} as const satisfies Record<HrMethod, readonly (readonly [number, number])[]>;

/**
 * The heart rates zones are read from, in bpm (the ranges running-hr-db's checks allow). A value
 * outside its range, or rates out of order (resting below threshold below max), gives no zones at
 * all: numbers that cannot all be right are not guessed between.
 */
export const HR_LIMITS = {
	max: [120, 230],
	resting: [30, 110],
	threshold: [100, 225]
} as const;
