/**
 * Next week's adjustments (PRD §5, §11; M6): a weekly review turned into concrete, explained
 * changes to the week after it, as the M3 edit ops an M5 program_adjustment carries. Nothing new
 * is decided here: the outcomes are results.ts's (decideFromResults, adaptRunning) and the
 * conflicts interference.ts's (checkWeek); this file only says which planned line or segment each
 * one changes, as an op M3's edit schemas accept, with a half step beside it.
 *
 * - Only a generated session dated today or later with no workout is touched (stillAhead): a
 *   past, started, done or skipped session never is, and an owner's commitment never is.
 * - Fatigue 'high' deloads the main lifts (DELOAD), unless next week is already light
 *   (LIGHT_WEEK_KINDS): then it only caps their RPE and flags the cycle review. A deloaded or
 *   light week takes no progression.
 * - Anything an op cannot express, or that breaks the session length, is listed as not proposed
 *   with its reason, never approximated; past MAX_NEXT_WEEK_OPS, the rest are too, by priority.
 * - Next week outside this block is the cycle review's (boundary); next week ended is late.
 * - M7: a review that proposes a deload of next week (ctx.deload; boundary 'deload') proposes no
 *   ops, and lists every other change it found as not proposed, because the week is a deload.
 * - M7: a recovery week is light too (LIGHT_WEEK_KINDS), and a cutback week (LIGHT_RUNNING_KINDS)
 *   keeps M6's strength changes but takes no running change: its lower mileage is deliberate.
 * - With M7's context (ctx.evaluation, review/evaluation.ts), a conflict is resolved by repairWeek
 *   instead, and every change is judged by evaluateWeek: one that adds an avoid finding is listed
 *   as not proposed ('conflict'), with the finding's headline.
 *
 * Pure and deterministic, and server-only at runtime, like all of domain/programming.
 */
