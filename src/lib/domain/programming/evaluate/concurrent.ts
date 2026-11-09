/**
 * The concurrent-training rules beyond M3's (m7/20 concurrent-load-rules; PRD §2 and §5): residual
 * fatigue, hard-day and nervous-system caps, running volume against leg lifting, same-day order and
 * spacing, events and light weeks. evaluateWeek runs them beside M3's checkWeek when it is given a
 * context, and turns each into a Finding the same way; rules/concurrent.ts holds every threshold.
 *
 * Each rule runs only when the context carries what it reads: the load model for residual fatigue,
 * priorities for the same-day order, an experience level for the hard-day cap, a week kind for the
 * light-week limits, and events for event protection. Every finding names its sessions, earlier
 * first: the one that causes it, then the one it harms, whose goal weight scales its cost.
 *
 * Pure and deterministic: the same findings for any input order. Server-only, like all of
 * domain/programming.
 */
import { addDays, daysBetween, mondayOf, weekdayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import {
	EXPERIENCE_LEVEL_INFO,
	RUNNING_DISCIPLINES,
	TIME_OF_DAY_LABEL,
	TIMES_OF_DAY,
	WEEKDAY_INFO
} from '../../profile/catalog.ts';
import type { Discipline, ExperienceLevel } from '../../profile/catalog.ts';
import type { WeekTargets } from '../../training/types.ts';
import { PHASE_LABEL } from '../../training/vocabulary.ts';
import type { Phase, PlanStatus, WeekKind } from '../../training/vocabulary.ts';
import { demandOf } from '../interference.ts';
import type { SessionDemand, TraitsOf } from '../interference.ts';
import { readinessOn } from '../load/fatigue.ts';
import type { FatigueDay, ModelLogged } from '../load/fatigue.ts';
import { fromPlanned } from '../load/systems.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { weightOfSession } from '../priority/weights.ts';
import { canonicalJson, compareText } from '../random.ts';
import {
	CNS_SESSIONS_MAX,
	CONCURRENT_RULES,
	CUTBACK_KIND,
	EVENT_LEAD_DAYS,
	HARD_DAYS_CAP,
	INTERFERES_WITH,
	LIMITED_WEEKS,
	RUN_LOAD_HIGH,
	SEPARATION_HOURS,
	SEPARATION_MODERATE_SEVERITY,
	SLOT_HOURS,
	SPARRING_MAX
} from '../rules/concurrent.ts';
import type { ConcurrentRule, HardDemand } from '../rules/concurrent.ts';
import { HALF_LIVES } from '../rules/fatigue.ts';
import type { EventKind } from '../rules/priority.ts';
import type { RuleSeverity } from '../rules/registry/types.ts';
import { SYSTEM_LABEL, SYSTEMS } from './types.ts';
import type { LoadSystem } from './types.ts';
import type { EvaluatedSession } from './week.ts';

/** An event the week leads up to. */
export interface ContextEvent {
	date: IsoDate;
	kind: EventKind;
	title: string;
	/** Its goal: the cost of a finding that threatens it is that goal's weight. */
	goalId?: string;
}

/** What evaluateWeek may know beyond the sessions: each rule runs when what it reads is here. */
export interface WeekContext {
	/** The load model over the week and the days before it, and the logged sessions it read. */
	load?: { days: readonly FatigueDay[]; logged?: readonly ModelLogged[] };
	/** Effective priorities on the week's dates (priority/weights.ts). */
	priorities?: readonly GoalPriority[];
	/** The week's kind and phase, its own targets, and a cutback week's planned running minutes. */
	week?: { kind: WeekKind; phase?: Phase; targets?: WeekTargets; runMinutesTarget?: number };
	events?: readonly ContextEvent[];
	experience?: ExperienceLevel;
}

/** A session a finding names: an evaluated session, or a logged one from the load context. */
export interface Named {
	title: string;
	date: IsoDate;
	discipline: Discipline;
	source: string;
	lineage?: string;
	status?: PlanStatus;
	movedFrom?: IsoDate | null;
}

/** A finding before evaluateWeek adds its resolution and whether it is actionable. */
export interface ConcurrentFinding {
	rule: `concurrent.${ConcurrentRule}`;
	severity: RuleSeverity;
	days: IsoDate[];
	sessions: Named[];
	headline: string;
	message: string;
	why: string;
	/** The harmed goal's weight: 1 without priorities. */
	weight: number;
	/** The harmed goal's id, when no session the finding names trains it (an event's, running's). */
	harms?: string;
}

interface Row {
	session: EvaluatedSession;
	demand: SessionDemand;
	/** Its planned load, read with the caller's exercise lookup. */
	load: ReturnType<typeof fromPlanned>;
}

const dayName = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].label;
const andList = (names: readonly string[]) =>
	names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
