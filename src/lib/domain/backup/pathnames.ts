/**
 * Where a backup lives in the store: backups/YYYY/MM/DD/coach-YYYYMMDDTHHMMSSZ.pcbk, all in UTC,
 * to the second. The name alone dates a backup, so listing and retention never open a file.
 */

/** The store prefix every backup sits under; list() is called with it. */
export const BACKUP_PREFIX = 'backups/';
export const BACKUP_EXTENSION = '.pcbk';

/** The file's stamp is captured; the folders must repeat it, which the round trip checks. */
const NAME =
	/^backups\/\d{4}\/\d{2}\/\d{2}\/coach-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.pcbk$/;

export interface BackupName {
	pathname: string;
	/** When it was taken, to the second. */
	createdAt: Date;
	/** Its UTC day, 'YYYY-MM-DD'. */
	day: string;
	/** Its UTC month, 'YYYY-MM'. */
	month: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The object name of a backup taken at `date` (milliseconds are dropped). */
export function backupPathname(date: Date): string {
	const ms = date.getTime();
	if (!Number.isFinite(ms)) throw new RangeError('backupPathname needs a valid date');
	const year = date.getUTCFullYear();
	if (year < 1000 || year > 9999) throw new RangeError('backupPathname needs a 4-digit year');
	const [y, mo, d] = [pad(year, 4), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())];
	const [h, mi, s] = [
		pad(date.getUTCHours()),
		pad(date.getUTCMinutes()),
		pad(date.getUTCSeconds())
	];
	return `${BACKUP_PREFIX}${y}/${mo}/${d}/coach-${y}${mo}${d}T${h}${mi}${s}Z${BACKUP_EXTENSION}`;
}

/**
 * The backup a name stands for, or null for anything else: another prefix or extension, a
 * relative segment, a lower-case 'z', a folder that disagrees with the file, or a date that does
 * not exist (Feb 30, hour 24).
 */
export function parseBackupPathname(name: string): BackupName | null {
	const match = NAME.exec(name);
	if (!match) return null;
	const part = (group: number) => Number(match[group]);
	if (part(1) < 1000) return null;
	const createdAt = new Date(Date.UTC(part(1), part(2) - 1, part(3), part(4), part(5), part(6)));
	// Feb 30 or hour 24 roll over to another instant, and other folders name another day.
	if (backupPathname(createdAt) !== name) return null;
	const iso = createdAt.toISOString();
	return { pathname: name, createdAt, day: iso.slice(0, 10), month: iso.slice(0, 7) };
}
