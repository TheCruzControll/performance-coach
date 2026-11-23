/**
 * The coach's periodisation reads (M7, tools-periodisation-reads): the engine's own view of a
 * week, so the coach explains with its numbers instead of guessing. Both only read, owner-scoped
 * by the session's owner (someone else's ids read as nothing), and capOutput holds each result to
 * TURN_LIMITS.toolOutputBytes.
 *
 * - evaluate_week_interference: evaluateWeek over the week as stored, with up to WHAT_IF_MAX
 *   what-if moves applied in memory only: the score and grade (metric), the findings with their
 *   rule, reason and resolution and the decisions that explain them, and the week's load by body
 *   system (metric). suggestedRepair is the scheduler's repair of the stored week (repairWeek with
 *   keepOwnerMoves false), its moves of still-ahead sessions as M3 move ops, exactly the ops
 *   propose_program_adjustment stores without a draft, with what they clear and what the week
 *   keeps (a recommendation). The what-if moves never reach the repair: its ops name the week as
 *   it is stored, so the proposal accept applies is the one judged.
 * - explain_schedule_tradeoffs: the goals' effective priorities at the week's Monday (their rank
 *   weight as a metric, with the mode and its reason), the stored decisions that put the week's
 *   sessions, or one session's, on their days (facts with their ids), the maintenance doses among
 *   them, the clashes the week keeps and why, and the road (facts). The road is read from today,
 *   as the timeline shows it: it holds every later week, and its "Now" and weeks-away stay true.
 *
 * The week's context (services/periodisation/context.ts) is read in its own bounded read-only
 * transaction. Without it (its reads failed, recorded) the week is judged by checkWeek alone,
 * with no loads, priorities or doses, and `checked` says 'basic'.
 *
 * The three re-plan proposals (M7, tools-periodisation-proposals) store a replan proposal and
 * change nothing until the owner accepts it (services/periodisation/propose.ts):
 * - plan_block: the next block re-planned as a chosen phase, maintenance included (a block
 *   directive, regenerated from the next Monday).
 * - schedule_deload: this week's or next week's deload, in place, asked by the owner (a deload
 *   directive with trigger coach): this_week changes only the sessions still ahead.
 * - plan_taper: an event goal's taper, a full one or a mini (a taper directive, spliced in). Left
 *   without a kind, its form follows the goal's priority (BY_PRIORITY).
 * A refusal or an unchanged plan is a tool error carrying the engine's sentence, nothing stored.
 * Each result is capped at MAX_PROPOSAL_OPS rows, never the whole plan.
 */
import * as z from 'zod/mini';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar.ts';
import type { DiffRow } from '../../../domain/coach/diff.ts';
import { MAX_PROPOSAL_OPS, moveOpSchema } from '../../../domain/coach/proposals.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import { TIMES_OF_DAY, type TimeOfDay } from '../../../domain/profile/catalog.ts';
import {
	SYSTEM_LABEL,
	SYSTEMS,
	type Finding,
	type WeekEvaluation
} from '../../../domain/programming/evaluate/types.ts';
import { evaluateWeek } from '../../../domain/programming/evaluate/week.ts';
import { loadModel, weekSummary } from '../../../domain/programming/load/fatigue.ts';
import { effectivePriorities } from '../../../domain/programming/priority/weights.ts';
import { SCORE_WEIGHTS } from '../../../domain/programming/rules/evaluation.ts';
import { RANK_WEIGHTS } from '../../../domain/programming/rules/priority.ts';
import { REFUSALS } from '../../../domain/programming/rules/replan.ts';
import { BY_PRIORITY } from '../../../domain/programming/rules/taper.ts';
import { repairWeek } from '../../../domain/programming/schedule/repair.ts';
import {
	REPLAN_BLOCK_WEEKS,
	REPLAN_PHASES,
	REPLAN_REASONS,
	TAPER_FORMS
} from '../../../domain/training/replan.ts';
import { DECIDERS, DECISION_KINDS, WEEK_KINDS } from '../../../domain/training/vocabulary.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import { proposeDeload } from '../../services/periodisation/deload.ts';
import { tradeoffHints } from '../../services/periodisation/evaluate.ts';
import {
	getScheduleTradeoffs,
	MAX_TRADEOFF_DECISIONS,
	type ScheduleDecision
} from '../../services/periodisation/explain.ts';
import {
	evaluationContext,
	weekContextOf,
	type EvaluationContext
} from '../../services/periodisation/context.ts';
import {
	proposeReplan,
	type ProposedReplan,
	type ReplanCoach
} from '../../services/periodisation/propose.ts';
import { getRoadView, serialiseRoad } from '../../services/periodisation/road-view.ts';
import { programmingInputFor } from '../../services/programs/alternatives.ts';
import {
	getCurrentProgram,
	getProgramVersion,
	type StoredSession
} from '../../services/programs/index.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import {
	fact,
	factSchema,
	metric,
	metricSchema,
	sourceRefSchema,
	toolError,
	untrusted,
	untrustedSchema
} from './output.ts';

