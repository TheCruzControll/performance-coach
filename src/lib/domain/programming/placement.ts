/**
 * Every session on its day and time of day (PRD §2, §5), by the concurrent-training rules
 * (./interference.ts), the day rule (./demand.ts) and goal priority. Each planned week:
 * - The commitments stay on their weekdays. The other sessions take their days in
 *   PLACEMENT.order: the long run, hard Muay Thai, heavy lower-body days, other strength, the
 *   quality run, easy runs, then other Muay Thai and custom sessions, and mobility last.
 * - The day rule: one session on each free day, on at most the week's free days, and a second
 *   session on a commitment day holding one only for the allocation's doubles.
 * - Each session takes the day that breaks the fewest 'avoid' rules, then for the long run a free
 *   weekend day, then the fewest 'prefer' rules, then a free day before a second place on a
 *   commitment day, for the long run and hard Muay Thai a day after one heavy lower body could not
 *   take anyway, a hard session away from other hard days, and then the day the stage before gave
 *   it. Strength is judged as its hardest week makes it (PLACEMENT.planStrengthAs), so a session
 *   keeps its day all block.
 * - Times of day from the preferred times: a commitment keeps its own, and a session added beside
 *   it takes the first preferred time left, the other slot. A day's sessions are ordered by their
 *   times; each week's end in date order.
 * - A session every day of which breaks an 'avoid' rule keeps the best day on which its goal
 *   ranks above every session it clashes with; with no such day it is dropped, with a
 *   session_dropped decision. A week with more sessions than room (a part week 1) drops its
 *   lowest-priority sessions. A final checkWeek, at the sessions' real demands, allows no 'avoid'
 *   but one kept by priority, and gives each a priority_tradeoff decision.
 * - A session ruled off a day it prefers gets an interference_resolved decision, or a
 *   priority_tradeoff when a higher-priority goal's session holds the day it clashes with.
 * Decisions alike across weeks are one decision citing each session, and every decision's refs
 * follow the sessions to their new places.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { addDays, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { TIME_OF_DAY_LABEL, TIMES_OF_DAY, WEEKDAY_INFO } from '../profile/catalog.ts';
import type { TimeOfDay, Weekday } from '../profile/catalog.ts';
import type { BlockPlan, PlanPath, SessionPlan, WeekPlan } from '../training/types.ts';
import { SESSION_INTENSITIES } from '../training/vocabulary.ts';
import type { DecisionKind, SessionIntensity } from '../training/vocabulary.ts';
import { inWords, sessionPath } from './commitments.ts';
import type { DecisionLog, FactsFor } from './decisions.ts';
import { clip, commitmentStream } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import { checkWeek, demandOf } from './interference.ts';
import type { Violation } from './interference.ts';
import { compareText } from './random.ts';
import { openDates } from './running.ts';
import type { GenerateOptions } from './stage.ts';

/** Placement's judgement calls, as data (m3-plan: M7 extends the interference engine). */
export const PLACEMENT = {
	/** The order sessions take their days in, once the commitments are on theirs. */
	order: [
		'long_run',
		'hard_combat',
		'heavy_lower',
		'strength',
		'quality_run',
		'easy_run',
		'other',
		'mobility'
	],
	/** The long run's days, best first: the weekend has the time for it. */
	longRunDays: ['sat', 'sun'] as readonly Weekday[],
	/**
	 * Strength is placed as if at least this hard, as its building weeks are, so a lighter week
	 * (the baseline, the deload) keeps the block's days instead of a layout of its own.
	 */
	planStrengthAs: 'hard' as SessionIntensity
} as const;

type Role = (typeof PLACEMENT.order)[number];

/** A decision names at most this many plan paths (programPlanSchema). */
const MAX_REFS = 50;

interface Item {
	session: SessionPlan;
	/** Its place in the week as it came: decisions cite it there until refs are retargeted. */
	index: number;
	fixed: boolean;
	/** Its place in PLACEMENT.order; -1 for a commitment. */
	role: number;
	/** Its goal's place in the priority order, 0 the top; past every goal when none trains it. */
	rank: number;
	goal: string | null;
	/** A second session on a commitment day. */
	double: boolean;
	/** Kept on a day that breaks an 'avoid' rule, its goal ranking above each it clashes with. */
	breach: boolean;
}

