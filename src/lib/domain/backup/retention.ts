/**
 * Which backups to keep (PRD §9): the newest of each of the last `daily` UTC days and one of each
 * of the last `monthly` UTC months, both windows counting today. A backup in both windows is
 * kept once. A missed or doubled cron run changes nothing else.
 *
 * Never deleted: a name that does not parse (reported in `unparseable`), a backup dated after
 * `now` (a clock that ran ahead must not cost a backup) and every name in `mustKeep` (the backup
 * just written). The answer depends only on the set of names, not their order.
 */
import { parseBackupPathname, type BackupName } from './pathnames.ts';

export interface RetentionPolicy {
	/** UTC days, today included, whose newest backup is kept. */
	daily: number;
	/** UTC months, this month included, of which one backup is kept. */
	monthly: number;
	/**
	 * Which backup of a month is kept. The owner's default is 'earliest' (a month's backup is its
	 * first); 'newest' keeps the month's last. One word to change here.
	 */
	monthlyKeeps?: 'earliest' | 'newest';
}

/** The policy the daily cron prunes with. */
export const RETENTION = {
	daily: 30,
	monthly: 12,
	monthlyKeeps: 'earliest'
} as const satisfies Required<RetentionPolicy>;

export interface RetentionSelection {
	/** Parseable names kept, oldest first. */
	keep: string[];
	/** Parseable names to delete, oldest first. */
	delete: string[];
	/** Names that are not backups, sorted; never deleted. */
	unparseable: string[];
}

const DAY_MS = 86_400_000;

const dayIndex = (date: Date) => Math.floor(date.getTime() / DAY_MS);
const monthIndex = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

function count(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`Retention ${name} must be a whole number of 0 or more`);
	}
	return value;
}

/** Splits the store's names into those to keep, those to delete and those that are not backups. */
export function selectForDeletion(
	names: readonly string[],
	now: Date,
	policy: RetentionPolicy = RETENTION,
	mustKeep: readonly string[] = []
): RetentionSelection {
	if (!Number.isFinite(now.getTime())) throw new RangeError('selectForDeletion needs a valid now');
	const daily = count(policy.daily, 'daily');
	const monthly = count(policy.monthly, 'monthly');
	const newestOfMonth = (policy.monthlyKeeps ?? RETENTION.monthlyKeeps) === 'newest';

	const backups: BackupName[] = [];
	const unparseable: string[] = [];
	for (const name of new Set(names)) {
		const parsed = parseBackupPathname(name);
		if (parsed) backups.push(parsed);
		else unparseable.push(name);
	}
	// Names sort by time, so this order is chronological and the same for any input order.
	backups.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
	unparseable.sort();

	const today = dayIndex(now);
	const thisMonth = monthIndex(now);
	const kept = new Set<string>(mustKeep);
	const newestOfDay = new Map<number, string>();
	const pickOfMonth = new Map<number, string>();
	for (const backup of backups) {
		if (backup.createdAt.getTime() > now.getTime()) {
			kept.add(backup.pathname);
			continue;
		}
		const day = dayIndex(backup.createdAt);
		if (today - day < daily) newestOfDay.set(day, backup.pathname);
		const month = monthIndex(backup.createdAt);
		if (thisMonth - month < monthly && (newestOfMonth || !pickOfMonth.has(month))) {
			pickOfMonth.set(month, backup.pathname);
		}
	}
	for (const name of newestOfDay.values()) kept.add(name);
	for (const name of pickOfMonth.values()) kept.add(name);

	const keep: string[] = [];
	const remove: string[] = [];
	for (const { pathname } of backups) (kept.has(pathname) ? keep : remove).push(pathname);
	return { keep, delete: remove, unparseable };
}
