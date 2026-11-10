/**
 * The coach's workout tools (PRD §4, §8; the M5 plan's tools-workout), with M4's semantics. Each
 * calls the services the workout and Today screens use, owner-scoped by the session's owner, so
 * someone else's ids read as nothing and write nothing.
 *
 * - get_current_workout: the workout in progress, and today's planned sessions with each strength
 *   exercise's lineage, place and library id (what the other tools take).
 * - get_exercise_alternatives: M3's ranked alternatives as the start kit carries them. Equipment
 *   unavailable puts those needing none of the slot's equipment first (M4's rankFor); with a body
 *   area, M4's gentler options for it (gentlerFor) instead, which a pain answer names.
 * - update_workout: today's session only, before it starts. The drafter writes the change, which
 *   is stored as a workout_update proposal; nothing changes until the owner accepts it.
 * - substitute_exercise: a session_substitution proposal, into the live workout once accepted. A
 *   situational statement this turn ('the leg press is taken') keeps it in the session. A lasting
 *   swap needs the owner's explicit dislike of the exercise this turn, and is a program_adjustment
 *   proposal (a 'never again' swap) instead.
 * - save_workout_analysis: the coach's note on one of the owner's workouts, which memory reads.
 *
 * Stored text (titles, lines) travels as untrusted_text. Exercise names stay plain strings, as the
 * output policy reads them to name gentler options.
 */
import * as z from 'zod/mini';
import {
	ANALYSIS_HEADLINE_MAX,
	ANALYSIS_POINT_MAX,
	ANALYSIS_POINTS_MAX
} from '../../../domain/coach/notes.ts';
import { RATIONALE_MAX, TITLE_MAX } from '../../../domain/coach/proposals.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import { classifyExerciseStatement } from '../../../domain/coach/statements.ts';
import { BODY_AREAS } from '../../../domain/profile/catalog.ts';
import { REASON_MAX } from '../../../domain/training/edits.ts';
import {
	SESSION_STATUSES,
	SUBSTITUTION_REASONS,
	type SubstitutionReason
} from '../../../domain/training/vocabulary.ts';
import type { KitAlternative, KitExercise, StrengthKit } from '../../../domain/workout/index.ts';
import { rankFor } from '../../../domain/workout/substitution.ts';
import { saveWorkoutAnalysis } from '../../services/coach/notes.ts';
import {
	createProposal,
	ProposalRefusedError,
	type CreatedProposal
} from '../../services/coach/proposals.ts';
import {
	CoachInputError,
	CoachNotFoundError,
	type ResolvedCoachDeps
} from '../../services/coach/shared.ts';
import { getPlannedSession, getTodayPlan } from '../../services/programs/index.ts';
import { getCanonicalWorkout, listActiveWorkouts } from '../../services/workouts/canonical.ts';
import { kitForLineage } from '../../services/workouts/kit.ts';
import { draftInTool } from '../proposals/draft.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { PAGE_MAX, sourceRefSchema, toolError, untrusted, untrustedSchema } from './output.ts';

/** substitute_exercise's scopes: this session only, or every session from today. */
export const SUBSTITUTE_SCOPES = ['session', 'from_now_on'] as const;
/**
 * Decision (the M5 plan: 'a situational statement forces session scope with
 * equipment_unavailable'): the reason a situational substitution is stored with, unless the coach
 * gave one of these, which already describe today's situation.
 */
export const SITUATIONAL_REASONS: readonly SubstitutionReason[] = [
	'equipment_unavailable',
	'situational',
	'pain',
	'injury'
];
/**
 * Decision (the M5 plan's open question 'After an explicit dislike, replacing its upcoming
 * occurrences is a proposal you accept'): a from_now_on swap, even on an explicit dislike, is
 * stored as a program_adjustment proposal the owner accepts, never applied at once.
 */
export const LASTING_SWAP_KIND = 'program_adjustment';
/** How many alternatives of each exercise the drafter is shown for a swap. */
export const DRAFT_ALTERNATIVES = 5;

type Ctx = ToolContext<ResolvedCoachDeps>;
const deps = (ctx: Ctx) => ({ db: ctx.deps.db, now: ctx.deps.now });

const uuid = z.uuid();
const isoDate = z.iso.date();
const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const sessionRef = (s: { lineage: string; date: string }): SourceRef => ({
	type: 'session',
	id: s.lineage,
	date: s.date
});
const exerciseRef = (id: string, name: string): SourceRef => ({
	type: 'exercise',
	id,
	label: name.slice(0, 80)
});

