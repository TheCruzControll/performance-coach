/**
 * runBackup on the scratch source (scratch.ts) into a folder store: one run exports, seals in
 * memory after the snapshot has ended, uploads, reads back and verifies, and only then prunes.
 * Every failure leaves the old backups alone and is recorded in app_errors (kind 'cron'), and
 * neither the logs nor app_errors ever hold the key or a row value.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupPathname } from '../../../src/lib/domain/backup/pathnames';
import { RETENTION, selectForDeletion } from '../../../src/lib/domain/backup/retention';
import { readArchive } from '../../../src/lib/server/backup/archive';
import { openEnvelope } from '../../../src/lib/server/backup/envelope';
import { fileStore } from '../../../src/lib/server/backup/fs-store';
import { parseBackupKey } from '../../../src/lib/server/backup/key';
import { BackupStoreError, type BackupStore } from '../../../src/lib/server/backup/store';
import type { Executor } from '../../../src/lib/server/db';
import { BACKUP_LOCK_KEY } from '../../../src/lib/server/db/backup/export';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import { startRun } from '../../../src/lib/server/db/backup/runs';
import { setLogLevel } from '../../../src/lib/server/observability/logger';
import {
	BackupRunError,
	runBackup,
	type BackupRunDeps,
	type BackupRunEnv
} from '../../../src/lib/server/services/backups';
import { recordServerError } from '../../../src/lib/server/services/errors';
import { withRollback } from '../helpers';
import { prepareSource } from './scratch';

/** A row value no log line or app_errors row may ever hold. */
const ROW_SENTINEL = 'row-sentinel-7f3c9e1a';
const KEY_TEXT = randomBytes(32).toString('base64');
const NOW = new Date('2026-11-08T10:41:07Z');

let url: string;
/** The test's own connections to the source: one to hold locks, one to watch. */
let holder: pg.Client;
let watcher: pg.Client;
let dir: string;
let env: BackupRunEnv;

beforeAll(async () => {
	({ url } = await prepareSource());
	holder = await backupClient(url);
	watcher = await backupClient(url);
	await holder.query(`SET application_name = 'backup-test'`);
	await watcher.query(`SET application_name = 'backup-test'`);
	// The scratch cycle needs a late key the app's LATE_ALLOWED does not list (export.test.ts
	// covers it); a run exports with the app's own list.
	await holder.query('DROP TABLE backup_cycle_a, backup_cycle_b CASCADE');
	await holder.query(`INSERT INTO backup_bulk VALUES (999999, $1)`, [ROW_SENTINEL]);
}, 60_000);

afterAll(async () => {
	await holder?.end();
	await watcher?.end();
});

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'coach-backup-run-'));
	env = { DATABASE_URL: url, BACKUP_ENCRYPTION_KEY: KEY_TEXT, BACKUP_DIR: dir };
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A run that records its failures as the app does, in app_errors on `db`. */
const run = ({ db, ...deps }: Omit<BackupRunDeps, 'record'> & { db?: Executor } = {}, now = NOW) =>
	runBackup(
		{ now, trigger: 'cron', env, appVersion: 'test' },
		{ record: (failure) => recordServerError(failure, { db }), ...deps }
	);

async function refusal(promise: Promise<unknown>): Promise<BackupRunError> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!(error instanceof BackupRunError)) throw new Error(`expected a refusal, got ${error}`);
	return error;
}

/** Every object name the folder store holds, sorted. */
async function names(): Promise<string[]> {
	return (await fileStore({ dir }).list('')).map((o) => o.pathname);
}

/** `count` older backups, one a day at 09:00 UTC on the days before NOW. */
async function seedOld(count: number): Promise<string[]> {
	const store = fileStore({ dir });
	const seeded: string[] = [];
	for (let day = 1; day <= count; day++) {
		const at = new Date(Date.UTC(2026, 10, 8 - day, 9, 0, 0));
		const name = backupPathname(at);
		await store.put(name, Buffer.from(`old backup ${day}`));
		seeded.push(name);
	}
	return seeded.sort();
}

