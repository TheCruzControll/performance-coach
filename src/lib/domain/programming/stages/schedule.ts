/**
 * Every planned week repaired by the week scheduler (m7-plan generator-schedule): the last stage,
 * so it judges the real demands after loads and the time fit, with evaluateWeek's full context
 * (the load projected from the plan's week before, the week's priorities, kind and targets, the
 * goals' events and the leader's level).
 *
 * - Building weeks share their days (M3's rule: a session keeps its day all block). repairWeek runs
 *   on the block's hardest building week (HARDEST_BY), and its day and time changes are made in
 *   every building week whose same sessions and days allow them, each with one schedule_repaired
 *   decision for the block. When those days leave a building week a clash it could avoid, or a
 *   building week they miss moves a session on its own, the next hardest week's are tried, and the
 *   days fewest weeks lapse from are kept. Never pinned into a finding repair without pins would
 *   fix.
 * - Then every week, the OWN_WEEKS kinds included, is repaired on its own, in order, with the load
 *   of the week before as repaired, and the day before and the next Monday's commitments judged
 *   beside it, as placement judges a week. A building week's shared sessions stay pinned to their
 *   shared days and only what is left is repaired, unless the week as placed keeps fewer avoid
 *   findings that no trade-off explains. Where placement already succeeded, nothing changes.
 * - A strength session is never left out (KEEPS_ITS_DOSE).
 * - An eased session's prescription matches its new target: each main lift whose top set the ease
 *   lowered is loaded again by M3's loads rules at that RPE, its sRPE follows, and the time fit is
 *   checked again for it.
 * - What repair cannot fix is kept. A finding a higher-priority goal holds, or one between a goal's
 *   session and a session no goal trains, gets a priority_tradeoff decision. Moves, eases and drops
 *   get schedule_repaired, load_eased and session_dropped decisions. Decisions alike across weeks
 *   are one citing each session, and every decision's refs follow the sessions to their new places,
 *   as placement's do.
 *
 * Pure and deterministic, like every stage.
 */
import { addDays, daysBetween } from '../../calendar.ts';
import { TIMES_OF_DAY } from '../../profile/catalog.ts';
import type { TimeOfDay } from '../../profile/catalog.ts';
import { sessionLoadOf } from '../../training/metrics.ts';
import type {
	BlockPlan,
	PlanPath,
	PlannedExercisePlan,
	SessionPlan,
	WeekPlan
} from '../../training/types.ts';
import type { WeekKind } from '../../training/vocabulary.ts';
import { sessionPath } from '../commitments.ts';
import type { FactsFor } from '../decisions.ts';
import { clip } from '../demand.ts';
import { goalOf } from '../evaluate/concurrent.ts';
import type { ContextEvent } from '../evaluate/concurrent.ts';
import type { ProgrammingInput } from '../input.ts';
import { eachMain, loadBaseline } from '../loads.ts';
import type { MainLift } from '../loads.ts';
import { eventKindOf } from '../priority/weights.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { loadLater } from '../progression.ts';
import { compareText } from '../random.ts';
import { LOAD_RULES } from '../rules/loads.ts';
import { openDates } from '../running.ts';
import { repairWeek } from '../schedule/repair.ts';
import type { KeptFinding, RepairDecision } from '../schedule/repair.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';
import { fitWeek } from '../timefit.ts';
import type { Trim } from '../timefit.ts';

/**
 * The week kinds repaired on their own, never given the building weeks' shared days: their
 * sessions and load differ from the building weeks' (a deload's lighter strength, a taper's
 * shorter runs, an event's race), so the days that suit the hardest week need not suit them.
 */
export const OWN_WEEKS: readonly WeekKind[] = [
	'deload',
	'taper',
	'event',
	'recovery',
	'maintenance',
	'cutback'
];

/**
 * What makes a building week the hardest: the most planned sRPE (minutes × target RPE) in its
 * generated sessions, the earliest on a tie. Its days become the block's, so the clashes its real
 * demands bring are the ones the shared days avoid.
 */
export const HARDEST_BY = 'estLoad' satisfies keyof SessionPlan;

/**
 * Whether repair may leave a generated session out. A strength session holds the hard sets the
 * volume stage gave its goal, at least the goal's maintenance dose, so it is moved, eased or kept
 * with a priority_tradeoff instead, never dropped.
 */
