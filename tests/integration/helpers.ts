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

/** A database handle that can never connect (nothing listens on port 1). */
export function unreachableDb() {
	const pool = createPool('postgres://coach:coach@127.0.0.1:1/nowhere', {
		connectionTimeoutMs: 500,
		max: 1
	});
	return { db: createDatabase(pool), close: () => pool.end() };
}
