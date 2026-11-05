/**
 * What auth use-cases need to know about the request and their dependencies. Routes build the
 * request context from the SvelteKit event (`requestContext` in ./http.ts); tests build it by
 * hand.
 */
import { getDb, type Executor } from '../db';
import type { RelyingParty } from './relying-party';

export interface AuthRequest {
	/** Relying party for this request (relying-party.ts). Absent for non-WebAuthn calls. */
	rp?: RelyingParty;
	/** Client address as reported by the platform (rate limits, audit log). */
	ip: string | null;
	/** Raw User-Agent (summarised before it is stored). */
	userAgent: string | null;
	requestId?: string;
}

export interface AuthDeps {
	db?: Executor;
	/** Clock (tests move it forward to expire sessions and windows). */
	now?: () => Date;
}

export interface ResolvedDeps {
	db: Executor;
	now: () => Date;
}

export function resolveDeps(deps: AuthDeps = {}): ResolvedDeps {
	return { db: deps.db ?? getDb(), now: deps.now ?? (() => new Date()) };
}
