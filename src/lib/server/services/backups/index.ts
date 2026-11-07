/**
 * Backup use-cases (M9): one verified run, for the cron endpoint and the operator's CLI. Callers
 * import this module by path; services/index.ts does not re-export it.
 */
export {
	BACKUP_BUFFER_CAP,
	BackupRunError,
	isBackupRunError,
	runBackup,
	type BackupRunDeps,
	type BackupRunEnv,
	type BackupRunErrorCode,
	type BackupRunInput,
	type BackupRunResult
} from './run.ts';
