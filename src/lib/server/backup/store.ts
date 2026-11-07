/**
 * Where sealed backups are kept. Production uses a private Vercel Blob store (blob-store.ts) and
 * development and tests use a folder (fs-store.ts); both pass one contract suite (store.test.ts).
 *
 * A store holds whole files by name and never interprets them: the run seals a backup into a
 * Buffer before it uploads, so a slow upload can never hold a snapshot open. Names are checked on
 * every call, so no caller can reach outside backups/ and probes/.
 */
import { parseBackupPathname } from '../../domain/backup/pathnames.ts';

/** One stored object, as list() reports it. */
export interface StoredObject {
	pathname: string;
	size: number;
}

export interface BackupStore {
	readonly kind: 'vercel-blob' | 'file';
	/** Writes a new object; an existing name is refused with `already_exists`. */
	put(pathname: string, body: Buffer): Promise<StoredObject>;
	/** Every object whose name starts with `prefix`, sorted by name, after reading every page. */
	list(prefix: string): Promise<StoredObject[]>;
	/** The object's bytes; over the store's cap is `too_large`, a missing one is `not_found`. */
	get(pathname: string): Promise<Buffer>;
	/** Deletes the named objects; names that are already gone are not an error. */
	del(pathnames: readonly string[]): Promise<void>;
}

/**
 * The largest object a store writes or reads back: the run's sealed in-memory buffer has the same
 * cap (backup_too_large), so anything bigger was not written by this app.
 */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/** The probe's objects: probes/<32 hex>.bin, deleted when the probe ends. */
export const PROBE_PREFIX = 'probes/';
const PROBE_NAME = /^probes\/[0-9a-f]{32}\.bin$/;
/** A listing prefix: lower-case folders and digits, so it cannot climb out of the store. */
const PREFIX = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]*$/;

/**
 * - `invalid_pathname`, `invalid_prefix`: not a backup or probe name, or not a safe prefix
 * - `already_exists`: put() was refused because the name is taken (no store overwrites)
 * - `not_found`: get() found no object of that name
 * - `too_large`: the object is over the store's cap
 * - `store_not_private`: the Blob store answered with a public URL, or anyone can read it
 * - `missing_token`, `invalid_token`: no Blob token, or not a read-write token
 * - `access_denied`: the store refused the token
 * - `store_unavailable`: the service is down, rate limited, suspended or the store is gone
 * - `store_error`: any other failure, including a listing that stopped part-way
 * - `probe_mismatch`: the probe read back other bytes, or did not find its object listed
 */
export type BackupStoreErrorCode =
	| 'invalid_pathname'
	| 'invalid_prefix'
	| 'already_exists'
	| 'not_found'
	| 'too_large'
	| 'store_not_private'
	| 'missing_token'
	| 'invalid_token'
	| 'access_denied'
	| 'store_unavailable'
	| 'store_error'
	| 'probe_mismatch';

/**
 * A store refusal. Messages name the operation, the object name and sizes only, never a token or
 * an SDK message, and there is no `cause`, so the error is safe to log whole.
 */
export class BackupStoreError extends Error {
	readonly code: BackupStoreErrorCode;

	constructor(code: BackupStoreErrorCode, message: string) {
		super(message);
		this.name = 'BackupStoreError';
		this.code = code;
	}
}

export function isBackupStoreError(
	error: unknown,
	code?: BackupStoreErrorCode
): error is BackupStoreError {
	return error instanceof BackupStoreError && (code === undefined || error.code === code);
}

/** Whether a store may hold this name: a backup's dated name or a probe's. */
export function isStorePathname(pathname: string): boolean {
	return parseBackupPathname(pathname) !== null || PROBE_NAME.test(pathname);
}

export function assertStorePathname(pathname: string): void {
	if (!isStorePathname(pathname)) {
		throw new BackupStoreError('invalid_pathname', 'Not a backup or probe object name');
	}
}

export function assertStorePrefix(prefix: string): void {
	if (!PREFIX.test(prefix)) throw new BackupStoreError('invalid_prefix', 'Not a listing prefix');
}

export function assertWithinCap(size: number, maxBytes: number, pathname: string): void {
	if (size > maxBytes) {
		throw new BackupStoreError(
			'too_large',
			`${pathname} is ${size} bytes, over the store's cap of ${maxBytes}`
		);
	}
}
