/**
 * What a session costs each body system (PRD §5; M7's load model in the periodisation engine ADR):
 * lower body, upper body, aerobic, combat and the nervous system (CNS), for planned and logged
 * sessions alike, so Train, the coach, Progress and the weekly review read one load.
 *
 * - The basis is M1's sRPE (minutes × RPE) through M3's sessionLoadOf, exactly as M6's
 *   sessionLoads counts a logged workout: give a logged session the minutes and RPE that
 *   sessionLoads resolves for its fact (its own RPE, else its run's, else its other record's).
 * - A logged session with no RPE or no duration is 'load unknown', M6's rule: counted and named,
 *   left out of every total, never 0.
 * - A planned session uses its target RPE. With none, DEFAULT_RPE fills it and the load is
 *   'estimated': its own series, never added to the known load.
 * - rules/load.ts's SYSTEM_SHARES split the basis; a session's shares add to 1 (mobility's, 0).
 *
 * Pure, and the same for any input order. Server-only, like all of domain/programming.
 */
import { ROUND_KEYS } from '../../analytics/workload.ts';
import type { IsoDate } from '../../calendar.ts';
import type { Discipline, TimeOfDay } from '../../profile/catalog.ts';
import { sessionLoadOf } from '../../training/metrics.ts';
import type { CustomMetric, RunSegment } from '../../training/types.ts';
import { SESSION_TYPE_LABEL } from '../../training/vocabulary.ts';
import type { OtherSessionKind, SessionIntensity, SessionType } from '../../training/vocabulary.ts';
import { SYSTEMS } from '../evaluate/types.ts';
import type { DayLoad, LoadSystem } from '../evaluate/types.ts';
import {
	catalogueTraits,
	demandOf,
	hardSetsIn,
	INTERFERENCE,
	isHeavySet,
	regionOf
} from '../interference.ts';
import type { InterferenceSession, Region, TraitsOf } from '../interference.ts';
import { DEFAULT_RPE, SYSTEM_SHARES } from '../rules/load.ts';
import type { Weights } from '../rules/load.ts';

// ---- What the model reads -------------------------------------------------------------------

export type LoadSource = 'planned' | 'logged';

/** Hard sets, and the heavy ones among them, in one body region. */
export interface RegionSets {
	hard: number;
	heavy: number;
}

interface LoadSessionBase {
	date: IsoDate;
	timeOfDay: TimeOfDay | null;
	/** 1 for the day's first session. */
	orderInDay: number;
	type: SessionType;
	title: string;
	discipline: Discipline;
	/** Null for a logged session, which records none. */
	intensity: SessionIntensity | null;
	/** Planned: its estimated minutes. Logged: M6's sessionLoads minutes; null when unknown. */
	minutes: number | null;
	/** Planned: its target RPE, null when it has none. Logged: M6's sessionLoads RPE. */
	rpe: number | null;
	source: LoadSource;
}

/** A planned or logged session as the load model reads it. */
export type LoadSession = LoadSessionBase &
	(
		| { kind: 'strength'; sets: Readonly<Record<Region, RegionSets>> }
		| { kind: 'run'; metres: number | null; intervals: boolean; long: boolean }
		| { kind: 'other'; format: OtherSessionKind; rounds: number | null }
	);

/** A SessionPlan, or a stored session with the fields the interference checks read. */
export type PlannedSession = InterferenceSession & { targetRpe?: number | null };

// ---- fromPlanned ----------------------------------------------------------------------------

function strengthSets(
	session: Extract<PlannedSession, { kind: 'strength' }>,
	traitsOf: TraitsOf
): Record<Region, RegionSets> {
	const sets = { lower: { hard: 0, heavy: 0 }, upper: { hard: 0, heavy: 0 } };
	for (const { exercise, sets: lines } of session.exercises) {
		const traits = traitsOf(exercise);
		const region = traits ? regionOf(traits) : null;
		if (!traits || !region) continue;
		const heavyLift = traits.tags.some((tag) => INTERFERENCE.heavyLiftTags.includes(tag));
		for (const line of lines) {
			const hard = hardSetsIn(line);
			sets[region].hard += hard;
			if (heavyLift && isHeavySet(line)) sets[region].heavy += hard;
		}
	}
	return sets;
}

