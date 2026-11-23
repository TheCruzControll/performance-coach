import { describe, expect, it } from 'vitest';
import type { BackupRunStatus } from './run-log.ts';
import {
	backupSize,
	backupState,
	backupStatusView,
	STALE_AFTER_MS,
	type BackupLog
} from './status.ts';

const NOW = new Date('2026-11-05T18:00:00Z');
const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const TZ = 'America/Los_Angeles';

const log = (
	succeededAgo: number | null,
	last: { status: BackupRunStatus; ago: number } | null = succeededAgo === null
		? null
		: { status: 'succeeded', ago: succeededAgo },
	bytes: number | null = 2_480_000
): BackupLog => ({
	lastSucceeded: succeededAgo === null ? null : { finishedAt: ago(succeededAgo), bytes },
	lastRun: last && { status: last.status, startedAt: ago(last.ago) }
});

const view = (l: BackupLog | null, configured = true) => backupStatusView(l, configured, NOW, TZ);

describe('backupState', () => {
	it('is not_configured whenever backups are off, whatever the log says', () => {
		expect(backupState(log(1 * H), false, NOW)).toBe('not_configured');
		expect(backupState(null, false, NOW)).toBe('not_configured');
	});

	it('is unavailable when the log could not be read', () => {
		expect(backupState(null, true, NOW)).toBe('unavailable');
	});

	it('is never with no run, or with only a skipped or a young running run', () => {
		expect(backupState(log(null), true, NOW)).toBe('never');
		expect(backupState(log(null, { status: 'skipped', ago: H }), true, NOW)).toBe('never');
		expect(backupState(log(null, { status: 'running', ago: 60_000 }), true, NOW)).toBe('never');
	});

	it('is ok up to 36 h after the last success, and stale one millisecond later', () => {
		expect(backupState(log(STALE_AFTER_MS), true, NOW)).toBe('ok');
		expect(backupState(log(STALE_AFTER_MS + 1), true, NOW)).toBe('stale');
	});

	it('is failed when the newest run failed, or was left running past 15 minutes', () => {
		expect(backupState(log(30 * H, { status: 'failed', ago: 6 * H }), true, NOW)).toBe('failed');
		expect(backupState(log(null, { status: 'failed', ago: H }), true, NOW)).toBe('failed');
		expect(backupState(log(30 * H, { status: 'running', ago: 16 * 60_000 }), true, NOW)).toBe(
			'failed'
		);
		expect(backupState(log(30 * H, { status: 'running', ago: 14 * 60_000 }), true, NOW)).toBe('ok');
	});

	it('says stale rather than failed once the last success is over 36 h old', () => {
		expect(backupState(log(40 * H, { status: 'failed', ago: H }), true, NOW)).toBe('stale');
	});

	it('is ok after a skipped run, since another run held the lock', () => {
		expect(backupState(log(7 * H, { status: 'skipped', ago: H }), true, NOW)).toBe('ok');
	});
});

describe('backupStatusView', () => {
	it('says how long ago and how big for an ok backup', () => {
		expect(view(log(6 * H + 59 * 60_000))).toEqual({
			state: 'ok',
			value: '6 h ago · 2.5 MB',
			tone: 'neutral'
		});
		expect(view(log(40 * 60_000)).value).toBe('40 min ago · 2.5 MB');
		expect(view(log(30_000)).value).toBe('just now · 2.5 MB');
		expect(view(log(35 * H, undefined, null)).value).toBe('35 h ago');
	});

	it('reads a finish ahead of this clock as just now, never a negative age', () => {
		expect(view(log(-5 * 60_000)).value).toBe('just now · 2.5 MB');
	});

	it('names the day of the last success, in the owner’s time zone, when backups stopped', () => {
		// 2026-11-04T02:00Z is still Tue 3 Nov in Los Angeles.
		const stopped = NOW.getTime() - new Date('2026-11-04T02:00:00Z').getTime();
		expect(view(log(stopped))).toEqual({
			state: 'stale',
			value: 'None since Tue 3 Nov',
			tone: 'warning'
		});
		expect(backupStatusView(log(stopped), true, NOW, 'UTC').value).toBe('None since Wed 4 Nov');
		expect(backupStatusView(log(stopped), true, NOW, 'Not/AZone').value).toBe(
			'None since Wed 4 Nov'
		);
	});

	it('words every other state, a warning only where backups need the owner', () => {
		expect(view(log(null, { status: 'failed', ago: H }))).toEqual({
			state: 'failed',
			value: 'Last one failed',
			tone: 'warning'
		});
		expect(view(log(null))).toEqual({ state: 'never', value: 'None yet', tone: 'warning' });
		expect(view(null, false)).toEqual({
			state: 'not_configured',
			value: 'Not set up',
			tone: 'neutral'
		});
		expect(view(null)).toEqual({ state: 'unavailable', value: 'Can’t check now', tone: 'neutral' });
	});
});

describe('backupSize', () => {
	it('counts in decimal KB under 1 MB and in MB to one decimal from there', () => {
		expect(backupSize(0)).toBe('1 KB');
		expect(backupSize(840_400)).toBe('840 KB');
		expect(backupSize(999_499)).toBe('999 KB');
		expect(backupSize(999_500)).toBe('1.0 MB');
		expect(backupSize(1_000_000)).toBe('1.0 MB');
		expect(backupSize(2_480_000)).toBe('2.5 MB');
	});
});
