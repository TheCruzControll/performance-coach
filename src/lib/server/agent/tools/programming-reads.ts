/**
 * The coach's programming read tools (PRD §4, the M5 plan's tools-programming-reads): the plan as
 * Train shows it, how it changed and why, and what became of the coach's own proposals. Each
 * calls the same M3 and M5 reads the screens use, owner-scoped by the session's owner, so someone
 * else's ids read as nothing.
 *
 * - get_current_program: the active program and where today falls in it.
 * - get_current_training_week: a week by its number (today's by default), as Train shows it; a
 *   week past the planned weeks is planned: false with its outline phase.
 * - get_training_schedule: the weeks from today's on, SCHEDULE_WEEKS at a time.
 * - get_program_history: the versions newest first, each with its decisions and their why,
 *   exactly as M3's templates or the editor wrote them (never shortened or reworded), as many
 *   decisions as fit the output cap, with `next` naming the version and decision to go on from
 *   (a generated version alone has more decisions than one result holds).
 * - get_coach_proposals: the coach's proposals, by status or by id, with the owner's reason for
 *   a rejection. Any id that is not one of the owner's proposals is NOT_FOUND.
 *
 * Stored text (titles, summaries, reasons) travels as untrusted_text; dates as ISO strings.
 */
import * as z from 'zod/mini';
import { addDays } from '../../../domain/calendar.ts';
import { TURN_LIMITS } from '../../../domain/coach/budgets.ts';
import { canonicalJson } from '../../../domain/programming/random.ts';
import { SUPERSEDED_REASONS } from '../../../domain/coach/vocabulary.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import type { DecisionView, SessionView, VersionInfo } from '../../../domain/training/types.ts';
import {
	DECIDERS,
	PHASES,
	PROPOSAL_STATUSES,
	SESSION_INTENSITIES,
	SESSION_STATUSES,
	SESSION_TYPES,
	WEEK_KINDS
} from '../../../domain/training/vocabulary.ts';
import { listProposals, PROPOSAL_IDS_MAX } from '../../services/coach/proposals.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import {
	getCurrentProgram,
	getTrainingWeek,
	getVersionHistory,
	type TrainingWeek
} from '../../services/programs/index.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import {
	fact,
	factSchema,
	sourceRefSchema,
	toolError,
	untrusted,
	untrustedSchema
} from './output.ts';

/**
 * Decision: how many weeks get_training_schedule reads when the model does not say, and the most
 * it may ask for (each week is one program read; four keep the result under the output cap).
 */
export const SCHEDULE_WEEKS = Object.freeze({ default: 2, max: 4 });
/** Decision: how many proposals get_coach_proposals lists when the model does not say. */
export const COACH_PROPOSALS_LIMIT = Object.freeze({ default: 5, max: PROPOSAL_IDS_MAX });
/** The furthest program week a tool may name (read.ts's own bound). */
const WEEK_MAX = 1000;
/** A decision's why is at most this long (decisionPlanSchema): it is never shortened. */
const WHY_MAX = 1000;

type Ctx = ToolContext<ResolvedCoachDeps>;
const training = (ctx: Ctx) => ({ db: ctx.deps.db });
const iso = (at: Date) => at.toISOString();
const versionRef = (number: number): SourceRef => ({
	type: 'version',
	id: String(number),
	label: `Version ${number}`
});
const sessionRef = (s: { lineage: string; date: string }): SourceRef => ({
	type: 'session',
	id: s.lineage,
	date: s.date
});

const whole = (min: number, max: number) => z.int().check(z.minimum(min), z.maximum(max));
const isoDate = z.iso.date();
const versionSchema = z.object({
	number: z.int(),
	createdAt: z.iso.datetime(),
	createdBy: z.enum(DECIDERS),
	summary: untrustedSchema,
	current: z.boolean()
});
const versionOut = (v: VersionInfo): z.input<typeof versionSchema> => ({
	number: v.number,
	createdAt: iso(v.createdAt),
	createdBy: v.createdBy,
	summary: untrusted(v.summary),
	current: v.current
});

// ---- get_current_program ----------------------------------------------------------------

const programSchema = z.object({
	title: untrustedSchema,
	version: versionSchema,
	startsOn: isoDate,
	firstPlannedDay: isoDate,
	lastPlannedDay: isoDate,
	plannedWeeks: z.int(),
	currentWeek: z.nullable(z.int()),
	baseline: z.boolean(),
	notStarted: z.boolean(),
	blockComplete: z.boolean(),
	blocks: z.array(
		z.object({
			name: untrustedSchema,
			phase: z.enum(PHASES),
			startsOn: isoDate,
			endsOn: isoDate,
			outline: z.boolean(),
			plannedWeeks: z.int(),
			goals: z.array(sourceRefSchema)
		})
	)
});
const currentProgramOutput = z.object({ program: z.nullable(factSchema(programSchema)) });