/** The planned metres, when every segment gives its distance (a stored one may carry none). */
function metresOf(segments: readonly Pick<RunSegment, 'kind'>[]) {
	let metres = 0;
	for (const segment of segments) {
		const { distanceMetres, repeats } = segment as Partial<RunSegment>;
		if (distanceMetres === undefined || distanceMetres === null) return null;
		metres += distanceMetres * (repeats ?? 1);
	}
	return segments.length ? metres : null;
}

/** The rounds M6 counts (ROUND_KEYS), or null when no metric gives any. */
function roundsOf(metrics: readonly CustomMetric[] | undefined): number | null {
	const counts = (metrics ?? []).flatMap(({ key, value }) =>
		(ROUND_KEYS as readonly string[]).includes(key) && typeof value === 'number' ? [value] : []
	);
	return counts.length ? counts.reduce((sum, n) => sum + n, 0) : null;
}

/** A planned session as the load model reads it: hard and heavy sets by M3's interference rules. */
export function fromPlanned(
	session: PlannedSession,
	traitsOf: TraitsOf = catalogueTraits
): LoadSession {
	const base: LoadSessionBase = {
		date: session.date,
		timeOfDay: session.timeOfDay,
		orderInDay: session.orderInDay,
		type: session.type,
		title: session.title,
		discipline: session.discipline,
		intensity: session.intensity,
		minutes: session.estMinutes,
		rpe: session.targetRpe ?? null,
		source: 'planned'
	};
	if (session.kind === 'strength') {
		return { ...base, kind: 'strength', sets: strengthSets(session, traitsOf) };
	}
	if (session.kind === 'run') {
		const demand = demandOf(session, traitsOf);
		return {
			...base,
			kind: 'run',
			metres: metresOf(session.segments),
			intervals: demand.intervals,
			long: demand.longRun
		};
	}
	const details = session.details as { kind: OtherSessionKind; metrics?: CustomMetric[] };
	return { ...base, kind: 'other', format: details.kind, rounds: roundsOf(details.metrics) };
}

// ---- systemLoads ----------------------------------------------------------------------------

/**
 * - logged: logged RPE and duration
 * - planned: the plan's target RPE
 * - estimated: a planned session with no target, at DEFAULT_RPE
 * - unknown: a logged session with no RPE or no duration (or a planned one with no minutes)
 */
export type LoadStatus = 'logged' | 'planned' | 'estimated' | 'unknown';

export interface SystemLoads {
	/** AU by system: the basis times each share. Null when the load is unknown, never 0. */
	loads: Readonly<Record<LoadSystem, number>> | null;
	/** The session's sRPE (minutes × RPE), as M6 counts it; null when unknown. */
	basis: number | null;
	/** Each system's share of the basis: they add to 1, or are all 0 for mobility. */
	shares: Readonly<Record<LoadSystem, number>>;
	status: LoadStatus;
	/** The RPE the basis used: the session's, or DEFAULT_RPE's for an estimate. */
	rpe: number | null;
	/** Why it splits as it does and, for an estimate or an unknown, why it is one. */
	why: string[];
}

const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0);

/** The share rule's weights for this session. */
function weightsOf(session: LoadSession): { weights: Weights; why: string } {
	const type =
		session.kind === 'run' && session.intervals
			? 'interval_run'
			: session.kind === 'run' && session.long
				? 'long_run'
				: session.type;
	const rule = SYSTEM_SHARES[type];
	if (rule.by === 'fixed') return rule;
	if (rule.by === 'format') {
		const extra = session.kind === 'other' ? (rule.formats[session.format] ?? {}) : {};
		const weights = Object.fromEntries(
			SYSTEMS.map((system) => [system, (rule.weights[system] ?? 0) + (extra[system] ?? 0)])
		);
		return { weights, why: rule.why };
	}
	const { lower, upper } =
		session.kind === 'strength' ? session.sets : { lower: undefined, upper: undefined };
	const hard = (lower?.hard ?? 0) + (upper?.hard ?? 0);
	if (!lower || !upper || hard === 0) return { weights: rule.unplaced, why: rule.why };
	return {
		weights: {
			lower: lower.hard / hard,
			upper: upper.hard / hard,
			cns: ((lower.heavy + upper.heavy) / hard) * rule.heavyCns
		},
		why: rule.why
	};
}