/** Decision (m7-plan, tools-periodisation-reads): the most what-if moves one evaluation applies. */
export const WHAT_IF_MAX = 4;
/** Decision: the most decisions one finding cites, the owner's moves first. */
export const FINDING_DECISIONS_MAX = 3;

/** How the week's score is computed, as its metric states it. */
export const SCORE_METHOD = `100 less ${SCORE_WEIGHTS.avoid} per avoid and ${SCORE_WEIGHTS.prefer} per prefer finding, by the harmed goal's weight; a kept one at ${SCORE_WEIGHTS.resolved}×`;
/** How a system's weekly load is computed, as its metric states it. */
export const LOAD_METHOD =
	'Sum of minutes × RPE by body system over the week, logged sessions replacing planned ones';
/** How a goal's weight is set, as its metric states it. */
export const PRIORITY_METHOD = `Rank weight by your goal order (${RANK_WEIGHTS.join(', ')}); an event in its lead window leads`;

type Ctx = ToolContext<ResolvedCoachDeps>;
const deps = (ctx: Ctx) => ({ db: ctx.deps.db });

const isoDate = z.iso.date();
const uuid = z.uuid();
const weekInput = z.optional(z.union([z.enum(['current', 'next']), isoDate]));

const versionRef = (number: number): SourceRef => ({
	type: 'version',
	id: String(number),
	label: `Version ${number}`
});
const weekRef = (monday: IsoDate): SourceRef => ({
	type: 'date',
	id: monday,
	label: `Week of ${monday}`
});
const sessionRef = (s: { lineage: string; date: string }): SourceRef => ({
	type: 'session',
	id: s.lineage,
	date: s.date
});
const decisionRef = (d: ScheduleDecision): SourceRef => ({ type: 'decision', id: d.id });

/** The week the coach named, read once: the active version's sessions, context and decisions. */
interface WeekRead {
	programId: string;
	version: number;
	monday: IsoDate;
	endsOn: IsoDate;
	kind: (typeof WEEK_KINDS)[number];
	/** The week's sessions and the Sunday before it (a clash can cross the weekend). */
	sessions: StoredSession[];
	context: EvaluationContext | null;
	/** The stored decisions behind the sessions, the owner's first (getScheduleTradeoffs). */
	decisions: ScheduleDecision[];
	/** The priority trade-offs the week keeps, as the judge's hints (evaluate.ts). */
	hints: ReturnType<typeof tradeoffHints>;
	/** The dates a session could still go on: the week's from today. */
	openDates: IsoDate[];
	completed: Set<string>;
}

/** The week `week` names (today's by default), or the week holding `session`. */
async function readWeek(ctx: Ctx, { week, session }: { week?: string; session?: string }) {
	const today = ctx.today as IsoDate;
	const current = await getCurrentProgram(ctx.ownerId, today, deps(ctx));
	if (!current) throw toolError('NOT_FOUND', 'You have no active program');
	const number = current.version.number;
	const version = await getProgramVersion(ctx.ownerId, current.id, number, deps(ctx));
	const weeks = version.blocks.flatMap((b) => b.weeks);
	const all = weeks.flatMap((w) => w.sessions);
	let monday = mondayOf(today);
	if (session !== undefined) {
		const found = all.find((s) => s.lineage === session);
		if (!found)
			throw toolError('NOT_FOUND', 'Your program has no session with that id', { session });
		monday = mondayOf(found.date);
	} else if (week === 'next') monday = addDays(monday, 7);
	else if (week !== undefined && week !== 'current') monday = mondayOf(week as IsoDate);
	const plan = weeks.find((w) => w.startsOn === monday);
	if (!plan) throw toolError('NOT_FOUND', 'That week is not planned yet', { week: monday });
	const sunday = addDays(monday, -1);
	const sessions = all.filter((s) => s.date >= sunday && s.date <= plan.endsOn);

	// One query at a time: the context's own transaction, then the decisions.
	const at = { versionId: version.version.id, weekStartsOn: monday, today };
	const context = await evaluationContext(ctx.ownerId, at, deps(ctx));
	const explained = await getScheduleTradeoffs(
		ctx.ownerId,
		{
			programId: current.id,
			sessions: sessions.map((s) => ({ lineage: s.lineage, date: s.date }))
		},
		deps(ctx)
	);
	const completed = new Set(
		(context?.load.logged ?? []).flatMap((l) => (l.plannedLineage ? [l.plannedLineage] : []))
	);
	return {
		programId: current.id,
		version: number,
		monday,
		endsOn: plan.endsOn,
		kind: plan.kind,
		sessions,
		context,
		decisions: explained.decisions,
		hints: tradeoffHints(explained.tradeoffs),
		openDates: Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => d >= today),
		completed
	} satisfies WeekRead;
}

