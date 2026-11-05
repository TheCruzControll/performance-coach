/**
 * Per-request context propagated with AsyncLocalStorage (available on Node and on Vercel's
 * Node runtime). It carries the request id for log correlation and accumulates timings that
 * become the `Server-Timing` response header.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TimingEntry {
	/** Total milliseconds spent in this metric during the request. */
	dur: number;
	/** Number of measured operations. */
	count: number;
}

export interface RequestContext {
	requestId: string;
	startedAt: number;
	timings: Map<string, TimingEntry>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createContext(requestId: string): RequestContext {
	return { requestId, startedAt: performance.now(), timings: new Map() };
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
	return storage.getStore();
}