function sharesOf(weights: Weights): Record<LoadSystem, number> {
	const total = sum(SYSTEMS.map((system) => weights[system] ?? 0));
	return Object.fromEntries(
		SYSTEMS.map((system) => [system, total > 0 ? (weights[system] ?? 0) / total : 0])
	) as Record<LoadSystem, number>;
}

const label = (type: SessionType) => SESSION_TYPE_LABEL[type].toLowerCase();

/** What `session` costs each system, on M6's sRPE basis and its rule for unknown load. */
export function systemLoads(session: LoadSession): SystemLoads {
	const { weights, why } = weightsOf(session);
	const shares = sharesOf(weights);
	const { minutes } = session;
	let { rpe } = session;
	let status: LoadStatus = session.source;
	const reasons = [why];
	if (session.source === 'planned' && rpe === null && minutes !== null) {
		rpe = DEFAULT_RPE[session.type];
		status = 'estimated';
		reasons.push(
			`It has no target RPE, so its load is estimated at RPE ${rpe}, a typical ${label(session.type)}, and kept apart from the known load.`
		);
	}
	if (minutes === null || rpe === null) {
		const lacks = [rpe === null && 'RPE', minutes === null && 'duration'].filter(Boolean);
		reasons.push(
			`It has no ${lacks.join(' or ')}, so its load is unknown: counted and named, never taken as 0.`
		);
		return { loads: null, basis: null, shares, status: 'unknown', rpe, why: reasons };
	}
	const basis = sessionLoadOf({ estMinutes: minutes, targetRpe: rpe });
	const loads = Object.fromEntries(
		SYSTEMS.map((system) => [system, basis * shares[system]])
	) as Record<LoadSystem, number>;
	return { loads, basis, shares, status, rpe, why: reasons };
}

// ---- sumByDay -------------------------------------------------------------------------------

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One fixed order, whatever order the sessions come in, so the sums are the same. */
const canonical = (a: LoadSession, b: LoadSession) =>
	compare(a.date, b.date) ||
	a.orderInDay - b.orderInDay ||
	compare(a.title, b.title) ||
	compare(JSON.stringify(a), JSON.stringify(b));

/**
 * Each date with a session, earliest first: the known load by system and in total (mobility's
 * counted in the total, as M6 counts it, and in no system), the estimated load apart, and the
 * sessions whose load is unknown counted. A day whose only loads are unknown has a null total.
 */
export function sumByDay(sessions: readonly LoadSession[]): DayLoad[] {
	const days = new Map<IsoDate, DayLoad & { bySystem: Record<LoadSystem, number> }>();
	for (const session of [...sessions].sort(canonical)) {
		let day = days.get(session.date);
		if (!day) {
			const bySystem = Object.fromEntries(SYSTEMS.map((s) => [s, 0])) as Record<LoadSystem, number>;
			day = { date: session.date, bySystem, total: null, estimated: 0, unknown: 0 };
			days.set(session.date, day);
		}
		const { loads, basis, status } = systemLoads(session);
		if (status === 'unknown' || loads === null || basis === null) day.unknown += 1;
		else if (status === 'estimated') day.estimated += basis;
		else {
			day.total = (day.total ?? 0) + basis;
			for (const system of SYSTEMS) day.bySystem[system] += loads[system];
		}
	}
	// M6's rule: a day of only unknown loads has no known total (null), never 0.
	return [...days.values()].map((day) =>
		day.total === null && day.unknown === 0 ? { ...day, total: 0 } : day
	);
}