import { addDays, weekdayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { Exposure } from '../../analytics/prescribed.ts';
import type { TrendResult } from '../../analytics/trend.ts';
import { MAX_PROPOSAL_OPS, programOpSchema } from '../../coach/proposals.ts';
import type { ProgramOp } from '../../coach/proposals.ts';
import { WEEKDAY_INFO } from '../../profile/catalog.ts';
import { REASON_MAX } from '../../training/edits.ts';
import { NON_WORKING_ROLES } from '../../training/metrics.ts';
import { runSegmentSchema, setPrescriptionSchema } from '../../training/schemas.ts';
import type {
	OtherSessionPlan,
	PlannedExercisePlan,
	RunSegment,
	RunSessionPlan,
	SetPrescription,
	StrengthSessionPlan
} from '../../training/types.ts';
import type { LoadType, PlanStatus, WeekKind } from '../../training/vocabulary.ts';
import { cleanFloat, DEFAULT_LOAD_INCREMENT, roundToIncrement } from '../../units.ts';
import type { WeightUnit } from '../../units.ts';
import { validate } from '../../validation.ts';
import type { Fact } from '../decisions.ts';
import { toExerciseKey } from '../input.ts';
import { catalogueTraits, checkWeek } from '../interference.ts';
import type { ExerciseTraits, TraitsOf, Violation } from '../interference.ts';
import { adaptRunning, decideFromResults } from '../results.ts';
import type { LongRunResults } from '../results.ts';
import { RESULT_RULES, RUN_RESULT_RULES } from '../rules/results.ts';
import {
	LIGHT_RUNNING_WEEK_KINDS,
	LIGHT_WEEK_KINDS as PLANNED_LIGHT_KINDS
} from '../periodisation/kinds.ts';
import { nextWeekJudge } from './evaluation.ts';
import type { ReviewEvaluation } from './evaluation.ts';
import type { NextWeekState, WeeklyReviewSnapshot } from './snapshot.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

/** Fatigue 'high' on a normal week: the main lifts' sets × 0.6 (−40 %) and RPE at most 6. */
export const DELOAD = { setsFactor: 0.6, rpeCap: 6 } as const;

/**
 * Weeks already light: high fatigue only caps their RPE and flags the cycle review. M7's
 * periodisation's own list (deload, taper, event and recovery), so both agree on what is light.
 */
export const LIGHT_WEEK_KINDS: readonly WeekKind[] = PLANNED_LIGHT_KINDS;

/**
 * Weeks light for running only (a cutback): strength changes as usual, but no running change,
 * neither the weekly cap nor a repeated long run, since the week's lower mileage is deliberate.
 */
export const LIGHT_RUNNING_KINDS: readonly WeekKind[] = LIGHT_RUNNING_WEEK_KINDS.filter(
	(kind) => !LIGHT_WEEK_KINDS.includes(kind)
);

/**
 * Decision (m6-plan open question 'Next-week changes are capped at 12'): at most M5's limit for
 * one proposal; the rest are listed as not proposed, with the reason. A deload counts per line.
 */
export const MAX_NEXT_WEEK_OPS = MAX_PROPOSAL_OPS;

/**
 * Decision (m6-plan open question 'Changing an adjustment'): an adjustment is taken as proposed,
 * at a half step (halfway, on the field's grain), or left out; no amount is typed.
 */
export const HALF_STEP = 0.5;

/** Which changes keep their place first when there are more than MAX_NEXT_WEEK_OPS. */
export const PRIORITY = { deload: 0, running: 1, reduce: 2, move: 3, increase: 4 } as const;

/** The run segments the weekly cap shortens: easy volume, never the quality work. */
export const CAPPED_SEGMENTS: readonly RunSegment['kind'][] = ['easy', 'steady', 'long'];

/** Only a rule to keep is resolved by a move; advice ('prefer') is left as planned. */
export const MOVE_SEVERITY = 'avoid';
/** A move never puts more than this many sessions on one day: sessionPlanSchema's bound. */
export const SESSIONS_A_DAY = 4;

// ---- Input and output ------------------------------------------------------------------------

/** A session of next week as the current version stores it (StoredSession fits). */
export type NextSession = (
	| (Omit<StrengthSessionPlan, 'exercises'> & {
			exercises: (PlannedExercisePlan & { lineage: string })[];
	  })
	| RunSessionPlan
	| OtherSessionPlan
) & { lineage: string; status: PlanStatus };

export interface NextWeek {
	/** The Monday after the reviewed week. */
	startsOn: IsoDate;
	state: NextWeekState;
	kind: WeekKind | null;
	/** The week's RPE cap (WeekTargets.rpeCap): an RPE-based line never goes above it. */
	rpeCap?: number | null;
	sessions: readonly NextSession[];
}

/** What the rules read of an exercise: a catalogue entry fits. */
export type NextWeekExercise = ExerciseTraits & {
	name: string;
	loadType: LoadType;
	repMax?: number | null;
};

export interface NextWeekContext {
	/** The owner's day, in their time zone. */
	today: IsoDate;
	unit: WeightUnit;
	increment?: Readonly<Record<WeightUnit, number>>;
	/** By exercise key (a catalogue key or `custom:<uuid>`), as the exposures name them. */
	exercises: ReadonlyMap<string, NextWeekExercise>;
	/** Each lift's e1RM trend and latest e1RM in kg, by exercise key. */
	trends?: ReadonlyMap<string, TrendResult>;
	e1rmKg?: ReadonlyMap<string, number>;
	/** Workouts of any status with their planned session: a started session is never touched. */
	workouts: readonly { plannedLineage: string | null }[];
	/** The owner's session length, and estimateMinutes with their programming input. */
	sessionMinutes: number;
	estimateMinutes: (session: Pick<StrengthSessionPlan, 'exercises'>) => number;
	/** The reviewed week's planned and run metres, and its last long run; null with no running. */
	running?: { previousPlanned: number; actual: number; lastLongRun: LongRunResults['last'] } | null;
	/**
	 * M7's context (evaluation.ts): a conflict is resolved by repairWeek, and every change is
	 * judged by evaluateWeek; without it, checkWeek as before.
	 */
	evaluation?: ReviewEvaluation;
	/**
	 * M7: the review proposes a deload of this week instead (boundary 'deload'): no ops, and every
	 * other change found is listed as not proposed ('deload').
	 */
	deload?: boolean;
}

export type AdjustmentKind =
	'load' | 'rpe' | 'reps' | 'seconds' | 'sets' | 'deload' | 'distance' | 'long_run' | 'move';
type Values = Record<string, Fact | null>;

export interface Adjustment {
	/** Stable across runs: its kind and the line, segment or session it changes. */
	id: string;
	kind: AdjustmentKind;
	/** The planned exercise (a line) or the session (a segment, a move) it changes. */
	lineage: string;
	sessionDate: IsoDate;
	/** options.proposed: what accepting it as proposed applies. */
	op: ProgramOp;
	/** The changed fields, before and after. */
	before: Values;
	after: Values;
	options: { proposed: ProgramOp; half_step: ProgramOp | null };
	/** The rule's reason in full; the op's `reason`, the version decision's why, is it clipped. */
	why: string;
	evidence: Record<string, Fact>;
	significant: boolean;
	/** PRIORITY's: lower is kept first. */
	priority: number;
}

export type NotProposedReason =
	'over_limit' | 'session_minutes' | 'not_expressible' | 'conflict' | 'deload';

/** Why a change is not proposed when the week is deloaded instead (ctx.deload). */
export const DELOAD_INSTEAD =
	'Next week is proposed as a deload instead, so this change is not proposed';

/** A change with its own `why`, and the `reason` and `words` for not proposing it. */
export type NotProposed = Pick<Adjustment, 'id' | 'kind' | 'lineage' | 'sessionDate' | 'why'> & {
	reason: NotProposedReason;
	words: string;
};

export interface NextWeekProposal {
	adjustments: Adjustment[];
	notProposed: NotProposed[];
	/** Next week is not planned in this block (the cycle review plans it), or is deloaded (M7). */
	boundary?: 'cycle' | 'deload';
	/** Next week has ended: nothing is left to change. */
	late?: true;
	/** Why there are no adjustments, for a boundary or a late review. */
	reason?: string;
	/** High fatigue in a week already light: what the cycle review should look at. */
	cycleFlag?: string;
}

// ---- Helpers ---------------------------------------------------------------------------------

type Strength = Extract<NextSession, { kind: 'strength' }>;
type Planned = Strength['exercises'][number];
type Candidate = Omit<Adjustment, 'op' | 'options'> & {
	proposed: ProgramOp;
	half: ProgramOp | null;
	/** A line change: the session's exercises after it, for the session-length check. */
	line?: { exercise: string; position: number; after: SetPrescription };
};

const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dayName = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].label;
const metresOf = (segments: readonly RunSegment[]) =>
	segments.reduce((sum, s) => sum + (s.distanceMetres ?? 0) * (s.repeats ?? 1), 0);
