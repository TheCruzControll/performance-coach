/**
 * Progression from actual results (PRD §5): next week and the next block move each lift by what
 * its last sessions showed, never by a fixed script, and every outcome carries its why and its
 * evidence. One rule table, rules/results.ts, for the weekly review's adjustments (m6/26) and the
 * next block's starting loads (m6/30).
 *
 * - decideFromResults(exposures, target, trend, ctx): one prescription line's outcome from the
 *   lift's exposures (analytics/prescribed.ts), read through `consistency`, and its e1RM trend
 *   (analytics/trend.ts). Loads round with M1's roundToIncrement; a share of a 1RM never passes
 *   M1's table (percentOfOneRepMax) for its reps at its RPE; an rpe_based line's suggested load is
 *   M1's loadForTarget. Bodyweight lines progress reps, then sets; seconds lines, seconds.
 * - adaptRunning(week, longRun): the week's distance and its long run.
 * - fatigueLevel(signals): none, watch or high, with a reason per signal met; high recommends a
 *   deload.
 *
 * Pure and deterministic. Server-only at runtime, like all of domain/programming.
 */
import { CONSISTENCY, consistency } from '../analytics/prescribed.ts';
import type { Exposure } from '../analytics/prescribed.ts';
import type { TrendResult } from '../analytics/trend.ts';
import { loadForTarget } from '../e1rm.ts';
import { percentOfOneRepMax } from '../rpe.ts';
import { PRESCRIPTION_LIMITS as L } from '../training/schemas.ts';
import type { SetPrescription } from '../training/types.ts';
import type { LoadType, MovementPattern } from '../training/vocabulary.ts';
import { cleanFloat, convertWeight, DEFAULT_LOAD_INCREMENT, roundToIncrement } from '../units.ts';
import type { WeightUnit } from '../units.ts';
import type { Fact } from './decisions.ts';
import {
	FATIGUE_RULES,
	LOWER_BODY_PATTERNS,
	RESULT_RULES,
	RUN_RESULT_RULES
} from './rules/results.ts';
import type { FatigueSignal, ResultRules } from './rules/results.ts';

export type ResultAction =
	'add_load' | 'reduce_load' | 'reduce_volume' | 'add_reps' | 'add_sets' | 'hold' | 'planned';

/** What an outcome changes on the line: its load, target RPE, reps, seconds or sets. */
export type ResultField = 'load' | 'rpe' | 'reps' | 'seconds' | 'sets';
export type Confidence = 'low' | 'medium' | 'high';
type Evidence = Record<string, Fact>;

/** The line next week would repeat, and what it is a line of. */
export interface ResultTarget {
	/** The exercise's name, for the why. */
	name: string;
	line: SetPrescription;
	loadType: LoadType;
	pattern: MovementPattern;
	/** The most reps a set should reach before a bodyweight line gains a set: the exercise's repMax. */
	repCeiling?: number | null;
}

export interface ResultContext {
	/** The owner's weight unit: a from_e1rm load rounds to its plates. */
	unit: WeightUnit;
	/** The smallest load step in each unit; M1's DEFAULT_LOAD_INCREMENT unless given. */
	increment?: Readonly<Record<WeightUnit, number>>;
	/** The latest e1RM in kg, which from_e1rm and rpe_based lines read. */
	e1rmKg?: number | null;
	/** The week's RPE cap: an rpe_based line never moves above it. */
	rpeCap?: number;
	rules?: ResultRules;
}

/** A line moved: the field, from and to (a load is the line's loadValue, a share for a relative line). */
interface Moved {
	action: ResultAction;
	field: ResultField;
	from: number;
	to: number;
	/** The load's change in percent; null for any other field. */
	pct: number | null;
	/** The line as the outcome leaves it. */
	line: SetPrescription;
	evidence?: Evidence;
}

export interface ResultOutcome {
	action: ResultAction;
	field: ResultField | null;
	from: number | null;
	to: number | null;
	pct: number | null;
	line: SetPrescription;
	ruleKey: string;
	evidence: Evidence;
	significant: boolean;
	confidence: Confidence;
	why: string;
	/** A real e1RM decline with rising RPE: a fatigue flag and a deload to consider. */
	fatigue: boolean;
	/** Sets to take off this lift's accessories (0 or rules.accessorySets). */
	accessorySets: number;
}

