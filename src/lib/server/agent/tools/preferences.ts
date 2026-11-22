/**
 * The coach's preference tools (PRD §4, §14; the M5 plan's tools-preferences), over the services
 * the Profile screens use, owner-scoped by the session's owner, so someone else's ids read as
 * nothing and write nothing.
 *
 * - get_training_preferences: likes and dislikes with where they were recorded and why, the open
 *   goals by rank (the ids update_training_goals takes), equipment, active injuries and the
 *   movements they say to avoid, the schedule, and M4's pain reports from the last
 *   MEMORY_RECORD_DAYS days. Equipment and injuries cite a 'preference' ref with an `equipment.`
 *   or `injury.` id, as the coaching memory does.
 * - update_exercise_preferences: the one direct write the brief allows. classifyExerciseStatement
 *   reads this turn's stored owner message, never a tool result or stored text. An explicit like
 *   or dislike of that exercise is recorded at once through recordExercisePreference (source
 *   'coach', under the preference lock) with a coach_decision note quoting the owner, in one
 *   transaction. A situational statement ('the leg press is taken') is refused, pointing to
 *   substitute_exercise; anything else is a preference_update proposal the owner accepts. A name
 *   that matches no single exercise is refused with candidates to ask the owner about.
 * - update_training_goals: always a goal_update proposal; goals never change directly.
 *
 * Stored free text (the owner's words for an exercise, reasons, notes, goal titles) travels as
 * untrusted_text.
 */
import * as z from 'zod/mini';
import { OWNER_WORDS_MAX } from '../../../domain/coach/notes.ts';
import {
	proposalDraftSchema,
	RATIONALE_MAX,
	TITLE_MAX,
	type GoalOp
} from '../../../domain/coach/proposals.ts';
import { REF_LABEL_MAX, type SourceRef } from '../../../domain/coach/sources.ts';
import { classifyExerciseStatement } from '../../../domain/coach/statements.ts';
import {
	BODY_AREA_LABEL,
	EQUIPMENT,
	EQUIPMENT_LABEL,
	SENTIMENTS
} from '../../../domain/profile/catalog.ts';
import type { ExercisePreference } from '../../../domain/profile/types.ts';
import { listRecentPainReports, MEMORY_RECORD_DAYS } from '../../services/coach/memory-records.ts';
import { recordCoachDecision } from '../../services/coach/notes.ts';
import { inTransaction, type ResolvedCoachDeps } from '../../services/coach/shared.ts';
import type { ExerciseDef } from '../../services/exercises/index.ts';
import { getEquipment, getInjuries, getSchedule, listGoals } from '../../services/profile/index.ts';
import {
	listExercisePreferences,
	recordExercisePreference
} from '../../services/training/preferences.ts';
import { TrainingNotFoundError } from '../../services/training/shared.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { resolveExercise } from './history.ts';
import {
	PAGE_MAX,
	sourceRefSchema,
	ToolError,
	toolError,
	untrusted,
	untrustedSchema
} from './output.ts';
import { proposalOut, proposalOutput, propose, service } from './workout.ts';

/** The most pain reports get_training_preferences lists, newest first. */
export const PREFERENCE_PAIN_REPORTS = PAGE_MAX;
/** The longest reason a preference keeps (M2's exercise preference reason). */
export const PREFERENCE_REASON_MAX = 200;

type Ctx = ToolContext<ResolvedCoachDeps>;
const deps = (ctx: Ctx) => ({ db: ctx.deps.db, now: ctx.deps.now });

const isoDate = z.iso.date();
const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const maybeUntrusted = (value: string | null) => (value ? untrusted(value) : null);
/** A ref label: no brackets, pipes or line breaks, at most REF_LABEL_MAX characters. */
const label = (value: string) =>
	Array.from(value.replace(/[[\]|\n]/g, ' '))
		.slice(0, REF_LABEL_MAX)
		.join('')
		.trim();
const exerciseRef = (e: Pick<ExerciseDef, 'id' | 'name'>): SourceRef => ({
	type: 'exercise',
	id: e.id,
	label: label(e.name)
});
const preferenceRef = (id: string, name?: string): SourceRef => ({
	type: 'preference',
	id,
	...(name && label(name) && { label: label(name) })
});

// ---- get_training_preferences -----------------------------------------------------------