const titled = (rows: readonly Row[]) => andList(rows.map((r) => r.session.title));
const onDays = (rows: readonly Row[]) =>
	andList(rows.map((r) => `${r.session.title} on ${dayName(r.session.date)}`));
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const systemWords = (s: LoadSystem) =>
	`the ${SYSTEM_LABEL[s].toLowerCase()}${s === 'aerobic' || s === 'combat' ? ' system' : ''}`;

const timeRank = (r: Row) => {
	const t = r.session.timeOfDay;
	return t === null || t === 'varies' ? null : TIMES_OF_DAY.indexOf(t);
};
/** Whether `a` is done before `b` on their day: by time of day when both differ, else by order. */
const before = (a: Row, b: Row) => {
	const [ta, tb] = [timeRank(a), timeRank(b)];
	return ta !== null && tb !== null && ta !== tb
		? ta < tb
		: a.session.orderInDay < b.session.orderInDay;
};
const isSparring = ({ session }: Row) =>
	session.kind === 'other' && session.details.kind === 'sparring';
/** The highest RPE the session asks for: its own target or any set's. */
const rpeOf = ({ session }: Row) =>
	Math.max(
		session.targetRpe ?? 0,
		...(session.kind === 'strength'
			? session.exercises.flatMap((e) => e.sets.map((l) => l.targetRpe ?? 0))
			: [])
	);

function finding(
	rule: ConcurrentRule,
	sessions: readonly Named[],
	message: string,
	weight: number,
	severity: RuleSeverity = CONCURRENT_RULES[rule].severity,
	harms?: string
): ConcurrentFinding {
	const { headline, why } = CONCURRENT_RULES[rule];
	const sorted = unique(sessions.map((s) => s.date)).sort(compareText);
	return {
		rule: `concurrent.${rule}`,
		severity,
		days: sorted,
		sessions: [...sessions],
		headline,
		message: `${headline}: ${message}`,
		why,
		weight,
		...(harms !== undefined && { harms })
	};
}

const asNamed = (rows: readonly Row[]): Named[] => rows.map((r) => r.session);

/** The rows of each Monday-to-Sunday week, in order. */
const byWeek = (rows: readonly Row[]) => [
	...Map.groupBy(rows, (r) => mondayOf(r.session.date)).values()
];

// ---- The rules -------------------------------------------------------------------------------

type Rule = (
	rows: readonly Row[],
	context: WeekContext,
	weight: (s: Named) => number
) => ConcurrentFinding[];

/** The fatigue `day` left on `date` in each of `systems`, decayed by their half-lives. */
const leftBy = (day: FatigueDay, date: IsoDate, systems: readonly LoadSystem[]) =>
	systems.reduce((sum, s) => {
		const { logged, planned, estimated } = day.systems[s];
		return (
			sum +
			(logged + planned + estimated) * 2 ** (-daysBetween(day.date, date) / HALF_LIVES[s].days)
		);
	}, 0);