const getCurrentProgramTool = defineTool({
	name: 'get_current_program',
	description:
		"The owner's active program as Train shows it: its title, current version, planned weeks, blocks with their phases and goals, and where today falls (currentWeek, notStarted, blockComplete). program is null when no program is active.",
	input: z.object({}),
	output: currentProgramOutput,
	run: async (_input, ctx: Ctx) => {
		const p = await getCurrentProgram(ctx.ownerId, ctx.today, training(ctx));
		if (!p) return { program: null };
		const program = {
			title: untrusted(p.title),
			version: versionOut(p.version),
			startsOn: p.startsOn,
			firstPlannedDay: p.firstPlannedDay,
			lastPlannedDay: p.lastPlannedDay,
			plannedWeeks: p.plannedWeeks,
			currentWeek: p.currentWeek,
			baseline: p.baseline,
			notStarted: p.notStarted,
			blockComplete: p.blockComplete,
			blocks: p.blocks.map((b) => ({
				name: untrusted(b.name),
				phase: b.phase,
				startsOn: b.startsOn,
				endsOn: b.endsOn,
				outline: b.outline,
				plannedWeeks: b.plannedWeeks,
				goals: b.goalRefs.map((id): SourceRef => ({ type: 'goal', id }))
			}))
		};
		return { program: fact(program, versionRef(p.version.number)) };
	}
});

// ---- weeks: get_current_training_week and get_training_schedule ---------------------------

const sessionSchema = z.object({
	source: sourceRefSchema,
	date: isoDate,
	timeOfDay: z.nullable(z.string()),
	title: untrustedSchema,
	line: untrustedSchema,
	kind: z.enum(['strength', 'run', 'other']),
	type: z.enum(SESSION_TYPES),
	status: z.enum(SESSION_STATUSES),
	intensity: z.enum(SESSION_INTENSITIES),
	estMinutes: z.number(),
	targetRpe: z.number(),
	movedFrom: z.nullable(isoDate)
});
const weekSchema = z.union([
	z.object({
		planned: z.literal(true),
		number: z.int(),
		kind: z.enum(WEEK_KINDS),
		phase: z.enum(PHASES),
		blockName: untrustedSchema,
		startsOn: isoDate,
		endsOn: isoDate,
		/** The first planned day, when the week asked for comes before it. */
		programStartsOn: z.nullable(isoDate),
		targets: z.object({
			rpeCap: z.number(),
			volumeFactor: z.number(),
			loadStep: z.number(),
			runVolumeFactor: z.number()
		}),
		sessions: z.array(sessionSchema)
	}),
	z.object({
		planned: z.literal(false),
		phase: z.nullable(z.enum(PHASES)),
		startsOn: isoDate,
		endsOn: isoDate
	})
]);
const weekFact = factSchema(weekSchema);

const sessionOut = (s: SessionView): z.input<typeof sessionSchema> => ({
	source: sessionRef(s),
	date: s.date,
	timeOfDay: s.timeOfDay,
	title: untrusted(s.title),
	line: untrusted(s.line),
	kind: s.kind,
	type: s.type,
	status: s.status,
	intensity: s.intensity,
	estMinutes: s.estMinutes,
	targetRpe: s.targetRpe,
	movedFrom: s.movedFrom
});

function weekOut(w: TrainingWeek): z.input<typeof weekFact> {
	const source = versionRef(w.version.number);
	if (!w.planned)
		return fact({ planned: false, phase: w.phase, startsOn: w.startsOn, endsOn: w.endsOn }, source);
	const { rpeCap, volumeFactor, loadStep, runVolumeFactor } = w.targets;
	return fact(
		{
			planned: true,
			number: w.number,
			kind: w.kind,
			phase: w.phase,
			blockName: untrusted(w.blockName),
			startsOn: w.startsOn,
			endsOn: w.endsOn,
			programStartsOn: w.programStartsOn ?? null,
			targets: { rpeCap, volumeFactor, loadStep, runVolumeFactor },
			sessions: w.days.flatMap((day) => day.sessions.map(sessionOut))
		},
		source
	);
}

