/**
 * The coach's programming proposal tools (PRD §4, §14; the M5 plan's tools-programming-proposals).
 * Each stores a coach_proposals row and changes nothing: the owner accepts or rejects it, and only
 * accept (services/coach/proposals.ts) touches the program. Every read is owner-scoped by the
 * session's owner, so someone else's ids read as nothing and store nothing.
 *
 * - propose_program_adjustment: the drafter (effort high) writes M3's edits against the active
 *   program's sessions from today on, with each exercise's alternatives; accepted, they become
 *   one new version. Given ops (evaluate_week_interference's suggestedRepair.ops), it drafts
 *   nothing and stores exactly those, still checked by checkProposal.
 * - create_training_program: M3's previewProgram, never the coach's own plan, stored as a
 *   new_program proposal by the preview's fingerprint. Refused while a program is active
 *   (NEW_PROGRAM_NEEDS_NO_PROGRAM); a profile changed before accept supersedes it.
 * - create_next_training_cycle: the drafter (effort high) writes a brief for the block after the
 *   current one. A proposal only: accepting it changes no program until M6's cycle review reads
 *   it (NEXT_CYCLE_AWAITS).
 *
 * The two drafting tools take `revises`, the open proposal the owner asked to change: the new one
 * supersedes it ('revised'). Stored text travels as untrusted_text.
 */
import * as z from 'zod/mini';
import { addDays, weekdayOf, type IsoDate } from '../../../domain/calendar.ts';
import {
	MAX_PROPOSAL_OPS,
	NEXT_CYCLE_AWAITS,
	programOpSchema,
	RATIONALE_MAX,
	TITLE_MAX,
	type ProgramOp
} from '../../../domain/coach/proposals.ts';
import { WEEKDAY_INFO } from '../../../domain/profile/catalog.ts';
import { classifyExerciseStatement } from '../../../domain/coach/statements.ts';
import { toExerciseKey } from '../../../domain/programming/input.ts';
import type { ExerciseRef } from '../../../domain/training/types.ts';
import { PHASES } from '../../../domain/training/vocabulary.ts';
import {
	createProposal,
	getProposalView,
	NEW_PROGRAM_NEEDS_NO_PROGRAM,
	PROGRAM_ACTIVE,
	ProposalClosedError
} from '../../services/coach/proposals.ts';
import { isCancelRequested } from '../../services/coach/runs.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import { getExercisesByIds, resolveKeys } from '../../services/exercises/index.ts';
import {
	DEFAULT_PROGRAM_START,
	ONBOARDING_FIRST,
	previewProgram,
	START_OPTIONS
} from '../../services/programming/index.ts';
import {
	alternativesForExercises,
	getCurrentProgram,
	getProgramVersion,
	type StoredSession
} from '../../services/programs/index.ts';
import { TrainingInputError } from '../../services/training/shared.ts';
import { draftInTool } from '../proposals/draft.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { toolError, untrusted, untrustedSchema } from './output.ts';
import { proposalOut, proposalOutput, service } from './workout.ts';

/**
 * Decision: how many days from today the adjustment drafter sees when the coach names no
 * sessions. Two weeks hold the next occurrence of every session of a weekly plan.
 */
export const ADJUSTMENT_DAYS = 14;
/** The most sessions propose_program_adjustment may name. */
export const ADJUSTMENT_SESSIONS_MAX = 12;
/** Decision: how many alternatives of each exercise a drafter is shown. */
export const DRAFT_ALTERNATIVES = 5;
/** Decision: how many of the preview's purpose decisions create_training_program returns. */
export const PREVIEW_PURPOSES = 5;

type Ctx = ToolContext<ResolvedCoachDeps>;
const deps = (ctx: Ctx) => ({ db: ctx.deps.db, now: ctx.deps.now });

const uuid = z.uuid();
const isoDate = z.iso.date();
const sessionKind = z.enum(['strength', 'run', 'other']);
const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const closed = (status: string) =>
	toolError('CLOSED', `That proposal is already ${status}; propose afresh instead`);

/** The active program at its current version, read as Train reads it. */
async function activeVersion(ctx: Ctx) {
	const current = await getCurrentProgram(ctx.ownerId, ctx.today, deps(ctx));
	if (!current)
		throw toolError('NOT_FOUND', 'You have no active program; create_training_program builds one');
	const number = current.version.number;
	const version = await getProgramVersion(ctx.ownerId, current.id, number, deps(ctx));
	return { current, version };
}

/**
 * The open proposal a revision replaces, checked before anything is drafted: someone else's or
 * an unknown one is NOT_FOUND, a decided one CLOSED.
 */
