/**
 * One backup run (M9 'export first, upload after commit'), safe to start at any time:
 *
 * 1. Export: on its own connection (backupClient), every table is read in one REPEATABLE READ
 *    transaction under the single-flight lock (already_running when another run holds it), then
 *    gzipped and sealed into a BoundedBuffer in memory (backup_too_large over the cap). The
 *    transaction has committed and the connection is closed before anything leaves the process,
 *    so a slow upload can never hold the snapshot open.
 * 2. Upload: store.put of the sealed bytes under backupPathname(now).
 * 3. Read back: store.get, then the same bytes, a GCM tag that verifies, an archive that proves
 *    its own completeness and the export's counts and digests. Anything else deletes the object
 *    (read_back_mismatch, or read_back_failed when it could not be read), so an unverified file
 *    never counts as a backup.
 * 4. Prune: retention (30 daily, 12 monthly), keeping the new file whatever the listing says.
 *
 * Nothing old is pruned unless steps 1 to 3 succeeded. Each phase logs one line of durations and
 * sizes. A failure goes to the caller's `record` with kind 'cron' and its code (the app passes
 * recordServerError, so app_errors), except already_running: another run is doing the same work
 * (a doubled cron is absorbed, M9 plan).
 *
 * The operator CLI imports this under plain Node (M9 plan: script-imported modules use relative
 * .ts specifiers), so its runtime imports name .ts files and it never imports the app's database
 * module; scripts/backup-node.test.ts proves it.
 *
 * Decision: a prune that fails is recorded (prune_failed) but does not fail the run, because the
 * new backup is already made and verified; the result then has `pruned: null`.
 *
 * Logs and app_errors carry codes, names, sizes and durations only: the key is never read here
 * except through backupConfig's opaque BackupKey, and no row passes through JavaScript as a value.
 */
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { backupPathname } from '../../../domain/backup/pathnames.ts';
import type { BackupTrailer } from '../../../domain/backup/format.ts';
import { ArchiveWriter, readArchive } from '../../backup/archive.ts';
import { vercelBlobStore } from '../../backup/blob-store.ts';
import { backupConfig, type BackupEnv, type BackupStoreConfig } from '../../backup/config.ts';
import { openEnvelope, sealStream } from '../../backup/envelope.ts';
import { isBackupError } from '../../backup/errors.ts';
import { fileStore } from '../../backup/fs-store.ts';
import type { BackupKey } from '../../backup/key.ts';
import { pruneBackups, type PruneResult } from '../../backup/prune.ts';
import { MAX_OBJECT_BYTES, type BackupStore } from '../../backup/store.ts';
import { backupClient } from '../../db/backup/connect.ts';
import { exportDatabase } from '../../db/backup/export.ts';
import { BackupExportError } from '../../db/backup/tables.ts';
import { logger } from '../../observability/logger.ts';
import type { ServerErrorInput } from '../errors.ts';
import { BoundedBuffer, BufferCapError } from './bounded-buffer.ts';

/**
 * The largest sealed backup a run holds in memory: the stores' own cap. A backup is a few MB; if
 * one ever nears this, the next step is a multipart upload from a temp file, still after COMMIT.
 */
export const BACKUP_BUFFER_CAP = MAX_OBJECT_BYTES;

/**
 * - `backup_not_configured`: backupConfig is off (`detail` names the variables, never a value)
 * - `already_running`: another run holds the export's lock; not recorded in app_errors
 * - `export_failed`: connecting, reading or sealing failed
 * - `backup_too_large`: the sealed backup went over the buffer's cap; nothing was uploaded
 * - `upload_failed`: store.put failed
 * - `read_back_failed`: store.get failed; the object was deleted
 * - `read_back_mismatch`: the object read back is not the backup written; it was deleted
 * - `prune_failed`: recorded only; the run itself succeeded
 * - `backup_failed`: anything unexpected
 */
export type BackupRunErrorCode =
	| 'backup_not_configured'
	| 'already_running'
	| 'export_failed'
	| 'backup_too_large'
	| 'upload_failed'
	| 'read_back_failed'
	| 'read_back_mismatch'
	| 'prune_failed'
	| 'backup_failed';

/** The HTTP status a caller answers with, and app_errors records. */
const STATUS: Partial<Record<BackupRunErrorCode, number>> = {
	backup_not_configured: 503,
	already_running: 409
};

/** A run that did not make a backup. Its message, detail and cause are safe to log whole. */
export class BackupRunError extends Error {
	readonly code: BackupRunErrorCode;
	/** Names and flags only (the missing variables, whether a bad object was deleted). */
	readonly detail: Record<string, unknown>;

