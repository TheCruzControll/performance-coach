/**
 * Deloads (m7-plan deload-taper; PRD §5), from rules/deload.ts:
 * - scheduledDeloads(weeks, level): which weeks of a block are deloads on schedule
 * - deloadNeed(…): whether a deload is needed now, from M6's signals, and why or why not
 * - deloadWeek(targets): a week's targets as a deload's
 * - deloadSessions(week, targets, ahead): a week's sessions as a deload's, values only, so a
 *   deload can land in place on the week after a review: the same sessions on the same days, with
 *   the same exercises and set rows; a session outside `ahead` is untouched
 * The triggers only combine M6's signals; their thresholds are M6's and the load model's.
 * Pure and deterministic.
 */
import { addDays, daysBetween } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { TrendResult } from '../../analytics/trend.ts';
import type { ExperienceLevel } from '../../profile/catalog.ts';
import { PRESCRIPTION_LIMITS } from '../../training/schemas.ts';
import { sessionLoadOf } from '../../training/metrics.ts';
import type {
	OtherSessionPlan,
	RunSegment,
	SessionPlan,
	SetPrescription,
	WeekPlan,
	WeekTargets
} from '../../training/types.ts';
import type { OtherSessionKind, WeekKind } from '../../training/vocabulary.ts';
import { SESSION_TYPE_LABEL } from '../../training/vocabulary.ts';
import { cleanFloat, DEFAULT_LOAD_INCREMENT, roundToIncrement } from '../../units.ts';
import type { WeightUnit } from '../../units.ts';
import type { Fact } from '../decisions.ts';
import { SYSTEM_LABEL, SYSTEMS } from '../evaluate/types.ts';
import { overloadedDays } from '../load/fatigue.ts';
import type { FatigueDay } from '../load/fatigue.ts';
import type { TrainingPaces } from '../paces.ts';
import type { FatigueLevel } from '../results.ts';
import { CADENCE, GUARDS, TARGETS, TRIGGERS } from '../rules/deload.ts';
import type { DeloadTargets } from '../rules/deload.ts';
import { LOAD_RULES } from '../rules/loads.ts';
import { SEGMENT_PACES, SEGMENT_ZONES } from '../rules/paces.ts';
import { MUAY_THAI } from '../rules/running.ts';

const isLight = (kind: WeekKind) => (GUARDS.lightKinds as readonly WeekKind[]).includes(kind);

// ---- On schedule -------------------------------------------------------------------------------

/**
 * The indexes of `weeks` (a block's weeks, first first) that are deloads on schedule at `level`:
 * each week after CADENCE's loading weeks, and the block's last week when CADENCE.endAfter
 * loading weeks or more precede it. A light week already planned counts as the rest and starts the count again.
 */
export function scheduledDeloads(
	weeks: readonly { kind: WeekKind }[],
	level: ExperienceLevel
): number[] {
	const every = CADENCE.weeks[level];
	const deloads: number[] = [];
	let loading = 0;
	weeks.forEach(({ kind }, i) => {
		if (isLight(kind)) loading = 0;
		else if (
			loading >= every ||
			(CADENCE.atBlockEnd && i === weeks.length - 1 && loading >= CADENCE.endAfter)
		) {
			deloads.push(i);
			loading = 0;
		} else loading += 1;
	});
	return deloads;
}

// ---- Needed now --------------------------------------------------------------------------------

/** A main lift's e1RM verdict (M6's classifyTrend over its e1RM series), by its name. */
export interface LiftTrend {
	name: string;
	trend: TrendResult | null;
}

/** A week of the plan, as the guards read it. */
export interface CalendarWeek {
	startsOn: IsoDate;
	kind: WeekKind;
}

export interface DeloadNeedInput {
	/** M6's fatigue verdict (results.ts fatigueLevel, or a weekly review's snapshot.fatigue). */
	fatigue: { level: FatigueLevel; reasons: readonly string[] };
	trends: {
		/** The main lifts' e1RM verdicts. */
		lifts: readonly LiftTrend[];
		/** Easy runs' pace at the same RPE, in seconds per km: before, and lately. */
		easyPace?: { before: number; recent: number } | null;
	};
	/** load-fatigue's days through `today`; null with none. */
	overload: { days: readonly FatigueDay[]; today: IsoDate } | null;
	/** The plan's weeks around the target week: past ones for the last deload, two after it. */
	calendar: readonly CalendarWeek[];
	/** The Monday of the week a deload would change. */
	targetWeek: IsoDate;
}