const residualFatigue: Rule = (rows, { load }, weight) => {
	if (!load) return [];
	const known = new Set(load.days.map((d) => d.date));
	const logged = load.logged ?? [];
	const done = new Set(logged.flatMap((l) => (l.plannedLineage ? [l.plannedLineage] : [])));
	return rows.flatMap((row) => {
		const { date } = row.session;
		const needs = (Object.keys(INTERFERES_WITH) as HardDemand[]).flatMap((d) =>
			row.demand[d] ? INTERFERES_WITH[d] : []
		);
		if (needs.length === 0 || !known.has(date)) return [];
		const over = SYSTEMS.filter(
			(s) => needs.includes(s) && readinessOn(load.days, date, s).level === 'overloaded'
		);
		if (over.length === 0) return [];
		const cause = load.days
			.filter((d) => d.date < date)
			.reduce<FatigueDay | null>(
				(best, d) => (best && leftBy(best, date, over) > leftBy(d, date, over) ? best : d),
				null
			);
		const causes: Named[] = cause
			? [
					...logged
						.filter((l) => l.date === cause.date)
						.sort((a, b) => a.orderInDay - b.orderInDay || compareText(a.title, b.title)),
					...rows
						.filter((r) => r.session.date === cause.date)
						.filter((r) => !(r.session.lineage && done.has(r.session.lineage)))
						.map((r) => r.session)
				]
			: [];
		const from = causes.length
			? `${andList(causes.map((c) => c.title))} on ${dayName(cause!.date)}, then `
			: '';
		const message = `${from}${row.session.title} on ${dayName(date)}, with ${andList(over.map(systemWords))} still overloaded.`;
		return [
			finding(
				'residual_fatigue_before_hard',
				[...causes, row.session],
				message,
				weight(row.session)
			)
		];
	});
};

const threeHardDays: Rule = (rows, _, weight) => {
	const hardOn = (date: IsoDate) => rows.filter((r) => r.session.date === date && r.demand.hard);
	return unique(rows.map((r) => r.session.date)).flatMap((date) => {
		const run = [0, 1, 2].map((n) => hardOn(addDays(date, n)));
		if (run.some((day) => day.length === 0)) return [];
		const all = run.flat();
		if (all.every((r) => r.session.source === 'commitment')) return [];
		const message = `${run.map((day) => `${titled(day)} on ${dayName(day[0]!.session.date)}`).join(', ')}.`;
		return [finding('three_hard_days', asNamed(all), message, weight(all.at(-1)!.session))];
	});
};

const hardDaysCap: Rule = (rows, { experience }, weight) => {
	if (!experience) return [];
	const cap = HARD_DAYS_CAP[experience];
	return byWeek(rows).flatMap((week) => {
		const hard = week.filter((r) => r.demand.hard);
		const days = unique(hard.map((r) => r.session.date));
		if (days.length <= cap) return [];
		const level = EXPERIENCE_LEVEL_INFO[experience].label.toLowerCase();
		const message = `${days.length} hard days (${onDays(hard)}), against ${cap} for ${level === 'intermediate' ? 'an' : 'a'} ${level} athlete.`;
		return [finding('hard_days_cap', asNamed(hard), message, weight(hard.at(-1)!.session))];
	});
};

const weeklyCnsCap: Rule = (rows, _, weight) =>
	byWeek(rows).flatMap((week) => {
		const cns = week.filter((r) => {
			if (r.demand.intervals || isSparring(r)) return true;
			const { load } = r;
			return load.kind === 'strength' && load.sets.lower.heavy + load.sets.upper.heavy > 0;
		});
		if (cns.length <= CNS_SESSIONS_MAX) return [];
		const message = `${cns.length} sessions of heavy lifting, intervals or sparring (${onDays(cns)}), against ${CNS_SESSIONS_MAX}.`;
		return [finding('weekly_cns_cap', asNamed(cns), message, weight(cns.at(-1)!.session))];
	});

