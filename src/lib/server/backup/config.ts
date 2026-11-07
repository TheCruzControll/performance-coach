/**
 * Whether backups and the backup cron are on, from four variables read the way the email link
 * reads its own (auth/email-link-config.ts): env.ts parses them leniently (trimmed, blank means
 * unset), so none of them can stop the server. This module decides, and a missing or invalid one
 * switches backups off and is named in the startup log, never its value.
 *
 * - `BACKUP_ENCRYPTION_KEY`: 32 bytes of base64 or base64url (key.ts), held as an opaque BackupKey.
 * - `BLOB_READ_WRITE_TOKEN`: the private Vercel Blob store's read-write token. It wins over
 *   BACKUP_DIR whenever it is set.
 * - `BACKUP_DIR`: a local folder, for development and tests only; invalid on Vercel or in a server
 *   built for Vercel.
 * - `CRON_SECRET`: what Vercel Cron sends as `Bearer <CRON_SECRET>`. Shorter than
 *   MIN_CRON_SECRET_LENGTH is invalid, and the cron endpoint then answers 404. Only its SHA-256
 *   digest leaves this module.
 *
 * Pure and a leaf (eslint.config.js): the caller passes the parsed environment.
 */
import { createHash } from 'node:crypto';
import { isBackupError } from './errors.ts';
import { parseBackupKey, type BackupKey } from './key.ts';

/**
 * The shortest CRON_SECRET accepted. Vercel Cron sends whatever the owner sets, so the guard
 * against a guessable secret is here: 32 characters (`openssl rand -base64 32` gives 44). Owner
 * decision: raise it freely; lowering it weakens the only credential the cron route takes.
 */
export const MIN_CRON_SECRET_LENGTH = 32;

/** A header-safe secret: visible ASCII only, so `Bearer <secret>` is one valid header value. */
const CRON_SECRET_PATTERN = /^[\x21-\x7e]+$/;

/** `vercel_blob_rw_<store id>_<secret>`, as the Vercel dashboard issues it. */
const BLOB_TOKEN_PATTERN = /^vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+$/;

/** No NUL (no file system takes it) and no line breaks (a pasted second line). */
const UNSAFE_DIR = /[\0\r\n]/;

export type BackupVariable = 'BACKUP_ENCRYPTION_KEY' | 'BLOB_READ_WRITE_TOKEN' | 'BACKUP_DIR';

export type BackupStoreConfig = { kind: 'blob'; token: string } | { kind: 'file'; dir: string };

export type BackupConfig =
	| { state: 'on'; key: BackupKey; store: BackupStoreConfig }
	| { state: 'off'; missing: BackupVariable[]; invalid: BackupVariable[] };

export interface CronConfig {
	/** SHA-256 of CRON_SECRET, for a timing-safe comparison with the request's digest. */
	secretDigest: Buffer;
}

/** The fields of env.ts's parsed environment this module reads. */
export interface BackupEnv {
	VERCEL?: boolean;
	VERCEL_ENV?: string;
	CRON_SECRET?: string;
	BACKUP_ENCRYPTION_KEY?: string;
	BLOB_READ_WRITE_TOKEN?: string;
	BACKUP_DIR?: string;
}

/** Replaced at build time by vite.config.ts (see env.ts): `true` in a build for Vercel. */
declare const __VERCEL_BUILD__: boolean | undefined;

function onVercel(env: BackupEnv): boolean {
	if (typeof __VERCEL_BUILD__ !== 'undefined' && __VERCEL_BUILD__) return true;
	return Boolean(env.VERCEL) || env.VERCEL_ENV !== undefined;
}

function readKey(text: string): BackupKey | undefined {
	try {
		return parseBackupKey(text, 'BACKUP_ENCRYPTION_KEY');
	} catch (error) {
		if (isBackupError(error, 'invalid_key')) return undefined;
		throw error;
	}
}

/** Where backups go: the Blob store when its token is set, else BACKUP_DIR off Vercel. */
function readStore(
	env: BackupEnv,
	missing: BackupVariable[],
	invalid: BackupVariable[]
): BackupStoreConfig | undefined {
	const token = env.BLOB_READ_WRITE_TOKEN;
	if (token !== undefined) {
		if (BLOB_TOKEN_PATTERN.test(token)) return { kind: 'blob', token };
		invalid.push('BLOB_READ_WRITE_TOKEN');
		return undefined;
	}
	const dir = env.BACKUP_DIR;
	if (dir === undefined) {
		missing.push('BLOB_READ_WRITE_TOKEN');
		return undefined;
	}
	if (onVercel(env) || UNSAFE_DIR.test(dir)) {
		invalid.push('BACKUP_DIR');
		return undefined;
	}
	return { kind: 'file', dir };
}

/** Whether backups are on, with the key and the store, or which variables keep them off. */
export function backupConfig(env: BackupEnv): BackupConfig {
	const missing: BackupVariable[] = [];
	const invalid: BackupVariable[] = [];

	let key: BackupKey | undefined;
	if (env.BACKUP_ENCRYPTION_KEY === undefined) missing.push('BACKUP_ENCRYPTION_KEY');
	else {
		key = readKey(env.BACKUP_ENCRYPTION_KEY);
		if (key === undefined) invalid.push('BACKUP_ENCRYPTION_KEY');
	}
	const store = readStore(env, missing, invalid);

	if (key === undefined || store === undefined) return { state: 'off', missing, invalid };
	return { state: 'on', key, store };
}

/** Why CRON_SECRET is unusable, or null when it is usable. */
export function cronSecretProblem(env: BackupEnv): 'missing' | 'invalid' | null {
	const secret = env.CRON_SECRET;
	if (secret === undefined) return 'missing';
	if (secret.length < MIN_CRON_SECRET_LENGTH || !CRON_SECRET_PATTERN.test(secret)) {
		return 'invalid';
	}
	return null;
}

/** The cron's secret as a digest, or null while CRON_SECRET is missing or invalid. */
export function cronConfig(env: BackupEnv): CronConfig | null {
	const secret = env.CRON_SECRET;
	if (secret === undefined || cronSecretProblem(env) !== null) return null;
	return { secretDigest: createHash('sha256').update(secret, 'utf8').digest() };
}

/** The startup log's fields: the store or 'off', with the variables' names only. */
export function backupLogFields(env: BackupEnv): Record<string, unknown> {
	const config = backupConfig(env);
	const cron = cronSecretProblem(env);
	return {
		...(config.state === 'on'
			? { backups: config.store.kind }
			: { backups: 'off', backupsMissing: config.missing, backupsInvalid: config.invalid }),
		backupCron: cron === null ? 'on' : 'off',
		...(cron === 'missing' ? { backupCronMissing: ['CRON_SECRET'] } : {}),
		...(cron === 'invalid' ? { backupCronInvalid: ['CRON_SECRET'] } : {})
	};
}