const getCurrentTrainingWeekTool = defineTool({
	name: 'get_current_training_week',
	description:
		"One Monday-to-Sunday week of the owner's active program at its current version, as Train shows it: each session with its date, title, one-line summary, status (planned, completed, skipped or moved) and source. Leave week out for the week today falls in, or give the program week number. A week past the planned weeks is planned: false with the phase outlined there. week is null when no program is active.",
	input: z.object({
		week: z.optional(whole(1, WEEK_MAX))
	}),
	output: z.object({ week: z.nullable(weekFact) }),
	run: async ({ week }, ctx: Ctx) => {
		const at = week === undefined ? { date: ctx.today } : { block: 1, week };
		const found = await getTrainingWeek(ctx.ownerId, at, {}, training(ctx));
		return { week: found && weekOut(found) };
	}
});

const getTrainingScheduleTool = defineTool({
	name: 'get_training_schedule',
	description: `The owner's planned weeks from the week today falls in onwards, as Train shows them, ${SCHEDULE_WEEKS.default} weeks unless weeks says otherwise. Weeks past the planned ones are planned: false. weeks is empty when no program is active.`,
	input: z.object({
		weeks: z.optional(whole(1, SCHEDULE_WEEKS.max))
	}),
	output: z.object({ weeks: z.array(weekFact), truncated: z.optional(z.literal(true)) }),
	run: async (input, ctx: Ctx) => {
		const weeks: z.input<typeof weekFact>[] = [];
		const count = input.weeks ?? SCHEDULE_WEEKS.default;
		const first = await getTrainingWeek(ctx.ownerId, { date: ctx.today }, {}, training(ctx));
		if (!first) return { weeks };
		weeks.push(weekOut(first));
		for (let n = 1; n < count; n += 1) {
			// One read at a time: the services may hold a transaction (docs/architecture.md).
			const next = await getTrainingWeek(
				ctx.ownerId,
				{ date: addDays(first.startsOn, 7 * n) },
				{},
				training(ctx)
			);
			if (next) weeks.push(weekOut(next));
		}
		return { weeks };
	}
});

// ---- get_program_history ------------------------------------------------------------------

const decisionSchema = z.object({
	source: sourceRefSchema,
	kind: z.string(),
	ruleKey: z.nullable(z.string()),
	summary: untrustedSchema,
	why: untrustedSchema,
	decidedBy: z.enum(DECIDERS),
	createdAt: z.iso.datetime(),
	affected: z.array(
		z.object({ lineage: z.string(), title: untrustedSchema, date: z.nullable(isoDate) })
	)
});
/** Where a history page starts: this version (and older ones), from its decision'th decision. */
const historyFrom = z.object({
	version: whole(1, Number.MAX_SAFE_INTEGER),
	decision: whole(0, Number.MAX_SAFE_INTEGER)
});
const historyOutput = z.object({
	versions: z.array(
		z.extend(versionSchema, { source: sourceRefSchema, decisions: z.array(decisionSchema) })
	),
	more: z.boolean(),
	/** `from` for the next page; null once version 1's last decision is in. */
	next: z.nullable(historyFrom),
	truncated: z.optional(z.literal(true))
});
type HistoryOut = z.input<typeof historyOutput>;

const decisionOut = (d: DecisionView): z.input<typeof decisionSchema> => ({
	source: { type: 'decision', id: d.id },
	kind: d.kind,
	ruleKey: d.ruleKey,
	summary: untrusted(d.summary),
	why: untrusted(d.why, WHY_MAX),
	decidedBy: d.decidedBy,
	createdAt: iso(d.createdAt),
	affected: d.affected.map((a) => ({ lineage: a.lineage, title: untrusted(a.title), date: a.date }))
});

/** Whether a page fits the output cap with the longest `next` it could end with. */
const fits = (page: HistoryOut) =>
	new TextEncoder().encode(
		canonicalJson({
			...page,
			more: true,
			next: { version: Number.MAX_SAFE_INTEGER, decision: Number.MAX_SAFE_INTEGER }
		})
	).length <= TURN_LIMITS.toolOutputBytes;

