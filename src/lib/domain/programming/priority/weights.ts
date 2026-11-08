/**
 * Goal priority on a date (M7, PRD §2 and §5), as data: which goal leads, which trains alongside
 * it as secondary and which is held at maintenance, each with the sentence that says why. It
 * applies rules/priority.ts to M3's shaping goals: with every open goal paused (input.maintenance)
 * every paused goal is at maintenance and none leads, as M3 plans it; otherwise paused goals are
 * left out, as in M3.
 *
 * Pure and deterministic: the same goals in any order give the same verdicts.
 */
import { daysBetween } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { RUNNING_DISCIPLINES } from '../../profile/catalog.ts';
import type { Discipline } from '../../profile/catalog.ts';
import type { Phase } from '../../training/vocabulary.ts';
import type { FactsFor } from '../decisions.ts';
import type { EffectivePriority } from '../evaluate/types.ts';
import type { InputGoal, ProgrammingInput } from '../input.ts';
import { clip } from '../demand.ts';
import { compareText } from '../random.ts';
import {
	ALL_PAUSED,
	CONFLICTS,
	LEAD,
	LEAD_WEEKS,
	RANK_WEIGHTS,
	SECONDARY_SHARE
} from '../rules/priority.ts';
import type { Emphasis, EventKind } from '../rules/priority.ts';

/** The rule keys a verdict cites: each is registered in rules/registry/priority.ts. */
export const PRIORITY_RULE_KEYS = {
	lead: 'priority.lead',
	rank: 'priority.rank_weights',
	share: 'priority.secondary_share',
	conflict: 'priority.conflicts',
	allPaused: 'priority.all_paused'
} as const;
export type PriorityRuleKey = (typeof PRIORITY_RULE_KEYS)[keyof typeof PRIORITY_RULE_KEYS];

/** A goal's priority on a date: EffectivePriority, with what decided it. */
export interface GoalPriority extends EffectivePriority {
	/** The goal's M2 uuid (input.refs). */
	goalId: string;
	title: string;
	disciplines: Discipline[];
	/** The owner's rank: 1 wins when goals compete. */
	priority: number;
	eventKind: EventKind | null;
	eventDate: IsoDate | null;
	/** Whole weeks from the date to the event: null without one, negative once it has passed. */
	weeksToEvent: number | null;
	/** Whether its event is inside its lead window on the date. */
	inWindow: boolean;
	/** The rule that set its mode. */
	rule: PriorityRuleKey;
}

type Goal = Pick<InputGoal, 'title' | 'disciplines' | 'eventType' | 'eventDate' | 'priority'>;

/** What an event goal is: null without an event date. */
export function eventKindOf(goal: Omit<Goal, 'priority'>): EventKind | null {
	if (goal.eventDate === null) return null;
	const text = goal.eventType ?? goal.title;
	const has = (d: Discipline) => goal.disciplines.includes(d);
	if (has('distance_running') || /marathon/i.test(text)) {
		return /half/i.test(text) ? 'half' : 'marathon';
	}
	if (/fight|bout/i.test(text) || (has('muay_thai') && !/grading/i.test(text))) return 'fight';
	if (/meet/i.test(text) || has('powerlifting') || has('weightlifting')) return 'meet';
	return 'other';
}

interface Windowed {
	goal: Goal;
	kind: EventKind | null;
	days: number | null;
	inWindow: boolean;
}

function windowOf(goal: Goal, on: IsoDate): Windowed {
	const kind = eventKindOf(goal);
	const days = goal.eventDate === null ? null : daysBetween(on, goal.eventDate);
	const inWindow =
		LEAD.windowBeatsRank &&
		kind !== null &&
		days !== null &&
		days >= 0 &&
		days < LEAD_WEEKS[kind].weeks * 7;
	return { goal, kind, days, inWindow };
}

/** Who goes first: an in-window event, then rank, then the sooner event, then the title. */
const leadOrder = (a: Windowed, b: Windowed) =>
	Number(b.inWindow) - Number(a.inWindow) ||
	a.goal.priority - b.goal.priority ||
	compareText(a.goal.eventDate ?? '~', b.goal.eventDate ?? '~') ||
	compareText(a.goal.title, b.goal.title);

/** Which of two goals wins on `on` when their demands conflict. */
export function winner<G extends Goal>(a: G, b: G, on: IsoDate): G {
	return leadOrder(windowOf(a, on), windowOf(b, on)) <= 0 ? a : b;
}

