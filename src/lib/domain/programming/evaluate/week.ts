/**
 * evaluateWeek (m7/03): the one judge of a week. It runs M3's checkWeek unchanged and turns each
 * violation into a calm finding: the rule's why, the reason the plan keeps it when there is one,
 * and whether the owner can still act on it. It scores the week 0–100 and grades it.
 *
 * Pure and deterministic: no clock (the caller passes today), and the same result, fingerprint
 * included, for any input order. Findings carry titles, dates and lineages, never the caller's
 * objects. Server-only, like all of domain/programming.
 */
import { addDays, mondayOf, weekdayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { WEEKDAY_INFO } from '../../profile/catalog.ts';
import type { PlanStatus } from '../../training/vocabulary.ts';
import { catalogueTraits, checkWeek, demandOf, INTERFERENCE_RULES } from '../interference.ts';
import type { InterferenceSession, TraitsOf, Violation } from '../interference.ts';
import { canonicalJson, compareText, fnv1a64 } from '../random.ts';
import { EVALUATION_ID, GRADES, RESOLUTION_ORDER, SCORE_WEIGHTS } from '../rules/evaluation.ts';
import type { Finding, ResolutionHint, WeekEvaluation } from './types.ts';

/** A session as the evaluator reads it: a stored one also carries its lineage and status. */
export type EvaluatedSession = InterferenceSession & {
	lineage?: string;
	status?: PlanStatus;
	movedFrom?: IsoDate | null;
};

/** The generator's note that it kept a conflict for a goal's priority, naming a session. */
export interface PriorityHint {
	kind: 'priority_tradeoff';
	lineage: string;
	/** The trade-off in one sentence, naming both goals. */
	text: string;
}

export interface EvaluateOptions {
	/** Exercise traits: catalogueTraits by default, which knows none of the owner's own. */
	traitsOf?: TraitsOf;
	/** The dates a session could move to (checkWeek's openDates); every date of the week by default. */
	openDates?: readonly IsoDate[];
	hints?: readonly PriorityHint[];
	/** The owner's today: a finding whose later session is before it is no longer actionable. */
	today?: IsoDate;
}

const dayName = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].label;

/** 'Lower A', 'Lower A and Tempo run', 'A, B and C'. */
const andList = (names: readonly string[]) =>
	names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');

/** The rule's own headline: the words its message opens with. */
function headlineOf({ rule, message }: Violation): string {
	const data = INTERFERENCE_RULES[rule];
	const headlines: readonly string[] =
		'sequences' in data ? data.sequences.map((s) => s.headline) : [data.headline];
	return headlines.find((h) => message.startsWith(`${h}:`)) ?? headlines[0]!;
}

/** Each date of the Monday-to-Sunday weeks the sessions fall in. */
function spanOf(sessions: readonly EvaluatedSession[]): IsoDate[] {
	const dates = sessions.map((s) => s.date).sort(compareText);
	const span: IsoDate[] = [];
	const last = addDays(mondayOf(dates.at(-1)!), 6);
	for (let date = mondayOf(dates[0]!); date <= last; date = addDays(date, 1)) span.push(date);
	return span;
}

type Resolver = (sessions: readonly EvaluatedSession[]) => string | null;

/** Each reason a week keeps a finding, as the sentence it reads, or null when it does not apply. */
function resolvers(
	hints: readonly PriorityHint[],
	freeDates: readonly IsoDate[]
): Record<ResolutionHint, Resolver> {
	return {
		owner_moved: (sessions) => {
			const moved = sessions.find((s) => s.status === 'moved' && s.movedFrom);
			return moved ? `You moved ${moved.title} here from ${dayName(moved.movedFrom!)}.` : null;
		},
		commitment_fixed: (sessions) =>
			sessions.every((s) => s.source === 'commitment')
				? `${andList(sessions.map((s) => s.title))} are fixed commitments, so they keep their days.`
				: null,
		priority_kept: (sessions) =>
			hints.find((h) => sessions.some((s) => s.lineage === h.lineage))?.text ?? null,
		no_room: (sessions) => {
			const movable = sessions.find((s) => s.source !== 'commitment');
			return movable && freeDates.length === 0
				? `The week has no free day to move ${movable.title} to.`
				: null;
		}
	};
}