const km = (metres: number) => `${cleanFloat(metres / 1000, 1)} km`;
/** M3's main slot is the one with a top set, with or without a baseline lift (volume.ts). */
const isMainLift = (p: PlannedExercisePlan) => p.sets.some((line) => line.role === 'top');
const working = (line: SetPrescription) => !NON_WORKING_ROLES.includes(line.role);

/** `before` moved halfway to `after`, on `grain`; null when no value lies between them. */
function halfway(before: number, after: number, grain: number): number | null {
	const half = roundToIncrement(before + (after - before) * HALF_STEP, grain);
	const between = after > before ? half > before && half < after : half < before && half > after;
	return between ? half : null;
}

const SET_FIELDS = ['sets', 'repsMin', 'repsMax', 'targetRpe', 'loadValue'] as const;

/**
 * The ops that move a line from `before` to `after`, as proposed and at a half step, and the
 * fields that change; null when nothing changes or M3's schema refuses the line.
 */
function setChange(
	session: Strength,
	planned: Planned,
	position: number,
	before: SetPrescription,
	after: SetPrescription,
	why: string,
	loadGrain: number
) {
	const fields = SET_FIELDS.filter((f) => before[f] !== after[f]);
	if (fields.length === 0 || !validate(setPrescriptionSchema, after).ok) return null;
	const grain = { sets: 1, repsMin: 1, repsMax: 1, targetRpe: 0.5, loadValue: loadGrain };
	const halves = fields.flatMap((f) => {
		const half = halfway(before[f] as number, after[f] as number, grain[f]);
		return half === null ? [] : [[f, half] as const];
	});
	const halfLine = { ...before, ...Object.fromEntries(halves) };
	const base = {
		op: 'adjust_set' as const,
		sessionLineage: session.lineage,
		plannedExerciseLineage: planned.lineage,
		position,
		reason: clip(why, REASON_MAX)
	};
	const pick = (line: SetPrescription, keys: readonly (typeof SET_FIELDS)[number][]) =>
		Object.fromEntries(keys.map((f) => [f, line[f]]));
	const halfOk = halves.length > 0 && validate(setPrescriptionSchema, halfLine).ok;
	return {
		proposed: { ...base, ...pick(after, fields) } as ProgramOp,
		half: halfOk ? ({ ...base, ...Object.fromEntries(halves) } as ProgramOp) : null,
		before: pick(before, fields),
		after: pick(after, fields)
	};
}

