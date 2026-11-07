/**
 * Applies the retention rule (domain/backup/retention.ts: 30 daily, 12 monthly) to a store.
 *
 * Deletion waits for the complete listing: list() reads every page before it returns, so a
 * listing that fails part-way throws here and nothing is deleted. A name that does not parse is
 * never deleted, and neither is anything in `mustKeep` (the backup this run just wrote and read
 * back). If a name in `mustKeep` is missing from the listing, the listing cannot be trusted and
 * nothing is deleted either.
 */
import { BACKUP_PREFIX } from '../../domain/backup/pathnames.ts';
import { RETENTION, selectForDeletion } from '../../domain/backup/retention.ts';
import { BackupStoreError, type BackupStore } from './store.ts';

export interface PruneResult {
	kept: string[];
	deleted: string[];
	/** Names under backups/ that are not backups; left alone. */
	unparseable: string[];
}

export async function pruneBackups(
	store: BackupStore,
	now: Date,
	mustKeep: readonly string[]
): Promise<PruneResult> {
	const names = (await store.list(BACKUP_PREFIX)).map((object) => object.pathname);
	const listed = new Set(names);
	const missing = mustKeep.filter((name) => !listed.has(name));
	if (missing.length > 0) {
		throw new BackupStoreError(
			'store_error',
			`The listing is missing ${missing.length} backup(s) that must be kept; nothing was deleted`
		);
	}
	const selection = selectForDeletion(names, now, RETENTION, mustKeep);
	if (selection.delete.length > 0) await store.del(selection.delete);
	return { kept: selection.keep, deleted: selection.delete, unparseable: selection.unparseable };
}