	constructor(
		code: BackupRunErrorCode,
		message: string,
		{ cause, detail = {} }: { cause?: unknown; detail?: Record<string, unknown> } = {}
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'BackupRunError';
		this.code = code;
		this.detail = detail;
	}

	get status(): number {
		return STATUS[this.code] ?? 500;
	}
}

export function isBackupRunError(
	error: unknown,
	code?: BackupRunErrorCode
): error is BackupRunError {
	return error instanceof BackupRunError && (code === undefined || error.code === code);
}

/** The parsed environment's fields a run reads. */
export interface BackupRunEnv extends BackupEnv {
	/** The database to back up; the export needs SELECT only. */
	DATABASE_URL: string;
}

export interface BackupRunInput {
	/** When the backup is taken: its name, its header's createdAt and retention's today. */
	now: Date;
	trigger: 'cron' | 'manual';
	env: BackupRunEnv;
	/** The running build's version, recorded in the header and with a failure. */
	appVersion: string;
	requestId?: string;
}

export interface BackupRunDeps {
	/** Replaces the store backupConfig chooses (tests). */
	store?: BackupStore;
	/** The buffer's cap; BACKUP_BUFFER_CAP by default. */
	maxBytes?: number;
	/**
	 * Where a failure is recorded; it must not throw. The app passes recordServerError (app_errors);
	 * the CLI, which cannot load the app's database module, its own.
	 */
	record: (failure: ServerErrorInput) => Promise<unknown>;
}

export interface BackupRunResult {
	pathname: string;
	/** The sealed file's size and SHA-256 (hex), as stored. */
	bytes: number;
	sha256: string;
	tables: number;
	rows: number;
	durationMs: number;
	phases: { export: number; upload: number; readBack: number; prune: number };
	/** null when the prune failed (recorded as prune_failed). */
	pruned: PruneResult | null;
}

export async function runBackup(
	input: BackupRunInput,
	deps: BackupRunDeps
): Promise<BackupRunResult> {
	try {
		return await run(input, deps);
	} catch (error) {
		const failure = isBackupRunError(error)
			? error
			: new BackupRunError('backup_failed', 'The backup run failed', { cause: error });
		if (failure.code === 'already_running') {
			logger.warn('backup skipped', { trigger: input.trigger, code: failure.code });
		} else {
			await record(failure, input, deps);
		}
		throw failure;
	}
}

async function run(input: BackupRunInput, deps: BackupRunDeps): Promise<BackupRunResult> {
	const started = performance.now();
	const config = backupConfig(input.env);
	if (config.state === 'off') {
		const { missing, invalid } = config;
		throw new BackupRunError(
			'backup_not_configured',
			`Backups are off (missing: ${missing.join(', ') || 'none'}; invalid: ${invalid.join(', ') || 'none'})`,
			{ detail: { missing, invalid } }
		);
	}
	const store = deps.store ?? openStore(config.store);
	const phase = (name: string, since: number, fields: Record<string, unknown>) => {
		const ms = Math.round(performance.now() - since);
		logger.info('backup phase', { trigger: input.trigger, phase: name, ms, ...fields });
		return ms;
	};

	let since = performance.now();
	const { sealed, trailer } = await exportSealed(input, config.key, deps.maxBytes);
	const sha256 = createHash('sha256').update(sealed).digest('hex');
	const tables = Object.keys(trailer.rowCounts).length;
	const rows = Object.values(trailer.rowCounts).reduce((sum, n) => sum + n, 0);
	const exportMs = phase('export', since, { tables, rows, bytes: sealed.length });

	const pathname = backupPathname(input.now);
	since = performance.now();
	try {
		await store.put(pathname, sealed);
	} catch (error) {
		throw new BackupRunError('upload_failed', `The upload of ${pathname} failed`, {
			cause: error
		});
	}
	const uploadMs = phase('upload', since, { pathname, bytes: sealed.length });

	since = performance.now();
	await readBack(store, pathname, config.key, sha256, trailer);
	const readBackMs = phase('read_back', since, { bytes: sealed.length });

	since = performance.now();
	let pruned: PruneResult | null = null;
	try {
		pruned = await pruneBackups(store, input.now, [pathname]);
	} catch (error) {
		await record(
			new BackupRunError('prune_failed', 'Pruning old backups failed', {
				cause: error
			}),
			input,
			deps
		);
	}
	const pruneMs = phase('prune', since, {
		deleted: pruned?.deleted.length ?? null,
		kept: pruned?.kept.length ?? null,
		unparseable: pruned?.unparseable.length ?? null
	});

	return {
		pathname,
		bytes: sealed.length,
		sha256,
		tables,
		rows,
		durationMs: Math.round(performance.now() - started),
		phases: { export: exportMs, upload: uploadMs, readBack: readBackMs, prune: pruneMs },
		pruned
	};
}

