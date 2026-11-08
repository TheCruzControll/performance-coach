/**
 * How fresh the store's backups are (M9): every backup, newest first, with its age, size and
 * retention bucket, totalled against the Hobby plan's Blob storage. It exits 1 when the newest is
 * older than FRESHNESS_LIMIT_HOURS, or when there is none, so a scheduler or a person sees a
 * missed cron.
 *
 *   BLOB_READ_WRITE_TOKEN='…' pnpm backup:list [--probe]
 *
 * The token comes from the store's page (Vercel → Storage → performance-coach-backups): the
 * Production value is Sensitive and cannot be pulled. BACKUP_DIR lists a local folder store
 * instead (development); the token wins when both are set, as in the app.
 *
 * --probe also proves the real private store end to end (probeBlobStore: about 5 Blob
 * operations) and exits 1 unless it passed; it needs the token and is refused before any request
 * without it.
 */
import { BACKUP_PREFIX, parseBackupPathname } from '../src/lib/domain/backup/pathnames.ts';
import { RETENTION, selectForDeletion } from '../src/lib/domain/backup/retention.ts';
import { probeBlobStore } from '../src/lib/server/backup/blob-probe.ts';
import { privateHost, vercelBlobStore } from '../src/lib/server/backup/blob-store.ts';
import { fileStore } from '../src/lib/server/backup/fs-store.ts';
import { isBackupStoreError, type StoredObject } from '../src/lib/server/backup/store.ts';
import {
	EXIT,
	Refusal,
	isEntry,
	parseCommand,
	runCommand,
	variable
} from './backup/cli-support.ts';

/**
 * The newest backup must be younger than this. The cron runs daily within its hour, so 36 h
 * allows one late run and flags one missed run. Owner decision: one number to change.
 */
export const FRESHNESS_LIMIT_HOURS = 36;

/**
 * Vercel Hobby's included Blob storage, as published on the date below (vercel.com/pricing).
 * Hobby limits are hard: over them the store is blocked until the window resets.
 */
export const HOBBY_BLOB_STORAGE = { bytes: 1_000_000_000, label: '1 GB', checked: '2026-11-07' };

const USAGE = `Usage: BLOB_READ_WRITE_TOKEN=… pnpm backup:list [--probe]

  --probe  also write, read, list, fetch without the token and delete one 1 KB object, proving
           the store is private (about 5 Blob operations)

BACKUP_DIR=<folder> lists a local folder store instead (development).`;

const HOUR_MS = 3_600_000;

function age(ms: number): string {
	const hours = Math.floor(ms / HOUR_MS);
	return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function size(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Which retention rule keeps each backup today, from the policy the cron prunes with. */
function buckets(names: string[], now: Date): (name: string) => string {
	const daily = new Set(selectForDeletion(names, now, { ...RETENTION, monthly: 0 }).keep);
	const monthly = new Set(selectForDeletion(names, now, { ...RETENTION, daily: 0 }).keep);
	return (name) => {
		if (parseBackupPathname(name)!.createdAt > now) return 'dated ahead, kept';
		const kept = [daily.has(name) && 'daily', monthly.has(name) && 'monthly'].filter(Boolean);
		return kept.length > 0 ? kept.join(' + ') : 'deleted by the next prune';
	};
}

/** Prints the listing; true when the newest backup is fresh. */
function report(objects: StoredObject[], now: Date): boolean {
	const backups = objects
		.flatMap((object) => {
			const parsed = parseBackupPathname(object.pathname);
			return parsed ? [{ ...object, createdAt: parsed.createdAt }] : [];
		})
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	const bucket = buckets(
		backups.map((b) => b.pathname),
		now
	);
	for (const backup of backups) {
		console.log(
			[
				backup.createdAt.toISOString().replace('.000', ''),
				age(now.getTime() - backup.createdAt.getTime()).padStart(8),
				size(backup.size).padStart(9),
				bucket(backup.pathname).padEnd(26),
				backup.pathname
			].join('  ')
		);
	}
	for (const other of objects.filter((o) => !parseBackupPathname(o.pathname))) {
		console.log(`Not a backup name (never pruned): ${other.pathname}, ${size(other.size)}`);
	}
	const total = objects.reduce((sum, object) => sum + object.size, 0);
	const share = ((total / HOBBY_BLOB_STORAGE.bytes) * 100).toFixed(1);
	console.log(
		`\nTotal: ${backups.length} backup(s), ${size(total)} of the Hobby plan's ` +
			`${HOBBY_BLOB_STORAGE.label} Blob storage (${share} %, as published ${HOBBY_BLOB_STORAGE.checked}).`
	);
	const newest = backups[0];
	if (!newest) {
		console.error('No backups in the store.');
		return false;
	}
	const ms = now.getTime() - newest.createdAt.getTime();
	if (ms > FRESHNESS_LIMIT_HOURS * HOUR_MS) {
		console.error(
			`Stale: the newest backup is ${age(ms)} old, over the ${FRESHNESS_LIMIT_HOURS} h limit.`
		);
		return false;
	}
	console.log(`Fresh: the newest backup is ${age(ms)} old (limit ${FRESHNESS_LIMIT_HOURS} h).`);
	return true;
}

export async function main(
	argv: string[],
	env: Record<string, string | undefined>
): Promise<number> {
	const flags = parseCommand(
		argv,
		{ probe: { type: 'boolean' }, help: { type: 'boolean' } },
		USAGE
	);
	if (!flags) return EXIT.ok;
	const token = variable(env, 'BLOB_READ_WRITE_TOKEN');
	const dir = variable(env, 'BACKUP_DIR');
	if (flags.probe && !token) {
		throw new Refusal(
			"Refusing to probe: set BLOB_READ_WRITE_TOKEN, copied from the store's page\n" +
				'(Vercel → Storage → performance-coach-backups). Nothing was sent.'
		);
	}
	if (!token && !dir) throw new Refusal(`Refusing to run: set BLOB_READ_WRITE_TOKEN.\n\n${USAGE}`);

	let fresh: boolean;
	try {
		const store = token ? vercelBlobStore({ token }) : fileStore({ dir: dir! });
		console.log(`Store: ${token ? `Vercel Blob ${privateHost(token)}` : `folder ${dir}`}\n`);
		fresh = report(await store.list(BACKUP_PREFIX), new Date());
	} catch (error) {
		if (!isBackupStoreError(error)) throw error;
		console.error(`Listing failed (${error.code}): ${error.message}`);
		return EXIT.failed;
	}
	if (!flags.probe) return fresh ? EXIT.ok : EXIT.failed;

	const probe = await probeBlobStore(token, { fetch: globalThis.fetch });
	const timings = probe.operations.map((op) => `${op} ${Math.round(probe.durations[op] ?? 0)} ms`);
	console.log(`\nProbe: ${probe.operations.length} operations (${timings.join(', ')})`);
	if (!probe.ok) {
		console.error(`Probe failed at ${probe.failedAt} (${probe.code}).`);
		return EXIT.failed;
	}
	console.log('Probe: the store is private, and writes, reads, lists and deletes.');
	return fresh ? EXIT.ok : EXIT.failed;
}

if (isEntry(import.meta.url)) await runCommand(() => main(process.argv.slice(2), process.env));
