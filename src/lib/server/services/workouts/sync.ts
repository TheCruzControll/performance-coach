/**
 * The sync dispatcher behind POST /api/workouts/sync (the offline workout sync ADR, 'Exactly
 * once'): the one server entry point the outbox flushes to. A batch of at most 25 mutations is
 * applied in request order, each in its own transaction:
 *
 * 1. Validate its envelope and payload (domain/workout/schemas.ts): refused at dotted paths.
 * 2. Claim its id in the ledger (sync_mutations) first in its transaction. 'seen' means it was
 *    applied before: nothing is applied again, and it is answered 'duplicate'.
 * 3. Apply it through M3's write services (apply/*), which address rows by client id and check
 *    the exercise's load type with logging-rules' checkSet, given the transaction as deps.db and
 *    'owner' as the audit actor.
 * 4. Answer its status; the last applied or duplicate result of each workout carries the
 *    workout's canonical rows, read once the batch is done.
 *
 * - Rejected, deferred and retried mutations roll their transaction back, so they leave no ledger
 *   row: a corrected payload re-sent under the same id applies.
 * - A mutation whose row is missing is deferred ('missing'); one whose row is another owner's is
 *   rejected ('forbidden'). Once a mutation is refused or deferred, every later one in the batch
 *   that depends on it (its row's, its workout's, the contract's dependsOn) is deferred
 *   ('blocked'), so one row's changes never apply out of order.
 * - Any other error (the database, a bug) stops the batch: the mutations already answered keep
 *   their results and the rest are answered 'retry'. When nothing was answered yet, the whole
 *   request fails with SyncUnavailableError (503), and nothing is half-applied because each
 *   mutation is its own transaction.
 * - Strictly sequential: one transaction at a time, each query awaited in turn (#62).
 * - Core logging never reaches the agent or an LLM (eslint.config.js, 'Core workout logging').
 */
import { Buffer } from 'node:buffer';
import * as z from 'zod/mini';
import {
	dependsOn,
	SYNC_LIMITS,
	type Mutation,
	type MutationType,
	type SyncResponse,
	type SyncResult
} from '../../../domain/workout/index';
import { envelopeSchema } from '../../../domain/workout/schemas';
import { validate, type FieldErrors } from '../../../domain/validation';
import { claimMutation, createSyncRepository } from '../../db/repositories/sync';
import { createWorkoutSyncRepository } from '../../db/repositories/workout-sync';
import type { Executor } from '../../db/types';
import { logger } from '../../observability/logger';
import { getExercisesByIds } from '../exercises/index';
import { TrainingLogConflictError } from '../training/log';
import {
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type ResolvedTrainingDeps
} from '../training/shared';
import { exerciseIdsOf, toCanonicalWorkout } from './dto';
import { exerciseHandlers } from './apply/exercises';
import { UnsupportedMutationError, type Handler, type Handlers } from './apply/handler';
import { otherHandlers } from './apply/other';
import { painHandlers } from './apply/pain';
import { runHandlers } from './apply/runs';
import { setHandlers } from './apply/sets';
import { structureHandlers } from './apply/structure';
import { workoutHandlers } from './apply/workout';

/** Every type's handler: a type without one fails pnpm check. */
const HANDLERS: Handlers<MutationType> = {
	...workoutHandlers,
	...setHandlers,
	...structureHandlers,
	...exerciseHandlers,
	...painHandlers,
	...runHandlers,
	...otherHandlers
};

export interface SyncDeps {
	db?: Executor;
	now?: () => Date;
	/** The request that applies the batch, recorded in the ledger to match the server's logs. */
	requestId?: string | null;
}

/** The database could not be reached, or failed, before any mutation was answered: 503. */
export class SyncUnavailableError extends Error {
	constructor(cause: unknown) {
		super('the sync batch could not start', { cause });
		this.name = 'SyncUnavailableError';
	}
}

// ---- The request ----------------------------------------------------------------------------

/**
 * The protocol, checked before any mutation: v1 and 1 to 25 mutations, each with a UUID id so its
 * result can name it. Each mutation's own shape is validated on its own, so one bad change is one
 * rejected result, not a refused batch.
 */
