/**
 * The backup run log's repository (M9 'backup-runs-db'): one row per run in backup_runs (the
 * table is schema/backups.ts; its guards are 0038). A run opens with startRun, finishes once with
 * finishRun, and a run still `running` 15 minutes after it started is expired by expireAbandoned.
 * lastRun, lastSucceeded and recent(n) read the log, newest first. Only codes, counts and the
 * stored object's name are written, never an error message or a row's value.
 *
 * Plain Node: it takes the caller's pg query target and imports only the domain vocabulary, so the
 * operator CLI can log its runs too (M9 plan: script-imported modules use relative .ts specifiers
 * and never the app's database module). Every statement is a constant with its values bound.
 */
import type { ClientBase } from 'pg';
import {
	ABANDONED_AFTER_MS,
	ABANDONED_CODE,
	ERROR_CODE_PATTERN,
	type BackupRunStatus,
	type BackupTrigger
} from '../../../domain/backup/run-log.ts';

/** Anything that runs a query: a client, a pooled client or a pool. */
export type RunLogQueryable = Pick<ClientBase, 'query'>;

export interface BackupRun {
	id: number;
	trigger: BackupTrigger;
	status: BackupRunStatus;
	startedAt: Date;
	finishedAt: Date | null;
	pathname: string | null;
	bytes: number | null;
	sha256: string | null;
	format: string | null;
	schemaTag: string | null;
	appVersion: string | null;
	rowCounts: Record<string, number> | null;
	errorCode: string | null;
}

/** What a run that made and verified a backup stored. */
export interface SucceededOutcome {
	status: 'succeeded';
	pathname: string;
	bytes: number;
	sha256: string;
	format: string;
	schemaTag: string;
	rowCounts: Record<string, number>;
}

/** A run that made no backup: `failed`, or `skipped` when another run already held the lock. */
export interface UnsuccessfulOutcome {
	status: 'failed' | 'skipped';
	/** A short lower-case code (ERROR_CODE_PATTERN), never a message. */
	errorCode: string;
}

export type RunOutcome = SucceededOutcome | UnsuccessfulOutcome;

const INSERT_RUN = `INSERT INTO backup_runs (trigger, status, started_at, app_version)
	VALUES ($1, 'running', $2, $3) RETURNING id`;

/** Finishes only a running row: a finished row matches nothing, so the guard never sees it. */
const FINISH_RUN = `UPDATE backup_runs
	SET status = $2, finished_at = $3, pathname = $4, bytes = $5, sha256 = $6, format = $7,
		schema_tag = $8, row_counts = $9::jsonb, error_code = $10
	WHERE id = $1 AND status = 'running'`;

const EXPIRE_ABANDONED = `UPDATE backup_runs SET status = 'failed', finished_at = $1, error_code = $2
	WHERE status = 'running' AND started_at < $3`;

const SELECT_RUNS = `SELECT id, trigger, status, started_at, finished_at, pathname, bytes, sha256,
	format, schema_tag, app_version, row_counts, error_code FROM backup_runs`;

const ORDER_NEWEST = 'ORDER BY started_at DESC, id DESC';

/** A row as pg returns it: bigint as text. */
interface RunRow {
	id: string;
	trigger: BackupTrigger;
	status: BackupRunStatus;
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
}

function toRun(row: RunRow): BackupRun {
	return {
		id: Number(row.id),
		trigger: row.trigger,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		pathname: row.pathname,
		bytes: row.bytes === null ? null : Number(row.bytes),
		sha256: row.sha256,
		format: row.format,
		schemaTag: row.schema_tag,
		appVersion: row.app_version,
		rowCounts: row.row_counts,
		errorCode: row.error_code
	};
}

export interface StartRunInput {
	trigger: BackupTrigger;
	/** The running build's version, recorded so an abandoned run still says which build ran it. */
	appVersion: string;
	now?: Date;
}

/** Opens a run as `running` and returns its id. */
export async function startRun(
	db: RunLogQueryable,
	{ trigger, appVersion, now = new Date() }: StartRunInput
): Promise<number> {
	const { rows } = await db.query<{ id: string }>(INSERT_RUN, [trigger, now, appVersion]);
	return Number(rows[0]!.id);
}

/**
 * Finishes the run once. True when this call finished it; false when it had finished already
 * (or was never opened), which changes nothing. The error code is checked before it is sent, so a
 * message can never reach the table.
 */
export async function finishRun(
	db: RunLogQueryable,
	id: number,
	outcome: RunOutcome,
	now = new Date()
): Promise<boolean> {
	if (outcome.status !== 'succeeded' && !ERROR_CODE_PATTERN.test(outcome.errorCode)) {
		throw new RangeError('An error code is a short lower-case code, never a message');
	}
	const values =
		outcome.status === 'succeeded'
			? [
					id,
					'succeeded',
					now,
					outcome.pathname,
					outcome.bytes,
					outcome.sha256,
					outcome.format,
					outcome.schemaTag,
					JSON.stringify(outcome.rowCounts),
					null
				]
			: [id, outcome.status, now, null, null, null, null, null, null, outcome.errorCode];
	const result = await db.query(FINISH_RUN, values);
	return result.rowCount === 1;
}

/**
 * Expires every run still `running` that started more than ABANDONED_AFTER_MS before `now`: it
 * becomes `failed` with the code `abandoned`. Returns how many it expired.
 */
export async function expireAbandoned(db: RunLogQueryable, now = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
	const result = await db.query(EXPIRE_ABANDONED, [now, ABANDONED_CODE, cutoff]);
	return result.rowCount ?? 0;
}

/** The newest run, whatever its status, or null when none has ever started. */
export async function lastRun(db: RunLogQueryable): Promise<BackupRun | null> {
	const { rows } = await db.query<RunRow>(`${SELECT_RUNS} ${ORDER_NEWEST} LIMIT 1`);
	return rows[0] ? toRun(rows[0]) : null;
}

/** The newest run that succeeded, or null. */
export async function lastSucceeded(db: RunLogQueryable): Promise<BackupRun | null> {
	const { rows } = await db.query<RunRow>(
		`${SELECT_RUNS} WHERE status = 'succeeded' ${ORDER_NEWEST} LIMIT 1`
	);
	return rows[0] ? toRun(rows[0]) : null;
}

/** The newest `n` runs, newest first. */
export async function recent(db: RunLogQueryable, n: number): Promise<BackupRun[]> {
	if (!Number.isSafeInteger(n) || n < 1) {
		throw new RangeError('recent takes a whole number of runs, at least 1');
	}
	const { rows } = await db.query<RunRow>(`${SELECT_RUNS} ${ORDER_NEWEST} LIMIT $1`, [n]);
	return rows.map(toRun);
}