interface Clash {
	violation: Violation<SessionPlan>;
	/** The sessions it names besides the one being placed. */
	others: Item[];
}

interface Candidate {
	date: IsoDate;
	/** The week with the session on this day, every day's times and order set. */
	week: Item[];
	clashes: Clash[];
	avoid: number;
	/**
	 * The long run's place in PLACEMENT.longRunDays on a free day, past them on any other; 0 for
	 * any other session. It outranks the 'prefer' rules: the weekend has the time a long run needs.
	 */
	weekend: number;
	prefer: number;
	/** The session's own preferences, the first deciding: lower is better. */
	prefers: number[];
}

interface Week {
	input: ProgrammingInput;
	demand: WeekDemand;
	/** The dates a generated session may go on. */
	open: IsoDate[];
	path: (index: number) => PlanPath;
	weekPath: PlanPath;
	note: Note;
}

type Note = <K extends DecisionKind>(
	kind: K,
	key: string,
	ref: PlanPath,
	facts: FactsFor<K>
) => void;

// ---- Sessions as placement sees them --------------------------------------------------------

const PLAN_AS = SESSION_INTENSITIES.indexOf(PLACEMENT.planStrengthAs);

/** A generated strength session at its block's hardest, for judging days; the rest as they are. */
const planned = (s: SessionPlan): SessionPlan =>
	s.kind === 'strength' &&
	s.source === 'generator' &&
	SESSION_INTENSITIES.indexOf(s.intensity) < PLAN_AS
		? { ...s, intensity: PLACEMENT.planStrengthAs }
		: s;

function roleOf(s: SessionPlan): Role {
	const demand = demandOf(planned(s));
	if (s.kind === 'run')
		return demand.longRun ? 'long_run' : demand.hard ? 'quality_run' : 'easy_run';
	if (s.kind === 'strength') return demand.heavyLower ? 'heavy_lower' : 'strength';
	return demand.hardCombat ? 'hard_combat' : s.type === 'mobility' ? 'mobility' : 'other';
}

/** The stream a session serves: a commitment's by its discipline, mobility none. */
function streamOf(s: SessionPlan, input: ProgrammingInput): string | null {
	if (s.source === 'commitment') {
		const c = input.commitments[input.refs.commitments.indexOf(s.commitmentRef ?? '')];
		return c ? commitmentStream(c) : null;
	}
	if (s.kind !== 'other') return s.kind === 'run' ? 'runs' : 'strength';
	return s.type === 'mobility' ? null : s.discipline;
}

function itemOf(session: SessionPlan, index: number, { input, demand }: Week): Item {
	const goals = input.maintenance ? input.paused : input.goals;
	const share = demand.allocation.streams.find((s) => s.stream === streamOf(session, input));
	const fixed = session.source === 'commitment';
	return {
		session,
		index,
		fixed,
		role: fixed ? -1 : PLACEMENT.order.indexOf(roleOf(session)),
		rank: share ? goals.indexOf(share.goal) : goals.length,
		goal: share ? clip(share.goal.title, 40) : null,
		double: false,
		breach: false
	};
}

const timeRank = (time: TimeOfDay | null) =>
	time === null || time === 'varies' ? TIMES_OF_DAY.length : TIMES_OF_DAY.indexOf(time);

/** Each day's times and order: commitments keep their times, the others take those left. */
function arrange(items: readonly Item[], preferred: readonly TimeOfDay[]): Item[] {
	return [...Map.groupBy(items, (item) => item.session.date).values()].flatMap((day) => {
		const taken = day.filter((i) => i.fixed).map((i) => i.session.timeOfDay);
		const left = preferred.filter((time) => !taken.includes(time));
		return day
			.map((i) =>
				i.fixed ? i : { ...i, session: { ...i.session, timeOfDay: left.shift() ?? null } }
			)
			.sort(
				(a, b) => timeRank(a.session.timeOfDay) - timeRank(b.session.timeOfDay) || a.role - b.role
			)
			.map((i, n) => ({ ...i, session: { ...i.session, orderInDay: n + 1 } }));
	});
}