const preferenceSchema = z.object({
	source: sourceRefSchema,
	/** The owner's words for the exercise. */
	exercise: untrustedSchema,
	/** The library exercise they name; null when nothing matched. */
	exerciseId: z.nullable(z.string()),
	/** Where it was recorded: onboarding, profile, swap, coach… */
	origin: z.nullable(z.string()),
	reason: z.nullable(untrustedSchema)
});

const preferencesOutput = z.object({
	likes: z.array(preferenceSchema),
	dislikes: z.array(preferenceSchema),
	goals: z.array(
		z.object({
			source: sourceRefSchema,
			goalId: z.string(),
			/** 1 = top priority. */
			rank: z.int(),
			title: untrustedSchema,
			kind: z.string(),
			status: z.string(),
			eventDate: z.nullable(isoDate),
			targetDate: z.nullable(isoDate)
		})
	),
	equipment: z.array(
		z.object({ source: sourceRefSchema, name: z.string(), where: z.enum(['gym', 'home']) })
	),
	injuries: z.array(
		z.object({
			source: sourceRefSchema,
			area: z.string(),
			side: z.nullable(z.string()),
			severity: z.string(),
			note: z.nullable(untrustedSchema)
		})
	),
	avoid: z.array(
		z.object({ source: sourceRefSchema, movement: untrustedSchema, reason: z.string() })
	),
	schedule: z.object({
		daysPerWeek: z.nullable(z.int()),
		availableDays: z.array(z.string()),
		preferredTimes: z.array(z.string()),
		sessionMinutes: z.nullable(z.int()),
		constraints: z.nullable(untrustedSchema),
		commitments: z.array(
			z.object({
				label: untrustedSchema,
				discipline: z.string(),
				days: z.array(z.string()),
				timeOfDay: z.nullable(z.string()),
				durationMinutes: z.nullable(z.int()),
				intensity: z.nullable(z.string())
			})
		)
	}),
	/** Pain reported in workouts over the window: never a preference, but what to be careful of. */
	painReports: z.object({
		days: z.int(),
		items: z.array(
			z.object({
				source: sourceRefSchema,
				date: isoDate,
				exercise: z.nullable(z.string()),
				area: z.nullable(z.string()),
				severity: z.nullable(z.string()),
				action: z.string(),
				note: z.nullable(untrustedSchema)
			})
		)
	})
});

const preferenceOut = (p: ExercisePreference) => ({
	source: preferenceRef(p.id, p.exercise),
	exercise: untrusted(p.exercise),
	exerciseId: p.exerciseId ?? null,
	origin: p.source ?? null,
	reason: maybeUntrusted(p.reason)
});

const getTrainingPreferencesTool = defineTool({
	name: 'get_training_preferences',
	description: `The owner's training preferences: exercise likes and dislikes (where each was recorded and why), open goals by rank with their goalId (what update_training_goals takes), equipment at the gym and at home, active injuries and the movements they say to avoid, the weekly schedule and fixed commitments, and the pain they reported in workouts over the last days (painReports.days), newest first, up to ${PREFERENCE_PAIN_REPORTS}. A pain report is not a preference: it says what to be careful with.`,
	input: z.object({}),
	output: preferencesOutput,
	run: async (_input, ctx: Ctx) => {
		// One read at a time: the services may hold a transaction (docs/architecture.md).
		const preferences = await listExercisePreferences(ctx.ownerId, deps(ctx));
		const goals = await listGoals(ctx.ownerId, deps(ctx));
		const equipment = await getEquipment(ctx.ownerId, deps(ctx));
		const injuries = (await getInjuries(ctx.ownerId, deps(ctx))).filter((i) => i.active);
		const schedule = await getSchedule(ctx.ownerId, deps(ctx));
		const pain = await listRecentPainReports(
			ctx.ownerId,
			{ today: ctx.today, limit: PREFERENCE_PAIN_REPORTS },
			deps(ctx)
		);
		const injuryRef = (id: string) => preferenceRef(`injury.${id}`);
		return {
			likes: preferences.filter((p) => p.sentiment === 'like').map(preferenceOut),
			dislikes: preferences.filter((p) => p.sentiment === 'dislike').map(preferenceOut),
			goals: goals
				.filter((g) => g.priority !== null)
				.map((g) => ({
					source: { type: 'goal' as const, id: g.id, label: label(g.title) },
					goalId: g.id,
					rank: g.priority!,
					title: untrusted(g.title),
					kind: g.kind,
					status: g.status,
					eventDate: g.eventDate,
					targetDate: g.targetDate
				})),
			equipment: EQUIPMENT.filter(
				(key) => equipment?.equipment.includes(key) || equipment?.homeEquipment.includes(key)
			).map((key) => ({
				source: preferenceRef(`equipment.${key}`, EQUIPMENT_LABEL[key]),
				name: EQUIPMENT_LABEL[key],
				where: equipment!.equipment.includes(key) ? ('gym' as const) : ('home' as const)
			})),
			injuries: injuries.map((i) => ({
				source: injuryRef(i.id),
				area: i.bodyArea,
				side: i.side,
				severity: i.severity,
				note: maybeUntrusted(i.notes)
			})),
			avoid: injuries.flatMap((i) =>
				i.avoid.map((movement) => ({
					source: injuryRef(i.id),
					movement: untrusted(movement),
					reason: `${BODY_AREA_LABEL[i.bodyArea] ?? i.bodyArea} injury`
				}))
			),
			schedule: {
				daysPerWeek: schedule.daysPerWeek,
				availableDays: [...schedule.availableDays],
				preferredTimes: [...schedule.preferredTimes],
				sessionMinutes: schedule.sessionMinutes,
				constraints: maybeUntrusted(schedule.constraints),
				commitments: schedule.commitments.map((c) => ({
					label: untrusted(c.label),
					discipline: c.discipline,
					days: [...c.days],
					timeOfDay: c.timeOfDay,
					durationMinutes: c.durationMinutes,
					intensity: c.intensity
				}))
			},
			painReports: {
				days: MEMORY_RECORD_DAYS,
				items: pain.map((p) => ({
					source: p.source,
					date: p.date,
					exercise: p.exercise,
					area: p.area,
					severity: p.severity,
					action: p.action,
					note: maybeUntrusted(p.note)
				}))
			}
		};
	}
});

