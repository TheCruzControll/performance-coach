/**
 * Training paces and heart-rate zones (m7-plan training-paces), by the numbers in rules/paces.ts:
 * - a race's VDOT by the Daniels–Gilbert equations, carried by Riegel only from a distance the
 *   equations do not read
 * - the race that sets the paces, by RECENCY: dated races by age, undated ones at low confidence
 * - the five training paces as ranges, the pace each run segment kind runs at, and a race time
 *   predicted from a VDOT
 * - heart-rate zones from threshold, reserve or max heart rate, whichever the owner gave
 * Unused by the generator until generator-running.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { daysBetween } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import type { RunSegmentKind } from '../training/vocabulary.ts';
import type { InputRunning } from './input.ts';
import * as P from './rules/paces.ts';
import type { HrMethod, PaceIntensity } from './rules/paces.ts';
import { RIEGEL_EXPONENT } from './rules/running.ts';

/** A race as the programming input holds it. */
export type Race = InputRunning['races'][number];
/** A pace range in seconds per km, fastest first. */
export type PaceRange = readonly [fast: number, slow: number];
export type TrainingPaces = Readonly<Record<PaceIntensity, PaceRange>>;

// ---- VDOT ------------------------------------------------------------------------------------

const [A, B, C] = P.DANIELS_GILBERT.vo2;
const [S0, S1, K1, S2, K2] = P.DANIELS_GILBERT.share;

/** The VO2 (ml/kg/min) running costs at `v` metres a minute. */
const vo2At = (v: number) => A + B * v + C * v * v;
/** The share of VO2max a race lasting `minutes` is run at. */
const shareAt = (minutes: number) => S0 + S1 * Math.exp(K1 * minutes) + S2 * Math.exp(K2 * minutes);
/** The velocity in metres a minute whose running cost is `vo2`: vo2At's inverse. */
const velocityAt = (vo2: number) => (-B + Math.sqrt(B * B - 4 * C * (A - vo2))) / (2 * C);

const readable = (metres: number) =>
	Math.min(P.VDOT_DISTANCES.max, Math.max(P.VDOT_DISTANCES.min, metres));
/** Riegel's formula: a time at `from` metres carried to `to` metres. */
const riegel = (seconds: number, from: number, to: number) =>
	seconds * (to / from) ** RIEGEL_EXPONENT;

function positive(...values: number[]) {
	for (const value of values) {
		if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`Not positive: ${value}`);
	}
}

/**
 * The VDOT a race of `metres` in `seconds` implies. A race shorter than 1500 m or longer than the
 * marathon is first carried to the nearer of them by Riegel's formula.
 */
export function vdotFromPerformance(metres: number, seconds: number): number {
	positive(metres, seconds);
	const distance = readable(metres);
	const minutes = riegel(seconds, metres, distance) / 60;
	return vo2At(distance / minutes) / shareAt(minutes);
}

/**
 * The time in whole seconds a runner of `vdot` would race `metres` in: the time whose VDOT is
 * `vdot`, by bisection, carried by Riegel's formula beyond the distances the equations read.
 */
export function raceEquivalent(vdot: number, metres: number): number {
	positive(vdot, metres);
	const distance = readable(metres);
	// Between 15 and 0.5 metres a second; a race's VDOT falls as its time grows.
	let fast = distance / 15;
	let slow = distance / 0.5;
	for (let i = 0; i < 100 && slow - fast > 1e-6; i++) {
		const mid = (fast + slow) / 2;
		if (vdotFromPerformance(distance, mid) > vdot) fast = mid;
		else slow = mid;
	}
	return Math.round(riegel((fast + slow) / 2, distance, metres));
}

/** The VDOT a told easy pace implies: the pace at EASY_PACE_SHARE of it. */
export function vdotFromEasyPace(secondsPerKm: number): number {
	positive(secondsPerKm);
	return vo2At(60_000 / secondsPerKm) / P.EASY_PACE_SHARE;
}

// ---- Paces -----------------------------------------------------------------------------------

/** The pace in whole seconds a km whose running cost is `share` of `vdot`, inside the contract. */
function paceAt(vdot: number, share: number) {
	const seconds = Math.round(60_000 / velocityAt(vdot * share));
	return Math.min(P.PACE_LIMITS.slowest, Math.max(P.PACE_LIMITS.fastest, seconds));
}

/** The five training paces for `vdot`, each a range in seconds per km, fastest first. */
export function trainingPaces(vdot: number): TrainingPaces {
	positive(vdot);
	const ranges = P.PACE_INTENSITIES.map((intensity) => {
		const [low, high] = P.TRAINING_INTENSITIES[intensity];
		return [intensity, [paceAt(vdot, high), paceAt(vdot, low)] as const] as const;
	});
	return Object.fromEntries(ranges) as Record<PaceIntensity, PaceRange>;
}

/** The pace range a run segment kind runs at (SEGMENT_PACES). */
export function paceFor(kind: RunSegmentKind, paces: TrainingPaces): PaceRange {
	return paces[P.SEGMENT_PACES[kind]];
}

/** The heart-rate zone a run segment kind runs in (SEGMENT_ZONES). */
export function zoneOf(kind: RunSegmentKind): (typeof P.SEGMENT_ZONES)[RunSegmentKind] {
	return P.SEGMENT_ZONES[kind];
}

// ---- Which race ------------------------------------------------------------------------------

/**
 * What a race counts for on `on` (RECENCY): 'full' within 26 weeks, 'low' within 52, 'undated'
 * with no date (low confidence when no race has a date), 'stale' older than 52 weeks (never).
 */
