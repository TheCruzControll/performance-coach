/**
 * The backup run log's vocabulary (M9 'backup-runs-db'), shared by the table (schema/backups.ts)
 * and its repository (src/lib/server/db/backup/runs.ts), so the repository and the operator CLI
 * never need the Drizzle schema. Pure: imported by path with relative .ts specifiers, so scripts
 * run it under plain Node.
 */

/** `cron`: the nightly Vercel Cron run. `manual`: the operator's CLI or a run started by hand. */
export const BACKUP_TRIGGERS = ['cron', 'manual'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/**
 * `running` until it finishes once; then `succeeded`, `failed`, or `skipped` when another run
 * already held the export's lock, so this one made no backup.
 */
export const BACKUP_RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

/** A run still `running` this long after it started is expired: failed with the code `abandoned`. */
export const ABANDONED_AFTER_MS = 15 * 60 * 1000;

/** The code an expired run records. */
export const ABANDONED_CODE = 'abandoned';

/** An error code: short, lower-case and free of values. The table's CHECK enforces the same rule. */
export const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