// ---- update_exercise_preferences --------------------------------------------------------

const updatePreferenceOutput = z.object({
	/** recorded: saved now, on the owner's own words; proposed: waiting for the owner. */
	outcome: z.enum(['recorded', 'proposed']),
	exercise: z.object({ source: sourceRefSchema, exerciseId: z.string(), name: z.string() }),
	sentiment: z.enum(SENTIMENTS),
	/** The recorded preference and the decision note quoting the owner; null when proposed. */
	recorded: z.nullable(
		z.object({
			preference: sourceRefSchema,
			decision: sourceRefSchema,
			ownerWords: untrustedSchema
		})
	),
	proposal: z.nullable(proposalOutput)
});

/** recordExercisePreference's not-found, as the tool's; anything else as it is. */
const notFound = (error: unknown) =>
	error instanceof TrainingNotFoundError
		? toolError('NOT_FOUND', 'You have no exercise with that id')
		: error;

const sentimentOpposite = (sentiment: (typeof SENTIMENTS)[number]) =>
	sentiment === 'like' ? 'dislike' : 'like';

/** The one exercise `name` means, or AMBIGUOUS asking the owner: never a guess. */
async function exerciseNamed(ctx: Ctx, name: string): Promise<ExerciseDef> {
	try {
		return await resolveExercise(ctx, name);
	} catch (error) {
		if (error instanceof ToolError && error.code === 'AMBIGUOUS')
			throw toolError(
				'AMBIGUOUS',
				'That name does not match one exercise. Ask the owner which one they mean; never pick one for them',
				{ ...error.details }
			);
		throw error;
	}
}

