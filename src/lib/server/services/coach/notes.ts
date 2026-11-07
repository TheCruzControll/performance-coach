/**
 * Coach notes (M5, PRD §4): what the coach writes down to remember, which memory reads instead of
 * replaying a chat. Notes are insert-only.
 *
 * - saveNote validates a note's body against its kind's schema (domain/coach/notes.ts), its
 *   summary and the records it names, and stores it.
 * - recordCoachDecision writes a coach_decision: a change to the owner's goals or preferences and
 *   why, resting on an accepted proposal or on the owner's own words.
 * - saveWorkoutAnalysis writes the coach's analysis of one of the owner's workouts.
 * - latestNotes reads the owner's newest notes of one kind.
 *
 * Every function is owner-scoped: an owner that does not exist, or a run or workout that is not
 * the owner's, is CoachNotFoundError and nothing is written. Input the caller can fix is a
 * CoachInputError naming the field at fault; nothing is written either.
 */
import {
	isNoteKind,
	NOTE_BODY_SCHEMAS,
	noteSubjectsSchema,
	type CoachDecision,
	type NoteBody,
	type NoteKind,
	type WorkoutAnalysis
} from '../../../domain/coach/notes';
import type { SourceRef } from '../../../domain/coach/sources';
import { validate } from '../../../domain/validation';
import { createCoachNotesRepository, type NoteRow } from '../../db/repositories/coach-notes';
import { NOTE_SUMMARY_MAX } from '../../db/schema/coach';
import { isUuid } from '../ids';
import { CoachInputError, CoachNotFoundError, resolveDeps, type CoachDeps } from './shared';

/** Notes per read: the default and the most a caller may ask for. */
export const NOTES_PAGE = Object.freeze({ default: 5, max: 20 });

export interface CoachNote<K extends NoteKind = NoteKind> {
	id: string;
	kind: K;
	subjects: SourceRef[];
	body: NoteBody<K>;
	summary: string;
	runId: string | null;
	createdAt: Date;
}

export interface NewNote<K extends NoteKind = NoteKind> {
	kind: K;
	/** Checked against the kind's schema. */
	body: unknown;
	/** The note in a few sentences, as memory shows it. */
	summary: string;
	/** The records it is about. */
	subjects?: readonly SourceRef[];
	/** What the coach read to write it. */
	evidence?: Record<string, unknown> | null;
	/** The run that wrote it; none for a note written outside a conversation. */
	runId?: string | null;
}

const toNote = (row: NoteRow) => row as CoachNote;

/** At most `max` characters (code points, as Postgres counts them), ending in '…' when cut. */
function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** The first problem with `input` against `schema`, as a CoachInputError at `prefix`. */
function parse<T>(
	result: { ok: true; data: T } | { ok: false; errors: Record<string, string> },
	prefix: string
): T {
	if (result.ok) return result.data;
	const [path, message] = Object.entries(result.errors)[0]!;
	throw new CoachInputError(path ? `${prefix}.${path}` : prefix, message);
}

/** Store one note for the owner, after checking everything about it. */
export async function saveNote<K extends NoteKind>(
	ownerId: string,
	input: NewNote<K>,
	deps: CoachDeps = {}
): Promise<CoachNote<K>> {
	if (!isNoteKind(input.kind)) throw new CoachInputError('kind', 'Unknown note kind');
	const kind: NoteKind = input.kind;
	const body = parse(validate(NOTE_BODY_SCHEMAS[kind], input.body), 'body');
	const summary = input.summary.trim();
	if (!summary) throw new CoachInputError('summary', 'Say what it is');
	if (Array.from(summary).length > NOTE_SUMMARY_MAX) {
		throw new CoachInputError('summary', `Up to ${NOTE_SUMMARY_MAX} characters`);
	}
	const subjects = parse(validate(noteSubjectsSchema, input.subjects ?? []), 'subjects');

	const runId = input.runId ?? null;
	const workoutId = kind === 'workout_analysis' ? (body as WorkoutAnalysis).workoutId : null;
	if (!isUuid(ownerId)) throw new CoachNotFoundError('owner');
	if (runId !== null && !isUuid(runId)) throw new CoachNotFoundError('run');
	const { db, now } = resolveDeps(deps);
	const repo = createCoachNotesRepository(db);
	const owned = await repo.ownership(ownerId, { runId, workoutId });
	if (!owned) throw new CoachNotFoundError('owner');
	if (!owned.workout) throw new CoachNotFoundError('workout');
	if (!owned.run) throw new CoachNotFoundError('run');
	const row = await repo.insertNote({
		ownerId,
		kind,
		subjects: subjects as SourceRef[],
		body: body as Record<string, unknown>,
		summary,
		evidence: input.evidence ?? null,
		runId,
		createdAt: now()
	});
	return toNote(row) as CoachNote<K>;
}

/** The owner's newest notes of one kind, newest first. */
export async function latestNotes<K extends NoteKind>(
	ownerId: string,
	kind: K,
	{ limit = NOTES_PAGE.default }: { limit?: number } = {},
	deps: CoachDeps = {}
): Promise<CoachNote<K>[]> {
	if (!isNoteKind(kind)) throw new CoachInputError('kind', 'Unknown note kind');
	if (!Number.isInteger(limit) || limit < 1 || limit > NOTES_PAGE.max) {
		throw new CoachInputError('limit', `1 to ${NOTES_PAGE.max} at a time`);
	}
	if (!isUuid(ownerId)) return [];
	const rows = await createCoachNotesRepository(resolveDeps(deps).db).latestNotes(
		ownerId,
		kind,
		limit
	);
	return rows.map(toNote) as CoachNote<K>[];
}

/**
 * Record a change the coach made to the owner's goals or preferences, and why, naming the
 * records it changed (and the proposal it applied, once).
 */
export function recordCoachDecision(
	ownerId: string,
	input: { decision: CoachDecision; subjects?: readonly SourceRef[]; runId?: string | null },
	deps: CoachDeps = {}
): Promise<CoachNote<'coach_decision'>> {
	const { decision } = input;
	const subjects = [...(input.subjects ?? [])];
	const proposalId = decision?.proposalId;
	if (proposalId && !subjects.some((s) => s.type === 'proposal' && s.id === proposalId)) {
		subjects.push({ type: 'proposal', id: proposalId });
	}
	const words = [decision?.what, decision?.why].map((s) => s?.trim()).filter(Boolean);
	return saveNote(
		ownerId,
		{
			kind: 'coach_decision',
			body: decision,
			summary: clip(words.join(': '), NOTE_SUMMARY_MAX),
			subjects,
			runId: input.runId
		},
		deps
	);
}

/** Save the coach's analysis of one of the owner's workouts. */
export function saveWorkoutAnalysis(
	ownerId: string,
	input: {
		analysis: WorkoutAnalysis;
		runId?: string | null;
		evidence?: Record<string, unknown> | null;
	},
	deps: CoachDeps = {}
): Promise<CoachNote<'workout_analysis'>> {
	const { analysis } = input;
	const words = [analysis?.headline, ...(analysis?.points ?? [])].map((s) => s?.trim());
	return saveNote(
		ownerId,
		{
			kind: 'workout_analysis',
			body: analysis,
			summary: clip(words.filter(Boolean).join(' '), NOTE_SUMMARY_MAX),
			subjects:
				typeof analysis?.workoutId === 'string'
					? [{ type: 'workout', id: analysis.workoutId }]
					: [],
			runId: input.runId,
			evidence: input.evidence
		},
		deps
	);
}
