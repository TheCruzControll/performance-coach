/**
 * The backup status Profile shows (M9 'backup-status'): one state from the run log
 * (src/lib/server/db/backup/runs.ts) at a given `now`, and the words its row says. Pure, so every
 * state is unit-tested at a fixed clock; the server makes the label, the page only draws it.
 *
 * - `not_configured`: backups are off (backupConfig or CRON_SECRET), so no run is expected.
 * - `never`: configured, and no run has succeeded or failed yet.
 * - `ok`: the last success finished within STALE_AFTER_MS and nothing has failed since.
 * - `stale`: the last success is older than STALE_AFTER_MS: the nightly cron has stopped.
 * - `failed`: the newest run failed (or was left running past ABANDONED_AFTER_MS).
 * - `unavailable`: the log could not be read in time; it says nothing about the backups.
 */
import { ABANDONED_AFTER_MS, type BackupRunStatus } from './run-log.ts';

/** A daily cron that has missed one run, with 12 h of slack for a late or slow one. */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export const BACKUP_STATES = [
	'not_configured',
	'never',
	'ok',
	'stale',
	'failed',
	'unavailable'
] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

/** The two rows the state is read from: the newest success and the newest run. */
export interface BackupLog {
	lastSucceeded: { finishedAt: Date; bytes: number | null } | null;
	lastRun: { status: BackupRunStatus; startedAt: Date } | null;
}

/** The row's words: `warning` draws the value in the warning tone, always with these words. */
export interface BackupStatusView {
	state: BackupState;
	value: string;
	tone: 'neutral' | 'warning';
}

/** Whether the newest run failed, counting one still `running` past the abandon cutoff. */
function newestFailed(lastRun: BackupLog['lastRun'], now: Date): boolean {
	if (!lastRun) return false;
	if (lastRun.status === 'failed') return true;
	return (
		lastRun.status === 'running' && now.getTime() - lastRun.startedAt.getTime() > ABANDONED_AFTER_MS
	);
}

export function backupState(log: BackupLog | null, configured: boolean, now: Date): BackupState {
	if (!configured) return 'not_configured';
	if (log === null) return 'unavailable';
	const failed = newestFailed(log.lastRun, now);
	if (!log.lastSucceeded) return failed ? 'failed' : 'never';
	if (now.getTime() - log.lastSucceeded.finishedAt.getTime() > STALE_AFTER_MS) return 'stale';
	return failed ? 'failed' : 'ok';
}

/** "just now", "40 min ago" or "6 h ago": an ok backup is at most 36 h old. */
function ago(at: Date, now: Date): string {
	// A finish stamped by a clock ahead of this one reads "just now", never a negative age.
	const minutes = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.floor(minutes / 60)} h ago`;
}

/** "840 KB" or "2.5 MB", in decimal units as the Blob store counts them. */
export function backupSize(bytes: number): string {
	const kb = Math.round(bytes / 1000);
	if (kb < 1000) return `${Math.max(1, kb)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "Tue 3 Nov" in the owner's time zone, or in UTC if the stored zone is not one Intl knows. */
function day(at: Date, timeZone: string): string {
	const options = { weekday: 'short', day: 'numeric', month: 'short' } as const;
	try {
		return at.toLocaleDateString('en-GB', { ...options, timeZone });
	} catch {
		return at.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
	}
}

export function backupStatusView(
	log: BackupLog | null,
	configured: boolean,
	now: Date,
	timeZone: string
): BackupStatusView {
	const state = backupState(log, configured, now);
	const success = log?.lastSucceeded;
	switch (state) {
		case 'ok': {
			const size = success!.bytes === null ? '' : ` · ${backupSize(success!.bytes)}`;
			return { state, value: `${ago(success!.finishedAt, now)}${size}`, tone: 'neutral' };
		}
		case 'stale':
			return { state, value: `None since ${day(success!.finishedAt, timeZone)}`, tone: 'warning' };
		case 'failed':
			return { state, value: 'Last one failed', tone: 'warning' };
		case 'never':
			return { state, value: 'None yet', tone: 'warning' };
		case 'not_configured':
			return { state, value: 'Not set up', tone: 'neutral' };
		case 'unavailable':
			return { state, value: 'Can’t check now', tone: 'neutral' };
	}
}
