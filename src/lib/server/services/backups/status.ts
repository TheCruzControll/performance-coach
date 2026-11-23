/**
 * The backup status Profile streams (M9 'backup-status'): whether backups are configured, and the
 * newest success and newest run from the run log, read on one pooled connection in a read-only
 * transaction with a 1,500 ms statement timeout on each statement, so a held lock or a slow
 * database ends the read instead of holding the stream open. A failure throws; Profile records
 * it and shows the neutral row. No Blob call: the log is the only source.
 *
 * Imported by path, never through ./index.ts: index.ts is the operator CLI's plain-Node entry,
 * and this module reaches the app's pool.
 */
import type pg from 'pg';
import type { BackupLog } from '../../../domain/backup/status.ts';
import { backupConfig, cronSecretProblem, type BackupEnv } from '../../backup/config.ts';
import { lastRun, lastSucceeded } from '../../db/backup/runs.ts';
import { getPool } from '../../db';

/**
 * The statement timeout, set per statement (SET LOCAL): each of the read's two queries may take
 * this long, so the read as a whole can take up to twice it. Profile's other rows never wait on it.
 */
export const BACKUP_STATUS_TIMEOUT_MS = 1500;

/** Whether the nightly backup can run: a key, a store and a usable CRON_SECRET. */
export function backupsConfigured(env: BackupEnv): boolean {
	return backupConfig(env).state === 'on' && cronSecretProblem(env) === null;
}

/** The run log's newest success and newest run. */
export async function readBackupLog(
	pool: Pick<pg.Pool, 'connect'> = getPool()
): Promise<BackupLog> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN READ ONLY');
		await client.query(`SET LOCAL statement_timeout = ${BACKUP_STATUS_TIMEOUT_MS}`);
		const succeeded = await lastSucceeded(client);
		const newest = await lastRun(client);
		await client.query('COMMIT');
		client.release();
		return {
			lastSucceeded: succeeded && {
				finishedAt: succeeded.finishedAt ?? succeeded.startedAt,
				bytes: succeeded.bytes
			},
			lastRun: newest && { status: newest.status, startedAt: newest.startedAt }
		};
	} catch (error) {
		// A connection that cannot even roll back is dropped, never returned to the pool.
		const broken = await client.query('ROLLBACK').then(
			() => false,
			() => true
		);
		client.release(broken);
		throw error;
	}
}