export type RaceWeight = 'full' | 'low' | 'undated' | 'stale';

export function raceWeight(race: Race, on: IsoDate): RaceWeight {
	if (race.racedOn === null) return 'undated';
	const age = Math.max(0, daysBetween(race.racedOn, on));
	return age <= P.RECENCY.fullDays ? 'full' : age <= P.RECENCY.lowDays ? 'low' : 'stale';
}

export interface Performance {
	vdot: number;
	race: Race;
	confidence: 'full' | 'low';
	dated: boolean;
	/** Why this race, in one plain sentence. */
	reason: string;
}

const WEEKS = { full: P.RECENCY.fullDays / 7, low: P.RECENCY.lowDays / 7 };
const REASONS: Readonly<Record<Exclude<RaceWeight, 'stale'>, string>> = {
	full: `It is from the last ${WEEKS.full} weeks, so it counts in full.`,
	low: `Your newest race is over ${WEEKS.full} weeks old, so it is treated as a rough guide.`,
	undated: 'The race has no date, so it is treated as a rough guide.'
};

/**
 * The race that sets the paces on `on`, or null when none counts: the best VDOT among the
 * full-weight races, failing them among the low-weight ones, failing them, when no race has a
 * date, among the undated ones. The newest wins a tie, then the earlier in `races`.
 */
export function bestRecentPerformance(races: readonly Race[], on: IsoDate): Performance | null {
	const anyDated = races.some((race) => race.racedOn !== null);
	for (const weight of ['full', 'low', 'undated'] as const) {
		if (weight === 'undated' && anyDated) break;
		let best: { race: Race; vdot: number } | null = null;
		for (const race of races) {
			if (raceWeight(race, on) !== weight) continue;
			const vdot = vdotFromPerformance(race.distanceMetres, race.timeSeconds);
			const newer = (race.racedOn ?? '') > (best?.race.racedOn ?? '');
			if (!best || vdot > best.vdot || (vdot === best.vdot && newer)) best = { race, vdot };
		}
		if (best) {
			return {
				...best,
				confidence: weight === 'full' ? 'full' : 'low',
				dated: weight !== 'undated',
				reason: REASONS[weight]
			};
		}
	}
	return null;
}

/** Where the paces come from: a race, the told easy pace, or nothing (RPE and zone alone). */
export type PaceSource =
	| {
			source: 'race';
			vdot: number;
			confidence: 'full' | 'low';
			performance: Performance;
			paces: TrainingPaces;
	  }
	| { source: 'easy_pace'; vdot: number; confidence: 'low'; paces: TrainingPaces }
	| { source: 'effort'; paces: null };

/** The owner's paces on `on`, by RECENCY's order. */
export function currentPaces(
	running: Pick<InputRunning, 'races' | 'easyPaceSecondsPerKm'>,
	on: IsoDate
): PaceSource {
	const performance = bestRecentPerformance(running.races, on);
	if (performance) {
		const { vdot, confidence } = performance;
		return { source: 'race', vdot, confidence, performance, paces: trainingPaces(vdot) };
	}
	const told = running.easyPaceSecondsPerKm;
	if (told === null) return { source: 'effort', paces: null };
	const vdot = vdotFromEasyPace(told);
	return { source: 'easy_pace', vdot, confidence: 'low', paces: trainingPaces(vdot) };
}

// ---- Heart rate ------------------------------------------------------------------------------

export interface HeartRates {
	maxHr?: number | null;
	restingHr?: number | null;
	thresholdHr?: number | null;
}

/** Zones 1 to 5 in bpm, [low, high], each zone's high the next one's low. */
export interface HeartRateZones {
	method: HrMethod;
	zones: readonly (readonly [low: number, high: number])[];
}

const given = (value: number | null | undefined): value is number =>
	value !== null && value !== undefined;

/** Whether every given heart rate is in its range, and they run resting < threshold < max. */
function coherent({ maxHr, restingHr, thresholdHr }: HeartRates) {
	const values = { max: maxHr, resting: restingHr, threshold: thresholdHr };
	for (const [key, [low, high]] of Object.entries(P.HR_LIMITS)) {
		const value = values[key as keyof typeof values];
		if (given(value) && !(Number.isFinite(value) && value >= low && value <= high)) return false;
	}
	const ordered = [restingHr, thresholdHr, maxHr].filter(given);
	return ordered.every((value, i) => i === 0 || value > ordered[i - 1]!);
}

/**
 * Heart-rate zones by the first method (HR_METHODS) the given rates allow, or null with no
 * usable data or rates that cannot all be right. Zone 5 never runs above a known max.
 */
export function heartRateZones(rates: HeartRates): HeartRateZones | null {
	if (!coherent(rates)) return null;
	const { maxHr, restingHr, thresholdHr } = rates;
	const scales: Record<HrMethod, ((share: number) => number) | null> = {
		threshold: given(thresholdHr) ? (share) => thresholdHr * share : null,
		reserve:
			given(maxHr) && given(restingHr) ? (share) => restingHr + share * (maxHr - restingHr) : null,
		max: given(maxHr) ? (share) => maxHr * share : null
	};
	const method = P.HR_METHODS.find((m) => scales[m] !== null);
	if (!method) return null;
	const scale = { method, bpm: scales[method]! };
	const cap = given(maxHr) ? maxHr : Infinity;
	const bpm = (share: number) => Math.min(cap, Math.round(scale.bpm(share)));
	const zones = P.HR_ZONE_BANDS[scale.method].map(([low, high]) => [bpm(low), bpm(high)] as const);
	return { method: scale.method, zones };
}