/** The services' refusals as errors the model can act on; nothing was written. */
export async function service<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ProposalRefusedError)
			throw toolError('REFUSED', 'The change fails today’s checks; nothing was stored', {
				errors: error.errors
			});
		if (error instanceof CoachNotFoundError) throw toolError('NOT_FOUND', error.message);
		if (error instanceof CoachInputError)
			throw toolError('INVALID_INPUT', error.message, { field: error.field });
		throw error;
	}
}

const notFound = (what: string) => toolError('NOT_FOUND', `You have no ${what} with that id`);

/** The strength kit of the current version's session, and its planned exercise. */
async function plannedExercise(ctx: Ctx, sessionLineage: string, plannedExerciseLineage: string) {
	const kit = await kitForLineage(ctx.ownerId, sessionLineage, deps(ctx));
	if (!kit) throw notFound('planned session');
	if (kit.kind !== 'strength')
		throw toolError('NOT_STRENGTH', 'Only a strength session’s exercises can be swapped');
	const exercise = kit.exercises.find((e) => e.plannedLineage === plannedExerciseLineage);
	if (!exercise) throw notFound('planned exercise in that session');
	return { kit, exercise };
}

// ---- get_current_workout ----------------------------------------------------------------

const exerciseSchema = z.object({
	source: sourceRefSchema,
	exerciseId: uuid,
	name: z.string(),
	equipment: z.array(z.string())
});
const plannedExerciseSchema = z.extend(exerciseSchema, {
	plannedExerciseLineage: uuid,
	position: z.int(),
	sets: z.int()
});
const currentWorkoutOutput = z.object({
	today: isoDate,
	live: z.nullable(
		z.object({
			/** The workout's client id: what a substitution into it names. */
			workoutId: uuid,
			title: untrustedSchema,
			kind: z.enum(['strength', 'run', 'other']),
			startedAt: z.iso.datetime(),
			session: z.nullable(sourceRefSchema),
			setsLogged: z.int(),
			substitutions: z.array(
				z.object({
					position: z.nullable(z.int()),
					from: z.string(),
					to: z.string(),
					reason: z.enum(SUBSTITUTION_REASONS)
				})
			)
		})
	),
	sessions: z.array(
		z.object({
			source: sourceRefSchema,
			title: untrustedSchema,
			line: untrustedSchema,
			kind: z.enum(['strength', 'run', 'other']),
			status: z.enum(SESSION_STATUSES),
			/** A workout in progress runs it. */
			started: z.boolean(),
			exercises: z.array(plannedExerciseSchema)
		})
	),
	noProgram: z.boolean()
});

const exerciseOut = (e: KitExercise['exercise']) => ({
	source: exerciseRef(e.id, e.name),
	exerciseId: e.id,
	name: e.name,
	equipment: [...(e.equipment ?? [])]
});
const plannedOut = (e: KitExercise) => ({
	...exerciseOut(e.exercise),
	plannedExerciseLineage: e.plannedLineage!,
	position: e.position,
	sets: e.sets.length
});

const getCurrentWorkoutTool = defineTool({
	name: 'get_current_workout',
	description:
		"The owner's workout in progress (live: its title, sets logged so far and substitutions; null when none) and today's planned sessions, each with its status, whether a workout in progress runs it, and for strength its exercises with their plannedExerciseLineage, position, exerciseId and equipment: the ids get_exercise_alternatives, substitute_exercise and update_workout take.",
	input: z.object({}),
	output: currentWorkoutOutput,
	run: async (_input, ctx: Ctx) => {
		const { workouts } = await listActiveWorkouts(ctx.ownerId, deps(ctx));
		let live: z.input<typeof currentWorkoutOutput>['live'] = null;
		const newest = workouts[0];
		const workout = newest && (await getCanonicalWorkout(ctx.ownerId, newest.id, deps(ctx)));
		if (newest && workout) {
			const name = (id: string) => workout.exercises[id]?.name ?? 'Unknown exercise';
			live = {
				workoutId: newest.id,
				title: untrusted(newest.title),
				kind: newest.kind,
				startedAt: newest.startedAt,
				session: null,
				setsLogged: workout.sets.filter((s) => !s.deletedAt && !s.isSkipped).length,
				substitutions: workout.substitutions
					.filter((s) => !s.deletedAt)
					.map((s) => ({
						position: s.position,
						from: name(s.fromExerciseId),
						to: name(s.toExerciseId),
						reason: s.reason
					}))
			};
		}
		const plan = await getTodayPlan(ctx.ownerId, ctx.today, deps(ctx));
		const sessions: z.input<typeof currentWorkoutOutput>['sessions'] = [];
		for (const s of plan?.sessions ?? []) {
			// One kit at a time: the services may hold a transaction (docs/architecture.md).
			const kit =
				s.kind === 'strength' ? await kitForLineage(ctx.ownerId, s.lineage, deps(ctx)) : null;
			const exercises = (kit as StrengthKit | null)?.exercises ?? [];
			if (live && newest?.plannedLineage === s.lineage) live.session = sessionRef(s);
			sessions.push({
				source: sessionRef(s),
				title: untrusted(s.title),
				line: untrusted(s.line),
				kind: s.kind,
				status: s.status,
				started: workouts.some((w) => w.plannedLineage === s.lineage),
				exercises: exercises.filter((e) => e.plannedLineage !== null).map(plannedOut)
			});
		}
		return { today: ctx.today, live, sessions, noProgram: plan === null };
	}
});