/**
 * The read's context with the load re-modelled over `sessions` (the week with its what-if moves),
 * as repairWeek models each candidate week, so a moved session's load lands on its new day.
 */
function movedContext(
	read: WeekRead,
	sessions: readonly StoredSession[],
	today: IsoDate
): EvaluationContext | null {
	const { context } = read;
	if (!context) return null;
	const days = loadModel({
		planned: [
			...context.load.planned.filter((s) => s.date < read.monday),
			...sessions.filter((s) => s.date >= read.monday)
		],
		logged: context.load.logged,
		from: context.load.from,
		to: read.endsOn,
		today,
		traitsOf: context.traitsOf
	});
	return { ...context, load: { ...context.load, days } };
}

/** The fields a what-if move reads and writes: where a session is, and how it is planned. */
export type PlacedSession = Pick<
	StoredSession,
	'lineage' | 'date' | 'timeOfDay' | 'orderInDay' | 'status' | 'movedFrom'
>;

/** A time of day's place in the day, as planMove ranks it; none for no time or 'varies'. */
const timeRank = (time: TimeOfDay | null) =>
	time === null || time === 'varies' ? null : TIMES_OF_DAY.indexOf(time);

/**
 * A what-if move applied to `sessions` the way a real move is (planMove, services/programs/
 * edits.ts), mirrored here because planMove also prices the move against the database's target
 * and returns copy changes, not the week. On its new day the session goes before the first
 * session there with a later time of day, or last when it has no time of day (or none is later),
 * and that day is numbered again from 1. Back on the day it was planned for, it is planned again;
 * otherwise it is moved, with the day of its first move as movedFrom.
 */
export function applyWhatIf<S extends PlacedSession>(
	sessions: readonly S[],
	session: S,
	toDate: IsoDate,
	timeOfDay: TimeOfDay | null
): S[] {
	const rank = timeRank(timeOfDay);
	const day = sessions.filter((s) => s.date === toDate && s.lineage !== session.lineage);
	const later = day.findIndex((s) => rank !== null && (timeRank(s.timeOfDay) ?? -1) > rank);
	const place = later === -1 ? day.length : later;
	const order = new Map<string, number>();
	[...day.slice(0, place), session, ...day.slice(place)].forEach((s, n) => {
		order.set(s.lineage, n + 1);
	});
	const firstDay = session.movedFrom ?? session.date;
	const back = toDate === firstDay;
	return sessions.map((s): S => {
		const orderInDay = order.get(s.lineage) ?? s.orderInDay;
		if (s.lineage !== session.lineage) return { ...s, orderInDay };
		return {
			...s,
			date: toDate,
			timeOfDay,
			orderInDay,
			status: back ? 'planned' : 'moved',
			movedFrom: back ? null : firstDay
		};
	});
}

/** evaluateWeek over `sessions` with everything `context` knows. */
function judge(
	read: WeekRead,
	sessions: readonly StoredSession[],
	today: IsoDate,
	context = read.context
): WeekEvaluation {
	return evaluateWeek(sessions, {
		...(context && { traitsOf: context.traitsOf, context: weekContextOf(context) }),
		openDates: read.openDates,
		hints: read.hints,
		today
	});
}

/** Whether the owner can still act on a session: this week, from today, not done or skipped. */
const aheadIn = (read: WeekRead, today: IsoDate) => (s: StoredSession) =>
	s.date >= today &&
	s.date >= read.monday &&
	s.status !== 'skipped' &&
	!read.completed.has(s.lineage);

// ---- evaluate_week_interference -----------------------------------------------------------