const updateExercisePreferencesTool = defineTool({
	name: 'update_exercise_preferences',
	description: `Record that the owner likes or dislikes an exercise (named by its exerciseId from an earlier result, or by its name), so the program never prescribes a dislike again. It is saved at once only when the owner's own message in this turn says so about that exercise ("I hate Bulgarian split squats"); otherwise it is stored as a proposal the owner accepts. Refused (SITUATIONAL) when the owner described today's situation (the machine is taken, no time today): use substitute_exercise with scope session instead. A name that matches no single exercise is AMBIGUOUS: ask the owner which one. reason is the owner's reason, up to ${PREFERENCE_REASON_MAX} characters; title up to ${TITLE_MAX}; rationale says why, up to ${RATIONALE_MAX}.`,
	input: z.object({
		exercise: text(100),
		sentiment: z.enum(SENTIMENTS),
		reason: z.optional(text(PREFERENCE_REASON_MAX)),
		title: text(TITLE_MAX),
		rationale: text(RATIONALE_MAX)
	}),
	output: updatePreferenceOutput,
	run: async ({ exercise: name, sentiment, reason, title, rationale }, ctx: Ctx) => {
		const exercise = await exerciseNamed(ctx, name);
		const key = exercise.key ?? `custom:${exercise.id}`;
		// Only the owner's stored message of this turn: never a tool result or stored text.
		const said = classifyExerciseStatement(ctx.ownerText, [], (words) =>
			ctx.matchExercise(words)
		).find((s) => s.exercise === key);
		const base = {
			exercise: { source: exerciseRef(exercise), exerciseId: exercise.id, name: exercise.name },
			sentiment
		};
		if (said?.kind === 'situational')
			throw toolError(
				'SITUATIONAL',
				'The owner described today’s situation, not a preference: nothing was stored. Use substitute_exercise with scope session for this workout',
				{ ownerWords: untrusted(said.quote) }
			);
		if (said && said.kind === sentimentOpposite(sentiment))
			throw toolError(
				'CONTRADICTS_OWNER',
				`The owner said they ${said.kind} this exercise: nothing was stored`,
				{ ownerWords: untrusted(said.quote) }
			);
		if (said?.kind === sentiment) {
			const ownerWords = Array.from(said.quote).slice(0, OWNER_WORDS_MAX).join('').trim();
			const { preference, note } = await service(() =>
				inTransaction(ctx.deps, async (tx) => {
					// The note first: it proves the owner and the run are the session's before anything
					// is written, and the transaction undoes it if the preference is refused.
					const decision = await recordCoachDecision(
						ctx.ownerId,
						{
							decision: {
								kind: 'preference_update',
								what: title,
								why: rationale,
								proposalId: null,
								ownerWords
							},
							subjects: [exerciseRef(exercise)],
							runId: ctx.runId
						},
						tx
					);
					const recorded = await recordExercisePreference(
						ctx.ownerId,
						{ exerciseId: exercise.id, sentiment, reason: reason ?? null, source: 'coach' },
						tx
					).catch((error: unknown) => {
						throw notFound(error);
					});
					return { preference: recorded, note: decision };
				})
			);
			return {
				...base,
				outcome: 'recorded' as const,
				recorded: {
					preference: preferenceRef(preference.id, preference.exercise),
					decision: { type: 'note' as const, id: note.id },
					ownerWords: untrusted(ownerWords)
				},
				proposal: null
			};
		}
		const payload = { exerciseId: exercise.id, sentiment, reason: reason ?? null };
		const proposal = { kind: 'preference_update', title, rationale, payload };
		const created = await propose(ctx, proposal, { statement: said?.kind ?? 'none' });
		return {
			...base,
			outcome: 'proposed' as const,
			recorded: null,
			proposal: proposalOut(created)
		};
	}
});

// ---- update_training_goals --------------------------------------------------------------

/** Every goal id the ops name. */
const goalIdsOf = (ops: readonly GoalOp[]) =>
	ops.flatMap((op) => (op.op === 'reorder' ? op.ids : op.op === 'add' ? [] : [op.goalId]));

const updateTrainingGoalsTool = defineTool({
	name: 'update_training_goals',
	description: `Propose a change to the owner's goals: add one, edit one, change its status, or reorder the open goals (ids lists every open goal, top priority first; goalIds come from get_training_preferences). It is stored as a proposal the owner accepts or rejects, so nothing changes yet. title up to ${TITLE_MAX} characters; rationale says why, up to ${RATIONALE_MAX}.`,
	input: proposalDraftSchema('goal_update'),
	output: z.object({ proposal: proposalOutput }),
	// Its ops union alone has 20 optional and 21 union-typed parameters, past the API's caps for a
	// whole request (16 unions): strict, it fails every request. zod checks the input instead.
	strict: false,
	run: async ({ title, rationale, payload }, ctx: Ctx) => {
		// Someone else's or an unknown goal is NOT_FOUND, before anything is stored.
		const own = new Set((await listGoals(ctx.ownerId, deps(ctx))).map((g) => g.id));
		const missing = goalIdsOf(payload.ops).find((id) => !own.has(id));
		if (missing) throw toolError('NOT_FOUND', 'You have no goal with that id', { goalId: missing });
		const proposal = { kind: 'goal_update', title, rationale, payload };
		const created = await propose(ctx, proposal, { ops: payload.ops.length });
		return { proposal: proposalOut(created) };
	}
});

export const PREFERENCE_TOOLS: readonly CoachTool[] = [
	getTrainingPreferencesTool,
	updateExercisePreferencesTool,
	updateTrainingGoalsTool
];