// ---- get_exercise_alternatives ----------------------------------------------------------

const alternativeSchema = z.extend(exerciseSchema, { reasons: z.array(z.string()) });
const alternativesOutput = z.object({
	exercise: exerciseSchema,
	/** How the items are ordered: M3's ranking, equipment-free first, or gentler for an area. */
	ranking: z.enum(['ranked', 'equipment_free_first', 'gentler']),
	area: z.nullable(z.enum(BODY_AREAS)),
	items: z.array(alternativeSchema).check(z.maxLength(PAGE_MAX)),
	/** Why nothing fits, when nothing does. */
	blocked: z.array(z.string()),
	truncated: z.optional(z.literal(true))
});

const alternativeOut = (a: KitAlternative) => ({
	...exerciseOut({ ...a.exercise, equipment: a.equipment }),
	reasons: [...a.reasons]
});

const getExerciseAlternativesTool = defineTool({
	name: 'get_exercise_alternatives',
	description:
		"What a planned exercise of a strength session can be swapped for, best first, keeping its purpose (pattern, muscles, intent) within the owner's equipment, injuries and dislikes, each with its reasons. reason equipment_unavailable puts the ones needing none of the exercise's equipment first. Give area when something hurts: then only the gentler options for that body area. blocked says why nothing fits when nothing does.",
	input: z.object({
		sessionLineage: uuid,
		plannedExerciseLineage: uuid,
		reason: z.optional(z.enum(SUBSTITUTION_REASONS)),
		area: z.optional(z.enum(BODY_AREAS))
	}),
	output: alternativesOutput,
	run: async ({ sessionLineage, plannedExerciseLineage, reason, area }, ctx: Ctx) => {
		const { exercise } = await plannedExercise(ctx, sessionLineage, plannedExerciseLineage);
		const slot = { plannedLineage: exercise.plannedLineage, exerciseId: exercise.exercise.id };
		const options = area
			? (exercise.gentler?.[area] ?? [])
			: rankFor(reason ?? 'owner_choice', exercise.alternatives ?? [], { ...slot, kit: exercise });
		const ranking = area
			? ('gentler' as const)
			: reason === 'equipment_unavailable'
				? ('equipment_free_first' as const)
				: ('ranked' as const);
		return {
			exercise: exerciseOut(exercise.exercise),
			ranking,
			area: area ?? null,
			items: options.slice(0, PAGE_MAX).map(alternativeOut),
			blocked: options.length ? [] : [...(exercise.blocked ?? [])]
		};
	}
});

// ---- proposals: update_workout and substitute_exercise ----------------------------------

export const proposalOutput = z.object({
	id: uuid,
	kind: z.string(),
	title: z.string(),
	status: z.string(),
	summaryLines: z.array(z.string()),
	/** An identical open proposal was returned: nothing new was stored. */
	duplicate: z.boolean()
});
export const proposalOut = ({ proposal, duplicate }: CreatedProposal) => ({
	id: proposal.id,
	kind: proposal.kind,
	title: proposal.title,
	status: proposal.status,
	summaryLines: [...proposal.summaryLines],
	duplicate
});
const origin = (ctx: Ctx) =>
	ctx.toolUseId ? { threadId: ctx.threadId, runId: ctx.runId, toolUseId: ctx.toolUseId } : null;
export const propose = (ctx: Ctx, proposal: object, evidence: Record<string, unknown>) =>
	service(() => createProposal(ctx.ownerId, { proposal, origin: origin(ctx), evidence }, ctx.deps));