/** What the sessions say, for the why: the lift's name, the window and the counts. */
interface Said {
	name: string;
	n: number;
	easier: number;
	harder: number;
	missed: number;
	hits: number;
	/** rules.minExposures. */
	min: number;
}

const of = ({ n }: Said) => `the last ${n} sessions`;
const HARDER = (s: Said) =>
	`${s.name} felt about an RPE or more harder than prescribed in ${s.harder} of ${of(s)}`;

/** Each strength rule's why. */
const WHY = {
	single: (s: Said) =>
		`${s.name} has ${s.n === 0 ? 'no session' : s.n === 1 ? 'one session' : `${s.n} sessions`} to judge yet, and nothing changes on ${s.min === 2 ? 'one session' : `fewer than ${s.min}`}.`,
	decline: (s: Said) =>
		`${s.name}'s estimated 1RM is really declining while its sessions feel harder, so it gets no increase, its accessories a set fewer, and a deload is worth considering.`,
	missed_repeat: (s: Said) =>
		`${s.name} missed reps in ${s.missed} of ${of(s)}, so the load comes down.`,
	above_sets: (s: Said) =>
		`${HARDER(s)}, though every rep was done, so it keeps its load with a set fewer.`,
	above: (s: Said) => `${HARDER(s)}, so the load comes down.`,
	above_all: (s: Said) => `${HARDER(s)}, so the load comes down.`,
	missed_once: (s: Said) =>
		`${s.name} missed reps once in ${of(s)}: it holds until the next sessions show whether that was a one-off.`,
	below: (s: Said) =>
		`${s.name} felt about an RPE or more easier than prescribed in ${s.easier} of ${of(s)}, so it goes up.`,
	below_lower: (s: Said) =>
		`${s.name} felt about an RPE or more easier than prescribed in ${s.easier} of ${of(s)}, so it goes up.`,
	on_target: (s: Said) =>
		`${s.name} has been within half an RPE of target, so it follows the planned progression.`,
	noisy: (s: Said) =>
		`${s.name} has been around its target, easier one session and harder another, so it holds rather than chase the noise.`,
	reps_hit: (s: Said) =>
		`${s.name} has too few RPEs logged, but every set reached its target in ${s.hits} of ${of(s)}, so it goes up.`,
	no_rpe: (s: Said) =>
		`${s.name} has too few RPEs logged, and too few sessions on target, to change it.`
};
type Rule = keyof typeof WHY;
type Move = 'up' | 'down' | 'fewer_sets' | 'hold' | 'planned';

const pctOf = (from: number, to: number) => cleanFloat(((to - from) / from) * 100, 2);
const withRpe = (list: readonly Exposure[]) =>
	list.flatMap((e) => (e.meanRpeDeviation === null ? [] : [e.meanRpeDeviation]));

/** The rise in mean RPE deviation from the first to the last of `list` with one; null under two. */
function rise(list: readonly Exposure[]): number | null {
	const means = withRpe(list);
	return means.length < 2 ? null : cleanFloat(means.at(-1)! - means[0]!);
}

/**
 * RPE creep: how much harder the latest of a lift's last exposures felt than the earliest at the
 * same top-set load, in RPE; null without two at that load with an RPE.
 */
export function rpeCreep(exposures: readonly Exposure[], rules: ResultRules = RESULT_RULES) {
	const window = consistency(exposures, rules.window).exposures;
	const kg = window.at(-1)?.kg ?? null;
	return kg === null ? null : rise(window.filter((e) => e.kg === kg));
}

/** The first rule that matches, in rules/results.ts's order, as [move, step, rule]. */
function judge(
	read: ReturnType<typeof consistency>,
	s: Said,
	decline: boolean,
	target: ResultTarget,
	r: ResultRules
): [Move, number, Rule] {
	if (s.n < r.minExposures) return ['hold', 0, 'single'];
	const judged = byResults(read, s, target, r);
	// A decline blocks increases only: a lift that is also failing its load still comes down.
	return decline && (judged[0] === 'up' || judged[0] === 'planned' || judged[0] === 'hold')
		? ['hold', 0, 'decline']
		: judged;
}