const getProgramHistoryTool = defineTool({
	name: 'get_program_history',
	description:
		"How the owner's active program changed, newest version first: each version's author and summary, and every programming decision in it with its kind, rule, who decided it and its why, exactly as recorded, as many as fit one result. Quote the why rather than rewording it. Give from (the previous result's next) to go on. versions is empty when no program is active.",
	input: z.object({ from: z.optional(historyFrom) }),
	output: historyOutput,
	run: async ({ from }, ctx: Ctx) => {
		const before = from && from.version + 1;
		const history = await getVersionHistory(ctx.ownerId, { before }, training(ctx));
		const page: HistoryOut = { versions: [], more: false, next: null };
		if (!history) return page;
		for (const v of history.versions) {
			const start = v.number === from?.version ? from.decision : 0;
			const version = { ...versionOut(v), source: versionRef(v.number), decisions: [] };
			page.versions.push(version);
			const firstOnPage = page.versions.length === 1;
			if (!firstOnPage && !fits(page)) {
				page.versions.pop();
				return { ...page, more: true, next: { version: v.number, decision: start } };
			}
			const decisions: z.input<typeof decisionSchema>[] = version.decisions;
			for (let i = start; i < v.decisions.length; i += 1) {
				decisions.push(decisionOut(v.decisions[i]!));
				// Always one decision a page, so `from` moves on; one alone over the cap is TOO_LARGE.
				if (decisions.length === 1 && firstOnPage) continue;
				if (fits(page)) continue;
				decisions.pop();
				return { ...page, more: true, next: { version: v.number, decision: i } };
			}
		}
		const older = history.nextCursor;
		return older === null
			? page
			: { ...page, more: true, next: { version: older - 1, decision: 0 } };
	}
});

// ---- get_coach_proposals ------------------------------------------------------------------

const proposalSchema = z.object({
	source: sourceRefSchema,
	kind: z.string(),
	title: untrustedSchema,
	status: z.enum(PROPOSAL_STATUSES),
	summaryLines: z.array(untrustedSchema),
	appliedVersion: z.nullable(z.int()),
	supersededReason: z.nullable(z.enum(SUPERSEDED_REASONS)),
	createdAt: z.iso.datetime(),
	decidedAt: z.nullable(z.iso.datetime()),
	/** The owner's reason for a rejection, in their words. */
	decisionNote: z.nullable(untrustedSchema)
});

const getCoachProposalsTool = defineTool({
	name: 'get_coach_proposals',
	description: `The changes you proposed and what became of them, newest first: each one's kind, title, status (proposed, accepted, rejected, applied or superseded), summary lines, the program version applying it made, why it was superseded, when it was decided, and the owner's reason for a rejection (decisionNote). Give ids (from the turn context or an earlier result) for those proposals, or a status to filter; up to ${COACH_PROPOSALS_LIMIT.default} unless limit says otherwise.`,
	input: z.object({
		status: z.optional(z.enum(PROPOSAL_STATUSES)),
		ids: z.optional(z.array(z.uuid()).check(z.minLength(1), z.maxLength(PROPOSAL_IDS_MAX))),
		limit: z.optional(whole(1, COACH_PROPOSALS_LIMIT.max))
	}),
	output: z.object({
		items: z.array(proposalSchema).check(z.maxLength(COACH_PROPOSALS_LIMIT.max)),
		more: z.boolean(),
		truncated: z.optional(z.literal(true))
	}),
	run: async ({ status, ids, limit }, ctx: Ctx) => {
		const wanted = ids && [...new Set(ids.map((id) => id.toLowerCase()))];
		const count = wanted ? wanted.length : (limit ?? COACH_PROPOSALS_LIMIT.default);
		const { proposals, next } = await listProposals(
			ctx.ownerId,
			wanted ? { ids: wanted, limit: count } : { status, limit: count },
			ctx.deps
		);
		if (wanted) {
			const found = new Set(proposals.map((p) => p.id));
			const missing = wanted.filter((id) => !found.has(id));
			if (missing.length > 0)
				throw toolError('NOT_FOUND', 'You have no proposal with that id', { ids: missing });
		}
		const items = proposals
			.filter((p) => !wanted || status === undefined || p.status === status)
			.map((p) => ({
				source: { type: 'proposal' as const, id: p.id },
				kind: p.kind,
				title: untrusted(p.title),
				status: p.status,
				summaryLines: p.summaryLines.map((line) => untrusted(line)),
				appliedVersion: p.appliedVersion?.number ?? null,
				supersededReason: p.supersededReason,
				createdAt: iso(p.createdAt),
				decidedAt: p.closedAt && iso(p.closedAt),
				decisionNote: p.decisionNote === null ? null : untrusted(p.decisionNote)
			}));
		return { items, more: next !== null };
	}
});

export const PROGRAMMING_READ_TOOLS: readonly CoachTool[] = [
	getCurrentProgramTool,
	getCurrentTrainingWeekTool,
	getTrainingScheduleTool,
	getProgramHistoryTool,
	getCoachProposalsTool
];