async function checkRevises(ctx: Ctx, id: string | undefined, kind: string) {
	if (id === undefined) return;
	const proposal = await service(() => getProposalView(ctx.ownerId, id, ctx.deps));
	if (proposal.status !== 'proposed') throw closed(proposal.status);
	if (proposal.kind !== kind)
		throw toolError(
			'WRONG_KIND',
			`That proposal is a ${proposal.kind}; revise it with its own tool`
		);
}

/** Store the proposal with the tool call it came from; a predecessor decided meanwhile is CLOSED. */
async function store(ctx: Ctx, proposal: object, revises: string | null, evidence: object) {
	const origin = ctx.toolUseId
		? { threadId: ctx.threadId, runId: ctx.runId, toolUseId: ctx.toolUseId }
		: null;
	const input = { proposal, revises, origin, evidence: { ...evidence } };
	try {
		return proposalOut(await service(() => createProposal(ctx.ownerId, input, ctx.deps)));
	} catch (error) {
		if (error instanceof ProposalClosedError) throw closed(error.status);
		throw error;
	}
}

type Planned = { lineage: string; exercise: ExerciseRef };

/**
 * What a drafter knows of these planned exercises: each library exercise once, by id, with its
 * name and its best alternatives for the owner (eligible, never a dislike).
 */
async function exerciseData(ctx: Ctx, planned: readonly Planned[]) {
	const firsts = [...new Map(planned.map((p) => [toExerciseKey(p.exercise), p])).values()];
	const keys = firsts.flatMap((p) => ('key' in p.exercise ? [p.exercise.key] : []));
	const custom = firsts.flatMap((p) => ('customId' in p.exercise ? [p.exercise.customId] : []));
	// One query at a time: the services may hold a transaction (docs/architecture.md).
	const byKey = await resolveKeys(keys, deps(ctx));
	const byId = await getExercisesByIds(ctx.ownerId, custom, deps(ctx));
	const alternatives = await alternativesForExercises(ctx.ownerId, firsts, deps(ctx));
	const defOf = (ref: ExerciseRef) => ('key' in ref ? byKey.get(ref.key) : byId.get(ref.customId));
	const exercises = firsts.flatMap((p) => {
		const def = defOf(p.exercise);
		if (!def) return [];
		const options = (alternatives.get(p.lineage)?.alternatives ?? []).slice(0, DRAFT_ALTERNATIVES);
		const alternativesOut = options.map((a) => ({ exerciseId: a.id, name: a.name }));
		return [{ exerciseId: def.id, name: def.name, alternatives: alternativesOut }];
	});
	return { exercises, idOf: (ref: ExerciseRef) => defOf(ref)?.id ?? null };
}

/** A stored session as the adjustment drafter reads it: what an op names, and what it changes. */
function sessionData(s: StoredSession, idOf: (ref: ExerciseRef) => string | null) {
	const base = {
		sessionLineage: s.lineage,
		date: s.date,
		timeOfDay: s.timeOfDay,
		title: untrusted(s.title),
		kind: s.kind
	};
	if (s.kind === 'run') return { ...base, segments: s.segments };
	if (s.kind === 'other') return { ...base, details: s.details };
	return {
		...base,
		exercises: s.exercises.map((e) => ({
			plannedExerciseLineage: e.lineage,
			exerciseId: idOf(e.exercise),
			sets: e.sets.map(({ notes: _notes, ...set }) => set)
		}))
	};
}

// ---- propose_program_adjustment ---------------------------------------------------------

/** What the adjustment drafter reads: the program, the sessions it may change and their exercises. */
async function adjustmentData(
	ctx: Ctx,
	current: { title: string; version: { number: number } },
	sessions: readonly StoredSession[],
	planned: readonly Planned[]
) {
	const { exercises, idOf } = await exerciseData(ctx, planned);
	return {
		today: ctx.today,
		program: { title: untrusted(current.title), version: current.version.number },
		sessions: sessions.map((s) => sessionData(s, idOf)),
		exercises
	};
}

/** The title of ops passed as they are: 'Move Lower A to Friday', or how many changes. */
function opsTitle(ops: readonly ProgramOp[], sessions: readonly StoredSession[]): string {
	const [first] = ops;
	const named = first && sessions.find((s) => s.lineage === first.sessionLineage);
	const title =
		ops.length === 1 && first?.op === 'move' && named
			? `Move ${named.title} to ${WEEKDAY_INFO[weekdayOf(first.toDate as IsoDate)].label}`
			: `${ops.length} change${ops.length === 1 ? '' : 's'} to your program`;
	return Array.from(title).slice(0, TITLE_MAX).join('').trim();
}

const draftedOutput = z.object({ proposal: proposalOutput });