/** Why the week's running is high, or null when it is not. */
function runLoadHigh(context: WeekContext, monday: IsoDate): string | null {
	const phase = context.week?.phase;
	if (phase && (RUN_LOAD_HIGH.phases as readonly Phase[]).includes(phase)) {
		return `in a ${PHASE_LABEL[phase].toLowerCase()} week`;
	}
	const ratios = (context.load?.days ?? [])
		.filter((d) => mondayOf(d.date) === monday)
		.flatMap((d) => (d.systems.aerobic.ratio === null ? [] : [d.systems.aerobic.ratio]));
	const ratio = Math.max(-Infinity, ...ratios);
	return ratio >= RUN_LOAD_HIGH.aerobicRatio
		? `with your running load rising (an aerobic ratio of ${ratio.toFixed(2)})`
		: null;
}

const runVolumeVsLegStrength: Rule = (rows, context, weight) => {
	const logged = context.load?.logged ?? [];
	const done = new Set(logged.flatMap((l) => (l.plannedLineage ? [l.plannedLineage] : [])));
	const mondays = unique(rows.map((r) => mondayOf(r.session.date)));
	return mondays.flatMap((monday) => {
		const why = runLoadHigh(context, monday);
		if (!why) return [];
		const inWeek = (date: IsoDate) => mondayOf(date) === monday;
		const legs: { session: Named; sets: number }[] = [
			...rows
				.filter((r) => inWeek(r.session.date))
				.filter((r) => !(r.session.lineage && done.has(r.session.lineage)))
				.map((r) => ({ session: r.session as Named, load: r.load })),
			...logged.filter((l) => inWeek(l.date)).map((l) => ({ session: l as Named, load: l }))
		].flatMap(({ session, load }) =>
			load.kind === 'strength' && load.sets.lower.hard > 0
				? [{ session, sets: load.sets.lower.hard }]
				: []
		);
		legs.sort(
			(a, b) =>
				compareText(a.session.date, b.session.date) || compareText(a.session.title, b.session.title)
		);
		const total = legs.reduce((sum, l) => sum + l.sets, 0);
		const [low, high] = RUN_LOAD_HIGH.band;
		if (total <= high) return [];
		const named = andList(
			legs.map((l) => `${l.session.title} on ${dayName(l.session.date)} (${l.sets})`)
		);
		const message = `${total} lower-body hard sets ${why}, above the maintenance dose of ${low}–${high}: ${named}.`;
		const runWeight = weight({ ...legs[0]!.session, discipline: 'running' });
		const running = context.priorities && goalOf({ discipline: 'running' }, context.priorities);
		return [
			finding(
				'run_volume_vs_leg_strength',
				legs.map((l) => l.session),
				message,
				runWeight,
				CONCURRENT_RULES.run_volume_vs_leg_strength.severity,
				running?.goalId
			)
		];
	});
};

/** Pairs of sessions on one day, the earlier first. */
function sameDayPairs(rows: readonly Row[]): [Row, Row][] {
	return [...Map.groupBy(rows, (r) => r.session.date).values()].flatMap((day) =>
		day.flatMap((a) => day.flatMap((b): [Row, Row][] => (a !== b && before(a, b) ? [[a, b]] : [])))
	);
}

const sameDayPriorityOrder: Rule = (rows, { priorities }, weight) => {
	if (!priorities) return [];
	return sameDayPairs(rows.filter((r) => r.demand.hard)).flatMap(([a, b]) => {
		if (weight(b.session) <= weight(a.session)) return [];
		const message = `${a.session.title}, then ${b.session.title}, on ${dayName(a.session.date)}; ${b.session.title}’s goal ranks higher, so it goes first.`;
		return [finding('same_day_priority_order', [a.session, b.session], message, weight(b.session))];
	});
};

const hourOf = (r: Row) => {
	const t = r.session.timeOfDay;
	return t && t in SLOT_HOURS ? SLOT_HOURS[t as keyof typeof SLOT_HOURS] : null;
};
const moderate = (r: Row) => !r.demand.hard && !r.demand.easy;