export const KEEPS_ITS_DOSE = (s: { kind: string }) => s.kind !== 'strength';

/** The tag of a session judged beside a week but not in it: the day before, the next Monday. */
const AROUND = 'around ';

/** A decision names at most this many plan paths (programPlanSchema). */
const MAX_REFS = 50;

/** A session tagged with its index in the week as placement left it: its refs follow the tag. */
type Tagged = SessionPlan & { lineage: string };

const untag = ({ lineage: _tag, ...s }: Tagged): SessionPlan => s as SessionPlan;
const offsetOf = (s: SessionPlan, week: WeekPlan) => daysBetween(week.startsOn, s.date);
/** What finds the same session in another building week: its day, time, title and source. */
const keyOf = (s: SessionPlan, week: WeekPlan) =>
	JSON.stringify([offsetOf(s, week), s.timeOfDay, s.title, s.source]);
const weekLoad = (week: WeekPlan) =>
	week.sessions.reduce((sum, s) => sum + (s.source === 'generator' ? s[HARDEST_BY] : 0), 0);
const timeRank = (t: TimeOfDay | null) =>
	t === null || t === 'varies' ? TIMES_OF_DAY.length : TIMES_OF_DAY.indexOf(t);
/** What a day holds, to compare a building week's with the hardest week's. */
const holding = (sessions: readonly SessionPlan[], week: WeekPlan, offset: number) =>
	sessions
		.filter((s) => offsetOf(s, week) === offset)
		.map((s) => JSON.stringify([s.timeOfDay, s.title, s.source]))
		.sort(compareText)
		.join();

/** `sessions` in date order, each day's numbered from 1 by time of day, then by its old order. */
function ordered<S extends SessionPlan>(sessions: readonly S[]): S[] {
	const sorted = [...sessions].sort(
		(a, b) =>
			compareText(a.date, b.date) ||
			timeRank(a.timeOfDay) - timeRank(b.timeOfDay) ||
			a.orderInDay - b.orderInDay
	);
	return sorted.map((s, i) => {
		const order = i - sorted.findIndex((o) => o.date === s.date) + 1;
		return s.orderInDay === order ? s : { ...s, orderInDay: order };
	});
}

/** The events the goals lead to, for event protection. */
const eventsOf = (input: ProgrammingInput): ContextEvent[] =>
	input.goals.flatMap((goal, i) => {
		const kind = eventKindOf(goal);
		return kind && goal.eventDate
			? [{ date: goal.eventDate, kind, title: goal.title, goalId: input.refs.goals[i]! }]
			: [];
	});

const topRpe = (s: SessionPlan, exercise: number) =>
	s.kind === 'strength'
		? s.exercises[exercise]?.sets.find((l) => l.role === 'top')?.targetRpe
		: undefined;

/**
 * `eased`, week `w` of `block`'s `given` session as repair eased it, prescribed for its new target:
 * each main lift whose top set the ease lowered is loaded at that RPE as M3 loads a week with that
 * cap (loads for a baseline week or a lift's first, progression otherwise), then its sRPE and
 * the time fit.
 */
export function reloaded(
	eased: SessionPlan,
	given: SessionPlan,
	block: BlockPlan,
	w: number,
	input: ProgrammingInput
): { session: SessionPlan; trims: Trim[] } {
	const week = block.weeks[w]!;
	const exercises: readonly PlannedExercisePlan[] =
		eased.kind === 'strength' ? eased.exercises : [];
	// progressWeeks' rule: a lift with no 1RM not in an earlier week of the block gets its baseline.
	const seen = new Set<string>();
	for (const x of block.weeks.slice(0, w)) {
		eachMain(x, input, (planned, { lift }) => (seen.add(lift), planned));
	}
	const load = (planned: PlannedExercisePlan, main: MainLift) => {
		const n = exercises.indexOf(planned);
		const [now, was] = [topRpe(eased, n), topRpe(given, n)];
		if (now == null || was == null || now >= was) return planned;
		if (week.kind === 'baseline' || (!main.oneRepMax && !seen.has(main.lift))) {
			return loadBaseline(planned, main, now, LOAD_RULES);
		}
		const targets = block.weeks.slice(0, w + 1).map((x) => x.targets);
		targets[w] = { ...targets[w]!, rpeCap: now };
		return loadLater(planned, main, targets, LOAD_RULES);
	};
	const loaded = eachMain({ ...week, sessions: [eased] }, input, load);
	const fitted = fitWeek(loaded, input);
	const session = fitted.week.sessions[0]!;
	return { session: { ...session, estLoad: sessionLoadOf(session) }, trims: fitted.trims };
}

