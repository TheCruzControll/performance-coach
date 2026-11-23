/**
 * The backup run log (M9 'backup-runs-db'): one row per backup run, opened as `running` when the
 * run starts and finished once, by src/lib/server/db/backup/runs.ts. A finished row never changes,
 * and a row is deleted only after 400 days (0038's guards). Only codes are stored: error_code is a
 * short lower-case code, and no column holds an error message, a row's values or a key.
 * `backup_runs` is excluded from the backups it describes (src/lib/server/db/backup/tables.ts).
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { BACKUP_RUN_STATUSES, BACKUP_TRIGGERS } from '../../../domain/backup/run-log';
import { inList } from './columns';

export const backupRuns = pgTable(
	'backup_runs',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		trigger: text('trigger').$type<(typeof BACKUP_TRIGGERS)[number]>().notNull(),
		status: text('status').$type<(typeof BACKUP_RUN_STATUSES)[number]>().notNull(),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		/** The stored object's pathname (backupPathname), set when the run succeeds. */
		pathname: text('pathname'),
		/** The sealed file's size in bytes. */
		bytes: bigint('bytes', { mode: 'number' }),
		/** The sealed file's SHA-256, lower-case hex. */
		sha256: text('sha256'),
		/** The archive format name and version the file was written in. */
		format: text('format'),
		/** The schema the backup was taken from: the archive header's last migration hash. */
		schemaTag: text('schema_tag'),
		appVersion: text('app_version'),
		/** Exported rows per table, by table name. Counts only, never a value. */
		rowCounts: jsonb('row_counts').$type<Record<string, number>>(),
		/** A short code (a BackupRunErrorCode, or `abandoned`), never a message. */
		errorCode: text('error_code')
	},
	(t) => [
		index('backup_runs_status_started_idx').on(t.status, t.startedAt.desc()),
		check('backup_runs_trigger_ck', inList('trigger', BACKUP_TRIGGERS)),
		check('backup_runs_status_ck', inList('status', BACKUP_RUN_STATUSES)),
		check('backup_runs_running_ck', sql`${t.status} <> 'running' or ${t.finishedAt} is null`),
		check(
			'backup_runs_error_code_ck',
			sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z_]{1,64}$'`
		)
	]
);