const findingSchema = z.object({
	rule: z.string(),
	severity: z.enum(['avoid', 'prefer']),
	headline: z.string(),
	message: untrustedSchema,
	why: z.string(),
	resolution: z.nullable(z.object({ kind: z.string(), text: untrustedSchema })),
	actionable: z.boolean(),
	days: z.array(isoDate),
	sessions: z.array(z.object({ title: untrustedSchema, date: isoDate })),
	/** The sessions it names, the stored decisions that explain them, then the week it is judged in. */
	sources: z.array(sourceRefSchema)
});
type FindingOut = z.input<typeof findingSchema>;

function findingOut(f: Finding, read: WeekRead): FindingOut {
	const named = f.sessions.flatMap((s) => (s.lineage ? [s.lineage] : []));
	const decisions = read.decisions
		.filter((d) => d.sessions.some((lineage) => named.includes(lineage)))
		.slice(0, FINDING_DECISIONS_MAX);
	return {
		rule: f.rule,
		severity: f.severity,
		headline: f.headline,
		message: untrusted(f.message),
		why: f.why,
		resolution: f.resolution
			? { kind: f.resolution.kind, text: untrusted(f.resolution.text) }
			: null,
		actionable: f.actionable,
		days: f.days,
		sessions: f.sessions.map((s) => ({ title: untrusted(s.title), date: s.date })),
		sources: [
			...f.sessions.flatMap((s) =>
				s.lineage ? [sessionRef({ lineage: s.lineage, date: s.date })] : []
			),
			...decisions.map(decisionRef),
			weekRef(read.monday)
		]
	};
}

const weekSchema = z.object({
	startsOn: isoDate,
	endsOn: isoDate,
	kind: z.enum(WEEK_KINDS),
	source: sourceRefSchema
});
const weekOut = (read: WeekRead) => ({
	startsOn: read.monday,
	endsOn: read.endsOn,
	kind: read.kind,
	source: weekRef(read.monday)
});
/** full: judged with the context's load, priorities and events; basic: by checkWeek alone. */
const checkedSchema = z.enum(['full', 'basic']);

const evaluateOutput = z.object({
	week: weekSchema,
	checked: checkedSchema,
	score: metricSchema,
	grade: z.enum(['clear', 'minor', 'conflicts']),
	/** The what-if moves judged, as given; none were written. */
	whatIf: z.array(z.object({ session: uuid, from: isoDate, toDate: isoDate })),
	findings: z.array(findingSchema),
	loads: z.array(
		z.object({
			system: z.enum(SYSTEMS as [string, ...string[]]),
			label: z.string(),
			worst: z.string(),
			load: metricSchema
		})
	),
	/** A recommendation: the scheduler's moves for the stored week, as propose ops. */
	suggestedRepair: z.nullable(
		z.object({
			ops: z.array(moveOpSchema),
			clears: z.array(z.object({ rule: z.string(), headline: z.string() })),
			tradeoffs: z.array(
				z.object({ rule: z.string(), headline: z.string(), tradeoff: untrustedSchema })
			),
			sources: z.array(sourceRefSchema)
		})
	),
	truncated: z.optional(z.literal(true))
});

/** A finding's identity across a repair: its rule and the sessions it names. */
const findingKey = (f: Finding) =>
	`${f.rule} ${f.sessions
		.map((s) => s.lineage ?? s.title)
		.sort()
		.join(' ')}`;

/**
 * The scheduler's repair of the stored week, moving only sessions still ahead. Null without the
 * context (the logged sessions it knows are done come from it), and null rather than part of a
 * repair: its clears and tradeoffs describe all of its ops.
 */