function byResults(
	read: ReturnType<typeof consistency>,
	s: Said,
	target: ResultTarget,
	r: ResultRules
): [Move, number, Rule] {
	const means = withRpe(read.exposures);
	if (s.missed >= r.missedAgree) return ['down', r.missedRepeat, 'missed_repeat'];
	if (read.verdict === 'above') {
		if (s.hits === s.n) return ['fewer_sets', r.above, 'above_sets'];
		return s.harder === r.window ? ['down', r.aboveAll, 'above_all'] : ['down', r.above, 'above'];
	}
	if (s.missed > 0) return ['hold', 0, 'missed_once'];
	if (read.verdict === 'below') {
		const lower =
			LOWER_BODY_PATTERNS.includes(target.pattern) && s.n === r.window && s.easier === s.n;
		return lower ? ['up', r.belowLower, 'below_lower'] : ['up', r.below, 'below'];
	}
	if (read.verdict === 'within') {
		return means.every((d) => Math.abs(d) <= r.onTarget)
			? ['planned', 0, 'on_target']
			: ['hold', 0, 'noisy'];
	}
	// Too few RPEs: the reps against the target decide.
	return s.hits >= r.missedAgree ? ['up', r.below, 'reps_hit'] : ['hold', 0, 'no_rpe'];
}

const moved = (
	action: ResultAction,
	field: ResultField,
	from: number,
	to: number,
	line: SetPrescription,
	more: Partial<Moved> = {}
): Moved => ({ action, field, from, to, pct: null, line, ...more });

/**
 * `from` moved by `step` percent onto `increment`, within `fits`; null when no step fits. The last
 * try is a single increment, which `fits` may let pass the weekly cap (`single`).
 */
type Fits = (pct: number, single: boolean) => boolean;
function stepLoad(from: number, step: number, increment: number, fits: Fits) {
	const up = step > 0;
	const exact = from * (1 + step / 100);
	const tries = [
		roundToIncrement(exact, increment),
		roundToIncrement(exact, increment, up ? 'down' : 'up'),
		cleanFloat(from + (up ? increment : -increment))
	];
	return (
		tries.find(
			(to, i) => to > 0 && (up ? to > from : to < from) && fits(pctOf(from, to), i === 2)
		) ?? null
	);
}

function moveLoad(
	target: ResultTarget,
	step: number,
	ctx: ResultContext,
	fits: Fits
): Moved | null {
	const { line } = target;
	const rules = ctx.rules ?? RESULT_RULES;
	const increment = ctx.increment ?? DEFAULT_LOAD_INCREMENT;
	const action = step > 0 ? 'add_load' : 'reduce_load';
	const reps = line.repsMax ?? line.repsMin;
	const value = line.loadValue;
	if (line.loadKind === 'rpe_based') {
		const rpe = line.targetRpe;
		const to = rpe === null ? null : rpe + (step > 0 ? rules.rpeStep : -rules.rpeStep);
		const cap = step > 0 ? Math.min(L.rpe[1], ctx.rpeCap ?? L.rpe[1]) : L.rpe[1];
		if (to === null || to > cap || to < L.rpe[0]) return null;
		const kg = ctx.e1rmKg && reps ? loadForTarget(ctx.e1rmKg, reps, to) : null;
		const evidence = kg === null ? undefined : { suggestedKg: cleanFloat(kg, 1) };
		return moved(action, 'rpe', rpe!, to, { ...line, targetRpe: to }, { evidence });
	}
	if (value === null) return null;
	const load = (to: number | null) =>
		to === null
			? null
			: moved(action, 'load', value, to, { ...line, loadValue: to }, { pct: pctOf(value, to) });
	if (line.loadKind === 'absolute')
		return load(stepLoad(value, step, increment[line.loadUnit ?? ctx.unit], fits));
	// A share of a 1RM moves as the load it gives, on the plates of the 1RM's unit.
	const unit = line.loadKind === 'percent_1rm' ? (line.reference1rmUnit ?? 'kg') : ctx.unit;
	const known =
		line.loadKind === 'percent_1rm'
			? line.reference1rm
			: ctx.e1rmKg
				? convertWeight(ctx.e1rmKg, 'kg', unit)
				: null;
	const kg = known === null ? null : stepLoad(value * known, step, increment[unit], fits);
	const share =
		known === null
			? stepLoad(value, step, rules.shareRounding, fits)
			: kg === null
				? null
				: cleanFloat(kg / known, 4);
	const table = reps && line.targetRpe ? percentOfOneRepMax(reps, line.targetRpe) : null;
	// M1's table caps an increase only: a share above it can still come down.
	const top = step > 0 ? Math.min(L.loadFraction[1], table ?? 1) : L.loadFraction[1];
	return share === null || share < L.loadFraction[0] || share > top ? null : load(share);
}

