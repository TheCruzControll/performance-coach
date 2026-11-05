/**
 * Postgres connection management.
 *
 * - Driver: node-postgres `Pool` (TCP). On Vercel Fluid compute one instance serves many
 *   concurrent requests, so a small long-lived pool is reused across invocations.
 * - `attachDatabasePool` (from @vercel/functions) lets Vercel keep the instance alive just long
 *   enough to release idle clients before suspension. It is a no-op outside Vercel.
 * - App traffic uses the pooled `DATABASE_URL` (Neon `-pooler` host); migrations use
 *   `DATABASE_URL_UNPOOLED` (see scripts/db-migrate.ts).
 */
import { attachDatabasePool } from '@vercel/functions/db-connections';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '../env';
import { connectionConfig } from './connection.ts';
import { logger } from '../observability/logger';
import * as schema from './schema';
import type { Database } from './types';

export interface PoolOptions {
	max?: number;
	queryTimeoutMs?: number;
	connectionTimeoutMs?: number;
	idleTimeoutMs?: number;
}

export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
	const pool = new pg.Pool({
		...connectionConfig(connectionString),
		max: options.max ?? 5,
		idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
		connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
		query_timeout: options.queryTimeoutMs ?? 10_000,
		application_name: 'performance-coach'
	});
	// An idle client erroring (e.g. the server restarted) must not crash the process.
	pool.on('error', (err) => logger.error('postgres pool error', { err }));
	return pool;
}

export function createDatabase(pool: pg.Pool): Database {
	return drizzle({ client: pool, schema });
}

let instance: { pool: pg.Pool; db: Database } | undefined;

/** The shared application database (lazily connected on first use). */
export function getDb(): Database {
	if (!instance) {
		const env = getEnv();
		const pool = createPool(env.DATABASE_URL, {
			max: env.DB_POOL_MAX,
			queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS
		});
		attachDatabasePool(pool);
		instance = { pool, db: createDatabase(pool) };
	}
	return instance.db;
}

/** Close the shared pool (graceful shutdown, tests). */
export async function closeDb(): Promise<void> {
	const current = instance;
	instance = undefined;
	await current?.pool.end();
}