/**
 * The priority_tradeoff for an avoid finding repair keeps between a generated session of a goal
 * and a session no goal trains (a class of a discipline no goal names): a goal ranks above every
 * session without one (UNRANKED_SESSION_WEIGHT), so the goal's session keeps its day, said so.
 * Null for any other finding, which repair's own decision covers when priority holds it.
 */
function overUngoaled(
	{ finding, tradeoff }: KeptFinding,
	sessions: readonly Tagged[],
	priorities: readonly GoalPriority[] | undefined
): RepairDecision | null {
	if (finding.severity !== 'avoid' || !priorities) return null;
	const named = finding.sessions.map((n) => sessions.find((s) => s.lineage === n.lineage));
	// Either order: the goal's session first or the session no goal trains first.
	const ours = named.find((s) => s?.source === 'generator' && goalOf(s, priorities));
	const other = named.find((s) => s && s !== ours && !goalOf(s, priorities));
	if (!ours || !other) return null;
	const kept = goalOf(ours, priorities)!;
	const reason = `${kept.title} is one of your goals and ${other.title} trains none, so ${ours.title} keeps its day. ${tradeoff}`;
	return {
		kind: 'priority_tradeoff',
		ruleKey: 'generator.kept_over_ungoaled',
		facts: { kept: clip(kept.title, 40), given: clip(other.title, 80), reason: clip(reason, 200) }
	};
}