const proposeProgramAdjustmentTool = defineTool({
	name: 'propose_program_adjustment',
	description: `Propose a change to the owner's active program from today on: move or skip sessions, swap an exercise (scope never_again only after the owner said in this message that they dislike it), or adjust sets, run segments or a session's details. Describe the change in request (up to ${RATIONALE_MAX} characters); it is drafted against the program's sessions and each exercise's alternatives, and stored as a proposal the owner accepts or rejects, so nothing changes yet. sessionLineages (from get_current_training_week or get_training_schedule, up to ${ADJUSTMENT_SESSIONS_MAX}) narrows it to those sessions; left out, the drafter sees the next ${ADJUSTMENT_DAYS} days. revises names the open proposal the owner asked you to change: it is replaced. For today's session before it starts use update_workout; inside a workout, substitute_exercise. ops (up to ${MAX_PROPOSAL_OPS}) takes evaluate_week_interference's suggestedRepair.ops exactly as returned: they are stored as given, with request as the reason, and nothing is drafted.`,
	input: z.object({
		request: text(RATIONALE_MAX),
		sessionLineages: z.optional(
			z.array(uuid).check(z.minLength(1), z.maxLength(ADJUSTMENT_SESSIONS_MAX))
		),
		revises: z.optional(uuid),
		ops: z.optional(z.array(programOpSchema).check(z.minLength(1), z.maxLength(MAX_PROPOSAL_OPS)))
	}),
	output: draftedOutput,
	run: async ({ request, sessionLineages, revises, ops }, ctx: Ctx) => {
		const { current, version } = await activeVersion(ctx);
		await checkRevises(ctx, revises, 'program_adjustment');
		const upcoming = version.blocks
			.flatMap((b) => b.weeks)
			.flatMap((w) => w.sessions)
			.filter((s) => s.date >= ctx.today && s.status !== 'skipped');
		const until = addDays(ctx.today as IsoDate, ADJUSTMENT_DAYS);
		const sessions = sessionLineages
			? upcoming.filter((s) => sessionLineages.includes(s.lineage))
			: upcoming.filter((s) => s.date < until);
		const missing = sessionLineages?.find((id) => !sessions.some((s) => s.lineage === id));
		if (missing)
			throw toolError('NOT_FOUND', 'You have no session from today on with that id', {
				sessionLineage: missing
			});
		const planned = sessions.flatMap((s) => (s.kind === 'strength' ? s.exercises : []));
		// Ops the engine computed are stored as they are: no draft, and checkProposal still runs.
		const draft = ops
			? { title: opsTitle(ops, upcoming), rationale: request, payload: { ops } }
			: await draftInTool(
					'program_adjustment',
					{ request, data: await adjustmentData(ctx, current, sessions, planned) },
					ctx
				);
		// A lasting swap saves a dislike when accepted: only the owner's words this turn allow it.
		const disliked = new Set(
			classifyExerciseStatement(ctx.ownerText, [], (words) => ctx.matchExercise(words))
				.filter((said) => said.kind === 'dislike')
				.map((said) => said.exercise)
		);
		for (const op of draft.payload.ops) {
			if (op.op !== 'swap' || op.scope !== 'never_again') continue;
			const from = planned.find((p) => p.lineage === op.plannedExerciseLineage);
			if (!from || !disliked.has(toExerciseKey(from.exercise)))
				throw toolError(
					'NEEDS_DISLIKE',
					'A lasting swap needs the owner to say in this message that they dislike the exercise; propose scope once instead'
				);
		}
		const proposal = { kind: 'program_adjustment', ...draft };
		return { proposal: await store(ctx, proposal, revises ?? null, { request }) };
	}
});

// ---- create_training_program ------------------------------------------------------------

const createProgramOutput = z.object({
	proposal: proposalOutput,
	preview: z.object({
		title: untrustedSchema,
		startsOn: isoDate,
		firstPlannedDay: isoDate,
		plannedWeeks: z.int(),
		blocks: z.array(
			z.object({ name: untrustedSchema, phase: z.enum(PHASES), plannedWeeks: z.int() })
		),
		week1: z.array(
			z.object({
				date: isoDate,
				sessions: z.array(z.object({ title: untrustedSchema, kind: sessionKind }))
			})
		),
		/** Why the program is shaped as it is, in the generator's own words. */
		purpose: z.array(untrustedSchema)
	})
});