function suggestedRepair(read: WeekRead, today: IsoDate) {
	const { context } = read;
	if (!context) return null;
	// The Sunday before is only there for the clashes across the weekend: it stays where it is.
	const sundayBefore = read.sessions.filter((s) => s.date < read.monday).map((s) => s.lineage);
	const repaired = repairWeek(read.sessions, {
		open: read.openDates,
		preferredTimes: context.preferredTimes,
		today,
		keepOwnerMoves: false,
		completed: [...read.completed, ...sundayBefore],
		traitsOf: context.traitsOf,
		priorities: context.priorities,
		load: {
			from: context.load.from,
			// Planned before the Sunday before the week: that Sunday's sessions are in read.sessions,
			// and repairWeek adds those to the load itself (as clearingMoves does).
			planned: context.load.planned.filter((s) => s.date < addDays(read.monday, -1)),
			logged: context.load.logged
		},
		...(context.weekKind && { week: { kind: context.weekKind } }),
		events: context.events,
		...(context.level && { level: context.level })
	});
	const ahead = new Map(read.sessions.filter(aheadIn(read, today)).map((s) => [s.lineage, s]));
	const ops = repaired.ops.map(({ sessionLineage, toDate, timeOfDay }) => ({
		op: 'move' as const,
		sessionLineage,
		toDate,
		...(timeOfDay !== undefined && { timeOfDay })
	}));
	const whole =
		ops.length <= MAX_PROPOSAL_OPS &&
		ops.every((op) => ahead.has(op.sessionLineage) && op.toDate >= today);
	if (!ops.length || !whole) return null;
	const after = new Set(repaired.after.evaluation.findings.map(findingKey));
	return {
		ops,
		clears: repaired.before.evaluation.findings
			.filter((f) => !after.has(findingKey(f)))
			.map((f) => ({ rule: f.rule, headline: f.headline })),
		tradeoffs: repaired.kept.map((k) => ({
			rule: k.finding.rule,
			headline: k.finding.headline,
			tradeoff: untrusted(k.tradeoff)
		})),
		sources: ops.map((op) =>
			sessionRef({ lineage: op.sessionLineage, date: ahead.get(op.sessionLineage)!.date })
		)
	};
}

const evaluateWeekInterferenceTool = defineTool({
	name: 'evaluate_week_interference',
	description: `Judge a week of the owner's active program with the app's scheduling engine: its 0–100 score and grade, every rule it breaks (findings, each with its rule, why the rule exists and why the week keeps it, citing the sessions it names and the stored decisions that explain them), and its load by body system. week is current (default), next or any date in the week. moves (up to ${WHAT_IF_MAX}) are what-ifs: sessions still ahead moved to another day of the same week from today on, judged in memory and never saved. suggestedRepair is the engine's own fix for the week as stored: pass its ops unchanged to propose_program_adjustment's ops to propose it; null when nothing ahead needs moving, when a repair would need an ease or a drop or more than ${MAX_PROPOSAL_OPS} moves, or when checked is basic. checked is basic when the engine could not read the owner's load and goals, so only the basic rules ran.`,
	input: z.object({
		week: weekInput,
		moves: z.optional(
			z
				.array(
					z.object({
						session: uuid,
						toDate: isoDate,
						timeOfDay: z.optional(z.enum(TIMES_OF_DAY))
					})
				)
				.check(z.minLength(1), z.maxLength(WHAT_IF_MAX))
		)
	}),
	output: evaluateOutput,
	run: async ({ week, moves = [] }, ctx: Ctx) => {
		const today = ctx.today as IsoDate;
		const read = await readWeek(ctx, { week });
		const ahead = aheadIn(read, today);
		let sessions = read.sessions;
		const whatIf: { session: string; from: IsoDate; toDate: IsoDate }[] = [];
		for (const move of moves) {
			const target = sessions.find((s) => s.lineage === move.session);
			if (!target || !ahead(target))
				throw toolError('NOT_FOUND', 'That is not a session of this week still ahead', {
					session: move.session
				});
			const toDate = move.toDate as IsoDate;
			if (!read.openDates.includes(toDate))
				throw toolError('INVALID_INPUT', 'Move a session to a day of its own week, from today on', {
					toDate
				});
			whatIf.push({ session: move.session, from: target.date, toDate });
			const timeOfDay = move.timeOfDay === undefined ? target.timeOfDay : move.timeOfDay;
			sessions = applyWhatIf(sessions, target, toDate, timeOfDay);
		}
		const context = moves.length ? movedContext(read, sessions, today) : read.context;
		const evaluation = judge(read, sessions, today, context);
		const days = context?.load.days.filter((d) => d.date >= read.monday && d.date <= read.endsOn);
		const summary = days?.length ? weekSummary(days) : null;
		const loadSources = [weekRef(read.monday), versionRef(read.version)];
		return {
			week: weekOut(read),
			checked: read.context ? ('full' as const) : ('basic' as const),
			score: metric({
				value: evaluation.score,
				unit: null,
				method: SCORE_METHOD,
				sources: [weekRef(read.monday), versionRef(read.version)]
			}),
			grade: evaluation.grade,
			whatIf,
			findings: evaluation.findings.map((f) => findingOut(f, read)),
			loads: summary
				? SYSTEMS.map((system) => {
						const s = summary.systems[system];
						return {
							system,
							label: SYSTEM_LABEL[system],
							worst: s.worst,
							load: metric({
								value: Math.round(s.logged + s.planned + s.estimated),
								unit: 'AU',
								method: LOAD_METHOD,
								sources: loadSources
							})
						};
					})
				: [],
			suggestedRepair: suggestedRepair(read, today)
		};
	}
});

