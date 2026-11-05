/**
 * Health use-case: proves the app can reach Postgres with a real round-trip.
 * Used by GET /api/health and by the Profile screen's "System" panel.
 */
import { createSystemRepository, getDb, type Executor } from '../db';
import { logger } from '../observability/logger';
import { measure } from '../observability/timing';

export interface HealthReport {
	ok: boolean;
	db: 'up' | 'down';
	version: string;
	/** Round-trip latency of the database probe, when it succeeded. */
	dbLatencyMs: number | null;
	checkedAt: string;
}

export interface HealthDeps {
	db?: Executor;
	version: string;
	/** Upper bound for the probe so a hung connection cannot hang the endpoint. */
	timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`database probe timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
	const started = performance.now();
	let db: HealthReport['db'] = 'down';
	let dbLatencyMs: number | null = null;
	try {
		const repo = createSystemRepository(deps.db ?? getDb());
		await withTimeout(
			measure('db', () => repo.ping()),
			deps.timeoutMs ?? 2_000
		);
		db = 'up';
		dbLatencyMs = Math.round((performance.now() - started) * 10) / 10;
	} catch (err) {
		logger.warn('health: database probe failed', { err });
	}
	return {
		ok: db === 'up',
		db,
		version: deps.version,
		dbLatencyMs,
		checkedAt: new Date().toISOString()
	};
}
