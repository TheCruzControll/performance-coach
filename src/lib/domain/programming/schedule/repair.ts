/**
 * repairWeek (m7/21 week-scheduler): turns a week's findings into a better week with the fewest
 * changes, by rules/schedule.ts. Candidate weeks are costed on evaluateWeek's own rules (checkWeek
 * and checkConcurrent, merged as it merges them); evaluateWeek reports the given and repaired weeks.
 *
 * - Avoid findings go first, then prefer findings and load peaks, then closeness to the given days.
 * - Only sessions a finding names change, in ACTIONS' order. It walks the findings in their order,
 *   takes the first change that lowers the cost, reads the week's findings again after each one
 *   (each finding is tried once a pass), and stops after a pass with none, or at BOUNDS.
 *   Run again on its own result it changes nothing.
 * - What it cannot fix is kept with its trade-off: the evaluation's reason when it gives one.
 * - It repairs the owner's week as well as a generated one; only an owner-facing suggestion passes
 *   keepOwnerMoves false. Its moves come out as M3 moveSession inputs, and none when an ease, a
 *   drop or a time-only change is needed, which a move edit cannot express (it refuses a move to
 *   the session's own day).
 *
 * Pure and deterministic: no clock, and the same output for any input order. Server-only.
 */
import { addDays, daysBetween, mondayOf, weekdayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { TIME_OF_DAY_LABEL, TIMES_OF_DAY, WEEKDAY_INFO } from '../../profile/catalog.ts';
import type { ExperienceLevel, TimeOfDay } from '../../profile/catalog.ts';
import type { MoveSessionInput } from '../../training/edits.ts';
import { render, TEMPLATES } from '../decisions.ts';
import type { FactsFor } from '../decisions.ts';
import { clip } from '../demand.ts';
import { checkConcurrent, goalOf, hasContext, weightFor } from '../evaluate/concurrent.ts';
import type { ContextEvent, WeekContext } from '../evaluate/concurrent.ts';
import type { Finding, WeekEvaluation } from '../evaluate/types.ts';
import { evaluateWeek } from '../evaluate/week.ts';
import type { EvaluatedSession } from '../evaluate/week.ts';
import {
	catalogueTraits,
	checkWeek,
	demandOf,
	INTERFERENCE_RULES,
	regionOf
} from '../interference.ts';
import type { SessionDemand, TraitsOf } from '../interference.ts';
import { loadModel } from '../load/fatigue.ts';
import type { ModelLogged, ModelPlanned } from '../load/fatigue.ts';
import { PLACEMENT } from '../placement.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { canonicalJson, compareText } from '../random.ts';
import { CONCURRENT_RULES } from '../rules/concurrent.ts';
import { DOUBLES, doubleTime } from '../rules/days.ts';
import { DEFAULT_RPE } from '../rules/load.ts';
import { BOUNDS, EASE, OBJECTIVE, TIME_RULES } from '../rules/schedule.ts';
import type { RuleSeverity } from '../rules/registry/types.ts';
import type { ScheduleAction } from '../rules/schedule.ts';

export interface RepairContext {
	/** The dates a session may go on: the owner's open days. */
	open: readonly IsoDate[];
	/** Effective priorities on the week's dates (priority/weights.ts). */
	priorities?: readonly GoalPriority[];
	/**
	 * The load of the days before the week, from `from`: its planned and logged sessions. The
	 * week's own load is modelled again for every candidate week, so a move moves its fatigue.
	 */
	load?: { from: IsoDate; planned?: readonly ModelPlanned[]; logged: readonly ModelLogged[] };
	/** The week's kind (the plan's weekKind), with its phase and targets when known. */
	week?: WeekContext['week'];
	events?: readonly ContextEvent[];
	preferredTimes: readonly TimeOfDay[];
	level?: ExperienceLevel;
	/** The owner's today: earlier sessions are past, and nothing moves before it. */
	today?: IsoDate;
	/** False only for a suggestion made to the owner, which may move the owner's own moves. */
	keepOwnerMoves?: boolean;
	/** Lineages of sessions already logged: they never change. */
	completed?: readonly string[];
	traitsOf?: TraitsOf;
}

type DecisionOf<
	K extends 'schedule_repaired' | 'load_eased' | 'priority_tradeoff' | 'session_dropped'
> = { kind: K; ruleKey: string; facts: FactsFor<K> };
/** The facts of the decision an action or a kept finding is recorded with. */
export type RepairDecision =
	| DecisionOf<'schedule_repaired'>
	| DecisionOf<'load_eased'>
	| DecisionOf<'priority_tradeoff'>
	| DecisionOf<'session_dropped'>;

export interface Slot {
	date: IsoDate;
	timeOfDay: TimeOfDay | null;
}

export interface RepairAction {
	kind: ScheduleAction;
	session: { lineage?: string; title: string };
	from: Slot;
	/** Where it went: the same slot for an ease, null for a drop. */
	to: Slot | null;
	/** The rule of the finding it fixes. */
	rule: string;
	/** Its decision's why, in words. */
	why: string;
	decision: RepairDecision;
}

export interface KeptFinding {
	finding: Finding;
	/** Why the week keeps it, in one sentence. */
	tradeoff: string;
	/** When a higher-priority goal's session holds it. */
	decision?: DecisionOf<'priority_tradeoff'>;
}

/** An M3 moveSession input: valid under moveSessionSchema. */
export type MoveOp = Pick<MoveSessionInput, 'sessionLineage' | 'toDate' | 'timeOfDay'>;

export interface Judged {
	cost: number;
	evaluation: WeekEvaluation;
}

export interface RepairResult<S extends EvaluatedSession> {
	/** The week as repaired, in date order; a dropped session is left out. */
	sessions: S[];
	actions: RepairAction[];
	kept: KeptFinding[];
	ops: MoveOp[];
	before: Judged;
	after: Judged;
	/** The weeks evaluated, the given one included: at most BOUNDS.evaluations. */
	evaluations: number;
}

interface Item<S> {
	id: number;
	orig: S;
	now: S;
	fixed: boolean;
	eased: boolean;
	dropped: boolean;
}
type State<S> = readonly Item<S>[];
/** A finding as the search costs it, naming the week's own session objects. */
interface Clash {
	rule: string;
	severity: RuleSeverity;
	headline: string;
	message: string;
	why: string;
	sessions: readonly object[];
	/** The harmed goal's weight (1 without priorities). */
	weight: number;
	day: IsoDate;
}
interface Neighbour<S> {
	kind: ScheduleAction;
	state: State<S>;
	ids: number[];
}

const timeRank = (t: TimeOfDay | null) =>
	t === null || t === 'varies' ? TIMES_OF_DAY.length : TIMES_OF_DAY.indexOf(t);
const SLOTS = TIMES_OF_DAY.filter((t) => t !== 'varies');
const slotOf = (s: EvaluatedSession): Slot => ({ date: s.date, timeOfDay: s.timeOfDay });
const sameSlot = (a: Slot, b: Slot) => a.date === b.date && a.timeOfDay === b.timeOfDay;
const slotWords = ({ date, timeOfDay }: Slot) =>
	WEEKDAY_INFO[weekdayOf(date)].label +
	(timeOfDay && timeOfDay !== 'varies' ? ` ${TIME_OF_DAY_LABEL[timeOfDay].toLowerCase()}` : '');
const sentence = (text: string) => text.replace(/\.$/, '');
const lowered = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const onWeekend = (date: IsoDate) => PLACEMENT.longRunDays.includes(weekdayOf(date));
/** evaluateWeek's order of rules within a day: M3's, then the concurrent rules'. */
const RULE_ORDER = [
	...Object.keys(INTERFERENCE_RULES).map((rule) => `placement.${rule}`),
	...Object.keys(CONCURRENT_RULES).map((rule) => `concurrent.${rule}`)
];

function canonicalOrder<S extends EvaluatedSession>(sessions: readonly S[]): S[] {
	return sessions
		.map((s) => ({ s, key: canonicalJson(s) }))
		.sort(
			(a, b) =>
				compareText(a.s.date, b.s.date) ||
				a.s.orderInDay - b.s.orderInDay ||
				timeRank(a.s.timeOfDay) - timeRank(b.s.timeOfDay) ||
				compareText(a.key, b.key)
		)
		.map(({ s }) => s);
}

/** The highest RPE a session asks for: its own target, a set's, or its type's default. */
function rpeOf(s: EvaluatedSession): number {
	const sets = s.kind === 'strength' ? s.exercises.flatMap((e) => e.sets) : [];
	const asked = [s.targetRpe, ...sets.map((l) => l.targetRpe)].filter((r) => r != null);
	return asked.length ? Math.max(...(asked as number[])) : DEFAULT_RPE[s.type];
}

/** `s` eased (EASE): moderate, lower-body sets and its target capped, sparring as pads. */
function eased<S extends EvaluatedSession>(s: S, traitsOf: TraitsOf): S {
	const over = (rpe: number | null | undefined) => rpe != null && rpe > EASE.rpe;
	const intensity = (EASE.from as readonly string[]).includes(s.intensity)
		? EASE.intensity
		: s.intensity;
	const base = { ...s, intensity, ...(over(s.targetRpe) && { targetRpe: EASE.rpe }) };
	if (s.kind === 'strength') {
		const exercises = s.exercises.map((e) => {
			const traits = traitsOf(e.exercise);
			if (!traits || regionOf(traits) !== 'lower') return e;
			return {
				...e,
				sets: e.sets.map((l) => (over(l.targetRpe) ? { ...l, targetRpe: EASE.rpe } : l))
			};
		});
		return { ...base, exercises } as S;
	}
	if (s.kind === 'other' && s.details.kind === 'sparring') {
		return { ...base, details: { ...s.details, kind: EASE.sparringTo } } as S;
	}
	return base as S;
}

/**
 * Repair `sessions`, a week or more, with `ctx`. A kept finding is matched to its sessions by
 * lineage, or by title and date when they have none.
 */
export function repairWeek<S extends EvaluatedSession>(
	sessions: readonly S[],
	ctx: RepairContext
): RepairResult<S> {
	const traitsOf = ctx.traitsOf ?? catalogueTraits;
	const { today, keepOwnerMoves = true, priorities } = ctx;
	const open = new Set(ctx.open.filter((d) => today === undefined || d >= today));
	const completed = new Set(ctx.completed ?? []);
	const weight = weightFor(priorities);
	const times = new Set(ctx.preferredTimes.filter((t) => t !== 'varies'));

	const fixedOf = (s: S) =>
		s.source === 'commitment' ||
		s.status === 'skipped' ||
		(today !== undefined && s.date < today) ||
		(s.lineage !== undefined && completed.has(s.lineage)) ||
		(keepOwnerMoves && s.status === 'moved');
	const start: State<S> = canonicalOrder(sessions).map((s, id) => ({
		id,
		orig: s,
		now: s,
		fixed: fixedOf(s),
		eased: false,
		dropped: false
	}));
	const live = (state: State<S>) => state.filter((i) => !i.dropped).map((i) => i.now);
	const find = (state: State<S>, named: Finding['sessions'][number]) =>
		state.find(
			(i) =>
				!i.dropped &&
				(named.lineage !== undefined
					? i.now.lineage === named.lineage
					: i.now.lineage === undefined && i.now.title === named.title && i.now.date === named.date)
		);

	// ---- Judging a week ---------------------------------------------------------------------

	const demands = new WeakMap<S, SessionDemand>();
	const demand = (s: S) => {
		if (!demands.has(s)) demands.set(s, demandOf(s, traitsOf));
		return demands.get(s)!;
	};

	const contextOf = (week: readonly S[]): WeekContext => {
		const dates = week.map((s) => s.date).sort(compareText);
		const monday = mondayOf(dates[0] ?? ctx.load?.from ?? '2000-01-03');
		const load = ctx.load && {
			days: loadModel({
				planned: [...(ctx.load.planned ?? []), ...week],
				logged: ctx.load.logged,
				from: ctx.load.from,
				to: addDays(mondayOf(dates.at(-1) ?? monday), 6),
				today: today ?? monday,
				traitsOf
			}),
			logged: ctx.load.logged
		};
		return { load, priorities, week: ctx.week, events: ctx.events, experience: ctx.level };
	};

	/**
	 * The findings of a candidate week, as evaluateWeek finds them (M3's checkWeek, the concurrent
	 * rules with a context, same_day_order replaced with priorities, in its order), each with the
	 * harmed goal's weight, without the words and the fingerprint only the reported weeks need.
	 */
	const clashesOf = (week: readonly S[]): Clash[] => {
		const happening = week.filter((s) => s.status !== 'skipped');
		const context = contextOf(happening);
		const m3 = checkWeek(happening, { traitsOf, openDates: ctx.open })
			.filter((v) => !(priorities && v.rule === 'same_day_order'))
			.map((v) => ({
				rule: `placement.${v.rule}`,
				severity: v.severity,
				headline: v.message.slice(0, v.message.indexOf(': ')),
				message: v.message,
				why: INTERFERENCE_RULES[v.rule].why,
				sessions: v.sessions,
				weight: weight(v.sessions.at(-1)!),
				day: v.days[0]!
			}));
		const concurrent = hasContext(context)
			? checkConcurrent(happening, context, traitsOf).map((f) => ({ ...f, day: f.days[0]! }))
			: [];
		return [...m3, ...concurrent].sort(
			(a, b) => compareText(a.day, b.day) || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule)
		);
	};

	/** The standard deviation of the days' hard load, over every day of the weeks spanned. */
	const spreadOf = (week: readonly S[]) => {
		if (week.length === 0) return 0;
		const dates = week.map((s) => s.date).sort(compareText);
		const loads = new Map<IsoDate, number>();
		const last = addDays(mondayOf(dates.at(-1)!), 6);
		for (let d = mondayOf(dates[0]!); d <= last; d = addDays(d, 1)) loads.set(d, 0);
		for (const s of week) {
			if (s.status !== 'skipped' && demand(s).hard) {
				loads.set(s.date, loads.get(s.date)! + s.estMinutes * rpeOf(s));
			}
		}
		const values = [...loads.values()];
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
	};

	let evaluations = 0;
	/** A candidate week's cost (OBJECTIVE) and findings. */
	const judge = (state: State<S>) => {
		evaluations += 1;
		const week = live(state);
		const clashes = clashesOf(week);
		let cost = OBJECTIVE.spread * spreadOf(week);
		for (const c of clashes) {
			cost += c.severity === 'avoid' ? OBJECTIVE.avoid * (1 + c.weight) : OBJECTIVE.prefer;
		}
		for (const i of state) {
			if (i.dropped) {
				cost += OBJECTIVE.drop;
				continue;
			}
			if (i.eased) cost += OBJECTIVE.ease;
			cost += OBJECTIVE.dayMoved * Math.abs(daysBetween(i.orig.date, i.now.date));
			if (demand(i.now).longRun && !onWeekend(i.now.date)) cost += OBJECTIVE.longRunOffWeekend;
		}
		return { cost, clashes };
	};
	/** The week as evaluateWeek reports it. */
	const evaluationOf = (state: State<S>): WeekEvaluation => {
		const week = live(state);
		return evaluateWeek(week, { traitsOf, openDates: ctx.open, today, context: contextOf(week) });
	};

	// ---- The neighbours of a week -----------------------------------------------------------

	/** The week with each of `moves` on its date, or null when that breaks what KEPT keeps. */
	const relocate = (state: State<S>, moves: readonly { id: number; date: IsoDate }[]) => {
		const to = new Map(moves.map((m) => [m.id, m.date]));
		const next = state.map((i) =>
			to.has(i.id) ? { ...i, now: { ...i.now, date: to.get(i.id)! } } : i
		);
		const placed = next.map((i) => {
			if (!to.has(i.id)) return i;
			const { orig } = i;
			if (demand(orig).longRun && onWeekend(orig.date) && !onWeekend(i.now.date)) {
				return null;
			}
			const others = next.filter((o) => o !== i && !o.dropped && o.now.date === i.now.date);
			// Last in its new day's order; the sessions already there keep theirs.
			const now = { ...i.now, orderInDay: 1 + Math.max(0, ...others.map((o) => o.now.orderInDay)) };
			if (others.some((o) => o.now.source !== 'commitment')) return null;
			if (others.length === 0) return { ...i, now };
			// A double: beside one commitment only, at the time DOUBLES leaves it (doubleTime).
			const time = others.length === 1 ? doubleTime(others[0]!.now.timeOfDay, [...times]) : null;
			const double = time !== null && now.estMinutes <= DOUBLES.maxSessionMinutes;
			return double ? { ...i, now: { ...now, timeOfDay: time } } : null;
		});
		return placed.some((i) => i === null) ? null : (placed as Item<S>[]);
	};

	const datesFor = (state: State<S>, x: Item<S>) => {
		const monday = mondayOf(x.orig.date);
		const week = Array.from({ length: 7 }, (_, n) => addDays(monday, n));
		const taken = (d: IsoDate) => state.some((o) => !o.dropped && o !== x && o.now.date === d);
		return week
			.filter((d) => open.has(d) && d !== x.now.date)
			.sort(
				(a, b) =>
					Number(taken(a)) - Number(taken(b)) ||
					Math.abs(daysBetween(x.now.date, a)) - Math.abs(daysBetween(x.now.date, b)) ||
					compareText(a, b)
			);
	};

	/** The sessions a finding names, as the week's items: a logged session it names has none. */
	const namedIn = (state: State<S>, f: Clash) =>
		state.filter((i) => !i.dropped && f.sessions.includes(i.now));
	/** The weights of the goals a finding names besides `x`'s session: the harmed goal's among them. */
	const rivals = (state: State<S>, f: Clash, x: Item<S>) => [
		...namedIn(state, f)
			.filter((i) => i !== x)
			.map((i) => weight(i.now)),
		f.weight
	];

	function* neighbours(state: State<S>, f: Clash): Generator<Neighbour<S>> {
		const movable = namedIn(state, f).filter((i) => !i.fixed);
		for (const x of movable) {
			for (const date of datesFor(state, x)) {
				const next = relocate(state, [{ id: x.id, date }]);
				if (next) yield { kind: 'move', state: next, ids: [x.id] };
			}
		}
		for (const x of movable) {
			const partners = state
				.filter((y) => !y.fixed && !y.dropped && y !== x && y.now.date !== x.now.date)
				.filter((y) => mondayOf(y.orig.date) === mondayOf(x.orig.date))
				.filter((y) => open.has(y.now.date) && open.has(x.now.date))
				.sort(
					(a, b) =>
						Math.abs(daysBetween(x.now.date, a.now.date)) -
							Math.abs(daysBetween(x.now.date, b.now.date)) || a.id - b.id
				);
			for (const y of partners) {
				const moves = [
					{ id: x.id, date: y.now.date },
					{ id: y.id, date: x.now.date }
				];
				const next = relocate(state, moves);
				if (next) yield { kind: 'swap', state: next, ids: [x.id, y.id] };
			}
		}
		if (TIME_RULES.includes(f.rule)) {
			for (const x of movable) {
				const taken = state
					.filter((o) => o !== x && !o.dropped && o.now.date === x.now.date)
					.map((o) => o.now.timeOfDay);
				const slots = times.size ? SLOTS.filter((t) => times.has(t)) : SLOTS;
				for (const t of slots.filter((t) => t !== x.now.timeOfDay && !taken.includes(t))) {
					const next = state.map((i) => (i === x ? { ...i, now: { ...i.now, timeOfDay: t } } : i));
					yield { kind: 'time', state: next, ids: [x.id] };
				}
			}
		}
		for (const x of movable) {
			if (x.eased || rivals(state, f, x).some((w) => weight(x.now) > w)) continue;
			const now = eased(x.now, traitsOf);
			if (canonicalJson(now) === canonicalJson(x.now)) continue;
			const next = state.map((i) => (i === x ? { ...i, now, eased: true } : i));
			yield { kind: 'ease', state: next, ids: [x.id] };
		}
		if (f.severity !== 'avoid') return;
		for (const x of movable) {
			if (x.now.source !== 'generator') continue;
			if (rivals(state, f, x).some((w) => weight(x.now) >= w)) continue;
			yield {
				kind: 'drop',
				state: state.map((i) => (i === x ? { ...i, dropped: true } : i)),
				ids: [x.id]
			};
		}
	}

	// ---- The search -------------------------------------------------------------------------

	const decisionFor = (kind: ScheduleAction, x: Item<S>, to: Slot | null, f: Clash) => {
		const session = clip(x.now.title, 60);
		const conflict = clip(sentence(f.message), 200);
		const reason = clip(f.why, 200);
		if (kind === 'drop') {
			const why = `${lowered(f.headline)}, and no other day, time or easier version avoids it`;
			const facts = { session, reason: clip(why, 200) };
			return { kind: 'session_dropped', ruleKey: 'schedule.drop', facts } as const;
		}
		if (kind === 'ease') {
			const facts = { session, rpe: EASE.rpe, conflict, reason };
			return { kind: 'load_eased', ruleKey: f.rule, facts } as const;
		}
		const facts = {
			session,
			from: slotWords(slotOf(x.orig)),
			to: slotWords(to!),
			conflict,
			reason
		};
		return { kind: 'schedule_repaired', ruleKey: f.rule, facts } as const;
	};

	const actions = new Map<string, { action: RepairAction; first: Clash }>();
	const record = (n: Neighbour<S>, clash: Clash) => {
		for (const id of n.ids) {
			const x = n.state[id]!;
			const to = x.dropped ? null : slotOf(x.now);
			const moving = n.kind === 'move' || n.kind === 'swap' || n.kind === 'time';
			// One move per session, from where it was given to where it ends, for the first reason
			// it left its day.
			const key = moving ? `${id} place` : `${id} ${n.kind}`;
			const f = actions.get(key)?.first ?? clash;
			actions.delete(key);
			if (moving && sameSlot(slotOf(x.orig), to!)) continue;
			const decision = decisionFor(n.kind, x, to, f);
			const { why } = TEMPLATES[decision.kind];
			const action: RepairAction = {
				kind: n.kind,
				session: {
					...(x.now.lineage !== undefined && { lineage: x.now.lineage }),
					title: x.now.title
				},
				from: slotOf(x.orig),
				to,
				rule: f.rule,
				why: render(why, decision.facts, decision.kind),
				decision
			};
			actions.set(key, { action, first: f });
		}
	};

	let current = { state: start, ...judge(start) };
	const before: Judged = { cost: current.cost, evaluation: evaluationOf(start) };
	search: for (let pass = 0; pass < BOUNDS.passes; pass++) {
		let improved = false;
		// The current week's findings, so one a change brings is tried in the same pass.
		const tried = new Set<string>();
		const untried = () => current.clashes.find((g) => !tried.has(`${g.rule} ${g.message}`));
		for (let f = untried(); f; f = untried()) {
			tried.add(`${f.rule} ${f.message}`);
			for (const n of neighbours(current.state, f)) {
				if (evaluations >= BOUNDS.evaluations) break search;
				const next = judge(n.state);
				if (next.cost < current.cost - 1e-9) {
					record(n, f);
					current = { state: n.state, ...next };
					improved = true;
					break;
				}
			}
		}
		if (!improved) break;
	}

	// ---- The result -------------------------------------------------------------------------

	const final = current.state;
	const after: Judged = { cost: current.cost, evaluation: evaluationOf(final) };
	const kept = after.evaluation.findings.map((finding): KeptFinding => {
		const tradeoff =
			finding.resolution?.text ??
			`${finding.headline}: kept, because no other day, time of day, easier version or lower-priority session to leave out fixes it without costing the week more.`;
		const first = find(final, finding.sessions[0]!);
		const last = find(final, finding.sessions.at(-1)!);
		const keptGoal = priorities && first && goalOf(first.now, priorities);
		const given = priorities && last && goalOf(last.now, priorities);
		const held = finding.resolution?.kind === 'priority_kept' && keptGoal && given;
		if (!held || keptGoal.rank >= given.rank) return { finding, tradeoff };
		const facts = {
			kept: clip(keptGoal.title, 40),
			given: clip(given.title, 80),
			reason: clip(tradeoff, 200)
		};
		return {
			finding,
			tradeoff,
			decision: { kind: 'priority_tradeoff', ruleKey: 'schedule.priority_kept', facts }
		};
	});
	const list = [...actions.values()].map((a) => a.action);
	const moved = final.filter((i) => !i.dropped && !sameSlot(slotOf(i.orig), slotOf(i.now)));
	const expressible =
		list.every((a) => a.kind !== 'ease' && a.kind !== 'drop') &&
		moved.every((i) => i.now.lineage !== undefined && i.now.date !== i.orig.date);
	const ops: MoveOp[] = expressible
		? moved
				.filter((i) => today === undefined || i.orig.date >= today)
				.map((i) => ({
					sessionLineage: i.now.lineage!,
					toDate: i.now.date,
					...(i.now.timeOfDay !== i.orig.timeOfDay && { timeOfDay: i.now.timeOfDay })
				}))
		: [];
	return {
		sessions: canonicalOrder(live(final)),
		actions: list,
		kept,
		ops,
		before,
		after,
		evaluations
	};
}