// ---- explain_schedule_tradeoffs -----------------------------------------------------------

const decisionSchema = z.object({
	source: sourceRefSchema,
	kind: z.enum(DECISION_KINDS),
	ruleKey: z.nullable(z.string()),
	summary: untrustedSchema,
	why: untrustedSchema,
	decidedBy: z.enum(DECIDERS),
	version: z.int()
});

const explainOutput = z.object({
	week: weekSchema,
	checked: checkedSchema,
	/** The session asked about, when one was. */
	session: z.nullable(sourceRefSchema),
	priorities: z.array(
		z.object({
			goal: sourceRefSchema,
			title: untrustedSchema,
			mode: z.enum(['primary', 'secondary', 'maintenance']),
			reason: untrustedSchema,
			weight: metricSchema
		})
	),
	decisions: z.array(factSchema(decisionSchema)),
	/** The maintenance doses among the decisions, by id. */
	doses: z.array(sourceRefSchema),
	/** The clashes the week keeps, each with why. */
	keptConflicts: z.array(
		z.object({
			rule: z.string(),
			headline: z.string(),
			why: untrustedSchema,
			sources: z.array(sourceRefSchema)
		})
	),
	road: z.nullable(factSchema(untrustedSchema)),
	truncated: z.optional(z.literal(true))
});

const explainScheduleTradeoffsTool = defineTool({
	name: 'explain_schedule_tradeoffs',
	description:
		"Why a week of the owner's active program is shaped as it is, from the engine and the stored record: each goal's priority that week (primary, secondary or maintenance, with the reason and its rank weight), the stored decisions that put its sessions on their days (kind, summary, why, who decided and the version, each citable by id), the maintenance doses among them, the clashes the week keeps and why, and the road of blocks, events, deloads and tapers around it. Give week (current by default, next, or any date in the week) or session (a session's lineage) to explain only that session. Quote a decision's why rather than rewording it.",
	input: z.object({ week: weekInput, session: z.optional(uuid) }),
	output: explainOutput,
	run: async ({ week, session }, ctx: Ctx) => {
		const today = ctx.today as IsoDate;
		const read = await readWeek(ctx, { week, session });
		const about = (lineages: readonly string[]) =>
			session === undefined || lineages.includes(session);
		const decisions = read.decisions
			.filter((d) => about(d.sessions))
			.slice(0, MAX_TRADEOFF_DECISIONS);
		const kept = judge(read, read.sessions, today).findings.filter(
			(f) => f.resolution && about(f.sessions.flatMap((s) => (s.lineage ? [s.lineage] : [])))
		);
		const road = await getRoadView(ctx.ownerId, today, deps(ctx));
		const target =
			session === undefined ? undefined : read.sessions.find((s) => s.lineage === session);
		return {
			week: weekOut(read),
			checked: read.context ? ('full' as const) : ('basic' as const),
			session: target ? sessionRef(target) : null,
			priorities: (read.context?.priorities ?? []).map((p) => {
				const goal: SourceRef = { type: 'goal', id: p.goalId };
				return {
					goal,
					title: untrusted(p.title),
					mode: p.mode,
					reason: untrusted(p.why),
					weight: metric({ value: p.weight, unit: null, method: PRIORITY_METHOD, sources: [goal] })
				};
			}),
			decisions: decisions.map((d) =>
				fact(
					{
						source: decisionRef(d),
						kind: d.kind,
						ruleKey: d.ruleKey,
						summary: untrusted(d.summary),
						why: untrusted(d.why),
						decidedBy: d.decidedBy,
						version: d.version
					},
					decisionRef(d),
					versionRef(d.version)
				)
			),
			doses: decisions.filter((d) => d.kind === 'maintenance_dose').map(decisionRef),
			keptConflicts: kept.map((f) => {
				const out = findingOut(f, read);
				return {
					rule: f.rule,
					headline: f.headline,
					why: out.resolution!.text,
					sources: out.sources
				};
			}),
			road: road ? fact(untrusted(serialiseRoad(road)), versionRef(read.version)) : null
		};
	}
});

// ---- plan_block, schedule_deload, plan_taper ------------------------------------------------