export type DeloadAction =
	'none' | 'deload' | 'already_light' | 'hold_for_planned' | 'reduce_volume';

export interface DeloadNeed {
	action: DeloadAction;
	/** The target week's Monday. */
	week: IsoDate;
	ruleKey: string;
	/** Each signal met, then the guard that blocked, if one did: plain sentences. */
	reasons: string[];
	evidence: Record<string, Fact>;
	/** The guard that held the deload back, and the week it read. */
	blockedBy: { guard: 'light_week' | 'planned_light' | 'recent_deload'; week: CalendarWeek } | null;
}

const declines = (t: TrendResult | null) => t?.verdict === 'real_trend' && t.direction === 'down';
const list = (names: readonly string[]) =>
	names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Whether a deload is needed in `targetWeek`: 'deload' when a trigger is met and no guard holds it
 * back; otherwise the guard's action ('already_light', 'hold_for_planned' or 'reduce_volume'), or
 * 'none' when no trigger is met. Every signal met is named, at any fatigue level.
 */
export function deloadNeed(input: DeloadNeedInput): DeloadNeed {
	const { fatigue, trends, overload, calendar, targetWeek } = input;
	const reasons: string[] = [];
	const evidence: Record<string, Fact> = { targetWeek, fatigue: fatigue.level };

	const declining = trends.lifts.filter((l) => declines(l.trend)).map((l) => l.name);
	evidence.decliningLifts = declining.length;
	const pace = trends.easyPace;
	const slower = pace && pace.before > 0 ? ((pace.recent - pace.before) / pace.before) * 100 : null;
	const slowerPct = slower === null ? null : cleanFloat(slower, 1);
	if (slowerPct !== null) evidence.easyPaceSlowerPct = slowerPct;
	const paceSlowed = slower !== null && slower >= TRIGGERS.watch.slowerPacePct;
	const decline = declining.length >= TRIGGERS.watch.decliningLifts || paceSlowed;

	let overloaded: { system: string; days: number } | null = null;
	if (overload) {
		const window = {
			from: addDays(overload.today, 1 - TRIGGERS.overload.windowDays),
			to: overload.today
		};
		for (const system of SYSTEMS) {
			const days = overloadedDays(overload.days, system, window).length;
			if (days >= TRIGGERS.overload.overloadedDays && days > (overloaded?.days ?? 0))
				overloaded = { system: SYSTEM_LABEL[system], days };
		}
	}

	if (fatigue.level !== 'none') reasons.push(...fatigue.reasons);
	if (declining.length > 0) reasons.push(`${list(declining)}: estimated 1RM really declining`);
	if (paceSlowed) reasons.push(`Easy runs ${slowerPct} % slower at the same effort`);
	if (overloaded) {
		evidence.overloadedSystem = overloaded.system;
		evidence.overloadedDays = overloaded.days;
		reasons.push(
			`${overloaded.system} overloaded on ${overloaded.days} of the last ${TRIGGERS.overload.windowDays} days`
		);
	}

	const trigger =
		fatigue.level === TRIGGERS.fatigue
			? 'fatigue_high'
			: fatigue.level === 'watch' && decline
				? 'watch_decline'
				: overloaded
					? 'overload'
					: null;
	const result = (
		action: DeloadAction,
		ruleKey: 'deload.triggers' | 'deload.guards',
		blockedBy: DeloadNeed['blockedBy'] = null
	): DeloadNeed => ({ action, week: targetWeek, ruleKey, reasons, evidence, blockedBy });

	if (trigger === null) {
		reasons.push(
			fatigue.level === 'watch'
				? `Fatigue is at watch with no real decline, and no system overloaded on ${TRIGGERS.overload.overloadedDays} of the last ${TRIGGERS.overload.windowDays} days: no deload yet.`
				: `Fatigue is ${fatigue.level === 'none' ? 'low' : fatigue.level}, and no system overloaded on ${TRIGGERS.overload.overloadedDays} of the last ${TRIGGERS.overload.windowDays} days: no deload needed.`
		);
		return result('none', 'deload.triggers');
	}
	evidence.trigger = trigger;

	const weekOn = (date: IsoDate) => calendar.find((w) => w.startsOn === date);
	const target = weekOn(targetWeek);
	if (target && isLight(target.kind)) {
		reasons.push(`The week is already a ${target.kind} week, so it is light already.`);
		return result('already_light', 'deload.guards', { guard: 'light_week', week: target });
	}
	for (let n = 1; n <= GUARDS.lookaheadWeeks; n++) {
		const ahead = weekOn(addDays(targetWeek, 7 * n));
		if (ahead && isLight(ahead.kind)) {
			evidence.plannedLight = ahead.startsOn;
			reasons.push(
				`A ${ahead.kind} week is planned ${n === 1 ? 'the week after' : `${n} weeks after`}, so the deload waits for it and this week is eased instead.`
			);
			return result('hold_for_planned', 'deload.guards', { guard: 'planned_light', week: ahead });
		}
	}
	const recent = calendar
		.filter((w) => w.kind === 'deload' && w.startsOn < targetWeek)
		.find((w) => daysBetween(addDays(w.startsOn, 6), targetWeek) <= GUARDS.recentDeloadDays);
	if (recent) {
		evidence.lastDeload = recent.startsOn;
		reasons.push(
			`A deload ended within ${GUARDS.recentDeloadDays} days, so volume comes down instead of another deload.`
		);
		return result('reduce_volume', 'deload.guards', { guard: 'recent_deload', week: recent });
	}
	return result('deload', 'deload.triggers');
}