const protocolSchema = z.object({
	v: z.literal(1, 'Wire format v1'),
	mutations: z
		.array(z.looseObject({ id: z.uuid('Unknown id') }))
		.check(
			z.minLength(1, 'Nothing to sync'),
			z.maxLength(SYNC_LIMITS.maxMutations, `Up to ${SYNC_LIMITS.maxMutations} changes at once`)
		)
});

export type ParsedSyncBody =
	| { ok: true; mutations: Record<string, unknown>[] }
	| {
			ok: false;
			status: 400 | 413;
			error: 'too_large' | 'invalid_json' | 'invalid_request';
			errors?: FieldErrors;
	  };

/** A request body as sent: at most SYNC_LIMITS.maxBytes of UTF-8 JSON, in the protocol. */
export function parseSyncBody(text: string): ParsedSyncBody {
	if (Buffer.byteLength(text, 'utf8') > SYNC_LIMITS.maxBytes) {
		return { ok: false, status: 413, error: 'too_large' };
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, status: 400, error: 'invalid_json' };
	}
	const parsed = validate(protocolSchema, body);
	if (!parsed.ok)
		return { ok: false, status: 400, error: 'invalid_request', errors: parsed.errors };
	return { ok: true, mutations: parsed.data.mutations };
}

// ---- One mutation ---------------------------------------------------------------------------

/** The mutation id is in the ledger, but another owner's: never answered as this owner's. */
class ForeignMutationError extends Error {}

/** Where M3's service inputs name what the wire format names otherwise; the rest is payload's. */
const WIRE_PATH: Readonly<Record<string, string>> = {
	clientId: 'id',
	clientMutationId: 'id',
	workoutClientId: 'workoutId',
	exercisePosition: 'payload.position',
	plannedExerciseLineageId: 'payload.plannedLineage',
	plannedLineageId: 'payload.plannedLineage',
	startedAt: 'at',
	performedAt: 'at',
	finishedAt: 'at'
};

const wirePath = (path: string) => {
	const [head, ...rest] = path.split('.');
	const mapped = WIRE_PATH[head!];
	return mapped ? [mapped, ...rest].join('.') : `payload.${path}`;
};

const rejected = (m: { id: string }, code: SyncResult['code'], errors?: FieldErrors) =>
	({ id: m.id, status: 'rejected', code, ...(errors && { errors }) }) satisfies SyncResult;

/** Edits and deletes of a set name the set; everything else names its workout. */
const namesSet = (m: Mutation) => m.type === 'set.edit' || m.type === 'set.delete';

/**
 * A domain refusal as its result, or the error again when it is not one. A missing row is
 * deferred until it arrives, unless another owner holds that client id.
 */
async function refusalOf(m: Mutation, err: unknown, ownerId: string, db: Executor) {
	if (err instanceof UnsupportedMutationError) return rejected(m, 'unsupported');
	if (err instanceof TrainingLogConflictError) return rejected(m, 'deleted');
	if (err instanceof ForeignMutationError) return rejected(m, 'forbidden');
	if (err instanceof TrainingInputError) {
		const errors = Object.fromEntries(
			Object.entries(err.errors).map(([path, message]) => [wirePath(path), message])
		);
		// An id another owner's row already holds: create refusals name it 'Already used'.
		return 'id' in errors ? rejected(m, 'forbidden') : rejected(m, 'invalid', errors);
	}
	if (err instanceof TrainingNotFoundError) {
		const repo = createWorkoutSyncRepository(db);
		const holder = namesSet(m)
			? await repo.setOwner(m.entityId)
			: await repo.workoutOwner(m.workoutId);
		if (holder !== null && holder !== ownerId) return rejected(m, 'forbidden');
		return { id: m.id, status: 'deferred', code: 'missing' } satisfies SyncResult;
	}
	throw err;
}