/** Decision (tools-periodisation-proposals): plan_block's weeks when the coach names none. */
export const PLAN_BLOCK_WEEKS = 4;

/** The sentence an answer gives when the re-plan would change nothing: nothing was stored. */
const UNCHANGED_WHY = 'That would change nothing in your plan, so nothing was proposed.';

const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const weeksInput = z
	.int()
	.check(z.minimum(REPLAN_BLOCK_WEEKS.min), z.maximum(REPLAN_BLOCK_WEEKS.max));

/** The conversation, run and tool call a coach's re-plan names: every one carries them. */
function coachOf(ctx: Ctx): ReplanCoach {
	if (!ctx.toolUseId) throw new Error('A coach re-plan is proposed inside a tool call');
	return { threadId: ctx.threadId, runId: ctx.runId, toolUseId: ctx.toolUseId };
}
const proposing = (ctx: Ctx) => ({ db: ctx.deps.db, now: ctx.deps.now });

const rowSchema = z.object({
	area: z.string(),
	label: untrustedSchema,
	before: z.nullable(untrustedSchema),
	after: z.nullable(untrustedSchema),
	date: z.nullable(isoDate),
	link: z.nullable(sourceRefSchema)
});
const replanOutput = z.object({
	/** The card the turn shows and the call links to (turn.ts reads output.proposal), as the others. */
	proposal: z.object({
		id: uuid,
		kind: z.string(),
		title: z.string(),
		status: z.string(),
		duplicate: z.boolean()
	}),
	proposalId: uuid,
	title: untrustedSchema,
	summaryLines: z.array(untrustedSchema),
	/** The changed rows, at most MAX_PROPOSAL_OPS: the first of them, when more change. */
	rows: z.array(rowSchema).check(z.maxLength(MAX_PROPOSAL_OPS)),
	/** The first day the new version may differ on: a Monday. */
	from: isoDate,
	truncated: z.optional(z.literal(true))
});

const rowOut = (row: DiffRow) => ({
	area: row.area,
	label: untrusted(row.label),
	before: row.before === null ? null : untrusted(row.before),
	after: row.after === null ? null : untrusted(row.after),
	date: row.date,
	link: row.link
});

/**
 * The stored replan as the tool answers it, or the engine's refusal as an error the coach can
 * explain. Nothing was stored for either.
 */
function replanOut(shown: ProposedReplan) {
	if (shown.status === 'refused') throw toolError('REFUSED', shown.why, { reason: shown.why });
	if (shown.status === 'unchanged')
		throw toolError('UNCHANGED', UNCHANGED_WHY, { reason: UNCHANGED_WHY });
	const { proposal, from, duplicate } = shown;
	return {
		proposal: {
			id: proposal.id,
			kind: proposal.kind,
			title: proposal.title,
			status: proposal.status,
			duplicate
		},
		proposalId: proposal.id,
		title: untrusted(proposal.title),
		summaryLines: proposal.summaryLines.map((line) => untrusted(line)),
		rows: proposal.rows.slice(0, MAX_PROPOSAL_OPS).map(rowOut),
		from
	};
}

const planBlockTool = defineTool({
	name: 'plan_block',
	description: `Propose re-planning the owner's next block as one phase: ${REPLAN_PHASES.join(', ')}, for ${REPLAN_BLOCK_WEEKS.min} to ${REPLAN_BLOCK_WEEKS.max} weeks (weeks, default ${PLAN_BLOCK_WEEKS}). For a deload week or a taper use schedule_deload or plan_taper. focusGoal (a goal's id, from explain_schedule_tradeoffs) puts that goal first in it. It is planned again from the next clean Monday and stored as a proposal the owner accepts or rejects: nothing changes until they do. A refusal (REFUSED) carries the engine's reason; say it to the owner. The result lists the changed rows, at most ${MAX_PROPOSAL_OPS}, never the whole plan. Only one re-plan is open at a time: this replaces any open re-plan proposal, the weekly review's included.`,
	input: z.object({
		phase: z.enum(REPLAN_PHASES),
		weeks: z.optional(weeksInput),
		focusGoal: z.optional(uuid)
	}),
	output: replanOutput,
	run: async ({ phase, weeks = PLAN_BLOCK_WEEKS, focusGoal }, ctx: Ctx) =>
		replanOut(
			await proposeReplan(
				ctx.ownerId,
				{
					today: ctx.today as IsoDate,
					source: 'coach',
					coach: coachOf(ctx),
					directive: {
						kind: 'block',
						phase,
						weeks,
						...(focusGoal !== undefined && { focusGoalRef: focusGoal })
					}
				},
				proposing(ctx)
			)
		)
});