const fewerSets = (line: SetPrescription) =>
	line.sets > L.sets[0]
		? moved('reduce_volume', 'sets', line.sets, line.sets - 1, { ...line, sets: line.sets - 1 })
		: null;

/** The line's reps, both bounds moved by `by`. */
const repsBy = (line: SetPrescription, by: number) => ({
	...line,
	repsMin: line.repsMin && Math.max(1, line.repsMin + by),
	repsMax: line.repsMax && line.repsMax + by
});

/** A bodyweight or seconds line: up, more reps (then a set) or seconds; down, a set fewer first. */
function moveAmount(target: ResultTarget, up: boolean, rules: ResultRules): Moved | null {
	const { line } = target;
	const timed = line.seconds !== null;
	const amount = line.seconds ?? line.repsMax ?? line.repsMin;
	const by = timed ? rules.secondsStep : 1;
	if (amount === null) return null;
	if (!up) {
		if (amount - by < 1) return fewerSets(line);
		return (
			fewerSets(line) ??
			moved(
				'reduce_volume',
				timed ? 'seconds' : 'reps',
				amount,
				amount - by,
				timed ? { ...line, seconds: amount - by } : repsBy(line, -1)
			)
		);
	}
	if (timed)
		return amount + by > L.seconds[1]
			? null
			: moved('add_reps', 'seconds', amount, amount + by, { ...line, seconds: amount + by });
	if (amount < Math.min(target.repCeiling ?? L.reps[1], L.reps[1]))
		return moved('add_reps', 'reps', amount, amount + 1, repsBy(line, 1));
	return line.sets < L.sets[1]
		? moved('add_sets', 'sets', line.sets, line.sets + 1, { ...line, sets: line.sets + 1 })
		: null;
}

const progressesAmount = ({ line, loadType }: ResultTarget) =>
	line.seconds !== null ||
	loadType === 'assisted' ||
	(loadType !== 'external' && line.loadKind !== 'absolute');

/**
 * One line's outcome from its lift's `exposures` (any order; the last rules.window by day, a
 * substitute's left out) and the lift's e1RM `trend` (null when there is none).
 */
