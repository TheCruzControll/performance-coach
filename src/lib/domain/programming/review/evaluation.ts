/**
 * The weekly review's one judge (m7/24 review-conflicts-engine): M7's evaluateWeek and repairWeek
 * over the review's own weeks, with the context the review service builds from the review's own
 * facts (services/periodisation/context.ts), so a move the review proposes never draws a Train
 * heads-up. Without that context (its reads failed, or no program plans the week) the review keeps
 * M3's checkWeek, in weekly.ts and next-week.ts.
 *
 * - The reviewed week is judged as performed: its logged workouts (weekly.ts's performedSessions)
 *   on the load model, which already holds them. Logged sessions are named only before its
 *   Monday, so a finding never names a workout twice.
 * - Next week is judged as planned, its load projected from the reviewed week: the days before
 *   next Monday as the model read them (planned and logged), and next week's sessions modelled
 *   again for every candidate, so a move moves its fatigue. Workouts logged in next week before the
 *   review are not in the review's facts, so next week counts from its plan, every day of it (the
 *   facts loader is the review's own: reading next week too would be a fact query of its own).
 * - A proposed change is judged with the changes kept before it: one that adds an avoid finding
 *   (by rule, days and sessions) is not proposed, nor is a move that leaves any finding still ahead
 *   on a session it moves (Train reads such a finding as a heads-up on the owner's move).
 *
 * Pure and deterministic, and server-only at runtime, like all of domain/programming.
 */
