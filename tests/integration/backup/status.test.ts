/**
 * readBackupLog on the test database's run log: the newest success and the newest run, read in
 * one read-only transaction with a 1,500 ms statement timeout, so a lock held on backup_runs ends
 * the read (57014) instead of holding Profile's stream open.
 */
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { backupStatusView } from '../../../src/lib/domain/backup/status';
import { getPool } from '../../../src/lib/server/db';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import { finishRun, startRun } from '../../../src/lib/server/db/backup/runs';
import {
	BACKUP_STATUS_TIMEOUT_MS,
	backupsConfigured,
	readBackupLog
} from '../../../src/lib/server/services/backups/status';

const NOW = new Date('2026-11-08T18:00:00Z');
const H = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H);
const SUCCESS = {
	status: 'succeeded',
	pathname: 'backups/2026/11/08/coach-20261108T104107Z.pcbk',
	bytes: 2_480_000,
	sha256: 'a'.repeat(64),
	format: 'performance-coach-backup@1',
	schemaTag: 'b'.repeat(64),
	rowCounts: { users: 1 }
} as const;

let owner: pg.Client;

beforeAll(async () => {
	owner = await backupClient(process.env.DATABASE_URL!);
	await owner.query('TRUNCATE backup_runs');
});

afterEach(async () => {
	await owner.query('TRUNCATE backup_runs');
});

afterAll(async () => {
	await owner?.end();
});

/** A finished run that started `hoursAgo` and took a minute. */
async function seed(hoursAgo: number, outcome: Parameters<typeof finishRun>[2]) {
	const id = await startRun(owner, { trigger: 'cron', appVersion: 'test', now: at(hoursAgo) });
	await finishRun(owner, id, outcome, new Date(at(hoursAgo).getTime() + 60_000));
	return id;
}

const view = async () => backupStatusView(await readBackupLog(), true, NOW, 'UTC');

describe('readBackupLog', () => {
	it('reads an empty log as never', async () => {
		expect(await readBackupLog()).toEqual({ lastSucceeded: null, lastRun: null });
		expect((await view()).state).toBe('never');
	});

	it('reads the newest success with its finish and size, and the newest run', async () => {
		await seed(30, SUCCESS);
		await seed(6, SUCCESS);
		expect(await readBackupLog()).toEqual({
			lastSucceeded: { finishedAt: new Date(at(6).getTime() + 60_000), bytes: 2_480_000 },
			lastRun: { status: 'succeeded', startedAt: at(6) }
		});
		expect(await view()).toEqual({ state: 'ok', value: '5 h ago · 2.5 MB', tone: 'neutral' });
	});

	it('sees a failure after the last success, and a success over 36 h old', async () => {
		await seed(30, SUCCESS);
		await seed(6, { status: 'failed', errorCode: 'upload_failed' });
		expect(await view()).toEqual({ state: 'failed', value: 'Last one failed', tone: 'warning' });
		await owner.query('TRUNCATE backup_runs');
		await seed(40, SUCCESS);
		expect(await view()).toEqual({
			state: 'stale',
			value: 'None since Sat 7 Nov',
			tone: 'warning'
		});
	});

	it('gives up with 57014 after 1,500 ms behind a held lock, and the pool stays usable', async () => {
		await seed(6, SUCCESS);
		await owner.query('BEGIN');
		await owner.query('LOCK TABLE backup_runs IN ACCESS EXCLUSIVE MODE');
		const started = performance.now();
		try {
			await expect(readBackupLog()).rejects.toMatchObject({ code: '57014' });
		} finally {
			await owner.query('ROLLBACK');
		}
		const waited = performance.now() - started;
		expect(waited).toBeGreaterThanOrEqual(BACKUP_STATUS_TIMEOUT_MS - 50);
		expect(waited).toBeLessThan(BACKUP_STATUS_TIMEOUT_MS + 2000);
		expect((await readBackupLog()).lastRun?.status).toBe('succeeded');
		// The pooled connection kept neither the read-only mode nor the timeout.
		const { rows } = await getPool().query<{ ro: string; timeout: string }>(
			`SELECT current_setting('transaction_read_only') AS ro,
				current_setting('statement_timeout') AS timeout`
		);
		expect(rows[0]!.ro).toBe('off');
		expect(rows[0]!.timeout).not.toBe('1500ms');
	});
});

describe('backupsConfigured', () => {
	const KEY = Buffer.alloc(32, 7).toString('base64');
	const SECRET = 's'.repeat(32);

	it('needs a key, a store and a usable CRON_SECRET', () => {
		expect(
			backupsConfigured({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: '/tmp/b', CRON_SECRET: SECRET })
		).toBe(true);
		expect(backupsConfigured({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: '/tmp/b' })).toBe(false);
		expect(
			backupsConfigured({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: '/tmp/b', CRON_SECRET: 'short' })
		).toBe(false);
		expect(backupsConfigured({ BACKUP_DIR: '/tmp/b', CRON_SECRET: SECRET })).toBe(false);
	});
});