// ---- A deload week -----------------------------------------------------------------------------

const hundredths = (n: number) => Math.round(n * 100) / 100;
const isCutback = (kind: WeekKind | null, targets: WeekTargets) =>
	kind === 'cutback' || targets.running?.cutback === true;
/** The runs' factor: a cutback week comes down only to the deload's share of a full week. */
const runFactorOf = (cutback: boolean, t: DeloadTargets) =>
	cutback ? Math.min(1, t.runFactor / t.cutbackShare) : t.runFactor;

/**
 * `targets` as a deload week's: sets and run volume cut, nothing above the deload's RPE cap, loads
 * 10 % under the week's own, no race-specific work and no sparring. `kind`, the week's kind when
 * known, makes a cutback week a cutback as deloadSessions reads it.
 */
export function deloadWeek(
	targets: WeekTargets,
	t: DeloadTargets = TARGETS,
	kind: WeekKind | null = null
): WeekTargets {
	const runs = runFactorOf(isCutback(kind, targets), t);
	const sets = (n: number) => Math.round(n * t.setsFactor);
	const out: WeekTargets = {
		...structuredClone(targets),
		rpeCap: Math.min(targets.rpeCap, t.rpeCap),
		volumeFactor: hundredths(targets.volumeFactor * t.setsFactor),
		loadStep: cleanFloat((1 + targets.loadStep) * t.loadFactor - 1, 4),
		runVolumeFactor: hundredths(targets.runVolumeFactor * runs)
	};
	if (targets.mainLifts)
		out.mainLifts = {
			...targets.mainLifts,
			topRpe: Math.min(targets.mainLifts.topRpe, t.rpeCap),
			setsFactor: hundredths(targets.mainLifts.setsFactor * t.setsFactor)
		};
	if (targets.setsPerGroup)
		out.setsPerGroup = {
			min: sets(targets.setsPerGroup.min),
			max: sets(targets.setsPerGroup.max),
			step: 0
		};
	if (targets.running)
		out.running = {
			...targets.running,
			longRunMetres:
				targets.running.longRunMetres === null
					? null
					: Math.max(1, roundToIncrement(targets.running.longRunMetres * runs, 100)),
			raceSpecific: null
		};
	if (targets.combat)
		out.combat = {
			...targets.combat,
			hardSparring: 0,
			sparringRounds: 0,
			conditioningRounds: sets(targets.combat.conditioningRounds)
		};
	return out;
}