const sameDaySeparation: Rule = (rows, _, weight) =>
	sameDayPairs(rows).flatMap(([a, b]) => {
		const [ha, hb] = [hourOf(a), hourOf(b)];
		if (ha === null || hb === null || Math.abs(hb - ha) >= SEPARATION_HOURS) return [];
		const both = a.demand.hard && b.demand.hard;
		if (!both && !(a.demand.hard && moderate(b)) && !(moderate(a) && b.demand.hard)) return [];
		const when = ({ session: { timeOfDay } }: Row) =>
			timeOfDay === 'midday'
				? 'at midday'
				: `in the ${TIME_OF_DAY_LABEL[timeOfDay!].toLowerCase()}`;
		const message = `${a.session.title} ${when(a)}, then ${b.session.title} ${when(b)}, on ${dayName(a.session.date)}: ${Math.abs(hb - ha)} hours apart, under ${SEPARATION_HOURS}.`;
		const severity = both
			? CONCURRENT_RULES.same_day_separation.severity
			: SEPARATION_MODERATE_SEVERITY;
		return [
			finding('same_day_separation', [a.session, b.session], message, weight(b.session), severity)
		];
	});

/** What an event's lead days keep away from it, and whether a session is that. */
const EVENT_GUARDS = {
	race: { what: 'heavy lower body', breaks: (r: Row) => r.demand.heavyLower },
	fight: { what: 'sparring', breaks: isSparring },
	meet: {
		what: 'anything heavier than openers',
		breaks: ({ session }: Row) =>
			session.kind === 'strength' &&
			session.exercises.some((e) =>
				e.sets.some(
					(l) =>
						(l.targetRpe ?? 0) > EVENT_LEAD_DAYS.meet.openerRpe ||
						((l.loadKind === 'percent_1rm' || l.loadKind === 'from_e1rm') &&
							(l.loadValue ?? 0) > EVENT_LEAD_DAYS.meet.openerFraction)
				)
			)
	}
} as const;

const eventProtection: Rule = (rows, { events, priorities }) =>
	// Events in one canonical order, so same-day findings never follow the caller's order.
	(events ?? [])
		.toSorted((a, b) => compareText(canonicalJson(a), canonicalJson(b)))
		.flatMap((event) => {
			const [guard, { days: lead }] = (
				Object.entries(EVENT_LEAD_DAYS) as [
					keyof typeof EVENT_LEAD_DAYS,
					(typeof EVENT_LEAD_DAYS)[keyof typeof EVENT_LEAD_DAYS]
				][]
			).find(([, rule]) => (rule.kinds as readonly EventKind[]).includes(event.kind))!;
			const goalWeight = priorities?.find((p) => p.goalId === event.goalId)?.weight ?? 1;
			return rows.flatMap((row) => {
				const days = daysBetween(row.session.date, event.date);
				if (days < 0 || days >= lead || !EVENT_GUARDS[guard].breaks(row)) return [];
				const message = `${row.session.title} on ${dayName(row.session.date)}, ${days} day${days === 1 ? '' : 's'} before ${event.title} on ${dayName(event.date)}; keep ${EVENT_GUARDS[guard].what} at least ${lead} days out.`;
				return [
					finding(
						'event_protection',
						[row.session],
						message,
						goalWeight,
						CONCURRENT_RULES.event_protection.severity,
						event.goalId
					)
				];
			});
		});

const recoveryWeekLimits: Rule = (rows, { week }, weight) => {
	if (!week) return [];
	if (week.kind === CUTBACK_KIND) {
		const runs = rows.filter((r) => r.session.kind === 'run');
		const minutes = runs.reduce((sum, r) => sum + r.session.estMinutes, 0);
		const target = week.runMinutesTarget;
		if (target === undefined || minutes <= target) return [];
		const message = `${minutes} minutes of running (${onDays(runs)}), above this cutback week’s ${target}.`;
		return [finding('recovery_week_limits', asNamed(runs), message, weight(runs.at(-1)!.session))];
	}
	if (!(week.kind in LIMITED_WEEKS)) return [];
	const cap = week.targets?.rpeCap ?? LIMITED_WEEKS[week.kind as keyof typeof LIMITED_WEEKS].rpeCap;
	return rows.flatMap((row) => {
		const rpe = rpeOf(row);
		if (rpe <= cap) return [];
		const message = `${row.session.title} on ${dayName(row.session.date)} asks for RPE ${rpe}, above this ${week.kind} week’s cap of ${cap}.`;
		return [finding('recovery_week_limits', [row.session], message, weight(row.session))];
	});
};

