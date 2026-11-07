/**
 * Shared plumbing for the coach services (M5): their dependencies, the errors an endpoint maps to
 * a response, and the tool runtime seam the agent reads.
 *
 * An endpoint maps the errors without knowing which service threw: CoachInputError → 400,
 * CoachNotFoundError → 404 ('not_found'), CoachArchivedError → 409. CoachTranscriptError is a caller's bug, never the owner's: a 500.
 */
import { PgTransaction } from 'drizzle-orm/pg-core';
import { getDb, type Executor } from '../../db';

export interface CoachDeps {
	db?: Executor;
	now?: () => Date;
}

export interface ResolvedCoachDeps {
	db: Executor;
	now: () => Date;
}

export function resolveDeps(deps: CoachDeps = {}): ResolvedCoachDeps {
	return { db: deps.db ?? getDb(), now: deps.now ?? (() => new Date()) };
}

/**
 * The deps the agent hands every tool, and whether the tools must run one at a time. A transaction
 * is one connection, which runs one query at a time (docs/architecture.md), so tools sharing one
 * run serially; on the pool they may run together. The agent may not see the Executor (lint
 * forbids agent → db, types included), so it reads only `serialTools`.
 */
export function toolRuntime(deps: CoachDeps = {}): {
	deps: ResolvedCoachDeps;
	serialTools: boolean;
} {
	const resolved = resolveDeps(deps);
	return { deps: resolved, serialTools: resolved.db instanceof PgTransaction };
}

/** Input the owner can fix (a message, a title, a page size); nothing was written. */
export class CoachInputError extends Error {
	readonly field: string;

	constructor(field: string, message: string) {
		super(message);
		this.name = 'CoachInputError';
		this.field = field;
	}
}

/** Not one of the owner's: a malformed id, someone else's or none at all look the same. */
export class CoachNotFoundError extends Error {
	constructor(what: string) {
		super(`${what} not found`);
		this.name = 'CoachNotFoundError';
	}
}

/** The conversation is archived: it opens read-only until it is unarchived. */
export class CoachArchivedError extends Error {
	constructor() {
		super('the conversation is archived; unarchive it to continue');
		this.name = 'CoachArchivedError';
	}
}

/**
 * A write that would leave a segment's transcript an invalid request (an orphan tool_use, a turn
 * context out of place); nothing was written.
 */
export class CoachTranscriptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CoachTranscriptError';
	}
}