function openStore(config: BackupStoreConfig): BackupStore {
	return config.kind === 'blob'
		? vercelBlobStore({ token: config.token })
		: fileStore({ dir: config.dir });
}

/**
 * Step 1: the sealed backup and its trailer. The connection is closed before this returns, and
 * the transaction has ended with it. When the buffer overflows, the export still reads to its
 * end (bounded by its own timeouts) while the destroyed streams drop what it writes.
 */
async function exportSealed(
	input: BackupRunInput,
	key: BackupKey,
	maxBytes = BACKUP_BUFFER_CAP
): Promise<{ sealed: Buffer; trailer: BackupTrailer }> {
	let client;
	try {
		client = await backupClient(input.env.DATABASE_URL);
	} catch (error) {
		throw new BackupRunError('export_failed', 'The export could not connect', { cause: error });
	}
	try {
		const writer = new ArchiveWriter();
		const sink = new BoundedBuffer(maxBytes);
		// Settled into a value at once, so a failure while the export runs is never unhandled.
		const sealing = pipeline(writer.output, sealStream(key), sink).then(
			() => null,
			(error: unknown) => error
		);
		let trailer: BackupTrailer;
		try {
			({ trailer } = await exportDatabase(client, writer, {
				appVersion: input.appVersion,
				now: () => input.now
			}));
		} catch (error) {
			writer.output.destroy();
			await sealing;
			if (error instanceof BackupExportError && error.code === 'already_running') {
				throw new BackupRunError('already_running', 'Another backup run is in progress');
			}
			throw new BackupRunError('export_failed', 'The export failed', { cause: error });
		}
		const failure = await sealing;
		if (failure instanceof BufferCapError) {
			throw new BackupRunError(
				'backup_too_large',
				`The sealed backup is over its ${maxBytes}-byte cap; nothing was uploaded`,
				{ cause: failure }
			);
		}
		if (failure !== null) {
			throw new BackupRunError('export_failed', 'Sealing the export failed', { cause: failure });
		}
		return { sealed: sink.contents(), trailer };
	} finally {
		await client.end().catch(() => undefined);
	}
}

/** Step 3: proves the stored object is the backup written, or deletes it and fails. */
async function readBack(
	store: BackupStore,
	pathname: string,
	key: BackupKey,
	sha256: string,
	trailer: BackupTrailer
): Promise<void> {
	const discard = async () => {
		try {
			await store.del([pathname]);
			return true;
		} catch (error) {
			logger.warn('backup discard failed', { pathname, err: error });
			return false;
		}
	};
	let stored: Buffer;
	try {
		stored = await store.get(pathname);
	} catch (error) {
		const discarded = await discard();
		throw new BackupRunError('read_back_failed', `${pathname} could not be read back`, {
			cause: error,
			detail: { discarded }
		});
	}
	const problem = verify(stored, key, sha256, trailer);
	if (problem !== null) {
		const discarded = await discard();
		throw new BackupRunError('read_back_mismatch', `${pathname} read back ${problem}`, {
			detail: { discarded }
		});
	}
}

/** Why `stored` is not the backup written, or null when it is. */
function verify(
	stored: Buffer,
	key: BackupKey,
	sha256: string,
	trailer: BackupTrailer
): string | null {
	if (createHash('sha256').update(stored).digest('hex') !== sha256) return 'with other bytes';
	let read: BackupTrailer;
	try {
		read = readArchive(openEnvelope(key, stored)).trailer;
	} catch (error) {
		if (isBackupError(error)) return `and failed to open (${error.code})`;
		throw error;
	}
	const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(([name, value]) => b[name] === value);
	if (
		read.sha256 !== trailer.sha256 ||
		!same(read.rowCounts, trailer.rowCounts) ||
		!same(read.tableDigests, trailer.tableDigests)
	) {
		return 'with other counts or digests';
	}
	return null;
}

async function record(
	error: BackupRunError,
	input: BackupRunInput,
	deps: BackupRunDeps
): Promise<void> {
	await deps.record({
		error,
		kind: 'cron',
		status: error.status,
		requestId: input.requestId,
		appVersion: input.appVersion,
		context: { code: error.code, trigger: input.trigger, ...error.detail }
	});
}
