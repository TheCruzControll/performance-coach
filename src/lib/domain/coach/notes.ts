/**
 * What a coach note holds (coach_notes.body), by its kind (the M5 plan's 'The only direct
 * writes'): services/coach/notes.ts validates every body against its kind's schema before it is
 * stored, so memory can read a note back without guessing its shape.
 *
 * - coach_decision: a change the coach made to the owner's goals or preferences, and why. It
 *   rests on an accepted proposal, or on the owner's own words in this turn (a direct preference
 *   write), and names at least one of them.
 * - workout_analysis: the coach's own analysis of one of the owner's workouts.
 *
 * Further kinds join NOTE_BODY_SCHEMAS with their schema (thread-summaries adds thread_summary).
 * Every object is closed: a key the schema does not name is refused, not dropped.
 *
 * Server-only: imported by path, never through ./index.ts (scripts/coach-index-imports.test.ts).
 */
import * as z from 'zod/mini';
import { PROPOSAL_KINDS, RATIONALE_MAX, TITLE_MAX } from './proposals.ts';
import { REF_ID_MAX, REF_LABEL_MAX, SOURCE_TYPES } from './sources.ts';

/** The most records one note names. */
export const NOTE_SUBJECTS_MAX = 20;
/** The longest quote of the owner's words a decision keeps (the turn's message is the record). */
export const OWNER_WORDS_MAX = 500;
export const ANALYSIS_HEADLINE_MAX = 200;
export const ANALYSIS_POINT_MAX = 300;
export const ANALYSIS_POINTS_MAX = 8;

const closed = <S extends z.core.$ZodLooseShape>(shape: S) =>
	z.strictObject(shape, {
		error: (issue) =>
			issue.code === 'unrecognized_keys' ? `Unknown field: ${issue.keys.join(', ')}` : undefined
	});
const text = (max: number, required: string) =>
	z
		.string(required)
		.check(z.trim(), z.minLength(1, required), z.maxLength(max, `Up to ${max} characters`));

/** A change the coach made, and why: an accepted proposal, or the owner's own words. */
export const coachDecisionSchema = closed({
	kind: z.enum(PROPOSAL_KINDS, 'Unknown change'),
	/** What changed, in a few words (the proposal's title). */
	what: text(TITLE_MAX, 'Say what changed'),
	why: text(RATIONALE_MAX, 'Say why'),
	proposalId: z.nullable(z.uuid('Unknown proposal')),
	/** The owner's statement it rests on, quoted as they wrote it. */
	ownerWords: z.nullable(text(OWNER_WORDS_MAX, 'Quote the owner'))
}).check(
	z.refine((d) => d.proposalId !== null || d.ownerWords !== null, {
		message: 'A decision rests on an accepted proposal or the owner’s own words',
		path: ['proposalId']
	})
);
export type CoachDecision = z.output<typeof coachDecisionSchema>;

/** The coach's analysis of one workout: a headline and the points behind it. */
export const workoutAnalysisSchema = closed({
	workoutId: z.uuid('Unknown workout'),
	headline: text(ANALYSIS_HEADLINE_MAX, 'Give it a headline'),
	points: z
		.array(text(ANALYSIS_POINT_MAX, 'Say something'), 'List what you found')
		.check(z.maxLength(ANALYSIS_POINTS_MAX, `Up to ${ANALYSIS_POINTS_MAX} points`))
});
export type WorkoutAnalysis = z.output<typeof workoutAnalysisSchema>;

export const NOTE_BODY_SCHEMAS = {
	coach_decision: coachDecisionSchema,
	workout_analysis: workoutAnalysisSchema
} as const satisfies Record<string, z.ZodMiniType>;
export type NoteKind = keyof typeof NOTE_BODY_SCHEMAS;
export const NOTE_KINDS = Object.keys(NOTE_BODY_SCHEMAS) as readonly NoteKind[];
export type NoteBody<K extends NoteKind = NoteKind> = z.output<(typeof NOTE_BODY_SCHEMAS)[K]>;

export function isNoteKind(value: unknown): value is NoteKind {
	return typeof value === 'string' && Object.hasOwn(NOTE_BODY_SCHEMAS, value);
}

/** The records a note is about (SourceRef, closed). */
export const noteSubjectsSchema = z
	.array(
		closed({
			type: z.enum(SOURCE_TYPES as [string, ...string[]], 'Unknown record type'),
			id: text(REF_ID_MAX, 'Name the record'),
			label: z.optional(text(REF_LABEL_MAX, 'Label it')),
			date: z.optional(z.iso.date('Not a date')),
			workoutId: z.optional(z.uuid('Unknown workout'))
		}),
		'List what it is about'
	)
	.check(z.maxLength(NOTE_SUBJECTS_MAX, `Up to ${NOTE_SUBJECTS_MAX} records`));