// ---- Timing ----------------------------------------------------------------------------------

/**
 * The items whose session is dated `today` or later and has no workout, in any status, and
 * whose move (if one) lands on `today` or later. Used here and again at decide time
 * (next-week-decide): a change for a session that has passed or started is dropped.
 */
export function stillAhead<T extends { sessionDate: IsoDate; op: ProgramOp }>(
	items: readonly T[],
	today: IsoDate,
	workouts: readonly { plannedLineage: string | null }[]
): T[] {
	const started = new Set(workouts.map((w) => w.plannedLineage));
	return items.filter(
		({ sessionDate, op }) =>
			sessionDate >= today &&
			!started.has(op.sessionLineage) &&
			(op.op !== 'move' || op.toDate >= today)
	);
}

// ---- Propose ---------------------------------------------------------------------------------

type Run = Extract<NextSession, { kind: 'run' }>;
const NOT_PROPOSED = {
	line: "M3's edits refuse this line",
	seconds: "M3's set edit cannot change a hold's seconds",
	segment: "M3's edits refuse this segment",
	noSegment: 'It has no single distance segment to shorten',
	op: "M5's proposal refuses this change",
	limit: `One proposal holds up to ${MAX_NEXT_WEEK_OPS} changes: the more important ones come first`
};

/**
 * Next week's adjustments from the reviewed week's `snapshot` and `exposures`
 * (composeWeeklyReview's). `nextWeek` must be the week after the reviewed one.
 */