/** What the drafter reads of today's session: its plan, and each exercise's alternatives. */
async function sessionData(ctx: Ctx, lineage: string) {
	const session = await getPlannedSession(ctx.ownerId, lineage, {}, deps(ctx));
	const kit =
		session.kind === 'strength' ? await kitForLineage(ctx.ownerId, lineage, deps(ctx)) : null;
	const kitExercises = (kit as StrengthKit | null)?.exercises ?? [];
	const base = {
		lineage,
		date: session.date,
		title: untrusted(session.title),
		kind: session.kind
	};
	if (session.kind === 'run') return { ...base, segments: session.segments };
	if (session.kind === 'other') return { ...base, details: session.details };
	return {
		...base,
		exercises: session.exercises.map((e) => {
			const kitted = kitExercises.find((k) => k.plannedLineage === e.lineage);
			return {
				plannedExerciseLineage: e.lineage,
				name: e.name,
				exerciseId: kitted?.exercise.id ?? null,
				sets: e.sets.map(({ notes: _notes, ...set }) => set),
				alternatives: (kitted?.alternatives ?? [])
					.slice(0, DRAFT_ALTERNATIVES)
					.map((a) => ({ exerciseId: a.exercise.id, name: a.exercise.name }))
			};
		})
	};
}

const updateWorkoutTool = defineTool({
	name: 'update_workout',
	description: `Propose a change to one of today's planned sessions before it starts: lighter or heavier sets, fewer exercises, a swap, a shorter run, or moving or skipping it. Describe the change in request (up to ${RATIONALE_MAX} characters); it is drafted against the session's plan and stored as a proposal the owner accepts or rejects, so nothing changes yet. Refused for another day's session (propose a program adjustment) and once the session has started or is done (use substitute_exercise inside a workout).`,
	input: z.object({ sessionLineage: uuid, request: text(RATIONALE_MAX) }),
	output: z.object({ proposal: proposalOutput }),
	run: async ({ sessionLineage, request }, ctx: Ctx) => {
		const plan = await getTodayPlan(ctx.ownerId, ctx.today, deps(ctx));
		const today = plan?.sessions.find((s) => s.lineage === sessionLineage);
		if (!today) {
			// Someone else's or an unknown session is NOT_FOUND here, before anything is drafted.
			await getPlannedSession(ctx.ownerId, sessionLineage, {}, deps(ctx));
			throw toolError(
				'NOT_TODAY',
				'update_workout changes only today’s sessions; propose a program adjustment for another day'
			);
		}
		const { workouts } = await listActiveWorkouts(ctx.ownerId, deps(ctx));
		if (today.status === 'completed' || workouts.some((w) => w.plannedLineage === sessionLineage))
			throw toolError(
				'STARTED',
				'This session has started or is done; use substitute_exercise for a change inside the workout'
			);
		const data = { today: ctx.today, session: await sessionData(ctx, sessionLineage) };
		const draft = await draftInTool('workout_update', { request, data }, ctx);
		// A never_again swap changes later sessions and saves a dislike: substitute_exercise's, on the
		// owner's explicit dislike.
		const elsewhere = draft.payload.ops.findIndex(
			(op) => op.sessionLineage !== sessionLineage || (op.op === 'swap' && op.scope !== 'once')
		);
		if (elsewhere >= 0)
			throw toolError(
				'NOT_TODAY',
				'The drafted change reaches beyond today’s session; nothing was stored',
				{
					op: elsewhere
				}
			);
		const created = await propose(ctx, { kind: 'workout_update', ...draft }, { request });
		return { proposal: proposalOut(created) };
	}
});

const substituteOutput = z.object({
	proposal: proposalOutput,
	exercise: exerciseSchema,
	scope: z.enum(SUBSTITUTE_SCOPES),
	/** The substitution's reason; null for a lasting swap. */
	reason: z.nullable(z.enum(SUBSTITUTION_REASONS)),
	/** Why the scope or reason differs from what was asked. */
	changed: z.nullable(z.string())
});