const scheduleDeloadTool = defineTool({
	name: 'schedule_deload',
	description: `Propose a deload the owner asked for: one lighter week, in place, with the same sessions on the same days. when is this_week or next_week (default next_week). this_week deloads only the sessions still ahead of today; a session done, begun or skipped stays as it is. reason (up to ${REPLAN_REASONS.length} characters, from the owner's words) is kept with the proposal; left out, none is invented. It is stored as a proposal the owner accepts or rejects. A refusal (REFUSED) carries the engine's reason. Only one re-plan is open at a time: this replaces any open re-plan proposal, the weekly review's included.`,
	input: z.object({
		when: z.optional(z.enum(['this_week', 'next_week'])),
		reason: z.optional(text(REPLAN_REASONS.length))
	}),
	output: replanOutput,
	run: async ({ when = 'next_week', reason }, ctx: Ctx) => {
		const today = ctx.today as IsoDate;
		const week = when === 'this_week' ? mondayOf(today) : addDays(mondayOf(today), 7);
		return replanOut(
			await proposeDeload(
				ctx.ownerId,
				{
					today,
					week,
					reasons: reason === undefined ? [] : [reason],
					source: 'coach',
					coach: coachOf(ctx)
				},
				proposing(ctx)
			)
		);
	}
});

/** The sentence a maintenance goal's taper is refused with, after the engine's standard one. */
const MAINTENANCE_TAPER_WHY =
	'A goal held at maintenance is trained through, so it has no taper to plan.';

/**
 * The form a taper takes when the coach leaves its kind out: BY_PRIORITY's rule for the goal's
 * priority this week, read as explain_schedule_tradeoffs reads it. The leader's event gets its full
 * taper and a secondary event its mini. The engine's splice takes a form and has no 'none', so a
 * goal held at maintenance (BY_PRIORITY's train_through) is refused here, storing nothing. A goal
 * that is not an event still ahead is refused by the engine with its sentence before it reads the
 * form, so 'full' is passed for it and never used.
 */
async function taperFormOf(ctx: Ctx, goal: string): Promise<(typeof TAPER_FORMS)[number]> {
	const today = ctx.today as IsoDate;
	const input = await programmingInputFor(ctx.ownerId, deps(ctx));
	const priority = effectivePriorities(input, mondayOf(today)).find((p) => p.goalId === goal);
	if (!priority?.eventDate || priority.eventDate < today) return 'full';
	const rule = BY_PRIORITY[priority.mode];
	if (rule === 'train_through') {
		const why = `${REFUSALS.not_applicable} ${MAINTENANCE_TAPER_WHY}`;
		throw toolError('REFUSED', why, { reason: why });
	}
	return rule === 'full' ? 'full' : 'mini';
}

const planTaperTool = defineTool({
	name: 'plan_taper',
	description: `Propose a taper for one of the owner's event goals (goal, its id from explain_schedule_tradeoffs): only an event still ahead can be tapered for. kind is full (the event's full taper) or mini (a few days before it); full only for the leading goal, mini for a secondary event; leave kind out to follow your goals' priorities. Asking for full upgrades a mini or a trained-through taper, if the engine allows it. It is spliced into the weeks before the event, and stored as a proposal the owner accepts or rejects. A refusal (REFUSED) carries the engine's reason, such as an event that is too close or a goal that has no event; say it to the owner. Only one re-plan is open at a time: this replaces any open re-plan proposal, the weekly review's included.`,
	input: z.object({
		goal: uuid,
		kind: z.optional(z.enum(TAPER_FORMS))
	}),
	output: replanOutput,
	run: async ({ goal, kind }, ctx: Ctx) => {
		const form = kind ?? (await taperFormOf(ctx, goal));
		return replanOut(
			await proposeReplan(
				ctx.ownerId,
				{
					today: ctx.today as IsoDate,
					source: 'coach',
					coach: coachOf(ctx),
					directive: { kind: 'taper', goalRef: goal, form }
				},
				proposing(ctx)
			)
		);
	}
});

export const PERIODISATION_TOOLS: readonly CoachTool[] = [
	evaluateWeekInterferenceTool,
	explainScheduleTradeoffsTool,
	planBlockTool,
	scheduleDeloadTool,
	planTaperTool
];