export function decideFromResults(
	exposures: readonly Exposure[],
	target: ResultTarget,
	trend: TrendResult | null,
	ctx: ResultContext
): ResultOutcome {
	const rules = ctx.rules ?? RESULT_RULES;
	const read = consistency(exposures, rules.window);
	const window = read.exposures;
	const means = withRpe(window);
	const said: Said = {
		name: target.name,
		n: window.length,
		easier: means.filter((d) => d <= -CONSISTENCY.rpe).length,
		harder: means.filter((d) => d >= CONSISTENCY.rpe).length,
		missed: read.missed.length,
		hits: window.filter((e) => e.hit === true).length,
		min: rules.minExposures
	};
	const declining = trend?.verdict === 'real_trend' && trend.direction === 'down';
	const decline = declining && (rise(window) ?? 0) >= rules.rpeCreep;
	const [move, judged, rule] = judge(read, said, decline, target, rules);
	const evidence: Evidence = {
		exposures: said.n,
		withRpe: means.length,
		missedSessions: said.missed,
		verdict: read.verdict,
		trend: trend?.verdict ?? 'none'
	};
	if (means.length > 0)
		evidence.meanDeviation = cleanFloat(means.reduce((a, b) => a + b, 0) / means.length, 2);
	const outcome = (change: Moved | null, ruleKey: string, why: string): ResultOutcome => ({
		action: change?.action ?? (move === 'planned' ? 'planned' : 'hold'),
		field: change?.field ?? null,
		from: change?.from ?? null,
		to: change?.to ?? null,
		pct: change?.pct ?? null,
		line: change?.line ?? target.line,
		ruleKey,
		evidence: change
			? { ...evidence, ...change.evidence, from: change.from, to: change.to }
			: evidence,
		significant: Math.abs(change?.pct ?? 0) >= rules.significantPct,
		confidence:
			means.length >= rules.window ? 'high' : means.length >= rules.minExposures ? 'medium' : 'low',
		why,
		fatigue: decline,
		accessorySets: decline ? rules.accessorySets : 0
	});
	const ruleKey = `results.${rule}`;
	let why = WHY[rule](said);
	if (move === 'hold' || move === 'planned') return outcome(null, ruleKey, why);

	// A significant change waits for a full window, and an increase for no real decline; every one
	// keeps the caps. A decline never softens a cut.
	const blocked = declining && judged > 0;
	const allowed = said.n >= rules.window && !blocked;
	const cap = (pct: number) => (pct > 0 ? rules.maxUp : rules.maxDown);
	const fits: Fits = (pct, single) =>
		Math.abs(pct) <= (single ? Math.max(cap(pct), rules.smallestStepPct) : cap(pct)) &&
		(allowed || Math.abs(pct) < rules.significantPct);
	let step = Math.max(-rules.maxDown, Math.min(rules.maxUp, judged));
	if (!allowed && Math.abs(step) >= rules.significantPct) {
		step = Math.sign(step) * rules.below;
		why += ` A bigger step waits for ${rules.window} sessions${blocked ? ' and no real decline' : ''}.`;
	}
	const change =
		(move === 'fewer_sets' ? fewerSets(target.line) : null) ??
		(progressesAmount(target)
			? moveAmount(target, move === 'up', rules)
			: moveLoad(target, step, ctx, fits));
	if (change === null)
		return outcome(
			null,
			`${ruleKey}.at_limit`,
			`${why} No step fits this week's limits, so it holds.`
		);
	if (change.pct !== null && Math.abs(change.pct) > cap(change.pct))
		why += ` Its smallest step, ${Math.abs(change.pct)} %, is more than the weekly ${cap(change.pct)} %, which a light lift takes.`;
	return outcome(change, ruleKey, why);
}

// ---- Running ---------------------------------------------------------------------------------

export interface RunWeekResults {
	/** Next week's planned metres. */
	planned: number;
	/** The reviewed week's planned metres. */
	previousPlanned: number;
	/** Metres run in the last completed week. */
	actual: number;
	/** That week's adherence (analytics/adherence.ts pct); null when nothing was due. */
	adherencePct: number | null;
}

export interface LongRunResults {
	/** Next week's long run, in metres. */
	planned: number;
	/** The last long run: what it prescribed, whether it was done and how hard it felt. */
	last: {
		prescribed: number;
		completed: boolean;
		rpe: number | null;
		targetRpe: number | null;
	} | null;
}

export interface RunOutcome {
	action: 'planned' | 'hold' | 'reduce_volume';
	from: number;
	to: number;
	ruleKey: string;
	why: string;
	evidence: Evidence;
}

const km = (metres: number) => `${cleanFloat(metres / 1000, 1)} km`;