const createTrainingProgramTool = defineTool({
	name: 'create_training_program',
	description: `Propose the owner's first program, built by the app's program generator from their profile (never written by you), starting ${START_OPTIONS.join(' or ')} (default ${DEFAULT_PROGRAM_START}). It is stored as a proposal the owner accepts or rejects; accepting builds exactly the program previewed, or nothing if their profile changed since. Refused (PROGRAM_ACTIVE) while a program is active: propose adjustments to it instead. Refused (PROFILE_INCOMPLETE) until onboarding is finished. rationale says why, up to ${RATIONALE_MAX} characters.`,
	input: z.object({
		start: z.optional(z.enum(START_OPTIONS)),
		rationale: text(RATIONALE_MAX)
	}),
	output: createProgramOutput,
	run: async ({ start = DEFAULT_PROGRAM_START, rationale }, ctx: Ctx) => {
		// The turn's run is the owner's: proven before the generator reads (and makes) a profile.
		await service(() => isCancelRequested(ctx.ownerId, ctx.runId, ctx.deps));
		const active = await getCurrentProgram(ctx.ownerId, ctx.today, deps(ctx));
		if (NEW_PROGRAM_NEEDS_NO_PROGRAM && active)
			throw toolError('PROGRAM_ACTIVE', `${PROGRAM_ACTIVE}: propose adjustments to it instead`);
		const preview = await previewProgram(ctx.ownerId, { today: ctx.today, start }, deps(ctx)).catch(
			(error: unknown) => {
				if (error instanceof TrainingInputError && error.errors.onboarding)
					throw toolError('PROFILE_INCOMPLETE', ONBOARDING_FIRST);
				throw error;
			}
		);
		const { startsOn, firstPlannedDay, fingerprint, digest, summary } = preview;
		const proposal = {
			kind: 'new_program',
			title: Array.from(summary.title).slice(0, TITLE_MAX).join('').trim(),
			rationale,
			payload: { start, startsOn, firstPlannedDay, fingerprint, digest }
		};
		return {
			proposal: await store(ctx, proposal, null, { start }),
			preview: {
				title: untrusted(summary.title),
				startsOn,
				firstPlannedDay,
				plannedWeeks: summary.plannedWeeks,
				blocks: summary.blocks.map((b) => ({
					name: untrusted(b.name),
					phase: b.phase,
					plannedWeeks: b.plannedWeeks
				})),
				week1: preview.week.days
					.filter((d) => d.sessions.length)
					.map((d) => ({
						date: d.date,
						sessions: d.sessions.map((s) => ({ title: untrusted(s.title), kind: s.kind }))
					})),
				purpose: preview.decisions.purpose
					.slice(0, PREVIEW_PURPOSES)
					.map((d) => untrusted(d.summary))
			}
		};
	}
});

// ---- create_next_training_cycle ---------------------------------------------------------

const createNextTrainingCycleTool = defineTool({
	name: 'create_next_training_cycle',
	description: `Propose the next training cycle: a brief for the block after the current one (its focus, phase, weeks, emphasis, week targets, exercises to rotate out, running volume and ending), drafted from the current block's weeks and exercises. Describe what it should be in request (up to ${RATIONALE_MAX} characters). It is a proposal only: accepting it changes no program until the cycle review plans its weeks. revises names the open proposal the owner asked you to change: it is replaced.`,
	input: z.object({ request: text(RATIONALE_MAX), revises: z.optional(uuid) }),
	output: z.extend(draftedOutput, { awaits: z.literal(NEXT_CYCLE_AWAITS) }),
	run: async ({ request, revises }, ctx: Ctx) => {
		const { current, version } = await activeVersion(ctx);
		await checkRevises(ctx, revises, 'next_cycle');
		// The block not yet over (before the program starts, its first); once every block is
		// behind, the last one.
		const block = version.blocks.find((b) => ctx.today <= b.endsOn) ?? version.blocks.at(-1)!;
		const planned = block.weeks
			.flatMap((w) => w.sessions)
			.flatMap((s) => (s.kind === 'strength' ? s.exercises : []));
		const { exercises } = await exerciseData(ctx, planned);
		const data = {
			today: ctx.today,
			program: {
				title: untrusted(current.title),
				version: current.version.number,
				currentWeek: current.currentWeek,
				plannedWeeks: current.plannedWeeks
			},
			block: {
				fromBlockLineage: block.lineage,
				name: untrusted(block.name),
				phase: block.phase,
				startsOn: block.startsOn,
				endsOn: block.endsOn,
				plannedWeeks: block.weeks.length,
				sessionsPerWeek: block.weeks.map((w) => w.sessions.length),
				lastWeekTargets: block.weeks.at(-1)?.targets ?? null
			},
			exercises
		};
		const draft = await draftInTool('next_cycle', { request, data }, ctx);
		// The tool decides which block the cycle follows, whatever the draft named.
		const payload = { ...draft.payload, fromBlockLineage: block.lineage };
		const proposal = { kind: 'next_cycle', ...draft, payload };
		return {
			proposal: await store(ctx, proposal, revises ?? null, { request }),
			awaits: NEXT_CYCLE_AWAITS as typeof NEXT_CYCLE_AWAITS
		};
	}
});

export const PROGRAMMING_PROPOSAL_TOOLS: readonly CoachTool[] = [
	proposeProgramAdjustmentTool,
	createTrainingProgramTool,
	createNextTrainingCycleTool
];