/** A store over the folder with `overrides` in place of its own calls. */
function storeWith(overrides: Partial<BackupStore>): BackupStore {
	return { ...fileStore({ dir }), ...overrides };
}

async function cronErrors(tx: Executor) {
	const { rows } = await tx.execute<{
		status: number | null;
		message: string;
		stack: string | null;
		app_version: string | null;
		context: Record<string, unknown> | null;
	}>(
		sql`select status, message, stack, app_version, context from app_errors where kind = 'cron' order by id`
	);
	return rows;
}

describe('runBackup', () => {
	it('writes one file that decrypts, with counts equal to the database and a matching sha256', async () => {
		const result = await run();

		expect(await names()).toEqual([backupPathname(NOW)]);
		expect(result.pathname).toBe(backupPathname(NOW));
		const file = await readFile(path.join(dir, result.pathname));
		expect(result.bytes).toBe(file.length);
		expect(result.sha256).toBe(createHash('sha256').update(file).digest('hex'));

		const archive = readArchive(openEnvelope(parseBackupKey(KEY_TEXT, 'key'), file));
		expect(archive.header.createdAt).toBe(NOW.toISOString());
		expect(archive.header.appVersion).toBe('test');
		expect(result.tables).toBe(archive.tables.length);
		let rows = 0;
		for (const table of archive.tables) {
			const { rows: counted } = await watcher.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM public."${table.name}"`
			);
			expect(table.rows.length, table.name).toBe(counted[0]!.n);
			rows += table.rows.length;
		}
		expect(result.rows).toBe(rows);
		expect(archive.trailer.rowCounts.backup_bulk).toBe(1_201);

		expect(Object.keys(result.phases)).toEqual(['export', 'upload', 'readBack', 'prune']);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.pruned).toEqual({ kept: [result.pathname], deleted: [], unparseable: [] });
	});

	it('uploads only after the export has ended its transaction', async () => {
		const inner = fileStore({ dir });
		const atPut: { open: number; idleInTransaction: number }[] = [];
		const store = storeWith({
			async put(pathname, body) {
				const { rows } = await watcher.query<{ open: number; idleInTransaction: number }>(
					`SELECT count(*) FILTER (WHERE xact_start IS NOT NULL)::int AS open,
						count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS "idleInTransaction"
					FROM pg_stat_activity
					WHERE application_name = 'coach-backup' AND datname = current_database()`
				);
				atPut.push(rows[0]!);
				return inner.put(pathname, body);
			}
		});

		await run({ store });
		expect(atPut).toEqual([{ open: 0, idleInTransaction: 0 }]);
	});

	it('refuses a concurrent run with already_running, and records nothing for it', async () => {
		await withRollback(async (tx) => {
			// Hold the first run inside its export (and so its lock) on backup_bulk.
			await holder.query('BEGIN');
			await holder.query('LOCK TABLE backup_bulk IN ACCESS EXCLUSIVE MODE');
			const first = run({ db: tx });
			let second: BackupRunError;
			try {
				for (let waited = 0; ; waited += 10) {
					const { rows } = await watcher.query<{ n: number }>(
						`SELECT count(*)::int AS n FROM pg_stat_activity
						WHERE application_name = 'coach-backup' AND wait_event_type = 'Lock'`
					);
					if (rows[0]!.n === 1) break;
					if (waited > 5_000) throw new Error('The first run never waited on backup_bulk');
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				second = await refusal(run({ db: tx }, new Date(NOW.getTime() + 1_000)));
			} finally {
				await holder.query('COMMIT');
			}
			const made = await first;

			expect(second.code).toBe('already_running');
			expect(second.status).toBe(409);
			expect(await names()).toEqual([made.pathname]);
			expect(await cronErrors(tx)).toEqual([]);
		});
	});

	it('fails backup_too_large over a 1 KB cap, uploading and pruning nothing', async () => {
		const seeded = await seedOld(40);
		await withRollback(async (tx) => {
			const error = await refusal(run({ maxBytes: 1024, db: tx }));
			expect(error.code).toBe('backup_too_large');
			expect(await names()).toEqual(seeded);
			expect(await cronErrors(tx)).toMatchObject([
				{ status: 500, app_version: 'test', context: { code: 'backup_too_large', trigger: 'cron' } }
			]);
		});
		// The refused run released its connection, lock and snapshot: the next run succeeds.
		expect((await run()).pathname).toBe(backupPathname(NOW));
	});

	it('records a failed upload in app_errors and prunes nothing', async () => {
		const seeded = await seedOld(40);
		const store = storeWith({
			put: () => Promise.reject(new BackupStoreError('store_unavailable', 'The store is down'))
		});
		await withRollback(async (tx) => {
			const error = await refusal(run({ store, db: tx }));
			expect(error.code).toBe('upload_failed');
			expect(await names()).toEqual(seeded);
			expect(await cronErrors(tx)).toMatchObject([
				{
					status: 500,
					message: `The upload of ${backupPathname(NOW)} failed`,
					context: {
						code: 'upload_failed',
						trigger: 'cron',
						cause: { name: 'BackupStoreError', code: 'store_unavailable' }
					}
				}
			]);
		});
	});

	it('deletes an object that reads back with a flipped byte, and prunes nothing', async () => {
		const seeded = await seedOld(40);
		const inner = fileStore({ dir });
		const store = storeWith({
			async get(pathname) {
				const bytes = await inner.get(pathname);
				bytes[bytes.length - 20]! ^= 0x01;
				return bytes;
			}
		});
		await withRollback(async (tx) => {
			const error = await refusal(run({ store, db: tx }));
			expect(error.code).toBe('read_back_mismatch');
			expect(await names()).toEqual(seeded);
			expect(await cronErrors(tx)).toMatchObject([
				{ status: 500, context: { code: 'read_back_mismatch', discarded: true } }
			]);
		});
	});

	it('records a prune that failed after deleting some files, and keeps the verified backup', async () => {
		const seeded = await seedOld(60);
		const inner = fileStore({ dir });
		const store = storeWith({
			async del(pathnames) {
				await inner.del(pathnames.slice(0, 1));
				throw new BackupStoreError('store_unavailable', 'The store went down mid-delete');
			}
		});
		await withRollback(async (tx) => {
			const result = await run({ store, db: tx });
			expect(result.pruned).toBeNull();
			const left = await names();
			expect(left).toHaveLength(seeded.length);
			expect(left).toContain(result.pathname);
			// One old file is gone, so the record must not claim that none were deleted.
			expect(await cronErrors(tx)).toMatchObject([
				{
					status: 500,
					message: 'Pruning old backups failed',
					context: { code: 'prune_failed', cause: { code: 'store_unavailable' } }
				}
			]);
		});
	});

	it('deletes exactly the retention set of 60 old files, never an unknown name or the new one', async () => {
		const seeded = await seedOld(60);
		const unknown = 'backups/2026/notes.txt';
		await mkdir(path.join(dir, 'backups/2026'), { recursive: true });
		await writeFile(path.join(dir, unknown), 'not a backup');

		const result = await run();

		const expected = selectForDeletion([...seeded, unknown, result.pathname], NOW, RETENTION, [
			result.pathname
		]);
		// 29 earlier days in the 30-day window, then October's and September's earliest.
		expect(expected.delete).toHaveLength(60 - 29 - 2);
		expect(result.pruned).toEqual({
			kept: expected.keep,
			deleted: expected.delete,
			unparseable: [unknown]
		});
		expect(await names()).toEqual(
			[...seeded.filter((name) => !expected.delete.includes(name)), unknown, result.pathname].sort()
		);
		expect(await names()).toEqual(
			expect.arrayContaining([
				backupPathname(new Date(Date.UTC(2026, 8, 9, 9))),
				backupPathname(new Date(Date.UTC(2026, 9, 1, 9)))
			])
		);
		expect(await names()).not.toContain(backupPathname(new Date(Date.UTC(2026, 9, 2, 9))));
	});

	it('refuses with backup_not_configured, naming the missing variable, while backups are off', async () => {
		const { BACKUP_ENCRYPTION_KEY: _key, ...withoutKey } = env;
		await withRollback(async (tx) => {
			const error = await refusal(
				runBackup(
					{ now: NOW, trigger: 'cron', env: withoutKey, appVersion: 'test' },
					{ record: (failure) => recordServerError(failure, { db: tx }) }
				)
			);
			expect(error.code).toBe('backup_not_configured');
			expect(error.status).toBe(503);
			expect(error.detail).toEqual({ missing: ['BACKUP_ENCRYPTION_KEY'], invalid: [] });
			expect(await cronErrors(tx)).toMatchObject([
				{
					status: 503,
					context: { code: 'backup_not_configured', missing: ['BACKUP_ENCRYPTION_KEY'] }
				}
			]);
		});
		expect(await names()).toEqual([]);
	});

	describe('the run log', () => {
		beforeEach(async () => {
			await holder.query('TRUNCATE backup_runs');
		});

		/** Every run logged, oldest first, as the table holds it. */
		async function runs() {
			const { rows } = await watcher.query<{
				trigger: string;
				status: string;
				started_at: Date;
				finished_at: Date | null;
				pathname: string | null;
				bytes: string | null;
				sha256: string | null;
				format: string | null;
				schema_tag: string | null;
				app_version: string | null;
				row_counts: Record<string, number> | null;
				error_code: string | null;
			}>('SELECT * FROM backup_runs ORDER BY id');
			return rows;
		}

		it('logs a verified run as succeeded, with what it stored and the schema it read', async () => {
			const result = await run();
			const { rows: last } = await watcher.query<{ hash: string }>(
				'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1'
			);
			const [row, ...others] = await runs();
			expect(others).toEqual([]);
			expect(row).toMatchObject({
				trigger: 'cron',
				status: 'succeeded',
				started_at: NOW,
				pathname: result.pathname,
				bytes: String(result.bytes),
				sha256: result.sha256,
				format: 'performance-coach-backup@1',
				schema_tag: last[0]!.hash,
				app_version: 'test',
				error_code: null
			});
			expect(row!.row_counts).toEqual(result.rowCounts);
			expect(Object.values(result.rowCounts).reduce((a, b) => a + b, 0)).toBe(result.rows);
			// The start plus the run's own duration on the monotonic clock.
			const took = row!.finished_at!.getTime() - NOW.getTime();
			expect(took).toBeGreaterThanOrEqual(0);
			expect(took).toBeLessThan(60_000);
		});

		it('stamps the finish from the run’s own clock, so a wall clock behind the start still finishes', async () => {
			// The run's clock is an hour ahead of this machine's: a finish stamped by the wall clock
			// would break the finish-order CHECK.
			const ahead = new Date(Date.now() + 60 * 60 * 1000);
			await run({}, ahead);
			const [row] = await runs();
			expect(row).toMatchObject({ status: 'succeeded', started_at: ahead });
			expect(row!.finished_at!.getTime()).toBeGreaterThanOrEqual(ahead.getTime());
		});

		it('logs a refused run as failed with its code, never a message', async () => {
			await withRollback(async (tx) => {
				await refusal(run({ maxBytes: 1024, db: tx }));
			});
			expect(await runs()).toMatchObject([
				{
					trigger: 'cron',
					status: 'failed',
					error_code: 'backup_too_large',
					pathname: null,
					bytes: null
				}
			]);
		});

		it('finishes the row failed even when recording the failure throws', async () => {
			await expect(
				runBackup(
					{ now: NOW, trigger: 'cron', env, appVersion: 'test' },
					{
						maxBytes: 1024,
						record: async () => {
							throw new Error('The app_errors table is down');
						}
					}
				)
			).rejects.toThrow('The app_errors table is down');
			expect(await runs()).toMatchObject([
				{
					trigger: 'cron',
					status: 'failed',
					error_code: 'backup_too_large',
					finished_at: expect.any(Date)
				}
			]);
		});

		it('logs nothing while backups are off: no backup was attempted', async () => {
			const { BACKUP_ENCRYPTION_KEY: _key, ...withoutKey } = env;
			const error = await refusal(
				runBackup(
					{ now: NOW, trigger: 'manual', env: withoutKey, appVersion: 'test' },
					{ record: async () => undefined }
				)
			);
			expect(error.code).toBe('backup_not_configured');
			expect(await runs()).toEqual([]);
		});

		it('logs a run that found the lock held as skipped with already_running', async () => {
			await holder.query('BEGIN');
			await holder.query('SELECT pg_advisory_xact_lock($1)', [BACKUP_LOCK_KEY]);
			try {
				expect((await refusal(run())).code).toBe('already_running');
			} finally {
				await holder.query('COMMIT');
			}
			expect(await runs()).toMatchObject([
				{ status: 'skipped', error_code: 'already_running', finished_at: expect.any(Date) }
			]);
		});

		it('expires a run abandoned over 15 minutes ago before it starts its own', async () => {
			const before = new Date(NOW.getTime() - 16 * 60 * 1000);
			await startRun(holder, { trigger: 'cron', appVersion: 'old', now: before });
			await run();
			expect(await runs()).toMatchObject([
				{ status: 'failed', error_code: 'abandoned', started_at: before, finished_at: NOW },
				{ status: 'succeeded', started_at: NOW }
			]);
		});

		it('logs nothing with log: false (the CLI’s --out)', async () => {
			await run({ log: false });
			expect(await runs()).toEqual([]);
		});
	});

	describe('logs', () => {
		afterEach(() => {
			setLogLevel('silent');
			vi.restoreAllMocks();
		});

		it('hold one line per phase, and neither they nor app_errors hold the key or a row value', async () => {
			setLogLevel('debug');
			const lines: string[] = [];
			const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
			vi.spyOn(console, 'log').mockImplementation(capture);
			vi.spyOn(console, 'error').mockImplementation(capture);
			const inner = fileStore({ dir });

			const recorded = await withRollback(async (tx) => {
				await run({ db: tx });
				const flipped = storeWith({
					async get(pathname) {
						const bytes = await inner.get(pathname);
						bytes[bytes.length - 1]! ^= 0x01;
						return bytes;
					}
				});
				await refusal(run({ store: flipped, db: tx }, new Date(NOW.getTime() + 1_000)));
				await refusal(run({ maxBytes: 1024, db: tx }, new Date(NOW.getTime() + 2_000)));
				return cronErrors(tx);
			});

			const phases = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((entry) => entry.msg === 'backup phase')
				.map((entry) => entry.phase);
			expect(phases).toEqual(['export', 'upload', 'read_back', 'prune', 'export', 'upload']);
			expect(recorded.map((row) => row.context?.code)).toEqual([
				'read_back_mismatch',
				'backup_too_large'
			]);
			const text = lines.join('\n') + JSON.stringify(recorded);
			expect(text).toContain('backup_too_large');
			for (const secret of [
				KEY_TEXT,
				Buffer.from(KEY_TEXT, 'base64').toString('hex'),
				ROW_SENTINEL
			]) {
				expect(text).not.toContain(secret);
			}
			expect(text).not.toContain('"label"');
		});
	});
});