/** Next week's distance and long run from the last completed week's. */
export function adaptRunning(
	week: RunWeekResults,
	longRun: LongRunResults | null,
	rules = RUN_RESULT_RULES
) {
	const { planned, previousPlanned, actual, adherencePct } = week;
	const evidence = { planned, previousPlanned, actual, adherence: adherencePct ?? 'none' };
	const run = (
		action: RunOutcome['action'],
		from: number,
		to: number,
		key: string,
		why: string,
		facts: Evidence
	): RunOutcome => ({ action, from, to, ruleKey: `results.${key}`, why, evidence: facts });
	const low = adherencePct !== null && adherencePct < rules.holdBelowAdherence;
	// No distance last week (a first running week, or nothing due) is no base to cap against, on
	// purpose: the plan's own ramp decides. Sessions due and none run is low adherence, which holds.
	const cap =
		actual > 0
			? roundToIncrement(actual * (1 + rules.maxWeeklyRise), rules.roundMetres, 'down')
			: Infinity;
	const held = low ? Math.min(planned, previousPlanned) : planned;
	const to = Math.min(held, cap);
	const weekly =
		to >= planned
			? run(
					'planned',
					planned,
					planned,
					'run.planned',
					`Next week's ${km(planned)} stays as planned.`,
					evidence
				)
			: to < held
				? run(
						'reduce_volume',
						planned,
						to,
						'run.weekly_cap',
						`You ran ${km(actual)} last week, so next week rises at most ${rules.maxWeeklyRise * 100} %: ${km(to)} instead of ${km(planned)}.`,
						evidence
					)
				: run(
						'hold',
						planned,
						to,
						'run.adherence_hold',
						`You completed ${adherencePct} % of last week's sessions, under ${rules.holdBelowAdherence} %, so the volume holds at ${km(to)}.`,
						evidence
					);
	if (longRun === null) return { weekly, longRun: null };
	const { last } = longRun;
	const facts = {
		planned: longRun.planned,
		last: last?.prescribed ?? 'none',
		completed: last?.completed ?? false
	};
	const unrated = last?.rpe == null || last.targetRpe === null;
	const easyEnough = last?.rpe != null && last.targetRpe !== null && last.rpe <= last.targetRpe;
	const long =
		last && !last.completed && longRun.planned > last.prescribed
			? run(
					'hold',
					longRun.planned,
					last.prescribed,
					'long_run.repeat',
					`The last long run of ${km(last.prescribed)} was missed, so it is repeated before it steps up.`,
					facts
				)
			: last && longRun.planned > last.prescribed && !easyEnough
				? run(
						'hold',
						longRun.planned,
						last.prescribed,
						unrated ? 'long_run.no_rpe' : 'long_run.hold',
						`The last long run of ${km(last.prescribed)} ${unrated ? 'has no RPE to check against its target' : 'was not done at or under its target RPE'}, so it stays there before it steps up.`,
						facts
					)
				: run(
						'planned',
						longRun.planned,
						longRun.planned,
						'long_run.planned',
						`The long run follows the plan: ${km(longRun.planned)}.`,
						facts
					);
	return { weekly, longRun: long };
}

// ---- Fatigue ---------------------------------------------------------------------------------

/** analytics' figures for the week: acwr's ratio (a rough guide, not an injury predictor), monotony, recovery means, rpeCreep and lift counts. */
export type FatigueSignals = Partial<Record<FatigueSignal, number | null>>;
export type FatigueLevel = 'none' | 'watch' | 'high';

export interface FatigueReason {
	signal: FatigueSignal;
	value: number;
	threshold: number;
	text: string;
}

const SIGNAL_TEXT: Record<FatigueSignal, (v: number) => string> = {
	acwr: (v) => `Your load is rising sharply (an acute:chronic ratio of ${v}, a rough guide only)`,
	monotony: (v) => `Your training days have been very alike (monotony ${v})`,
	soreness: (v) => `You have been sore (${v} of 5)`,
	sleepHours: (v) => `You have slept ${v} hours a night`,
	rpeCreep: (v) => `The same loads feel ${v} RPE harder`,
	liftsMissingReps: (v) => `${v} lifts missed reps`,
	decliningLifts: (v) =>
		`${v === 1 ? 'A lift is' : `${v} lifts are`} declining while feeling harder`
};

/** The fatigue level from `signals`, with a reason per signal met; high recommends a deload. */
export function fatigueLevel(signals: FatigueSignals) {
	const reasons: FatigueReason[] = [];
	for (const [signal, [way, threshold]] of Object.entries(FATIGUE_RULES.signals) as [
		FatigueSignal,
		readonly [string, number]
	][]) {
		const value = signals[signal];
		if (value === null || value === undefined) continue;
		const met =
			way === 'above'
				? value > threshold
				: way === 'below'
					? value < threshold
					: value >= threshold;
		if (met)
			reasons.push({ signal, value, threshold, text: SIGNAL_TEXT[signal](cleanFloat(value, 2)) });
	}
	const level: FatigueLevel =
		reasons.length >= FATIGUE_RULES.highSignals ? 'high' : reasons.length > 0 ? 'watch' : 'none';
	return { level, reasons, deload: level === 'high' };
}
