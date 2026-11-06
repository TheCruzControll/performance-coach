/**
 * Migration + reset helpers shared by `scripts/db-*.ts`, the integration test global setup and
 * the Playwright global setup. Node runs it directly (type stripping) without a bundler, so it
 * depends only on npm packages and on modules imported with explicit .ts specifiers
 * (scripts/catalogue-node.test.ts runs it that way).
 */
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { connectionConfig } from './connection.ts';
import { seedExerciseCatalogue, type CatalogueSeed } from './seed/exercises.ts';

/** Local defaults created by scripts/db-setup.sh. Never used in preview/production. */
export const LOCAL_DATABASE_URLS = {
	development: 'postgres://coach:coach@localhost:5432/coach_dev',
	test: 'postgres://coach:coach@localhost:5432/coach_test',
	e2e: 'postgres://coach:coach@localhost:5432/coach_e2e',
	/** `pnpm db:explain`'s scratch database, reset and loaded on every run. */
	explain: 'postgres://coach:coach@localhost:5432/coach_explain'
} as const;

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle');
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** Arbitrary constant key: serialises concurrent migrators (CI + deploy) on one database. */
const MIGRATION_LOCK_KEY = 727_001;

export function databaseName(url: string): string {
	return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function redactUrl(url: string): string {
	const u = new URL(url);
	if (u.password) u.password = '***';
	return u.toString();
}

export interface MigrationRun {
	applied: number;
	total: number;
	/** What the exercise catalogue seed changed. */
	library: CatalogueSeed;
}

/**
 * Apply all pending SQL migrations from ./drizzle using a direct (non-pooled) connection, then
 * seed the exercise catalogue under the same lock, so every migrated database has the library
 * the code was built with.
 */
export async function runMigrations(
	url: string,
	options: { migrationsFolder?: string } = {}
): Promise<MigrationRun> {
	const client = new pg.Client({
		...connectionConfig(url),
		application_name: 'performance-coach-migrate'
	});
	await client.connect();
	try {
		await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
		const before = await countApplied(client);
		await migrate(drizzle({ client }), {
			migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE
		});
		const total = await countApplied(client);
		const library = await seedExerciseCatalogue(client);
		return { applied: total - before, total, library };
	} finally {
		await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
		await client.end();
	}
}

async function countApplied(client: pg.Client): Promise<number> {
	const exists = await client.query<{ present: boolean }>(
		`select to_regclass($1) is not null as present`,
		[`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`]
	);
	if (!exists.rows[0]?.present) return 0;
	const res = await client.query<{ n: string }>(
		`select count(*)::text as n from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`
	);
	return Number(res.rows[0]?.n ?? 0);
}

/**
 * Drop everything in a disposable database and re-apply migrations.
 * Refuses to touch any database whose name does not end in `_test`, `_e2e` or `_explain`.
 */
export async function resetDatabase(url: string): Promise<MigrationRun> {
	const name = databaseName(url);
	if (!/_(test|e2e|explain)$/.test(name)) {
		throw new Error(
			`Refusing to reset database "${name}": only databases ending in _test, _e2e or _explain can be reset.`
		);
	}
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	try {
		await client.query(`drop schema if exists "${MIGRATIONS_SCHEMA}" cascade`);
		await client.query('drop schema if exists public cascade');
		await client.query('create schema public');
	} finally {
		await client.end();
	}
	return runMigrations(url);
}