const sparringCap: Rule = (rows, _, weight) =>
	byWeek(rows).flatMap((week) => {
		const sparring = week.filter(isSparring);
		if (sparring.length <= SPARRING_MAX) return [];
		const message = `${sparring.length} sparring sessions (${onDays(sparring)}), against ${SPARRING_MAX}.`;
		return [finding('sparring_cap', asNamed(sparring), message, weight(sparring.at(-1)!.session))];
	});

/** The rules, in CONCURRENT_RULES' order. */
const RULES: Record<ConcurrentRule, Rule> = {
	residual_fatigue_before_hard: residualFatigue,
	three_hard_days: threeHardDays,
	hard_days_cap: hardDaysCap,
	weekly_cns_cap: weeklyCnsCap,
	run_volume_vs_leg_strength: runVolumeVsLegStrength,
	same_day_priority_order: sameDayPriorityOrder,
	same_day_separation: sameDaySeparation,
	event_protection: eventProtection,
	recovery_week_limits: recoveryWeekLimits,
	sparring_cap: sparringCap
};

/** Whether the context carries anything these rules read: without it, only M3's rules run. */
export const hasContext = (context: WeekContext | undefined): context is WeekContext =>
	context !== undefined &&
	[context.load, context.priorities, context.week, context.events, context.experience].some(
		(field) => field !== undefined
	);

/** The goal a session trains: the highest-ranked goal of its discipline (running's family). */
export function goalOf(
	session: { discipline: Discipline },
	priorities: readonly GoalPriority[]
): GoalPriority | undefined {
	const family = RUNNING_DISCIPLINES.includes(session.discipline)
		? RUNNING_DISCIPLINES
		: [session.discipline];
	return priorities
		.filter((p) => p.disciplines.some((d) => family.includes(d)))
		.sort((a, b) => a.rank - b.rank)[0];
}

/** The weight a finding harming `session`'s goal costs: 1 without priorities. */
export const weightFor =
	(priorities: readonly GoalPriority[] | undefined) => (session: { discipline: Discipline }) =>
		priorities ? weightOfSession(session, priorities) : 1;

/**
 * The concurrent rules `sessions` break in `context`: by first day, then in CONCURRENT_RULES'
 * order. Pass the sessions that will happen, skipped ones left out.
 */
export function checkConcurrent(
	sessions: readonly EvaluatedSession[],
	context: WeekContext,
	traitsOf?: TraitsOf
): ConcurrentFinding[] {
	// A session's canonical JSON breaks a tie of date and order only: written when a tie needs it.
	const keys = new Map<EvaluatedSession, string>();
	const keyOf = (session: EvaluatedSession) => {
		if (!keys.has(session)) keys.set(session, canonicalJson(session));
		return keys.get(session)!;
	};
	const rows = sessions
		.toSorted(
			(a, b) =>
				compareText(a.date, b.date) ||
				a.orderInDay - b.orderInDay ||
				compareText(keyOf(a), keyOf(b))
		)
		.map((session) => ({
			session,
			demand: demandOf(session, traitsOf),
			load: fromPlanned(session, traitsOf)
		}));
	const weight = weightFor(context.priorities);
	const order = Object.keys(CONCURRENT_RULES);
	return (Object.keys(RULES) as ConcurrentRule[])
		.flatMap((rule) => RULES[rule](rows, context, weight))
		.sort(
			(a, b) =>
				compareText(a.days[0]!, b.days[0]!) ||
				order.indexOf(a.rule.slice('concurrent.'.length)) -
					order.indexOf(b.rule.slice('concurrent.'.length))
		);
}