import { addDays, weekdayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { ProgramOp } from '../../coach/proposals.ts';
import { WEEKDAY_INFO } from '../../profile/catalog.ts';
import type { ExperienceLevel, TimeOfDay } from '../../profile/catalog.ts';
import type { SetPrescription } from '../../training/types.ts';
import type { WeekKind } from '../../training/vocabulary.ts';
import type { ContextEvent, WeekContext } from '../evaluate/concurrent.ts';
import type { Finding, WeekEvaluation } from '../evaluate/types.ts';
import { evaluateWeek } from '../evaluate/week.ts';
import type { EvaluatedSession } from '../evaluate/week.ts';
import { checkWeek, INTERFERENCE_RULES } from '../interference.ts';
import type { InterferenceSession, TraitsOf } from '../interference.ts';
import { loadModel } from '../load/fatigue.ts';
import type { FatigueDay, ModelLogged, ModelPlanned } from '../load/fatigue.ts';
import { weightOfSession } from '../priority/weights.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { repairWeek } from '../schedule/repair.ts';

/** What the review knows beyond its sessions: the evaluation context, as the service built it. */
export interface ReviewEvaluation {
	/** The load model from `from` through the reviewed week's Sunday, and what it read. */
	load: {
		from: IsoDate;
		days: readonly FatigueDay[];
		planned: readonly ModelPlanned[];
		logged: readonly ModelLogged[];
	};
	/** Effective priorities at the reviewed week's Monday. */
	priorities: readonly GoalPriority[];
	/** The reviewed week's kind. */
	weekKind: WeekKind | null;
	events: readonly ContextEvent[];
	level?: ExperienceLevel;
	/** Where the scheduler places a moved session first. */
	preferredTimes?: readonly TimeOfDay[];
}

/** A conflict entry as the review lists it: M6's (rule, headline, where, days) with its why. */
export interface ReviewConflict {
	/** M3's rule key for M3's rules (as M6 stored them), else the registry id. */
	rule: string;
	headline: string;
	/** The sentence after the headline, naming the days and sessions. */
	where: string;
	why: string;
	days: IsoDate[];
	/** The workouts it names, by id. */
	workouts: string[];
}

const M3_PREFIX = 'placement.';

/**
 * Decision (m7-plan, review-conflicts-engine): how many times next week is repaired when the
 * scheduler's answer needs an ease, a drop or a time-only change, which no move op expresses. Each
 * round keeps those sessions as planned and repairs the rest again.
 */
export const REPAIR_ROUNDS = 3;

/** The week's conflicts by M3's checkWeek alone, as M6 listed them. */
export function m3Conflicts(
	sessions: readonly (InterferenceSession & { id: string })[],
	traitsOf: TraitsOf
): ReviewConflict[] {
	return checkWeek(sessions, { traitsOf }).map((c) => {
		const [headline, where] = c.message.split(/: (.*)/s) as [string, string];
		const { why } = INTERFERENCE_RULES[c.rule];
		const workouts = c.sessions.map((s) => s.id);
		return { rule: c.rule, headline, where, why, days: c.days, workouts };
	});
}

/** A conflict: its rule, days and workouts. */
const conflictKey = (c: ReviewConflict) => [c.rule, ...c.days, ...c.workouts].join(' ');

/**
 * The reviewed week's conflicts as performed, on the logged load. `sessions` are its performed
 * sessions with the session RPE logged, by workout id. M3's conflicts evaluateWeek leaves out
 * follow: same_day_order, which priorities replace, only for a pair they do not rank (both goals
 * unranked or of equal weight), so a ranked pair is judged by same_day_priority_order alone.
 */
export function performedConflicts(
	sessions: readonly (InterferenceSession & { id: string; rpe: number | null })[],
	evaluation: ReviewEvaluation,
	at: { monday: IsoDate; today: IsoDate; traitsOf: TraitsOf }
): ReviewConflict[] {
	const { load, priorities, weekKind, events, level } = evaluation;
	const context: WeekContext = {
		load: { days: load.days, logged: load.logged.filter((l) => l.date < at.monday) },
		priorities,
		...(weekKind && { week: { kind: weekKind } }),
		events,
		...(level && { experience: level })
	};
	// A workout's id stands in for a lineage, so each finding names the workouts it cites.
	const judged = sessions.map(({ id, rpe, ...s }) => ({ ...s, lineage: id, targetRpe: rpe }));
	const { findings } = evaluateWeek(judged, { traitsOf: at.traitsOf, today: at.today, context });
	const conflicts = findings.map((f): ReviewConflict => {
		const m3 = f.rule.startsWith(M3_PREFIX);
		return {
			rule: m3 ? f.rule.slice(M3_PREFIX.length) : f.rule,
			headline: f.headline,
			where: f.message.startsWith(`${f.headline}: `)
				? f.message.slice(f.headline.length + 2)
				: f.message,
			why: f.why,
			days: f.days,
			workouts: f.sessions.flatMap((s) => (s.lineage ? [s.lineage] : []))
		};
	});
	const listed = new Set(conflicts.map(conflictKey));
	const byId = new Map(sessions.map((s) => [s.id, s]));
	// A pair the priorities rank follows same_day_priority_order alone, as evaluateWeek has it.
	const ranked = (c: ReviewConflict) => {
		const [a, b] = c.workouts.map((id) => weightOfSession(byId.get(id)!, priorities));
		return a !== b;
	};
	const m3 = m3Conflicts(sessions, at.traitsOf).filter(
		(c) => !listed.has(conflictKey(c)) && !(c.rule === 'same_day_order' && ranked(c))
	);
	return [...conflicts, ...m3];
}

/** A session of next week, as next-week.ts reads it. */
type Session = EvaluatedSession & { lineage: string };

/** Where next week is judged from. */
export interface NextWeekAt<S extends Session> {
	sessions: readonly S[];
	/** Next week's Monday, its kind and the owner's today. */
	monday: IsoDate;
	kind: WeekKind | null;
	today: IsoDate;
	/** The days a session may move to: next week's, from today. */
	open: readonly IsoDate[];
	traitsOf: TraitsOf;
}

/** Next week's context: the load projected from the reviewed week through `week`. */
function nextContext<S extends Session>(
	evaluation: ReviewEvaluation,
	at: NextWeekAt<S>,
	week: readonly S[]
): WeekContext {
	const { load, priorities, events, level } = evaluation;
	const planned = [...load.planned.filter((s) => s.date < at.monday), ...week];
	const days = loadModel({
		planned,
		logged: load.logged,
		from: load.from,
		to: addDays(at.monday, 6),
		// Next week counts from its plan: its workouts are not in the review's facts.
		today: at.monday,
		traitsOf: at.traitsOf
	});
	return {
		load: { days, logged: load.logged },
		priorities,
		...(at.kind && { week: { kind: at.kind } }),
		events,
		...(level && { experience: level })
	};
}

/** A change to next week, as next-week.ts proposes it: its op, and a line change's new line. */
export interface WeekChange {
	proposed: ProgramOp;
	line?: { exercise: string; position: number; after: SetPrescription };
}

/** `week` with `change` made, every other session as it was. */
function changed<S extends Session>(week: readonly S[], { proposed: op, line }: WeekChange): S[] {
	return week.map((s) => {
		if (s.lineage !== op.sessionLineage) return s;
		if (op.op === 'move') {
			const orderInDay = week.filter((o) => o.date === op.toDate).length + 1;
			const timeOfDay = op.timeOfDay === undefined ? s.timeOfDay : op.timeOfDay;
			return { ...s, date: op.toDate, orderInDay, timeOfDay };
		}
		if (line && s.kind === 'strength') {
			const exercises = s.exercises.map((e) =>
				(e as { lineage?: string }).lineage === line.exercise
					? { ...e, sets: e.sets.with(line.position - 1, line.after) }
					: e
			);
			return { ...s, exercises };
		}
		if (op.op === 'adjust_run_segment' && s.kind === 'run') {
			const segments = s.segments.map((seg, i) =>
				i === op.position - 1 ? { ...seg, distanceMetres: op.distanceMetres } : seg
			);
			return { ...s, segments };
		}
		return s;
	});
}

/** A finding: its rule, days and sessions. */
const keyOf = (f: Finding) =>
	[f.rule, ...f.days, ...f.sessions.map((s) => s.lineage ?? `${s.title}@${s.date}`)].join(' ');

/** A move repairWeek chose for a conflict in next week, with the finding it clears. */
export interface ConflictMove {
	sessionLineage: string;
	from: IsoDate;
	toDate: IsoDate;
	timeOfDay?: TimeOfDay | null;
	why: string;
	rule: string;
	severity: Finding['severity'];
}

/**
 * Next week judged with `evaluation`: repairWeek's moves for its conflicts, and a judge that keeps
 * each proposed change only when it adds no avoid finding to the week as changed so far.
 * `movable` says which sessions a move may change (still ahead, generated), and of those only the
 * ones a conflict of `severity` names move; every other session keeps its day, and so do the
 * owner's own moves.
 */
export function nextWeekJudge<S extends Session>(
	evaluation: ReviewEvaluation,
	at: NextWeekAt<S>,
	movable: (s: S) => boolean,
	severity: Finding['severity']
) {
	const judge = (week: readonly S[]): WeekEvaluation =>
		evaluateWeek(week, {
			traitsOf: at.traitsOf,
			openDates: at.open,
			today: at.today,
			context: nextContext(evaluation, at, week)
		});
	let week = [...at.sessions];
	let current = judge(week);

	/** repairWeek's moves, when next week has a conflict of `severity` on a session it may move. */
	function moves(): ConflictMove[] {
		// Decision (narrowing the plan's 'still-ahead sessions'): only the sessions a conflict of
		// `severity` names may move, as in M6's checkWeek path. A session with no conflict never moves
		// (no swap with a free one), so every move answers a conflict the review lists.
		const ahead = new Set(week.filter(movable).map((s) => s.lineage));
		const named = new Set(
			current.findings
				.filter((f) => f.severity === severity)
				.flatMap((f) =>
					f.sessions.flatMap((s) => (s.lineage && ahead.has(s.lineage) ? [s.lineage] : []))
				)
		);
		if (named.size === 0) return [];
		const { load, priorities, events, level } = evaluation;
		const repair = (fixed: ReadonlySet<string>) =>
			repairWeek(week, {
				open: at.open,
				priorities,
				load: {
					from: load.from,
					planned: load.planned.filter((s) => s.date < at.monday),
					logged: load.logged
				},
				...(at.kind && { week: { kind: at.kind } }),
				events,
				preferredTimes: evaluation.preferredTimes ?? [],
				...(level && { level }),
				// Next week's load from its plan, as nextContext models it. Nothing moves before today
				// all the same: only sessions ahead are left unfixed, and `open` starts today.
				today: at.monday,
				keepOwnerMoves: true,
				completed: week.filter((s) => fixed.has(s.lineage)).map((s) => s.lineage),
				traitsOf: at.traitsOf
			});
		// A repair that eases, drops or only retimes a session has no move op for it: that session
		// keeps its plan, and the rest is repaired again around it (REPAIR_ROUNDS at most).
		const fixed = new Set(week.filter((s) => !named.has(s.lineage)).map((s) => s.lineage));
		let repaired = repair(fixed);
		for (let round = 1; round < REPAIR_ROUNDS && repaired.ops.length === 0; round++) {
			const kept = repaired.actions.filter((a) => a.kind !== 'move' && a.kind !== 'swap');
			const lineages = kept.flatMap((a) => (a.session.lineage ? [a.session.lineage] : []));
			if (lineages.length === 0) break;
			for (const lineage of lineages) fixed.add(lineage);
			repaired = repair(fixed);
		}
		// Each move says which conflict it clears: the first of `severity` naming its session.
		return repaired.ops.map((op) => {
			const action = repaired.actions.find((a) => a.session.lineage === op.sessionLineage)!;
			const finding = current.findings.find(
				(f) => f.severity === severity && f.sessions.some((s) => s.lineage === op.sessionLineage)
			);
			const day = WEEKDAY_INFO[weekdayOf(op.toDate)].label;
			return {
				sessionLineage: op.sessionLineage,
				from: action.from.date,
				toDate: op.toDate,
				...(op.timeOfDay !== undefined && { timeOfDay: op.timeOfDay }),
				why: finding
					? `${finding.message} Moving ${action.session.title} to ${day} clears this.`
					: action.why,
				rule: finding?.rule ?? action.rule,
				severity: finding?.severity ?? severity
			};
		});
	}

	/**
	 * Why `changes` are not proposed, or null: then they are kept, and the next changes are judged
	 * after them. A change is refused for an avoid finding it would add to the week as changed so
	 * far (by rule, days and sessions); a move also for any finding still ahead that names a
	 * session it moves, which Train would show as a heads-up once the owner accepts it.
	 */
	function adds(changes: readonly WeekChange[]): Finding | null {
		const after = changes.reduce(changed, week);
		const judged = judge(after);
		const known = new Set(current.findings.map(keyOf));
		const moved = new Set(
			changes.flatMap((c) => (c.proposed.op === 'move' ? [c.proposed.sessionLineage] : []))
		);
		const names = (f: Finding) => f.sessions.some((s) => s.lineage && moved.has(s.lineage));
		const added = judged.findings.find(
			(f) => (f.severity === 'avoid' && !known.has(keyOf(f))) || (f.actionable && names(f))
		);
		if (added) return added;
		week = after;
		current = judged;
		return null;
	}

	return { moves, adds };
}