function resolutionOf(
	sessions: readonly EvaluatedSession[],
	resolve: Record<ResolutionHint, Resolver>
): Finding['resolution'] {
	for (const kind of RESOLUTION_ORDER) {
		const text = resolve[kind](sessions);
		if (text !== null) return { kind, text };
	}
	return undefined;
}

function findingOf(
	violation: Violation<EvaluatedSession>,
	resolve: Record<ResolutionHint, Resolver>,
	today: IsoDate | undefined
): Finding {
	const resolution = resolutionOf(violation.sessions, resolve);
	return {
		rule: `placement.${violation.rule}`,
		area: 'interference',
		severity: violation.severity,
		days: [...violation.days],
		sessions: violation.sessions.map(({ lineage, title, date }) => ({
			...(lineage !== undefined && { lineage }),
			title,
			date
		})),
		headline: headlineOf(violation),
		message: violation.message,
		why: INTERFERENCE_RULES[violation.rule].why,
		...(resolution && { resolution }),
		actionable: today === undefined || violation.days.at(-1)! >= today
	};
}

/** 100 less each finding's cost: SCORE_WEIGHTS, at half weight when the week keeps it for a reason. */
function scoreOf(findings: readonly Finding[]): number {
	const cost = findings.reduce(
		(sum, f) => sum + SCORE_WEIGHTS[f.severity] * (f.resolution ? SCORE_WEIGHTS.resolved : 1),
		0
	);
	return Math.max(0, Math.round(100 - cost));
}

/** GRADES, judged on the findings the owner can still act on. */
function gradeOf(findings: readonly Finding[]): WeekEvaluation['grade'] {
	const ahead = findings.filter((f) => f.actionable);
	const grades: Record<keyof typeof GRADES, boolean> = {
		conflicts: ahead.some((f) => f.severity === 'avoid' && !f.resolution),
		minor: ahead.length > 0,
		clear: true
	};
	return (Object.keys(GRADES) as (keyof typeof GRADES)[]).find((grade) => grades[grade])!;
}

/** What was judged, as plain data in one order: each session's day, words and demands. */
function judged(sessions: readonly EvaluatedSession[], options: EvaluateOptions) {
	const traitsOf = options.traitsOf ?? catalogueTraits;
	const rows = sessions.map((s) =>
		canonicalJson({
			date: s.date,
			timeOfDay: s.timeOfDay,
			orderInDay: s.orderInDay,
			title: s.title,
			type: s.type,
			source: s.source,
			lineage: s.lineage,
			status: s.status,
			movedFrom: s.movedFrom ?? undefined,
			demand: demandOf(s, traitsOf)
		})
	);
	return {
		id: EVALUATION_ID,
		sessions: rows.sort(compareText),
		openDates: options.openDates && [...options.openDates].sort(compareText),
		hints: (options.hints ?? []).map((h) => canonicalJson(h)).sort(compareText),
		today: options.today
	};
}

/**
 * Judge a week (or more) of sessions. Skipped sessions are left out: they will not happen.
 * Findings come in checkWeek's order: by first day, then in INTERFERENCE_RULES' order.
 */
export function evaluateWeek(
	sessions: readonly EvaluatedSession[],
	options: EvaluateOptions = {}
): WeekEvaluation {
	const happening = sessions.filter((s) => s.status !== 'skipped');
	const taken = new Set(happening.map((s) => s.date));
	const open = happening.length > 0 ? (options.openDates ?? spanOf(happening)) : [];
	// Hints in one canonical order, so the hint a finding reads never depends on the caller's order.
	const hints = (options.hints ?? []).toSorted((a, b) =>
		compareText(canonicalJson(a), canonicalJson(b))
	);
	const resolve = resolvers(
		hints,
		open.filter((date) => !taken.has(date))
	);
	const { traitsOf, openDates } = options;
	const findings = checkWeek(happening, { traitsOf, openDates }).map((v) =>
		findingOf(v, resolve, options.today)
	);
	return {
		score: scoreOf(findings),
		grade: gradeOf(findings),
		findings,
		fingerprint: fnv1a64(canonicalJson(judged(happening, options)))
	};
}
