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
import { tradeoffSentence } from '../priority/weights.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { canonicalJson, compareText, fnv1a64 } from '../random.ts';
import { CONCURRENT_RULES } from '../rules/concurrent.ts';
import { EVALUATION_ID, GRADES, RESOLUTION_ORDER, SCORE_WEIGHTS } from '../rules/evaluation.ts';
import { checkConcurrent, goalOf, hasContext, weightFor } from './concurrent.ts';
import type { ConcurrentFinding, Named, WeekContext } from './concurrent.ts';
import type { Finding, ResolutionHint, WeekEvaluation } from './types.ts';

/** A session as the evaluator reads it: a stored one also carries its lineage and status. */
export type EvaluatedSession = InterferenceSession & {
	lineage?: string;
	status?: PlanStatus;
	movedFrom?: IsoDate | null;
	/** The session's own target RPE, when it has one (a run's, a class's). */
	targetRpe?: number | null;
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
	/** What else is known of the week: with it, the concurrent rules (evaluate/concurrent.ts) run too. */
	context?: WeekContext;
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

type Resolver = (sessions: readonly Named[], headline: string, harms?: string) => string | null;

/**
 * The trade-off sentence when the finding's first session trains a goal that ranks ahead of the
 * goal it harms (`harms`, else the goal its last session trains): the plan keeps the
 * higher-priority session where it is.
 */
function priorityTradeoff(
	sessions: readonly Named[],
	headline: string,
	priorities: readonly GoalPriority[] | undefined,
	harms: string | undefined
): string | null {
	if (!priorities) return null;
	const kept = goalOf(sessions[0]!, priorities);
	const given =
		harms === undefined
			? sessions.length > 1 && goalOf(sessions.at(-1)!, priorities)
			: priorities.find((p) => p.goalId === harms);
	return kept && given && kept.rank < given.rank ? tradeoffSentence(kept, given, headline) : null;
}

/** Each reason a week keeps a finding, as the sentence it reads, or null when it does not apply. */
function resolvers(
	hints: readonly PriorityHint[],
	freeDates: readonly IsoDate[],
	priorities?: readonly GoalPriority[]
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
		priority_kept: (sessions, headline, harms) =>
			hints.find((h) => sessions.some((s) => s.lineage === h.lineage))?.text ??
			priorityTradeoff(sessions, headline, priorities, harms),
		no_room: (sessions) => {
			// A logged session is done: it cannot move.
			const movable = sessions.find((s) => s.source !== 'commitment' && s.source !== 'logged');
			return movable && freeDates.length === 0
				? `The week has no free day to move ${movable.title} to.`
				: null;
		}
	};
}

function resolutionOf(
	{ sessions, headline, harms }: Draft,
	resolve: Record<ResolutionHint, Resolver>
): Finding['resolution'] {
	for (const kind of RESOLUTION_ORDER) {
		const text = resolve[kind](sessions, headline, harms);
		if (text !== null) return { kind, text };
	}
	return undefined;
}

/** A finding before its resolution: M3's violations and the concurrent rules' alike. */
type Draft = Omit<ConcurrentFinding, 'rule'> & Pick<Finding, 'rule' | 'area'>;

const draftOf = (
	violation: Violation<EvaluatedSession>,
	weight: (session: EvaluatedSession) => number
): Draft => ({
	rule: `placement.${violation.rule}`,
	area: 'interference',
	severity: violation.severity,
	days: [...violation.days],
	sessions: violation.sessions,
	headline: headlineOf(violation),
	message: violation.message,
	why: INTERFERENCE_RULES[violation.rule].why,
	// The later session is the one the clash harms.
	weight: weight(violation.sessions.at(-1)!)
});

function findingOf(
	draft: Draft,
	resolve: Record<ResolutionHint, Resolver>,
	today: IsoDate | undefined
): Finding {
	const resolution = resolutionOf(draft, resolve);
	return {
		rule: draft.rule,
		area: draft.area,
		severity: draft.severity,
		days: [...draft.days],
		sessions: draft.sessions.map(({ lineage, title, date }) => ({
			...(lineage !== undefined && { lineage }),
			title,
			date
		})),
		headline: draft.headline,
		message: draft.message,
		why: draft.why,
		...(resolution && { resolution }),
		actionable: today === undefined || draft.days.at(-1)! >= today
	};
}

/**
 * 100 less each finding's cost: SCORE_WEIGHTS, times the harmed goal's weight (1 without
 * priorities), at half when the week keeps it for a reason.
 */
function scoreOf(findings: readonly Finding[], weights: readonly number[]): number {
	const cost = findings.reduce(
		(sum, f, i) =>
			sum + SCORE_WEIGHTS[f.severity] * weights[i]! * (f.resolution ? SCORE_WEIGHTS.resolved : 1),
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
			demand: demandOf(s, traitsOf),
			// With a context, the concurrent rules read the whole session: its sets, RPE and minutes.
			session: hasContext(options.context) ? s : undefined
		})
	);
	const sorted = <T>(items: readonly T[] | undefined) =>
		items && items.map((item) => canonicalJson(item)).sort(compareText);
	const { context } = options;
	return {
		id: EVALUATION_ID,
		sessions: rows.sort(compareText),
		openDates: options.openDates && [...options.openDates].sort(compareText),
		hints: (options.hints ?? []).map((h) => canonicalJson(h)).sort(compareText),
		today: options.today,
		context: hasContext(context)
			? {
					load: context.load && {
						days: sorted(context.load.days),
						logged: sorted(context.load.logged)
					},
					priorities: sorted(context.priorities),
					week: context.week,
					events: sorted(context.events),
					experience: context.experience
				}
			: undefined
	};
}

/** The rule order findings are listed in within a day: M3's, then the concurrent rules'. */
const RULE_ORDER = [
	...Object.keys(INTERFERENCE_RULES).map((rule) => `placement.${rule}`),
	...Object.keys(CONCURRENT_RULES).map((rule) => `concurrent.${rule}`)
];

/**
 * Judge a week (or more) of sessions. Skipped sessions are left out: they will not happen.
 * Findings come by first day, then in INTERFERENCE_RULES' order, then CONCURRENT_RULES'. With a
 * context, the concurrent rules run too, and with priorities same_day_priority_order replaces
 * M3's same_day_order.
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
	const { traitsOf, openDates, context } = options;
	const resolve = resolvers(
		hints,
		open.filter((date) => !taken.has(date)),
		context?.priorities
	);
	const weight = weightFor(context?.priorities);
	let drafts: Draft[] = checkWeek(happening, { traitsOf, openDates }).map((v) =>
		draftOf(v, weight)
	);
	if (hasContext(context)) {
		drafts = [
			...drafts.filter((d) => !(context.priorities && d.rule === 'placement.same_day_order')),
			...checkConcurrent(happening, context, traitsOf).map((f) => ({
				...f,
				area: 'concurrent' as const
			}))
		].sort(
			(a, b) =>
				compareText(a.days[0]!, b.days[0]!) ||
				RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule)
		);
	}
	const findings = drafts.map((d) => findingOf(d, resolve, options.today));
	return {
		score: scoreOf(
			findings,
			drafts.map((d) => d.weight)
		),
		grade: gradeOf(findings),
		findings,
		fingerprint: fnv1a64(canonicalJson(judged(happening, options)))
	};
}