async function applyOne(
	m: Mutation,
	ownerId: string,
	deps: ResolvedTrainingDeps,
	requestId: string | null
): Promise<SyncResult> {
	try {
		const status = await deps.db.transaction(async (tx) => {
			const claim = await claimMutation(tx, {
				mutationId: m.id,
				ownerId,
				type: m.type,
				entityId: m.entityId,
				workoutClientId: m.workoutId,
				clientAt: new Date(m.at),
				requestId
			});
			if (claim === 'seen') {
				const mine = await createSyncRepository(tx).appliedIn(ownerId, [m.id]);
				if (!mine.has(m.id)) throw new ForeignMutationError();
				return 'duplicate' as const;
			}
			const handler = HANDLERS[m.type] as Handler<MutationType>;
			await handler(m, { ownerId, deps: { ...deps, db: tx, source: 'owner' } });
			return 'applied' as const;
		});
		return { id: m.id, status };
	} catch (err) {
		return refusalOf(m, err, ownerId, deps.db);
	}
}

// ---- The batch ------------------------------------------------------------------------------

/** Whether `m` must wait for `held`, refused or deferred earlier in the batch. */
function waitsFor(m: Mutation, held: unknown): boolean {
	try {
		// A refused mutation may be malformed: what cannot be read blocks nothing.
		return dependsOn(m, held as Mutation);
	} catch {
		return false;
	}
}

async function canonicalOf(ownerId: string, workoutClientId: string, db: Executor) {
	const rows = await createWorkoutSyncRepository(db).canonicalRows(ownerId, workoutClientId);
	if (!rows) return null;
	const exercises = await getExercisesByIds(ownerId, exerciseIdsOf(rows), { db });
	return toCanonicalWorkout(rows, exercises);
}

/**
 * Apply a batch's mutations (parseSyncBody's) for the owner, in order, and answer one result per
 * mutation. Throws SyncUnavailableError when the first mutation already fails for a non-domain
 * reason.
 */
export async function applySyncBatch(
	ownerId: string,
	mutations: readonly Record<string, unknown>[],
	deps: SyncDeps = {}
): Promise<SyncResponse> {
	const resolved = resolveDeps({ db: deps.db, now: deps.now, source: 'owner' });
	const requestId = deps.requestId ?? null;
	const results: SyncResult[] = [];
	/** Workout client ids by result, for the canonical rows. */
	const workoutOf: string[] = [];
	const held: unknown[] = [];

	for (const [i, raw] of mutations.entries()) {
		const id = raw.id as string;
		const parsed = validate(envelopeSchema, raw);
		if (!parsed.ok) {
			results.push(rejected({ id }, 'invalid', parsed.errors));
			held.push(raw);
			continue;
		}
		const m = parsed.data as Mutation;
		workoutOf[i] = m.workoutId;
		if (held.some((earlier) => waitsFor(m, earlier))) {
			results.push({ id, status: 'deferred', code: 'blocked' });
			held.push(m);
			continue;
		}
		let result: SyncResult;
		try {
			result = await applyOne(m, ownerId, resolved, requestId);
		} catch (err) {
			logger.error('sync: batch stopped', { err, mutation: id, type: m.type });
			if (results.length === 0) throw new SyncUnavailableError(err);
			for (const rest of mutations.slice(i)) {
				results.push({ id: rest.id as string, status: 'retry', code: 'unavailable' });
			}
			break;
		}
		results.push(result);
		if (result.status === 'rejected' || result.status === 'deferred') held.push(m);
	}

	await attachCanonical(ownerId, results, workoutOf, resolved.db);
	return { v: 1, results };
}

/** The workout's rows on the last applied or duplicate result of each workout, read in turn. */
async function attachCanonical(
	ownerId: string,
	results: SyncResult[],
	workoutOf: readonly string[],
	db: Executor
) {
	const last = new Map<string, number>();
	results.forEach((r, i) => {
		if ((r.status === 'applied' || r.status === 'duplicate') && workoutOf[i]) {
			last.set(workoutOf[i]!, i);
		}
	});
	for (const [workout, i] of last) {
		try {
			const canonical = await canonicalOf(ownerId, workout, db);
			if (canonical) results[i]!.canonical = canonical;
		} catch (err) {
			// Applied is applied: the device reconciles the rows later.
			logger.warn('sync: canonical rows not read', { err, workout });
			return;
		}
	}
}