// ---- A deload's sessions -----------------------------------------------------------------------

export interface SessionOptions {
	/** The smallest load step in each unit; M1's DEFAULT_LOAD_INCREMENT unless given. */
	increment?: Readonly<Record<WeightUnit, number>>;
	/** The owner's training paces: an eased segment runs at E. Without them, the run's own E pace. */
	paces?: TrainingPaces | null;
}

/** `n` metres or seconds × `factor`, to the step, never below one step nor above `n`. */
const scaled = (n: number | null, factor: number, step: number) =>
	n === null || factor >= 1
		? n
		: Math.min(n, Math.max(step, roundToIncrement(cleanFloat(n * factor), step)));

/** A run segment's distance and duration × `factor` (to 100 m and 30 s): its pace kept. */
export const shorterSegment = (s: RunSegment, factor: number): RunSegment => ({
	...s,
	distanceMetres: scaled(s.distanceMetres, factor, 100),
	durationSeconds: scaled(s.durationSeconds, factor, 30)
});

/** A line's sets × `factor`, never fewer than one. */
export const fewerSets = (line: SetPrescription, factor: number): SetPrescription => ({
	...line,
	sets: Math.max(1, Math.round(line.sets * factor))
});

/** `session` at `minutes` and `targetRpe`, with its load recomputed (M1's sRPE). */
export function retimed<S extends SessionPlan>(session: S, minutes: number, targetRpe: number): S {
	const estMinutes = Math.max(5, Math.round(minutes));
	return { ...session, estMinutes, targetRpe, estLoad: sessionLoadOf({ estMinutes, targetRpe }) };
}

const setsIn = (s: Extract<SessionPlan, { kind: 'strength' }>) =>
	s.exercises.reduce((sum, e) => sum + e.sets.reduce((n, l) => n + l.sets, 0), 0);

/** A line's load × the deload's factor, rounded down to the plates (M1's roundToIncrement). */
function lighter(line: SetPrescription, t: DeloadTargets, increment: Record<WeightUnit, number>) {
	const value = line.loadValue;
	if (value === null || line.loadKind === 'rpe_based') return value;
	if (line.loadKind === 'absolute') {
		const step = increment[line.loadUnit ?? 'kg'];
		return Math.min(value, Math.max(step, roundToIncrement(value * t.loadFactor, step, 'down')));
	}
	const floor = PRESCRIPTION_LIMITS.loadFraction[0];
	return Math.min(
		value,
		Math.max(floor, roundToIncrement(value * t.loadFactor, LOAD_RULES.loadRounding, 'down'))
	);
}

const QUALITY = (s: RunSegment) => SEGMENT_PACES[s.kind] !== 'E';