const substituteExerciseTool = defineTool({
	name: 'substitute_exercise',
	description: `Propose swapping a planned exercise of a strength session for one of its alternatives (an exerciseId from get_exercise_alternatives). scope session swaps it in that session only, into the workout in progress once accepted: use it whenever today's situation is the reason (equipment taken or missing, time, a niggle). scope from_now_on swaps it in every session from today, and only when the owner said in this message that they dislike the exercise; a situational message always stays in the session. Either way it is a proposal the owner accepts or rejects. title up to ${TITLE_MAX} characters; rationale says why, up to ${RATIONALE_MAX}.`,
	input: z.object({
		sessionLineage: uuid,
		plannedExerciseLineage: uuid,
		toExerciseId: uuid,
		reason: z.enum(SUBSTITUTION_REASONS),
		scope: z.enum(SUBSTITUTE_SCOPES),
		title: text(TITLE_MAX),
		rationale: text(RATIONALE_MAX)
	}),
	output: substituteOutput,
	run: async (input, ctx: Ctx) => {
		const { sessionLineage, plannedExerciseLineage, toExerciseId, title, rationale } = input;
		const { exercise } = await plannedExercise(ctx, sessionLineage, plannedExerciseLineage);
		const key = exercise.exercise.key ?? `custom:${exercise.exercise.id}`;
		const said = classifyExerciseStatement(ctx.ownerText, [], (words) =>
			ctx.matchExercise(words)
		).find((s) => s.exercise === key);
		let { scope, reason } = input;
		let changed: string | null = null;
		if (said?.kind === 'situational') {
			if (scope !== 'session') changed = 'The owner described today’s situation: this session only';
			scope = 'session';
			if (!SITUATIONAL_REASONS.includes(reason)) {
				reason = 'equipment_unavailable';
				changed ??= 'Stored as equipment unavailable: today’s situation, not a preference';
			}
		}
		if (scope === 'from_now_on') {
			if (said?.kind !== 'dislike')
				throw toolError(
					'NEEDS_DISLIKE',
					'A lasting swap needs the owner to say in this message that they dislike the exercise; propose scope session instead'
				);
			const swap = {
				op: 'swap',
				sessionLineage,
				plannedExerciseLineage,
				toExerciseId,
				scope: 'never_again',
				reason: said.quote.slice(0, REASON_MAX)
			};
			const proposal = { kind: LASTING_SWAP_KIND, title, rationale, payload: { ops: [swap] } };
			const created = await propose(ctx, proposal, { ownerWords: said.quote });
			return {
				proposal: proposalOut(created),
				exercise: exerciseOut(exercise.exercise),
				scope,
				reason: null,
				changed
			};
		}
		const { workouts } = await listActiveWorkouts(ctx.ownerId, deps(ctx));
		const live = workouts.find((w) => w.plannedLineage === sessionLineage);
		const payload = {
			...(live && { workoutId: live.id }),
			sessionLineage,
			plannedExerciseLineage,
			position: exercise.position,
			fromExerciseId: exercise.exercise.id,
			toExerciseId,
			reason
		};
		const proposal = { kind: 'session_substitution', title, rationale, payload };
		const created = await propose(ctx, proposal, { statement: said?.kind ?? 'none' });
		return {
			proposal: proposalOut(created),
			exercise: exerciseOut(exercise.exercise),
			scope,
			reason,
			changed
		};
	}
});

// ---- save_workout_analysis --------------------------------------------------------------

const saveWorkoutAnalysisTool = defineTool({
	name: 'save_workout_analysis',
	description: `Save your analysis of one of the owner's workouts (its workoutId from their history) so you remember it in later conversations: a headline (up to ${ANALYSIS_HEADLINE_MAX} characters) and up to ${ANALYSIS_POINTS_MAX} points (each up to ${ANALYSIS_POINT_MAX}). Write only what the workout's data shows.`,
	input: z.object({
		workoutId: uuid,
		headline: text(ANALYSIS_HEADLINE_MAX),
		points: z.array(text(ANALYSIS_POINT_MAX)).check(z.maxLength(ANALYSIS_POINTS_MAX))
	}),
	output: z.object({
		note: z.object({ source: sourceRefSchema, workout: sourceRefSchema })
	}),
	run: async ({ workoutId, headline, points }, ctx: Ctx) => {
		const note = await service(() =>
			saveWorkoutAnalysis(
				ctx.ownerId,
				{ analysis: { workoutId, headline, points }, runId: ctx.runId },
				ctx.deps
			)
		);
		return {
			note: {
				source: { type: 'note' as const, id: note.id },
				workout: { type: 'workout' as const, id: workoutId }
			}
		};
	}
});

export const WORKOUT_TOOLS: readonly CoachTool[] = [
	getCurrentWorkoutTool,
	getExerciseAlternativesTool,
	updateWorkoutTool,
	substituteExerciseTool,
	saveWorkoutAnalysisTool
];
