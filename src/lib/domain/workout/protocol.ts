/**
 * The sync protocol (wire format v1; the offline workout sync ADR): POST /api/workouts/sync takes
 * a SyncRequest and answers a SyncResponse, one result per mutation in request order, and
 * GET /api/workouts/[id] answers a CanonicalWorkout and GET /api/workouts/active the workouts in
 * progress (ActiveWorkouts). Rows are keyed by client ids.
 */
import type { Discipline } from '../profile/catalog.ts';
import type { SessionKind } from '../training/types.ts';
import type * as v from '../training/vocabulary.ts';
import type { FieldErrors } from '../validation.ts';
import type {
	OtherFields,
	PainReport,
	Mutation,
	RunFields,
	RunSegmentFields,
	SetPlace,
	Substitution,
	WorkoutFields
} from './mutations.ts';
import type { ExerciseSummary, Instant, LoggedSet, WorkoutStatus } from './types.ts';

/**
 * A batch is at most 25 mutations and 64 KB, so a request stays bounded however long the device
 * was offline. The pagehide keepalive batch stops at 48 KB: RUM's sendBeacon shares the page's
 * 64 KB keepalive quota.
 */
export const SYNC_LIMITS = { maxMutations: 25, maxBytes: 64 * 1024, keepaliveBytes: 48 * 1024 };

/** Up to SYNC_LIMITS.maxMutations mutations, in outbox order, and as many discarded ids. */
export interface SyncRequest {
	v: 1;
	mutations: Mutation[];
	/**
	 * Ids the owner discarded after a request carrying them may have reached the server: claimed
	 * before any mutation, so that request answers 'duplicate' and never lands them late.
	 */
	discarded?: string[];
	/**
	 * The workouts whose rows the device already holds: each of their results carries only the
	 * rows the batch's changes name (`changes`, changes.ts), not the whole workout.
	 */
	held?: string[];
}

/**
 * - applied: done now, in its own transaction, with its ledger row
 * - duplicate: its id was applied before; nothing is applied again
 * - rejected: refused for good, with no ledger row, so Fix re-sends it under the same id
 * - deferred: its target has not arrived; it is sent again later
 * - retry: a transient failure, which stops the batch
 */
export const SYNC_STATUSES = ['applied', 'duplicate', 'rejected', 'deferred', 'retry'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Why a mutation was rejected, deferred or retried. Clients act on the status alone. */
export const SYNC_CODE_LABEL = {
	invalid: 'A value is not valid',
	forbidden: 'Not your workout or exercise',
	deleted: 'Deleted on another device',
	unsupported: 'This change is not supported yet',
	missing: 'Waiting for an earlier change',
	blocked: 'Waiting for an earlier change to the same item',
	unavailable: 'The server is busy'
};
export type SyncCode = keyof typeof SYNC_CODE_LABEL;

export interface SyncResult {
	/** The mutation's id. */
	id: string;
	status: SyncStatus;
	/** The workout's rows afterwards, on the last applied or duplicate result of each workout. */
	canonical?: CanonicalWorkout;
	/**
	 * Instead of `canonical`, for a workout the request says the device holds (held): only the
	 * rows the batch's applied and duplicate changes name, with the workout row (changes.ts).
	 */
	changes?: CanonicalWorkout;
	/** rejected: field errors keyed by dotted path under `payload.`, as 'payload.weight'. */
	errors?: FieldErrors;
	code?: SyncCode;
}

export interface SyncResponse {
	v: 1;
	results: SyncResult[];
}

// ---- The canonical workout ------------------------------------------------------------------

/** A soft-deleted row stays, with its deletion time: a tombstone a replayed create cannot undo. */
interface Tombstone {
	deletedAt: Instant | null;
}

export interface CanonicalWorkoutRow extends WorkoutFields, Tombstone {
	/** workouts.client_id: workout.start's id. */
	id: string;
	kind: SessionKind;
	title: string;
	sessionType: v.SessionType;
	discipline: Discipline;
	plannedSessionId: string | null;
	plannedLineage: string | null;
	programId: string | null;
	status: WorkoutStatus;
	startedAt: Instant;
	finishedAt: Instant | null;
}

export interface CanonicalSet extends SetPlace, LoggedSet, Tombstone {
	/** set_records.client_mutation_id: its set.log's or set.skip's id. */
	id: string;
	isSkipped: boolean;
	/** M3's setE1rm in kg; null where none applies. */
	e1rmKg: number | null;
	performedAt: Instant;
}

export interface CanonicalSubstitution extends Substitution, Tombstone {
	id: string;
}

export interface CanonicalPainReport extends PainReport, Tombstone {
	id: string;
	reportedAt: Instant;
}

export interface CanonicalSegment extends RunSegmentFields {
	id: string;
	paceSecondsPerKm: number | null;
}

export interface CanonicalRun extends RunFields {
	paceSecondsPerKm: number | null;
	segments: CanonicalSegment[];
}

export type CanonicalOther = OtherFields;

/** Everything the server holds for a workout, enough to render it on a device with no kit. */
export interface CanonicalWorkout {
	v: 1;
	workout: CanonicalWorkoutRow;
	sets: CanonicalSet[];
	substitutions: CanonicalSubstitution[];
	pain: CanonicalPainReport[];
	run: CanonicalRun | null;
	other: CanonicalOther | null;
	/** Every exercise a row names, custom ones included. */
	exercises: Record<string, ExerciseSummary>;
}

// ---- Workouts in progress -------------------------------------------------------------------

/** A workout in progress, as GET /api/workouts/active lists it to offer 'Continue here'. */
export type ActiveWorkout = Pick<
	CanonicalWorkoutRow,
	| 'id'
	| 'kind'
	| 'title'
	| 'sessionType'
	| 'discipline'
	| 'plannedSessionId'
	| 'plannedLineage'
	| 'programId'
	| 'startedAt'
>;

/** The owner's workouts in progress, newest first. */
export interface ActiveWorkouts {
	v: 1;
	workouts: ActiveWorkout[];
}
