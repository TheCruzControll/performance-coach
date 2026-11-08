/**
 * Shared plumbing for the training services (M3: the exercise library, programs, programming;
 * the coach's tools from M5): their dependencies, the errors a form maps to a response, and
 * validation with the domain's zod/mini schemas.
 *
 * A form maps them without knowing which service threw: TrainingInputError → 400 with the field
 * errors, TrainingNotFoundError → 404, and any ConflictError → 409 with its reason, which picks
 * the copy the owner sees.
 */
import type * as z from 'zod/mini';
import type { Decider } from '../../../domain/training/vocabulary';
import { validate, type FieldErrors } from '../../../domain/validation';
import { getDb, type Executor } from '../../db';

export interface TrainingDeps {
	db?: Executor;
	now?: () => Date;
	/** Who acts: the owner on a screen, the coach through its tools (M5) or the rules. */
	source?: Decider;
}

export interface ResolvedTrainingDeps {
	db: Executor;
	now: () => Date;
	source: Decider;
}

export function resolveDeps(deps: TrainingDeps = {}): ResolvedTrainingDeps {
	return {
		db: deps.db ?? getDb(),
		now: deps.now ?? (() => new Date()),
		source: deps.source ?? 'owner'
	};
}

/** Input the owner can fix: field path → message (shown next to the field). */
export class TrainingInputError extends Error {
	readonly errors: FieldErrors;

	constructor(errors: FieldErrors) {
		super(`invalid training input: ${Object.keys(errors).join(', ') || '(root)'}`);
		this.name = 'TrainingInputError';
		this.errors = errors;
	}
}

export class TrainingNotFoundError extends Error {
	/** What was not found: 'program', 'planned session'… */
	readonly what: string;

	constructor(what: string) {
		super(`${what} not found`);
		this.name = 'TrainingNotFoundError';
		this.what = what;
	}
}

/**
 * What the owner saw has changed since: nothing was written. Each service extends this with its
 * own reasons, so a form maps every conflict alike without depending on the service.
 */
export abstract class ConflictError<Reason extends string = string> extends Error {
	readonly reason: Reason;

	protected constructor(reason: Reason, message: string) {
		super(message);
		this.name = 'ConflictError';
		this.reason = reason;
	}
}

/** An edit based on a version that is no longer current (ADR 0010's compare-and-set). */
export class ProgramConflictError extends ConflictError<'version'> {
	constructor() {
		super('version', 'the program has a newer version than the one this edit started from');
		this.name = 'ProgramConflictError';
	}
}

/** Validate with a domain schema or throw a TrainingInputError. */
export function parseWith<S extends z.ZodMiniType>(schema: S, input: unknown): z.output<S> {
	const result = validate(schema, input);
	if (!result.ok) throw new TrainingInputError(result.errors);
	return result.data;
}