/** The rules `items` break, judged at their planned demands, each traced back to its items. */
function judge(items: readonly Item[], open: readonly IsoDate[]) {
	const of = new Map(items.map((item) => [planned(item.session), item]));
	return { violations: checkWeek([...of.keys()], { openDates: open }), of };
}

// ---- Choosing a day ---------------------------------------------------------------------------

const LONG_RUN = PLACEMENT.order.indexOf('long_run');
/** The roles heavy lower body must not come the day before (heavy_lower_before_hard). */
const AFTER_LOWER = [LONG_RUN, PLACEMENT.order.indexOf('hard_combat')];
const isHard = (s: SessionPlan) => demandOf(planned(s)).hard;

/** `x` on `date`: the rules it would break there, and how much it would like the day. */
function score(
	x: Item,
	date: IsoDate,
	double: boolean,
	placed: readonly Item[],
	w: Week
): Candidate {
	const week = arrange(
		[...placed, { ...x, double, session: { ...x.session, date } }],
		w.input.preferredTimes
	);
	const { violations, of } = judge(week, w.open);
	const clashes = violations
		.filter((violation) => violation.sessions.some((s) => of.get(s)!.index === x.index))
		.map((violation) => ({
			violation,
			others: violation.sessions.map((s) => of.get(s)!).filter((i) => i.index !== x.index)
		}));
	const count = (severity: string) =>
		clashes.filter((c) => c.violation.severity === severity).length;
	const near = [-1, 1].filter((d) =>
		week.some((i) => i.session.date === addDays(date, d) && isHard(i.session))
	).length;
	const weekend = double ? -1 : PLACEMENT.longRunDays.indexOf(weekdayOf(date));
	// The day before, still empty, is a day heavy lower body could no longer take.
	const before = addDays(date, -1);
	const blocks =
		AFTER_LOWER.includes(x.role) &&
		w.open.includes(before) &&
		!week.some((i) => i.session.date === before);
	return {
		date,
		week,
		clashes,
		avoid: count('avoid'),
		weekend: x.role !== LONG_RUN ? 0 : weekend < 0 ? PLACEMENT.longRunDays.length : weekend,
		prefer: count('prefer'),
		prefers: [
			Number(double),
			Number(blocks),
			isHard(x.session) ? near : 0,
			Number(date !== x.session.date)
		]
	};
}

const byPreference = (a: Candidate, b: Candidate) =>
	a.weekend - b.weekend ||
	a.prefers.reduce((d, n, i) => d || n - b.prefers[i]!, 0) ||
	compareText(a.date, b.date);
const byRules = (a: Candidate, b: Candidate) =>
	a.avoid - b.avoid || a.weekend - b.weekend || a.prefer - b.prefer || byPreference(a, b);

/** The days `x` may take: a free day while the week has free days left, or a double. */
function candidates(x: Item, placed: readonly Item[], w: Week): Candidate[] {
	const { budget, allocation } = w.demand;
	const generated = placed.filter((i) => !i.fixed);
	const freeUsed = generated.filter((i) => !i.double).length;
	const doubles = generated.length - freeUsed;
	return w.open.flatMap((date) => {
		const here = placed.filter((i) => i.session.date === date);
		const fixed = here.filter((i) => i.fixed).length;
		if (here.length > fixed) return [];
		if (fixed === 0) return freeUsed < budget.freeDays ? [score(x, date, false, placed, w)] : [];
		const double = fixed === 1 && budget.doublesAllowed && doubles < allocation.doubles;
		return double ? [score(x, date, true, placed, w)] : [];
	});
}

// ---- Words ----------------------------------------------------------------------------------

const dayOf = ({ date, timeOfDay }: Pick<SessionPlan, 'date' | 'timeOfDay'>) =>
	WEEKDAY_INFO[weekdayOf(date)].label +
	(timeOfDay && timeOfDay !== 'varies' ? ` ${TIME_OF_DAY_LABEL[timeOfDay].toLowerCase()}` : '');
const sentence = (v: Violation<SessionPlan>) => v.message.replace(/\.$/, '');
const lowered = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const headline = (v: Violation<SessionPlan>) =>
	lowered(v.message.slice(0, v.message.indexOf(': ')));
