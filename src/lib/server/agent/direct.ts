/**
 * Unambiguous lookups answered without a model call (the brief: 'answer simple lookups like
 * "what's today's workout" directly'; PRD §15: they keep working when the provider is
 * misconfigured). domain/coach/intents.ts decides whether the whole message is one of
 * DIRECT_INTENTS; this file reads M3's program (the reads Today and Train use) and writes the
 * answer as facts in the answer grammar, which the turn parses, checks and stores like a model's.
 * The turn records such a run as DIRECT_RUN, with no model call, so it costs nothing.
 *
 * It runs before the provider check, so no_key and mock_in_production still answer lookups; a
 * coach that is switched off or not launched refuses the turn before it gets here.
 *
 * Stored text (titles, session lines) is escaped for the grammar, so it can never open a tag or a
 * ref. One read per intent: the turn may hand this a transaction (docs/architecture.md).
 */
import { weekdayOf, type IsoDate } from '../../domain/calendar.ts';
import type { DirectIntent } from '../../domain/coach/intents.ts';
import { parseRef, REF_LABEL_MAX } from '../../domain/coach/sources.ts';
import { WEEKDAY_INFO } from '../../domain/profile/catalog.ts';
import type { SessionView } from '../../domain/training/types.ts';
import { resolveDeps, type CoachDeps } from '../services/coach/shared.ts';
import { getTodayPlan, getTrainingWeek } from '../services/programs/index.ts';
import type { TurnFacts } from './prompt/context.ts';

/** How a direct answer's run is recorded: no provider, no model, no effort, so no cost. */
export const DIRECT_RUN = Object.freeze({ provider: 'direct', model: 'none', effort: 'none' });

export interface DirectInput {
	ownerId: string;
	intent: DirectIntent;
	facts: TurnFacts;
	deps: CoachDeps;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Wed 11 Nov'. */
function day(date: IsoDate): string {
	const [, month, dom] = date.split('-').map(Number);
	return `${WEEKDAY_INFO[weekdayOf(date)].short} ${dom} ${MONTHS[month! - 1]}`;
}

/** Stored text as literal grammar text: a bracket or backslash never starts a tag or a ref. */
const literal = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');

/**
 * The words `label` as an inline ref to the record, which the screen shows as those words with a
 * source action; the words as literal text when the id cannot be cited inline. A label cannot
 * hold brackets, bars or backslashes, so those become spaces.
 */
function cite(type: 'session' | 'date', id: string, label: string): string {
	const clean = Array.from(label.replace(/[[\]|\\\n\r]/g, ' ').replace(/\s+/g, ' '))
		.slice(0, REF_LABEL_MAX)
		.join('')
		.trim();
	const inline = `${type}:${id}|${clean}`;
	return clean && parseRef(inline) ? `[[${inline}]]` : literal(label);
}

const NO_PROGRAM =
	'[note] You have no active program yet, so nothing is planned. Set one up in Train.';

const STATUS_WORDS: Record<SessionView['status'], (s: SessionView) => string> = {
	planned: () => '',
	completed: () => ' (done)',
	skipped: () => ' (skipped)',
	moved: (s) => (s.movedFrom ? ` (moved from ${day(s.movedFrom)})` : ' (moved)')
};

/** One session in words: its title (citing it), its one-line summary and its status. */
function session(s: SessionView): string {
	// An 'other' session's line opens with its title ('Muay Thai class · 90 min · Evening').
	const rest = s.line.startsWith(`${s.title} · `) ? s.line.slice(s.title.length + 3) : s.line;
	const line = rest && rest !== s.title ? ` — ${literal(rest)}` : '';
	return `${cite('session', s.lineage, s.title)}${line}${STATUS_WORDS[s.status](s)}`;
}

const bookable = (s: SessionView) => s.status === 'planned' || s.status === 'moved';

async function todaysWorkout({ ownerId, facts, deps }: DirectInput): Promise<string> {
	const today = facts.date;
	const plan = await getTodayPlan(ownerId, today, { db: resolveDeps(deps).db });
	if (!plan) return NO_PROGRAM;
	const blocks: string[] = [];
	if (plan.sessions.length > 0) {
		for (const s of plan.sessions) blocks.push(`[fact] Today, ${day(today)}: ${session(s)}.`);
		return blocks.join('\n\n');
	}
	if (plan.startsOn)
		blocks.push(
			`[fact] Your program starts on ${cite('date', plan.startsOn, day(plan.startsOn))}, so nothing is planned today.`
		);
	else if (plan.blockComplete)
		blocks.push("[fact] Your program's planned weeks are over, so nothing is planned today.");
	else blocks.push(`[fact] Today, ${day(today)}, is a rest day: nothing is planned.`);
	const next = plan.upNext.find(bookable);
	if (next) blocks.push(`[fact] Next up, ${day(next.date)}: ${session(next)}.`);
	return blocks.join('\n\n');
}

async function thisWeek({ ownerId, facts, deps }: DirectInput): Promise<string> {
	const week = await getTrainingWeek(
		ownerId,
		{ date: facts.date },
		{},
		{ db: resolveDeps(deps).db }
	);
	if (!week) return NO_PROGRAM;
	const span = `${day(week.startsOn)} to ${day(week.endsOn)}`;
	if (!week.planned)
		return `[fact] Nothing is planned this week (${span}): it is past your program's planned weeks.`;
	// Before the start, getTrainingWeek gives week 1, which may be a later calendar week.
	if (week.programStartsOn && facts.date < week.startsOn)
		return `[fact] Your program starts on ${cite('date', week.programStartsOn, day(week.programStartsOn))}, so nothing is planned this week. Week ${week.number} runs ${span}.`;
	const of = facts.week?.number === week.number && facts.week.of ? ` of ${facts.week.of}` : '';
	const sessions = week.days.flatMap((d) => d.sessions);
	const blocks = [`[fact] This is week ${week.number}${of}, ${span}.`];
	if (sessions.length === 0) blocks.push('[fact] Nothing is planned this week.');
	for (const s of sessions) blocks.push(`[fact] ${day(s.date)}: ${session(s)}.`);
	return blocks.join('\n\n');
}

async function nextSession({ ownerId, facts, deps }: DirectInput): Promise<string> {
	const plan = await getTodayPlan(ownerId, facts.date, { db: resolveDeps(deps).db });
	if (!plan) return NO_PROGRAM;
	const next = plan.sessions.find(bookable) ?? plan.upNext.find(bookable);
	if (!next)
		return plan.blockComplete
			? "[fact] Your program's planned weeks are over, so no session is planned next."
			: '[fact] No session is planned after today.';
	const when = next.date === facts.date ? `today, ${day(next.date)}` : day(next.date);
	return `[fact] Your next session is ${when}: ${session(next)}.`;
}

const ANSWERS: Record<DirectIntent, (input: DirectInput) => Promise<string>> = {
	todays_workout: todaysWorkout,
	this_week: thisWeek,
	next_session: nextSession
};

/** The answer to a lookup, in the answer grammar. */
export function directAnswer(input: DirectInput): Promise<string> {
	return ANSWERS[input.intent](input);
}
