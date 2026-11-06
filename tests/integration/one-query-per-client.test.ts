/**
 * The setup file that fails a test for overlapping queries on one pg client: it must catch them
 * (two at once, and pg's own warning from three), fail the test they happen in, and leave correct
 * code alone. The tests that only check what it caught take it first, so it does not fail them.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getDb, type Executor } from '../../src/lib/server/db';
import { withRollback } from './helpers';
import { takeOverlaps } from './one-query-per-client';

const PG_WARNING = 'Calling client.query() when the client is already executing a query';

const select = (db: Executor, n: number) => db.execute(sql`select ${n}::int as n`);

describe('one query at a time per pg client', () => {
	it('catches a second query sent to a transaction that is still running one', async () => {
		await withRollback((tx) => Promise.all([select(tx, 1), select(tx, 2)]));
		expect(takeOverlaps().map((e) => e.message)).toEqual([
			'client.query() was called while this client was running a query'
		]);
	});

	it('catches the deprecation warning pg prints from the third query at once', async () => {
		// Expected here, so keep it out of the run's output: a clean run prints no such warning.
		const write = process.stderr.write.bind(process.stderr);
		const stderr = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation((chunk, encoding, cb) =>
				String(chunk).includes(PG_WARNING) ? true : write(chunk, encoding, cb)
			);
		try {
			await withRollback((tx) => Promise.all([select(tx, 1), select(tx, 2), select(tx, 3)]));
		} finally {
			stderr.mockRestore();
		}
		const warnings = takeOverlaps().filter((e) => e.name === 'DeprecationWarning');
		expect(warnings.map((e) => e.message)).toEqual([
			expect.stringContaining(`${PG_WARNING} is deprecated and will be removed in pg@9`)
		]);
	});

	describe('a test that leaves an overlap behind', () => {
		let failure: string[] | undefined;

		it.fails('fails once it has run, from the setup file', async ({ onTestFinished }) => {
			onTestFinished(({ task }) => {
				failure = task.result?.errors?.map((e) => e.message);
			});
			// pg 8 still runs both queries, so only the setup file can fail this test.
			const results = await withRollback((tx) => Promise.all([select(tx, 1), select(tx, 2)]));
			expect(results.map((r) => r.rows[0])).toEqual([{ n: 1 }, { n: 2 }]);
		});

		it('says why, and what to write instead', () => {
			expect(failure).toEqual([
				expect.stringMatching(
					/^A query was sent to a pg client that was still running another\. Await each query in turn/
				)
			]);
		});
	});

	it('lets one transaction run its queries in turn', async () => {
		const rows = await withRollback(async (tx) => {
			const first = await select(tx, 1);
			const second = await select(tx, 2);
			return [...first.rows, ...second.rows];
		});
		expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
		expect(takeOverlaps()).toEqual([]);
	});

	it('lets the pool run queries together: each one gets a connection of its own', async () => {
		const db = getDb();
		const results = await Promise.all([1, 2, 3].map((n) => select(db, n)));
		expect(results.map((r) => r.rows[0])).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(takeOverlaps()).toEqual([]);
	});
});
