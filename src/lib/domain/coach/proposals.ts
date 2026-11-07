/**
 * What the coach may propose (PRD §14): one zod/mini schema per proposal kind. The same schema is
 * the drafter's output format or the propose tool's input, the check before a proposal is stored
 * and the check again when the owner accepts it (accept re-parses the stored payload by id).
 *
 * Every payload is built on the rules the owner's own edits already pass, never a second copy:
 * - program_adjustment and workout_update carry M3's program edits (domain/training/edits.ts),
 *   each as an op tagged with its kind;
 * - session_substitution has M4's substitution fields and reasons (training/schemas.ts);
 * - goal_update carries M2's goal schemas, and preference_update M2's like or dislike;
 * - new_program names what M3's preview showed (services/programming), by its fingerprint;
 * - next_cycle is a brief for M6's cycle review, with M3's week targets and vocabulary.
 *
 * Every object is closed: a key the schema does not name is refused, not dropped, so a payload
 * means exactly what was checked and its JSON Schema states additionalProperties: false. What
 * needs the owner's data (dates, ids, dislikes, eligibility) is ./proposal-rules.ts.
 *
 * Server-only: imported by path, never through ./index.ts (scripts/coach-index-imports.test.ts).
 * It never imports domain/exercises or domain/programming at runtime, so payloadHash carries its
 * own copy of M3's canonical JSON and FNV-1a (programming/random.ts), and NEW_PROGRAM_STARTS
 * copies services/programming's starts; services/programming/proposal-alignment.test.ts pins
 * them to the originals.
 */
import * as z from 'zod/mini';
import { GOAL_STATUSES } from '../profile/catalog.ts';
import {
	eventGoalSchema,
	exercisePreferenceSchema,
	generalGoalSchema,
	goalOrderSchema,
	goalSchema
} from '../profile/schemas.ts';
import {
	adjustDetailsSchema,
	adjustRunSegmentSchema,
	adjustSetSchema,
	moveSessionSchema,
	skipSessionSchema,
	swapSchema
} from '../training/edits.ts';
import {
	LOG_LIMITS,
	RECORD_LIMITS,
	runSegmentSchema,
	substitutionSchema,
	weekTargetsSchema
} from '../training/schemas.ts';
import { MUSCLE_GROUPS, PHASES } from '../training/vocabulary.ts';