const unique = <T>(items: readonly T[]) => [...new Set(items)];

/** Why `x` is not on the days it prefers to the one it takes: the 'avoid' rules that ruled them out. */
function noteMoves(x: Item, chosen: Candidate, all: readonly Candidate[], w: Week) {
	const at = chosen.week.find((i) => i.index === x.index)!;
	const explained = new Set<string>();
	const better = all.filter((c) => c.avoid > 0 && byPreference(c, chosen) < 0);
	for (const { violation, others } of better.flatMap((c) => c.clashes)) {
		if (violation.severity !== 'avoid') continue;
		for (const o of others) {
			// One reason for each rule and the session it clashes with, which repeats each week.
			const id = `${violation.rule} ${o.session.title}`;
			if (explained.has(id)) continue;
			explained.add(id);
			if (!o.fixed && o.rank < x.rank && o.goal && x.goal) {
				w.note('priority_tradeoff', 'placement.priority', w.path(x.index), {
					kept: o.goal,
					given: x.goal,
					reason: clip(
						`${o.goal} ranks above ${x.goal}, so its ${o.session.title} keeps ${dayOf(o.session)}, and ${x.goal} is planned around it: ${headline(violation)} is avoided.`,
						200
					)
				});
			} else {
				w.note('interference_resolved', `placement.${violation.rule}`, w.path(x.index), {
					session: x.session.title,
					other: o.session.title,
					conflict: clip(sentence(violation), 200),
					day: dayOf(at.session)
				});
			}
		}
	}
}

// ---- A week ---------------------------------------------------------------------------------

/**
 * `week`'s sessions on their days and times, in date order, and where each one went. `around` is
 * the days either side as they stand, the Sunday before and the commitments the Monday after, so
 * the rules hold across weeks too.
 */
function placeWeek(
	week: WeekPlan,
	around: readonly SessionPlan[],
	w: Week
): { sessions: SessionPlan[]; to: (number | null)[] } {
	const items = week.sessions.map((session, index) => itemOf(session, index, w));
	const beside = around.map((s, k) => ({ ...itemOf(s, -1 - k, w), fixed: true, role: -1 }));
	let placed = [...beside, ...items.filter((i) => i.fixed)];
	const queue = items.filter((i) => !i.fixed).sort((a, b) => a.role - b.role || a.index - b.index);
	const dropped = new Set<Item>();
	const drop = (x: Item, ruleKey: string, reason: string) => {
		dropped.add(x);
		w.note('session_dropped', ruleKey, w.weekPath, { session: x.session.title, reason });
	};

	// A week with more sessions than room drops the lowest-priority ones first.
	const { budget, allocation } = w.demand;
	const fixedOn = (date: IsoDate) => placed.filter((i) => i.session.date === date).length;
	const room =
		Math.min(budget.freeDays, w.open.filter((d) => fixedOn(d) === 0).length) +
		(budget.doublesAllowed
			? Math.min(allocation.doubles, w.open.filter((d) => fixedOn(d) === 1).length)
			: 0);
	const lowestFirst = [...queue].sort(
		(a, b) => b.rank - a.rank || b.role - a.role || b.index - a.index
	);
	const sessions = `${room} session${room === 1 ? '' : 's'}`;
	for (const x of lowestFirst.slice(0, Math.max(0, queue.length - room))) {
		drop(
			x,
			'placement.no_room',
			`the days left this week hold ${sessions} besides your commitments`
		);
	}

	for (const x of queue.filter((i) => !dropped.has(i))) {
		const all = candidates(x, placed, w).sort(byRules);
		const rivalsOf = (c: Candidate) =>
			unique(c.clashes.filter((k) => k.violation.severity === 'avoid').flatMap((k) => k.others));
		const best = all.find((c) => rivalsOf(c).every((r) => r.rank > x.rank));
		if (!best) {
			const avoid = all[0]!.clashes.filter((c) => c.violation.severity === 'avoid');
			const rule = lowered(sentence(avoid[0]!.violation));
			drop(
				x,
				'placement.every_day_clashes',
				clip(`every day left breaks a rule, such as ${rule}`, 200)
			);
			continue;
		}
		// Its goal outranks every session it clashes with: it keeps the day, and the final check
		// below records why for each week the rule is really broken.
		best.week.find((i) => i.index === x.index)!.breach = rivalsOf(best).length > 0;
		noteMoves(x, best, all, w);
		placed = best.week;
	}

	// Each 'avoid' rule a generated session breaks is kept by its goal's priority, with a decision.
	const all = arrange(placed, w.input.preferredTimes);
	const of = new Map(all.map((item) => [item.session, item]));
	for (const v of checkWeek([...of.keys()], { openDates: w.open })) {
		const named = v.sessions.map((s) => of.get(s)!);
		if (v.severity !== 'avoid' || !named.some((i) => i.index >= 0 && !i.fixed)) continue;
		const kept = named.find((i) => i.breach && named.every((o) => o === i || o.rank > i.rank));
		if (!kept) throw new Error(`Placement broke a rule: ${v.message}`);
		const goal = kept.goal ?? kept.session.title;
		const others = named.filter((i) => i !== kept).map((i) => i.goal ?? i.session.title);
		const given = clip(inWords(unique(others)), 80);
		w.note('priority_tradeoff', 'placement.priority_kept', w.path(kept.index), {
			kept: goal,
			given,
			reason: clip(
				`${goal} ranks above ${given}, so ${kept.session.title} keeps ${dayOf(kept.session)}, the best day left. ${v.message}`,
				200
			)
		});
	}
	const final = all
		.filter((i) => i.index >= 0)
		.sort(
			(a, b) =>
				compareText(a.session.date, b.session.date) || a.session.orderInDay - b.session.orderInDay
		);
	const to = items.map((item) => {
		const n = final.findIndex((i) => i.index === item.index);
		return n < 0 ? null : n;
	});
	return { sessions: final.map((i) => i.session), to };
}