function deloadOne(
	session: SessionPlan,
	cutback: boolean,
	t: DeloadTargets,
	options: SessionOptions
): SessionPlan {
	const rpe = Math.min(session.targetRpe, t.rpeCap);
	if (session.kind === 'strength') {
		const before = setsIn(session);
		const exercises = session.exercises.map((e) => ({
			...e,
			sets: e.sets.map((line) => ({
				...fewerSets(line, t.setsFactor),
				targetRpe: line.targetRpe === null ? null : Math.min(line.targetRpe, t.rpeCap),
				loadValue: lighter(line, t, { ...DEFAULT_LOAD_INCREMENT, ...options.increment })
			}))
		}));
		const out = { ...session, exercises };
		return retimed(out, (session.estMinutes * setsIn(out)) / before, rpe);
	}
	if (session.kind === 'run' && session.source === 'commitment') {
		// A club run keeps its length and pace, as M3 keeps it in a deload week; only its effort is capped.
		const segments = session.segments.map((s) => ({
			...s,
			targetRpe: s.targetRpe === null ? null : Math.min(s.targetRpe, rpe)
		}));
		return retimed({ ...session, segments }, session.estMinutes, rpe);
	}
	if (session.kind === 'run') {
		const factor = runFactorOf(cutback, t);
		const easy = session.segments.find((s) => !QUALITY(s));
		const pace = options.paces?.E ?? null;
		const segments = session.segments.map((s) => {
			const shorter = shorterSegment(s, factor);
			if (!QUALITY(s)) return shorter;
			return {
				...shorter,
				kind: 'easy' as const,
				paceMinSecondsPerKm: pace?.[0] ?? easy?.paceMinSecondsPerKm ?? null,
				paceMaxSecondsPerKm: pace?.[1] ?? easy?.paceMaxSecondsPerKm ?? null,
				hrZone: SEGMENT_ZONES.easy,
				targetRpe: easy?.targetRpe ?? (s.targetRpe === null ? null : Math.min(s.targetRpe, rpe))
			};
		});
		const eased = session.segments.some(QUALITY);
		const type = eased && session.type !== 'long_run' ? 'easy_run' : session.type;
		const out = {
			...session,
			segments,
			type,
			title:
				session.title === SESSION_TYPE_LABEL[session.type]
					? SESSION_TYPE_LABEL[type]
					: session.title,
			intensity: eased ? ('easy' as const) : session.intensity
		};
		return retimed(out, session.estMinutes * factor, rpe);
	}
	if (session.discipline !== 'muay_thai') return retimed(session, session.estMinutes, rpe);
	if (session.source === 'commitment') {
		const classRpe = Math.min(session.targetRpe, t.muayThai.commitmentRpe);
		const details = { ...session.details, targetRpe: classRpe };
		return retimed({ ...session, details }, session.estMinutes, classRpe);
	}
	const kind = session.details.kind === 'sparring' ? t.muayThai.sparringTo : t.muayThai.kind;
	const made = asMuayThai(session, kind);
	const details = {
		...made.details,
		targetRpe:
			session.details.targetRpe === null ? null : Math.min(session.details.targetRpe, t.rpeCap)
	};
	return retimed({ ...made, details, intensity: 'easy' }, session.estMinutes, rpe);
}

const FORMATS = ['technical', 'pad_work', 'sparring'] as const;
const isFormat = (kind: OtherSessionKind): kind is (typeof FORMATS)[number] =>
	(FORMATS as readonly string[]).includes(kind);

/**
 * A Muay Thai session as one of `kind`. A session still titled as the generator made it (M3's
 * MUAY_THAI) takes the new format's title, intensity and rounds; a renamed one keeps its own.
 */
export function asMuayThai(session: OtherSessionPlan, kind: OtherSessionKind): OtherSessionPlan {
	const was = session.details.kind;
	const details = { ...session.details, kind };
	if (was === kind || !isFormat(was) || !isFormat(kind) || session.title !== MUAY_THAI[was].title)
		return { ...session, details };
	const to = MUAY_THAI[kind];
	details.metrics = details.metrics.map((m) =>
		m.key === 'rounds' ? { ...m, value: to.rounds } : m
	);
	return { ...session, title: to.title, intensity: to.intensity, details };
}

/**
 * `week`'s sessions as a deload's (TARGETS), each session `ahead` says is still to come; every
 * other session is returned as it is. Values only: the same sessions, in the same order, on the
 * same days, with the same exercises and the same set rows and segments.
 * - strength: 40 % fewer sets (at least one a line), RPE ≤ 6, loads 10 % lighter to the plates
 * - runs: 30 % shorter, quality segments easy at E pace in zone 2; a cutback week keeps its lower
 *   mileage; a commitment run keeps its length at RPE ≤ 6
 * - Muay Thai: a session of the plan becomes technique at RPE ≤ 6, sparring becomes pads, retitled
 *   when it kept the generator's title; a commitment class keeps its slot at RPE 6
 */
export function deloadSessions(
	week: Pick<WeekPlan, 'kind' | 'targets' | 'sessions'>,
	targets: DeloadTargets,
	ahead: (session: SessionPlan) => boolean,
	options: SessionOptions = {}
): SessionPlan[] {
	const cutback = isCutback(week.kind, week.targets);
	return week.sessions.map((s) => (ahead(s) ? deloadOne(s, cutback, targets, options) : s));
}