export function proposeNextWeek(
	nextWeek: NextWeek,
	snapshot: WeeklyReviewSnapshot,
	exposures: readonly Exposure[],
	ctx: NextWeekContext
): NextWeekProposal {
	if (nextWeek.startsOn !== snapshot.next.weekStartsOn)
		throw new RangeError(`Not the week after the reviewed one: ${nextWeek.startsOn}`);
	const none = { adjustments: [], notProposed: [] };
	const sunday = addDays(nextWeek.startsOn, 6);
	if (nextWeek.state !== 'planned')
		return {
			...none,
			boundary: 'cycle',
			reason: 'Next week is not planned in this block: your cycle review plans it.'
		};
	if (ctx.today > sunday)
		return {
			...none,
			late: true,
			reason: `Next week ended on ${sunday}, before this review: nothing is left to change.`
		};

	const { today, unit } = ctx;
	const increment = ctx.increment ?? DEFAULT_LOAD_INCREMENT;
	const started = new Set(ctx.workouts.map((w) => w.plannedLineage));
	const happening = [...nextWeek.sessions]
		.filter((s) => s.status !== 'skipped')
		.sort(
			(a, b) =>
				byText(a.date, b.date) || a.orderInDay - b.orderInDay || byText(a.lineage, b.lineage)
		);
	const ahead = (s: NextSession) =>
		s.source === 'generator' && s.date >= today && !started.has(s.lineage);
	const open = happening.filter(ahead);
	const candidates: Candidate[] = [];
	const notProposed: NotProposed[] = [];
	type At = Pick<Candidate, 'id' | 'kind' | 'lineage' | 'sessionDate' | 'why'>;
	/** What a change is about; its id is its kind, lineage and position. */
	const item = (kind: AdjustmentKind, lineage: string, sessionDate: IsoDate, why: string, n = 0) =>
		({ id: `${kind}:${lineage}${n ? `:${n}` : ''}`, kind, lineage, sessionDate, why }) as At;
	const refuse = (
		{ id, kind, lineage, sessionDate, why }: At,
		reason: NotProposedReason,
		words: string
	) => void notProposed.push({ id, kind, lineage, sessionDate, why, reason, words });

	// Strength: a deload on the main lifts, or each working line by its results.
	const light = nextWeek.kind !== null && LIGHT_WEEK_KINDS.includes(nextWeek.kind);
	const high = snapshot.fatigue.level === 'high';
	const signals = snapshot.fatigue.reasons.join('. ');
	const cap = (rpe: number | null) => (rpe === null ? null : Math.min(rpe, DELOAD.rpeCap));
	const fewer = Math.round((1 - DELOAD.setsFactor) * 100);
	const deloadWhy = light
		? `Next week is already a deload week, so with your fatigue high (${signals}) it only caps RPE at ${DELOAD.rpeCap}.`
		: `Your fatigue is high (${signals}), so next week deloads the main lifts: ${fewer} % fewer sets and RPE at most ${DELOAD.rpeCap}.`;
	const exposuresOf = Map.groupBy(exposures, (e) => e.exerciseId);
	for (const session of open) {
		if (session.kind !== 'strength') continue;
		for (const planned of session.exercises) {
			const key = toExerciseKey(planned.exercise);
			const exercise = ctx.exercises.get(key);
			planned.sets.forEach((line, i) => {
				if (!working(line)) return;
				const position = i + 1;
				const at = (kind: AdjustmentKind, why: string) =>
					item(kind, planned.lineage, session.date, why, position);
				const grain =
					line.loadKind === 'absolute'
						? increment[line.loadUnit ?? unit] * HALF_STEP
						: RESULT_RULES.shareRounding;
				const add = (
					kind: AdjustmentKind,
					after: SetPrescription,
					why: string,
					more: Pick<Candidate, 'evidence' | 'significant' | 'priority'>
				) => {
					if (SET_FIELDS.every((f) => after[f] === line[f])) return;
					const change = setChange(session, planned, position, line, after, why, grain);
					if (change === null) return refuse(at(kind, why), 'not_expressible', NOT_PROPOSED.line);
					candidates.push({
						...at(kind, why),
						...change,
						...more,
						line: { exercise: planned.lineage, position, after }
					});
				};
				if (high) {
					if (!isMainLift(planned)) return;
					const sets = light ? line.sets : Math.max(1, Math.round(line.sets * DELOAD.setsFactor));
					const evidence = { fatigue: 'high', signals: snapshot.fatigue.reasons.length };
					const after = { ...line, sets, targetRpe: cap(line.targetRpe) };
					return add('deload', after, deloadWhy, {
						evidence,
						significant: true,
						priority: PRIORITY.deload
					});
				}
				if (light || !exercise) return;
				const { name, loadType, pattern, repMax } = exercise;
				const outcome = decideFromResults(
					exposuresOf.get(key) ?? [],
					{ name, line, loadType, pattern, repCeiling: repMax ?? null },
					ctx.trends?.get(key) ?? null,
					{
						unit,
						increment,
						e1rmKg: ctx.e1rmKg?.get(key) ?? null,
						rpeCap: nextWeek.rpeCap ?? undefined
					}
				);
				const { field: kind, evidence, significant } = outcome;
				if (kind === null) return;
				if (kind === 'seconds')
					return refuse(at(kind, outcome.why), 'not_expressible', NOT_PROPOSED.seconds);
				const priority = outcome.to! < outcome.from! ? PRIORITY.reduce : PRIORITY.increase;
				add(kind, outcome.line, outcome.why, { evidence, significant, priority });
			});
		}
	}

	// Running: a missed long run repeated, then the week within +10 % of last week's distance.
	const runs = happening.filter((s): s is Run => s.kind === 'run');
	const touched = new Set<RunSegment>();
	const shorten = (
		kind: AdjustmentKind,
		run: Run,
		segment: RunSegment,
		to: number,
		o: { why: string; evidence: Record<string, Fact> }
	) => {
		const position = run.segments.indexOf(segment) + 1;
		const at = item(kind, run.lineage, run.date, o.why, position);
		if (!validate(runSegmentSchema, { ...segment, distanceMetres: to }).ok)
			return refuse(at, 'not_expressible', NOT_PROPOSED.segment);
		touched.add(segment);
		const reason = clip(o.why, REASON_MAX);
		const op = (distanceMetres: number) =>
			({
				op: 'adjust_run_segment',
				sessionLineage: run.lineage,
				position,
				distanceMetres,
				reason
			}) as ProgramOp;
		const from = segment.distanceMetres!;
		const half = halfway(from, to, RUN_RESULT_RULES.roundMetres);
		const { evidence } = o;
		candidates.push({
			...at,
			proposed: op(to),
			half: half === null ? null : op(half),
			before: { distanceMetres: from },
			after: { distanceMetres: to },
			evidence,
			significant: true,
			priority: PRIORITY.running
		});
	};
	const single = (s: RunSegment) => s.repeats === null && s.distanceMetres !== null;
	const runningLight = nextWeek.kind !== null && LIGHT_RUNNING_KINDS.includes(nextWeek.kind);
	if (ctx.running && runs.length > 0 && !runningLight) {
		const { previousPlanned, actual, lastLongRun: last } = ctx.running;
		const planned = runs.reduce((sum, r) => sum + metresOf(r.segments), 0);
		const long = runs.find((r) => r.type === 'long_run');
		const out = adaptRunning(
			{ planned, previousPlanned, actual, adherencePct: snapshot.adherence.pct },
			long ? { planned: metresOf(long.segments), last } : null
		);
		const repeat = out.longRun && out.longRun.from - out.longRun.to;
		let cut = 0;
		if (long && out.longRun && repeat && repeat > 0 && ahead(long)) {
			const [segment] = long.segments
				.filter(single)
				.sort((a, b) => b.distanceMetres! - a.distanceMetres!);
			if (segment && segment.distanceMetres! > repeat) {
				shorten('long_run', long, segment, segment.distanceMetres! - repeat, out.longRun);
				cut = repeat;
			} else {
				const at = item('long_run', long.lineage, long.date, out.longRun.why);
				refuse(at, 'not_expressible', NOT_PROPOSED.noSegment);
			}
		}
		const needed = planned - cut - out.weekly.to;
		if (out.weekly.to < out.weekly.from && needed > 0) {
			const capped = (s: RunSegment) =>
				single(s) && !touched.has(s) && CAPPED_SEGMENTS.includes(s.kind);
			const eligible = runs
				.filter(ahead)
				.flatMap((run) => run.segments.filter(capped).map((s) => [run, s] as const));
			const total = eligible.reduce((sum, [, s]) => sum + s.distanceMetres!, 0);
			const step = RUN_RESULT_RULES.roundMetres;
			const cuts = eligible.map(([run, s]) => {
				const d = s.distanceMetres!;
				return [
					run,
					s,
					Math.max(step, roundToIncrement(d - (needed * d) / total, step, 'down'))
				] as const;
			});
			const gives = cuts.reduce((sum, [, s, to]) => sum + Math.max(0, s.distanceMetres! - to), 0);
			// Never a partial cut presented as meeting the cap: short of it, nothing is proposed.
			if (gives < needed) {
				const at = item('distance', runs[0]!.lineage, runs[0]!.date, out.weekly.why);
				const words = `The easy distance still ahead gives only ${km(gives)} of the ${km(needed)} the cap needs`;
				refuse(at, 'not_expressible', words);
			} else
				for (const [run, s, to] of cuts)
					if (to < s.distanceMetres!) shorten('distance', run, s, to, out.weekly);
		}
	}

	// Conflicts: a session moved to another day of the week, when that breaks no rule it did not.
	const traitsOf: TraitsOf = (ref) => ctx.exercises.get(toExerciseKey(ref)) ?? catalogueTraits(ref);
	const days = Array.from({ length: 7 }, (_, n) => addDays(nextWeek.startsOn, n)).filter(
		(d) => d >= today
	);
	const judge =
		ctx.evaluation &&
		nextWeekJudge(
			ctx.evaluation,
			{
				sessions: happening,
				monday: nextWeek.startsOn,
				kind: nextWeek.kind,
				today,
				open: days,
				traitsOf
			},
			ahead,
			MOVE_SEVERITY
		);
	for (const m of judge ? judge.moves() : []) {
		const proposed = {
			op: 'move',
			sessionLineage: m.sessionLineage,
			toDate: m.toDate,
			...(m.timeOfDay !== undefined && { timeOfDay: m.timeOfDay }),
			reason: clip(m.why, REASON_MAX)
		} as ProgramOp;
		candidates.push({
			...item('move', m.sessionLineage, m.from, m.why),
			proposed,
			half: null,
			before: { date: m.from },
			after: { date: m.toDate },
			evidence: { rule: m.rule, severity: m.severity },
			significant: false,
			priority: PRIORITY.move
		});
	}
	const check = (week: readonly NextSession[]) => checkWeek(week, { traitsOf, openDates: days });
	const keyOf = (v: Violation<NextSession>) =>
		[v.rule, ...v.days, ...v.sessions.map((s) => s.lineage)].join(' ');
	const apart = (a: IsoDate, b: IsoDate) => Math.abs(Date.parse(a) - Date.parse(b));
	let week = happening;
	const moved = new Set<string>();
	const resolveOne = () => {
		const before = check(week);
		const known = new Set(before.map(keyOf));
		for (const v of before.filter((v) => v.severity === MOVE_SEVERITY)) {
			for (const s of [...v.sessions].reverse()) {
				if (!ahead(s) || moved.has(s.lineage)) continue;
				const dayOf = (d: IsoDate) => week.filter((o) => o.date === d);
				const targets = days
					.filter((d) => d !== s.date && dayOf(d).length < SESSIONS_A_DAY)
					.sort((a, b) => apart(a, s.date) - apart(b, s.date) || byText(a, b));
				for (const toDate of targets) {
					const after = week.map((o) =>
						o === s ? { ...o, date: toDate, orderInDay: dayOf(toDate).length + 1 } : o
					);
					const broken = check(after).map(keyOf);
					if (broken.includes(keyOf(v)) || !broken.every((k) => known.has(k))) continue;
					const why = `${v.message} Moving ${s.title} to ${dayName(toDate)} keeps them apart.`;
					const proposed = {
						op: 'move',
						sessionLineage: s.lineage,
						toDate,
						reason: clip(why, REASON_MAX)
					} as ProgramOp;
					candidates.push({
						...item('move', s.lineage, s.date, why),
						proposed,
						half: null,
						before: { date: s.date },
						after: { date: toDate },
						evidence: { rule: v.rule, severity: v.severity },
						significant: false,
						priority: PRIORITY.move
					});
					moved.add(s.lineage);
					week = after;
					return true;
				}
			}
		}
		return false;
	};
	while (!judge && resolveOne());

	// Rank; check each op with M5's schema (M3's edits inside it), the session length and the cap.
	candidates.sort(
		(a, b) =>
			a.priority - b.priority ||
			Number(b.significant) - Number(a.significant) ||
			byText(a.sessionDate, b.sessionDate) ||
			byText(a.id, b.id)
	);
	const exercisesNow = new Map(
		open.flatMap((s) => (s.kind === 'strength' ? [[s.lineage, s.exercises] as const] : []))
	);
	const adjustments: Adjustment[] = [];
	/** Whether repairWeek's moves were kept together, once the first of them is judged. */
	let movesKept: boolean | undefined;
	for (const c of candidates) {
		const { proposed, half, line, ...rest } = c;
		if (!validate(programOpSchema, proposed).ok) {
			refuse(c, 'not_expressible', NOT_PROPOSED.op);
			continue;
		}
		const now = line ? exercisesNow.get(proposed.sessionLineage)! : null;
		const next = now?.map((p) =>
			p.lineage === line!.exercise
				? { ...p, sets: p.sets.with(line!.position - 1, line!.after) }
				: p
		);
		const minutes = next ? ctx.estimateMinutes({ exercises: next }) : 0;
		if (minutes > ctx.sessionMinutes && minutes > ctx.estimateMinutes({ exercises: now! })) {
			refuse(
				c,
				'session_minutes',
				`It would take the session to ${minutes} minutes, over your ${ctx.sessionMinutes}`
			);
			continue;
		}
		if (adjustments.length >= MAX_NEXT_WEEK_OPS) {
			refuse(c, 'over_limit', NOT_PROPOSED.limit);
			continue;
		}
		// Judged with the changes kept so far. repairWeek's moves are judged together first, as it
		// chose them (a swap is two moves), when every one of them is an op within the cap; else, or
		// refused together, each is judged on its own.
		if (judge) {
			if (c.kind === 'move' && movesKept === undefined) {
				const moves = candidates.filter((m) => m.kind === 'move');
				const fit =
					adjustments.length + moves.length <= MAX_NEXT_WEEK_OPS &&
					moves.every((m) => validate(programOpSchema, m.proposed).ok);
				movesKept = fit && judge.adds(moves) === null;
			}
			const added = c.kind === 'move' && movesKept ? '' : (judge.adds([c])?.headline ?? '');
			if (added) {
				refuse(c, 'conflict', added);
				continue;
			}
		}
		if (next) exercisesNow.set(proposed.sessionLineage, next);
		const halfStep = half !== null && validate(programOpSchema, half).ok ? half : null;
		adjustments.push({ ...rest, op: proposed, options: { proposed, half_step: halfStep } });
	}
	const flag =
		high && light
			? { cycleFlag: `Fatigue stayed high going into a ${nextWeek.kind} week: ${signals}.` }
			: {};
	if (ctx.deload) {
		// The deload replaces M6's own deload of the main lifts; every other change waits for it.
		const instead = adjustments
			.filter((a) => a.kind !== 'deload')
			.map(({ id, kind, lineage, sessionDate, why }) => ({
				...{ id, kind, lineage, sessionDate, why },
				reason: 'deload' as const,
				words: DELOAD_INSTEAD
			}));
		return { adjustments: [], notProposed: [...notProposed, ...instead], boundary: 'deload' };
	}
	return { adjustments, notProposed, ...flag };
}
