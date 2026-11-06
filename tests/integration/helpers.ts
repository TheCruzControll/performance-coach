import { sql } from 'drizzle-orm';
import { createDatabase, createPool, getDb, type Executor } from '../../src/lib/server/db';

const ROLLBACK = Symbol('rollback');

/**
 * Run `fn` inside a transaction that is always rolled back, so tests never leak rows into
 * each other. Services and repositories accept the transaction as their `db` dependency.
 */
export async function withRollback<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
	let result: T | undefined;
	try {
		await getDb().transaction(async (tx) => {
			result = await fn(tx);
			throw ROLLBACK;
		});
	} catch (err) {
		if (err !== ROLLBACK) throw err;
	}
	return result as T;
}

/** Transactions opened by `holdTransaction` and not yet committed. */
const held = new Set<() => Promise<void>>();

/**
 * For the few tests that race real connections, which only see each other's committed rows:
 * run `fn` on the shared pool (every statement commits), then end any transaction it still
 * holds and remove every owner-related row, so the next test starts from an empty database.
 */
export async function withCommitted<T>(fn: (db: Executor) => Promise<T>): Promise<T> {
	try {
		return await fn(getDb());
	} finally {
		await Promise.allSettled([...held].map((commit) => commit()));
		await getDb().execute(
			sql`truncate owners, used_setup_tokens, auth_events, auth_rate_limits, webauthn_challenges cascade`
		);
	}
}

/**
 * Run `work` in a transaction on its own connection and keep that transaction open (its row
 * locks held, its writes invisible to others) until `commit()`.
 */
export async function holdTransaction(
	work: (tx: Executor) => Promise<unknown>
): Promise<{ commit: () => Promise<void> }> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let ready!: () => void;
	const started = new Promise<void>((resolve) => (ready = resolve));
	const done = getDb().transaction(async (tx) => {
		await work(tx);
		ready();
		await released;
	});
	const commit = () => {
		held.delete(commit);
		release();
		return done;
	};
	held.add(commit);
	await Promise.race([started, done]);
	return { commit };
}

/**
 * Wait until `count` connections to the test database are blocked on a lock, so a test can
 * order the steps of concurrent requests exactly instead of sleeping.
 */
export async function lockWaiters(count: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { rows } = await getDb().execute<{ n: number }>(
			sql`select count(*)::int as n from pg_stat_activity
				where datname = current_database() and wait_event_type = 'Lock'`
		);
		if (rows[0]!.n >= count) return;
		if (Date.now() > deadline) {
			throw new Error(`Expected ${count} connection(s) waiting on a lock; found ${rows[0]!.n}.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let restrictCode: '23001' | '23503' | undefined;

/**
 * The SQLSTATE an ON DELETE RESTRICT foreign key refuses with: PostgreSQL 18 (CI, Neon production)
 * reports restrict_violation, 16 (local) foreign_key_violation; NO ACTION keys 23503 on both.
 */
export async function restrictRefusalCode(db: Executor): Promise<'23001' | '23503'> {
	if (!restrictCode) {
		const { rows } = await db.execute<{ version: number }>(
			sql`select current_setting('server_version_num')::int as version`
		);
		restrictCode = rows[0]!.version >= 180000 ? '23001' : '23503';
	}
	return restrictCode;
}

/** A database handle that can never connect (nothing listens on port 1). */
export function unreachableDb() {
	const pool = createPool('postgres://coach:coach@127.0.0.1:1/nowhere', {
		connectionTimeoutMs: 500,
		max: 1
	});
	return { db: createDatabase(pool), close: () => pool.end() };
}