export const schedule: Stage = (draft, { input, options, log }) => {
	const { budget } = demandIn(draft);
	const notes = new Map<string, { refs: PlanPath[]; write: (refs: PlanPath[]) => void }>();
	/** One decision per block for alike facts: `ref` names its block. */
	const note = ({ kind, ruleKey, facts }: RepairDecision, ref: PlanPath) => {
		const id = JSON.stringify([ref.split('.')[1], kind, ruleKey, facts]);
		const found = notes.get(id) ?? {
			refs: [],
			write: (refs: PlanPath[]) => log.add(kind, ruleKey, refs, facts as FactsFor<typeof kind>)
		};
		if (!found.refs.includes(ref)) found.refs.push(ref);
		notes.set(id, found);
	};
	const trims = new Map<string, { facts: Trim['facts']; refs: PlanPath[] }>();
	const moves = new Map<PlanPath, PlanPath | null>();
	const events = eventsOf(input);
	const level = input.experience[input.disciplines[0]!];
	const openOf = (week: WeekPlan) => openDates(week, budget.days, options.firstPlannedDay);
	/**
	 * repairWeek on week `w` of `block`, with the load of `before`, the week before as planned.
	 * As in placement, the day before the week (its sessions, never changed) and the next Monday's
	 * commitments are judged with it, so no change makes a clash across the week's edges; they are
	 * left out of the result.
	 */
	const repairIn = (
		block: BlockPlan,
		w: number,
		sessions: Tagged[],
		before: readonly SessionPlan[],
		pinned: readonly string[] = []
	) => {
		const week = block.weeks[w]!;
		const [eve, after] = [addDays(week.startsOn, -1), addDays(week.endsOn, 1)];
		const next =
			block.weeks[w + 1]?.sessions ??
			week.sessions.map((s) => ({ ...s, date: addDays(s.date, 7) }));
		const around = [
			...before.filter((s) => s.date === eve),
			...next.filter((s) => s.source === 'commitment' && s.date === after)
		].map((s, i): Tagged => ({ ...s, lineage: `${AROUND}${i}` }));
		const priorities = draft.periodisation?.prioritiesByWeek.find(
			(p) => p.startsOn === week.startsOn
		)?.priorities;
		const r = repairWeek([...sessions, ...around], {
			open: openOf(week),
			preferredTimes: input.preferredTimes,
			priorities,
			week: { kind: week.kind, phase: block.phase, targets: week.targets },
			events,
			...(level && { level }),
			load: {
				from: addDays(week.startsOn, -7),
				planned: before.filter((s) => s.date !== eve),
				logged: []
			},
			completed: [...around.map((s) => s.lineage), ...pinned],
			mayDrop: KEEPS_ITS_DOSE
		});
		const all = r.sessions;
		return { ...r, all, priorities, sessions: all.filter((s) => !s.lineage.startsWith(AROUND)) };
	};

	let before: readonly SessionPlan[] = [];
	const blocks = draft.blocks.map((block, b) => {
		if (block.outline) return block;
		// Placement's index tags each session; every ref below names that index.
		const placed: Tagged[][] = block.weeks.map((week) =>
			week.sessions.map((s, i) => ({ ...s, lineage: `${i}` }))
		);
		const building = block.weeks.flatMap((week, w) => (OWN_WEEKS.includes(week.kind) ? [] : [w]));
		// The candidate weeks whose days the block shares: the hardest first, the earliest on a tie.
		const candidates = [...building].sort(
			(x, y) => weekLoad(block.weeks[y]!) - weekLoad(block.weeks[x]!) || x - y
		);

		/** Week `t`'s day and time changes, made in every building week they fit. */
		const sharedFrom = (t: number | undefined) => {
			const shared: ({
				sessions: Tagged[];
				pinned: string[];
				notes: [RepairDecision, PlanPath][];
			} | null)[] = placed.map(() => null);
			if (t === undefined) return shared;
			const week = block.weeks[t]!;
			const around = t > 0 ? block.weeks[t - 1]!.sessions : before;
			const repair = repairIn(block, t, placed[t]!, around);
			const kept = new Set(repair.sessions.map((s) => s.lineage));
			const changes = repair.actions.filter(
				(a) => a.to && a.kind !== 'ease' && kept.has(a.session.lineage!)
			);
			const keys = changes.map((a) => keyOf(week.sessions[Number(a.session.lineage)]!, week));
			const to = changes.map((a) => {
				const s = repair.sessions.find((x) => x.lineage === a.session.lineage)!;
				return { offset: offsetOf(s, week), timeOfDay: s.timeOfDay };
			});
			for (const w of changes.length ? building : []) {
				const [at, sessions] = [block.weeks[w]!, placed[w]!];
				const open = new Set(openOf(at));
				const next = sessions.map((s) => {
					const k = keys.indexOf(keyOf(s, at));
					if (k < 0) return s;
					return { ...s, date: addDays(at.startsOn, to[k]!.offset), timeOfDay: to[k]!.timeOfDay };
				});
				// Each day a change reaches must be open this week and hold what week t's does.
				const fits = to.every(
					({ offset }) =>
						!next.some((s, i) => s !== sessions[i] && offsetOf(s, at) === offset) ||
						(open.has(addDays(at.startsOn, offset)) &&
							holding(next, at, offset) === holding(repair.sessions, week, offset))
				);
				if (!fits || next.every((s, i) => s === sessions[i])) continue;
				const notes = next.flatMap((s, i): [RepairDecision, PlanPath][] => {
					const k = keys.indexOf(keyOf(sessions[i]!, at));
					return k < 0 ? [] : [[changes[k]!.decision, sessionPath(b, w, Number(s.lineage))]];
				});
				const pinned = sessions.flatMap((s, i) => (next[i] === s ? [] : [s.lineage]));
				shared[w] = { sessions: ordered(next), pinned, notes };
			}
			return shared;
		};

		// The avoid findings a week keeps; `open`, only those no trade-off explains.
		const avoids = (r: ReturnType<typeof repairIn>, open = true) =>
			r.kept.filter(
				(k) =>
					k.finding.severity === 'avoid' &&
					k.finding.resolution?.kind !== 'commitment_fixed' &&
					!(open && (k.decision ?? overUngoaled(k, r.all, r.priorities)))
			).length;

		/**
		 * Every week repaired on its own, in order, with the load of the week before, sharing week
		 * `t`'s days. A building week keeps its shared sessions pinned to the shared days, unless they
		 * leave it an avoid finding no trade-off explains that the week as placed avoids, or one that
		 * repair without the pins would fix: a `lapse`, as is a building week with no shared days whose
		 * own repair moves a generated session.
		 * What it records is made by `commit`.
		 */
		const pass = (t: number | undefined) => {
			const shared = sharedFrom(t);
			let [prev, lapses] = [before, 0];
			const cites: [RepairDecision, PlanPath][] = [];
			const trimmed: [Trim['facts'], PlanPath][] = [];
			const moved: [PlanPath, PlanPath | null][] = [];
			const weeks = placed.map((given, w): WeekPlan => {
				const week = block.weeks[w]!;
				const own = shared[w];
				const pinned = own && repairIn(block, w, own.sessions, prev, own.pinned);
				// Never pinned into a finding that repair without the pins would fix: an avoid, or a
				// prefer the shared days bring to a week whose own days differ, such as the first week,
				// which has no week before it.
				const withShared =
					pinned && repairIn(block, w, pinned.sessions, prev).actions.length === 0 ? pinned : null;
				const asPlaced =
					withShared && avoids(withShared) === 0 ? null : repairIn(block, w, given, prev);
				const r =
					withShared && (!asPlaced || avoids(withShared) <= avoids(asPlaced))
						? withShared
						: asPlaced!;
				// A building week lapses when it leaves the shared days or moves a session on its own.
				const movesOwn = r.actions.some(
					(a) =>
						a.to && a.kind !== 'ease' && given[Number(a.session.lineage)]?.source === 'generator'
				);
				if (r === withShared) cites.push(...own!.notes);
				else if (own || (building.includes(w) && movesOwn)) lapses += 1;
				const path = (tag: string | undefined) => sessionPath(b, w, Number(tag));
				const eased = new Set(
					r.actions.filter((a) => a.kind === 'ease').map((a) => a.session.lineage)
				);
				const out = r.sessions.map((s): Tagged => {
					if (!eased.has(s.lineage)) return s;
					const given = week.sessions[Number(s.lineage)]!;
					const reload = reloaded(untag(s), given, block, w, input);
					for (const { facts } of reload.trims) trimmed.push([facts, path(s.lineage)]);
					return { ...reload.session, lineage: s.lineage };
				});
				for (const a of r.actions) {
					cites.push([
						a.decision,
						a.kind === 'drop' ? `blocks.${b}.weeks.${w}` : path(a.session.lineage)
					]);
				}
				for (const kept of r.kept) {
					const decision = kept.decision ?? overUngoaled(kept, r.all, r.priorities);
					// It cites the first session of this week it names.
					const tag = kept.finding.sessions.find((n) => !n.lineage?.startsWith(AROUND))?.lineage;
					if (decision && tag !== undefined) cites.push([decision, path(tag)]);
				}
				const final = ordered(out);
				week.sessions.forEach((_, i) => {
					const n = final.findIndex((s) => s.lineage === `${i}`);
					moved.push([path(`${i}`), n < 0 ? null : sessionPath(b, w, n)]);
				});
				const sessions = final.map(untag);
				prev = sessions;
				return { ...week, sessions };
			});
			const commit = () => {
				for (const [decision, ref] of cites) note(decision, ref);
				for (const [facts, ref] of trimmed) {
					const id = JSON.stringify(facts);
					trims.set(id, { facts, refs: [...(trims.get(id)?.refs ?? []), ref] });
				}
				for (const [from, to] of moved) moves.set(from, to);
				before = prev;
			};
			return { weeks, lapses, commit };
		};

		// The hardest week's days, or the next hardest's while a building week lapses from them.
		let best = pass(candidates[0]);
		for (const t of candidates.slice(1)) {
			if (best.lapses === 0) break;
			const next = pass(t);
			if (next.lapses < best.lapses) best = next;
		}
		best.commit();
		return { ...block, weeks: best.weeks };
	});

	for (const { refs, write } of notes.values()) {
		for (let i = 0; i < refs.length; i += MAX_REFS) write(refs.slice(i, i + MAX_REFS));
	}
	for (const { facts, refs } of trims.values()) {
		for (let i = 0; i < refs.length; i += MAX_REFS) {
			log.add('time_trimmed', 'timefit.session_minutes', refs.slice(i, i + MAX_REFS), facts);
		}
	}
	log.retarget((ref) => {
		const [, session, rest] = /^(blocks\.\d+\.weeks\.\d+\.sessions\.\d+)(.*)$/.exec(ref) ?? [];
		const to = session === undefined ? undefined : moves.get(session);
		return to === undefined ? ref : to === null ? null : to + rest;
	});
	return { ...draft, blocks };
};