const weightAt = (place: number) => RANK_WEIGHTS[Math.min(place, RANK_WEIGHTS.length - 1)]!;

const emphasesOf = (goal: Goal): Emphasis[] => [
	...(goal.disciplines.includes('hypertrophy') ? (['hypertrophy'] as const) : []),
	...(goal.disciplines.some((d) => ['strength', 'powerlifting', 'weightlifting'].includes(d))
		? (['strength'] as const)
		: [])
];

/** The conflict that holds `goal` at maintenance while `leader` leads, if any. */
function conflictWith(leader: Windowed, goal: Goal, phase: Phase | undefined) {
	const emphases = emphasesOf(goal);
	return CONFLICTS.find(
		(c) =>
			c.leader === leader.kind &&
			emphases.includes(c.against) &&
			(phase === undefined ? c.inWindow && leader.inWindow : c.phases.some((p) => p === phase))
	);
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const inLine = (place: number) => `${ORDINALS[place] ?? `number ${place + 1}`} in line`;
const away = (days: number) => {
	const weeks = Math.floor(days / 7);
	return weeks === 0 ? 'under a week away' : `${weeks} week${weeks === 1 ? '' : 's'} away`;
};
const windowWords = (w: Windowed) => `its ${LEAD_WEEKS[w.kind!].weeks}-week lead window`;

/** The leader's sentence: the goals, the dates and the rule that put it first. */
function leaderWhy(leader: Windowed, all: readonly Windowed[]): string {
	const { title, eventDate } = leader.goal;
	// The latest event that has passed, which may have led until it did.
	const last = all
		.filter((w) => w.days !== null && w.days < 0)
		.sort((a, b) => b.days! - a.days! || leadOrder(a, b))[0];
	const passed = last ? ` ${last.goal.title}’s event on ${last.goal.eventDate} has passed.` : '';
	if (!leader.inWindow) {
		return `${title} is your top-ranked goal, and no goal’s event is inside its lead window.${passed}`;
	}
	const at = `${title} on ${eventDate} is ${away(leader.days!)}, inside ${windowWords(leader)}`;
	const over = all.find((w) => !w.inWindow && w.goal.priority < leader.goal.priority);
	if (over) {
		const their =
			over.days !== null && over.days >= 0
				? ` but ${away(over.days).replace(' away', '')} from its event on ${over.goal.eventDate}, outside ${windowWords(over)}`
				: '';
		return `${at}, so it leads ${over.goal.title}, ranked higher${their}.${passed}`;
	}
	const rival = all.find((w) => w !== leader && w.inWindow);
	if (rival) {
		return `${at}, as is ${rival.goal.title} on ${rival.goal.eventDate}, and you rank ${title} higher.${passed}`;
	}
	return `${at}, and it is your top-ranked goal.${passed}`;
}

/**
 * Every shaping goal's priority on `on`, the leader first. `phase` is the block's phase when it is
 * known; without it, a conflict holds while the leader's event is inside its lead window.
 */
export function effectivePriorities(
	input: ProgrammingInput,
	on: IsoDate,
	{ phase }: { phase?: Phase } = {}
): GoalPriority[] {
	const goals = input.maintenance ? input.paused : input.goals;
	const refs = input.maintenance ? input.refs.paused : input.refs.goals;
	const windowed = goals
		.map((goal, i) => ({ ...windowOf(goal, on), id: refs[i]! }))
		.sort((a, b) => leadOrder(a, b) || compareText(a.id, b.id));
	const leader = windowed[0];

	return windowed.map((w, place): GoalPriority => {
		const weight = weightAt(place);
		const base = {
			goalId: w.id,
			title: w.goal.title,
			disciplines: [...w.goal.disciplines],
			priority: w.goal.priority,
			rank: place,
			weight,
			eventKind: w.kind,
			eventDate: w.goal.eventDate,
			weeksToEvent: w.days === null ? null : Math.floor(w.days / 7),
			inWindow: w.inWindow
		};
		if (input.maintenance) {
			return {
				...base,
				mode: ALL_PAUSED.mode,
				why: ALL_PAUSED.reason,
				rule: PRIORITY_RULE_KEYS.allPaused
			};
		}
		if (w === leader) {
			const rule = w.inWindow ? PRIORITY_RULE_KEYS.lead : PRIORITY_RULE_KEYS.rank;
			return { ...base, mode: 'primary', why: leaderWhy(w, windowed), rule };
		}
		const held = `${w.goal.title} is held at maintenance while ${leader!.goal.title} leads`;
		const conflict = conflictWith(leader!, w.goal, phase);
		if (conflict) {
			return {
				...base,
				mode: 'maintenance',
				why: `${held}: ${conflict.why}`,
				rule: PRIORITY_RULE_KEYS.conflict
			};
		}
		const share = `${inLine(place)}, its weight of ${weight} is`;
		if (weight >= SECONDARY_SHARE * weightAt(0)) {
			const why = `${w.goal.title} trains alongside ${leader!.goal.title} as a secondary goal: ${share} at least half the leader’s, and the two do not conflict.`;
			return { ...base, mode: 'secondary', why, rule: PRIORITY_RULE_KEYS.share };
		}
		const why = `${held}: ${share} under half the leader’s.`;
		return { ...base, mode: 'maintenance', why, rule: PRIORITY_RULE_KEYS.share };
	});
}

/** The goal that leads on `on`; null when none does (every goal paused, or none open). */
export function leaderOn(
	input: ProgrammingInput,
	on: IsoDate,
	options: { phase?: Phase } = {}
): GoalPriority | null {
	return effectivePriorities(input, on, options).find((p) => p.mode === 'primary') ?? null;
}

/**
 * A session no goal trains still counts, at the least weight a goal can have (a class kept for
 * its own sake, say).
 */
export const UNRANKED_SESSION_WEIGHT: number = weightAt(RANK_WEIGHTS.length - 1);

const family = (d: Discipline): readonly Discipline[] =>
	RUNNING_DISCIPLINES.includes(d) ? RUNNING_DISCIPLINES : [d];

/** A session's weight: the highest weight among the goals that train its discipline. */
export function weightOfSession(
	session: { discipline: Discipline },
	priorities: readonly GoalPriority[]
): number {
	const trains = priorities.filter((p) =>
		p.disciplines.some((d) => family(session.discipline).includes(d))
	);
	return Math.max(UNRANKED_SESSION_WEIGHT, ...trains.map((p) => p.weight));
}

/**
 * The sentence for a conflict kept in the week: `rule` says what was kept ('Heavy squats the day
 * before hard sparring'), and `kept` must rank ahead of `given`.
 */
export function tradeoffSentence(kept: GoalPriority, given: GoalPriority, rule: string): string {
	if (kept.rank >= given.rank) {
		throw new RangeError(`'${kept.title}' does not rank ahead of '${given.title}'`);
	}
	const what = rule.trim().replace(/[.\s]+$/, '');
	return `${what}: kept, because ${kept.title} ranks ahead of ${given.title} on this date, so ${given.title} gives way.`;
}

const list = (titles: readonly string[]) =>
	titles.length < 2 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;

/**
 * The facts of a priority_resolved decision for a span with these priorities, and the rule key it
 * cites; null when no goal leads (every goal paused: each gets a maintenance_dose decision).
 */
export function priorityFacts(
	priorities: readonly GoalPriority[],
	from: IsoDate,
	until: IsoDate
): { ruleKey: PriorityRuleKey; facts: FactsFor<'priority_resolved'> } | null {
	const leader = priorities.find((p) => p.mode === 'primary');
	if (!leader) return null;
	const titlesIn = (mode: GoalPriority['mode']) =>
		priorities.filter((p) => p !== leader && p.mode === mode).map((p) => p.title);
	const secondary = titlesIn('secondary');
	const held = titlesIn('maintenance');
	const modes = [
		secondary.length
			? `${list(secondary)} ${secondary.length > 1 ? 'train' : 'trains'} alongside as secondary.`
			: '',
		held.length ? `${list(held)} ${held.length > 1 ? 'are' : 'is'} held at maintenance.` : ''
	]
		.filter(Boolean)
		.join(' ');
	// Every fact is a decision evidence string, 200 characters at most: long titles are cut.
	return {
		ruleKey: leader.rule,
		facts: {
			leader: clip(leader.title, 60),
			from,
			until,
			reason: clip(leader.why, 200),
			modes: clip(modes || 'It is your only open goal.', 200)
		}
	};
}