/** Every planned week's sessions placed, with the decisions saying why. */
export function placeSessions(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ firstPlannedDay }: GenerateOptions,
	log: DecisionLog
): BlockPlan[] {
	const notes = new Map<string, { refs: PlanPath[]; write: (refs: PlanPath[]) => void }>();
	const note: Note = (kind, key, ref, facts) => {
		const id = JSON.stringify([kind, key, facts]);
		const found = notes.get(id) ?? { refs: [], write: (refs) => log.add(kind, key, refs, facts) };
		if (!found.refs.includes(ref)) found.refs.push(ref);
		notes.set(id, found);
	};
	const moves = new Map<PlanPath, PlanPath | null>();
	const weeks = blocks.flatMap((block, b) => block.weeks.map((week, n) => ({ b, n, week })));
	let before: readonly SessionPlan[] = [];
	const done = weeks.map(({ b, n, week }, k) => {
		const path = (index: number) => sessionPath(b, n, index);
		const open = openDates(week, demand.budget.days, firstPlannedDay);
		const w = { input, demand, open, path, weekPath: `blocks.${b}.weeks.${n}`, note };
		// After the last planned week, the commitments go on as they are.
		const after =
			weeks[k + 1]?.week.sessions ?? week.sessions.map((s) => ({ ...s, date: addDays(s.date, 7) }));
		const around = [
			...before.filter((s) => s.date === addDays(week.startsOn, -1)),
			...after.filter((s) => s.source === 'commitment' && s.date === addDays(week.endsOn, 1))
		];
		const { sessions, to } = placeWeek(week, around, w);
		to.forEach((index, from) => moves.set(path(from), index === null ? null : path(index)));
		before = sessions;
		return { ...week, sessions };
	});
	const placed = blocks.map((block, b) => ({
		...block,
		weeks: done.filter((_, k) => weeks[k]!.b === b)
	}));
	for (const { refs, write } of notes.values()) {
		for (let i = 0; i < refs.length; i += MAX_REFS) write(refs.slice(i, i + MAX_REFS));
	}
	log.retarget((ref) => {
		const [, session, rest] = /^(blocks\.\d+\.weeks\.\d+\.sessions\.\d+)(.*)$/.exec(ref) ?? [];
		const to = session === undefined ? undefined : moves.get(session);
		return to === undefined ? ref : to === null ? null : to + rest;
	});
	return placed;
}