export const PROPOSAL_KINDS = [
	'program_adjustment',
	'workout_update',
	'session_substitution',
	'new_program',
	'next_cycle',
	'goal_update',
	'preference_update'
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Stored beside each payload (coach_proposals.payload_version). Bump it when a payload changes. */
export const PAYLOAD_VERSION = 1;

/** The most changes one proposal carries: more is a new program, not an adjustment. */
export const MAX_PROPOSAL_OPS = 12;
export const TITLE_MAX = 80;
/** A rationale becomes each applied change's decision 'why', which M3 holds to 1,000. */
export const RATIONALE_MAX = 1000;
/** The longest next cycle the coach may brief: a marathon build fits. */
export const NEXT_CYCLE_MAX_WEEKS = 16;
/**
 * Decision (m5 plan open question 'M6 consumes accepted next_cycle proposals'): accepting a
 * next_cycle changes no program; it waits for M6's cycle review, which reads it. Change it here.
 */
export const NEXT_CYCLE_AWAITS = 'cycle_review';

/** A closed object: a key it does not name is refused, naming the key. */
const closed = <S extends z.core.$ZodLooseShape>(shape: S) =>
	z.strictObject(shape, {
		error: (issue) =>
			issue.code === 'unrecognized_keys' ? `Unknown field: ${issue.keys.join(', ')}` : undefined
	});
const uuid = (message: string) => z.uuid(message);
const text = (max: number, required: string) =>
	z
		.string(required)
		.check(z.trim(), z.minLength(1, required), z.maxLength(max, `Up to ${max} characters`));
const ops = <S extends z.ZodMiniType>(op: S) =>
	z
		.array(op, 'List the changes')
		.check(
			z.minLength(1, 'Propose at least one change'),
			z.maxLength(MAX_PROPOSAL_OPS, `Up to ${MAX_PROPOSAL_OPS} changes`)
		);
/** M3's edit as an op: its own fields and messages, tagged, and closed. */
const op = <K extends string, S extends z.core.$ZodLooseShape>(kind: K, schema: { shape: S }) =>
	closed({ op: z.literal(kind), ...schema.shape });

// ---- program edits ----------------------------------------------------------------------------

export const PROGRAM_OPS = [
	'move',
	'skip',
	'swap',
	'adjust_set',
	'adjust_run_segment',
	'adjust_details'
] as const;
export type ProgramOpKind = (typeof PROGRAM_OPS)[number];

export const programOpSchema = z.discriminatedUnion(
	'op',
	[
		op('move', moveSessionSchema),
		op('skip', skipSessionSchema),
		op('swap', swapSchema),
		op('adjust_set', adjustSetSchema),
		op('adjust_run_segment', adjustRunSegmentSchema),
		op('adjust_details', adjustDetailsSchema)
	],
	'Pick a change'
);
export type ProgramOp = z.output<typeof programOpSchema>;

/** Changes to the active program, from its base version; one version when accepted. */
const programAdjustment = closed({ ops: ops(programOpSchema) });
/** Today's workout before it starts: the same ops, on one session (proposal-rules). */
const workoutUpdate = closed({ ops: ops(programOpSchema) });

// ---- a substitution in one session ----------------------------------------------------------

const substitution = substitutionSchema.shape;

/** One exercise swapped in one session (M4's semantics): never a preference or a version. */
const sessionSubstitution = closed({
	/** The live workout's client id, when it has started. */
	workoutId: z.optional(uuid('Unknown workout')),
	sessionLineage: uuid('Unknown session'),
	plannedExerciseLineage: uuid('Unknown exercise'),
	position: z
		.int('Exercise 1 to 50')
		.check(
			z.minimum(LOG_LIMITS.position[0], 'Exercise 1 to 50'),
			z.maximum(LOG_LIMITS.position[1], 'Exercise 1 to 50')
		),
	fromExerciseId: substitution.fromExerciseId,
	toExerciseId: substitution.toExerciseId,
	reason: substitution.reason
}).check(
	z.refine((s) => s.fromExerciseId !== s.toExerciseId, {
		message: 'Pick a different exercise',
		path: ['toExerciseId']
	})
);

// ---- a new program --------------------------------------------------------------------------

/** services/programming/start.ts PROGRAM_STARTS, which buildProgram checks again. */
export const NEW_PROGRAM_STARTS = ['next_monday', 'this_week'] as const;
/** FNV-1a 64-bit as 16 hex digits, as M3's fingerprint and digest are written. */
const hash = z.string('Preview again').check(z.regex(/^[0-9a-f]{16}$/, 'Preview again'));

/** What M3's preview showed, so accepting builds exactly that program or nothing. */
const newProgram = closed({
	start: z.enum(NEW_PROGRAM_STARTS, 'Pick when to start'),
	startsOn: z.iso.date('Use a real date'),
	firstPlannedDay: z.iso.date('Use a real date'),
	fingerprint: hash,
	/** The library digest: buildProgram's request names it beside the fingerprint. */
	digest: hash
});

// ---- the next cycle -------------------------------------------------------------------------

export const CYCLE_ENDINGS = ['none', 'deload', 'taper'] as const;

const exerciseId = uuid('Pick an exercise');
const WEEKLY_METRES = `1 m to ${RECORD_LIMITS.metres / 1000} km a week`;

/** The block after `fromBlockLineage`, as a brief: M6's cycle review plans its weeks. */
const nextCycle = closed({
	fromBlockLineage: uuid('Unknown block'),
	focus: text(200, 'Say what the cycle is for'),
	phase: z.enum(PHASES, 'Pick a phase'),
	weeks: z
		.int(`1 to ${NEXT_CYCLE_MAX_WEEKS} weeks`)
		.check(
			z.minimum(1, `1 to ${NEXT_CYCLE_MAX_WEEKS} weeks`),
			z.maximum(NEXT_CYCLE_MAX_WEEKS, `1 to ${NEXT_CYCLE_MAX_WEEKS} weeks`)
		),
	/** Muscle groups to bias volume toward. */
	emphasis: z.array(z.enum(MUSCLE_GROUPS, 'Pick a muscle group')).check(
		z.maxLength(MUSCLE_GROUPS.length, 'Too many muscle groups'),
		z.refine((all) => new Set(all).size === all.length, 'Each one once')
	),
	targets: closed(weekTargetsSchema.shape),
	/** Exercises to rotate out, each with what replaces it. */
	rotation: z
		.array(
			closed({ fromExerciseId: exerciseId, toExerciseId: exerciseId }).check(
				z.refine((r) => r.fromExerciseId !== r.toExerciseId, {
					message: 'Pick a different exercise',
					path: ['toExerciseId']
				})
			)
		)
		.check(z.maxLength(MAX_PROPOSAL_OPS, `Up to ${MAX_PROPOSAL_OPS} swaps`)),
	running: z.nullable(
		closed({
			weeklyMetres: z.nullable(
				z
					.int(WEEKLY_METRES)
					.check(z.minimum(1, WEEKLY_METRES), z.maximum(RECORD_LIMITS.metres, WEEKLY_METRES))
			),
			longRunMetres: runSegmentSchema.shape.distanceMetres
		})
	),
	ending: z.enum(CYCLE_ENDINGS, 'Deload, taper or neither?'),
	constraints: z
		.array(text(200, 'Say what to respect'))
		.check(z.maxLength(10, 'Up to 10 constraints'))
});

// ---- goals and preferences ------------------------------------------------------------------

/** As M2's own cross-field goal rules run: even when a field failed, so every problem shows. */
const ALWAYS = {
	when: (payload: { value: unknown }) => typeof payload.value === 'object' && payload.value !== null
};

/**
 * M2's goal, closed: its two kinds with their fields and messages, then goalSchema itself, so a
 * rule M2 adds to goals holds here too.
 */
const goal = z
	.discriminatedUnion(
		'kind',
		[closed(eventGoalSchema.shape), closed(generalGoalSchema.shape)],
		'Pick an event or a general goal'
	)
	.check(
		z.superRefine((value, ctx) => {
			const parsed = z.safeParse(goalSchema, value);
			if (parsed.success) return;
			for (const issue of parsed.error.issues) {
				ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path, input: value });
			}
		}, ALWAYS)
	);

