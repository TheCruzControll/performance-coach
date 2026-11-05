/**
 * Client error reporting: uncaught exceptions, unhandled rejections and the client
 * `handleError` hook beacon to POST /api/client-errors (src/lib/client/errors.ts), and land in
 * `app_errors` with kind `client` next to server incidents. On an iPhone-first PWA most future
 * failures (offline sync, timers, IndexedDB) happen in the browser, so they must be visible.
 *
 * Abuse limits: payloads are size-capped and validated, and each server instance accepts at
 * most CLIENT_ERROR_LIMIT reports per minute (one user; the client also caps itself). The
 * endpoint requires a session once auth lands (M2).
 */
import { z } from 'zod';
import { createAppErrorsRepository, getDb, type AppErrorRow, type Executor } from '../db';
import { logger } from '../observability/logger';

export const CLIENT_ERROR_SOURCES = ['error', 'unhandledrejection', 'handleError'] as const;
export const CLIENT_ERROR_LIMIT = 30;
const WINDOW_MS = 60_000;

export const clientErrorSchema = z.object({
	source: z.enum(CLIENT_ERROR_SOURCES),
	name: z.string().max(200).default('Error'),
	message: z.string().min(1).max(1_000),
	stack: z.string().max(8_000).optional(),
	path: z
		.string()
		.max(512)
		.refine((p) => p.startsWith('/'), 'path must be absolute'),
	route: z
		.string()
		.max(256)
		.refine((r) => r.startsWith('/'), 'route must be a route id')
		.nullish(),
	/** Build the page was running (a stale tab can run an older one than the server). */
	version: z.string().max(64).optional()
});

export type ClientErrorInput = z.input<typeof clientErrorSchema>;

export class InvalidClientErrorReport extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super('invalid client error report');
		this.name = 'InvalidClientErrorReport';
		this.issues = issues;
	}
}

export class ClientErrorRateLimited extends Error {
	constructor() {
		super('too many client error reports');
		this.name = 'ClientErrorRateLimited';
	}
}

/** Fixed-window counter: at most `limit` events per `windowMs` (per server instance). */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
	let windowStart = -Infinity;
	let count = 0;
	return {
		take(): boolean {
			const t = now();
			if (t - windowStart >= windowMs) {
				windowStart = t;
				count = 0;
			}
			if (count >= limit) return false;
			count += 1;
			return true;
		}
	};
}

const limiter = createRateLimiter(CLIENT_ERROR_LIMIT, WINDOW_MS);

export interface ClientErrorMeta {
	requestId?: string;
	userAgent?: string | null;
}

/** Validate and store one client error report. */
export async function recordClientError(
	payload: unknown,
	meta: ClientErrorMeta = {},
	deps: { db?: Executor; limiter?: { take(): boolean } } = {}
): Promise<AppErrorRow> {
	const parsed = clientErrorSchema.safeParse(payload);
	if (!parsed.success) {
		throw new InvalidClientErrorReport(
			parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
		);
	}
	if (!(deps.limiter ?? limiter).take()) throw new ClientErrorRateLimited();

	const report = parsed.data;
	logger.warn('client error', {
		requestId: meta.requestId,
		source: report.source,
		name: report.name,
		message: report.message,
		path: report.path,
		route: report.route
	});
	return createAppErrorsRepository(deps.db ?? getDb()).insert({
		kind: 'client',
		status: null,
		requestId: meta.requestId ?? null,
		method: null,
		path: report.path,
		routeId: report.route ?? null,
		message: `${report.name}: ${report.message}`,
		stack: report.stack ?? null,
		appVersion: report.version ?? null,
		context: {
			source: report.source,
			...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 256) } : {})
		}
	});
}