const goalId = uuid('Unknown goal');

export const goalOpSchema = z.discriminatedUnion(
	'op',
	[
		closed({ op: z.literal('add'), goal }),
		closed({ op: z.literal('edit'), goalId, goal }),
		closed({
			op: z.literal('set_status'),
			goalId,
			status: z.enum(GOAL_STATUSES, 'Pick a status')
		}),
		closed({ op: z.literal('reorder'), ids: goalOrderSchema.shape.ids })
	],
	'Pick a change'
);
export type GoalOp = z.output<typeof goalOpSchema>;

const goalUpdate = closed({ ops: ops(goalOpSchema) });

/** One like or dislike of a library exercise, recorded with source 'coach'. */
const preferenceUpdate = closed({
	exerciseId,
	sentiment: exercisePreferenceSchema.shape.sentiment,
	reason: exercisePreferenceSchema.shape.reason
});

// ---- the proposal ---------------------------------------------------------------------------

export const PAYLOAD_SCHEMAS = {
	program_adjustment: programAdjustment,
	workout_update: workoutUpdate,
	session_substitution: sessionSubstitution,
	new_program: newProgram,
	next_cycle: nextCycle,
	goal_update: goalUpdate,
	preference_update: preferenceUpdate
} as const satisfies Record<ProposalKind, z.ZodMiniType>;

type Payloads = typeof PAYLOAD_SCHEMAS;
export type ProposalPayload<K extends ProposalKind = ProposalKind> = z.output<Payloads[K]>;

const title = text(TITLE_MAX, 'Give it a title');
const rationale = text(RATIONALE_MAX, 'Say why');

const draft = <K extends ProposalKind>(kind: K) =>
	closed({ title, rationale, payload: PAYLOAD_SCHEMAS[kind] });

/** What the drafter writes, or a propose tool takes, for a kind it already knows. */
export function proposalDraftSchema<K extends ProposalKind>(kind: K) {
	return draft(kind);
}
export type ProposalDraft<K extends ProposalKind = ProposalKind> = z.output<
	ReturnType<typeof draft<K>>
>;

const proposal = <K extends ProposalKind>(kind: K) =>
	closed({ kind: z.literal(kind), ...draft(kind).shape });

/** A whole proposal, as stored and as accept re-parses it. */
export const proposalSchema = z.discriminatedUnion(
	'kind',
	[
		proposal('program_adjustment'),
		proposal('workout_update'),
		proposal('session_substitution'),
		proposal('new_program'),
		proposal('next_cycle'),
		proposal('goal_update'),
		proposal('preference_update')
	],
	'Unknown proposal kind'
);
export type Proposal = z.output<typeof proposalSchema>;

// ---- the payload hash -----------------------------------------------------------------------

/** FNV-1a 64-bit over UTF-8, as two 32-bit halves (M3's programming/random.ts). */
function fnv1a64(text: string): string {
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (const byte of new TextEncoder().encode(text)) {
		lo = (lo ^ byte) >>> 0;
		const low = lo * 0x1b3;
		hi = (Math.imul(hi, 0x1b3) + Math.floor(low / 2 ** 32) + (lo << 8)) >>> 0;
		lo = low >>> 0;
	}
	return [hi, lo].map((half) => half.toString(16).padStart(8, '0')).join('');
}

/** Plain data as JSON with keys in code-unit order; anything else throws (M3's canonicalJson). */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const fields = Object.entries(value)
			.filter(([, field]) => field !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
		return `{${fields.join(',')}}`;
	}
	throw new TypeError(`Not plain data: ${String(value)}`);
}

/** coach_proposals.payload_hash: the same payload is the same hash, whatever its key order. */
export function payloadHash(payload: unknown): string {
	return fnv1a64(canonicalJson(payload));
}
