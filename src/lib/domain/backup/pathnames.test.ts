import { describe, expect, it } from 'vitest';
import { BACKUP_PREFIX, backupPathname, parseBackupPathname } from './pathnames';

const at = (iso: string) => new Date(iso);

describe('backupPathname', () => {
	it('names a backup by its UTC second under backups/YYYY/MM/DD', () => {
		expect(backupPathname(at('2026-11-07T10:41:05.987Z'))).toBe(
			'backups/2026/11/07/coach-20261107T104105Z.pcbk'
		);
		expect(backupPathname(at('2026-11-07T10:41:05.987Z')).startsWith(BACKUP_PREFIX)).toBe(true);
	});

	it('uses the UTC day, not the local one', () => {
		expect(backupPathname(at('2026-11-07T23:30:00-08:00'))).toBe(
			'backups/2026/11/08/coach-20261108T073000Z.pcbk'
		);
	});

	it('refuses an invalid date', () => {
		expect(() => backupPathname(new Date(Number.NaN))).toThrow(RangeError);
		expect(() => backupPathname(at('0999-01-01T00:00:00Z'))).toThrow(RangeError);
	});
});

describe('parseBackupPathname', () => {
	it.each([
		['the end of a month', '2026-01-31T23:59:59Z', '2026-01-31', '2026-01'],
		['the start of a month', '2026-02-01T00:00:00Z', '2026-02-01', '2026-02'],
		['the end of a year', '2025-12-31T23:59:59Z', '2025-12-31', '2025-12'],
		['the start of a year', '2026-01-01T00:00:00Z', '2026-01-01', '2026-01'],
		['a leap day', '2028-02-29T10:41:00Z', '2028-02-29', '2028-02'],
		['the day after a leap day', '2028-03-01T00:00:01Z', '2028-03-01', '2028-03']
	])('round-trips %s', (_, iso, day, month) => {
		const name = backupPathname(at(iso));
		expect(parseBackupPathname(name)).toEqual({
			pathname: name,
			createdAt: at(iso),
			day,
			month
		});
	});

	it.each([
		['a relative segment', 'backups/2026/11/../11/coach-20261107T104100Z.pcbk'],
		['a leading ../', '../backups/2026/11/07/coach-20261107T104100Z.pcbk'],
		['a trailing traversal', 'backups/2026/11/07/coach-20261107T104100Z.pcbk/..'],
		['a leading slash', '/backups/2026/11/07/coach-20261107T104100Z.pcbk'],
		['a foreign prefix', 'other/2026/11/07/coach-20261107T104100Z.pcbk'],
		['a nested prefix', 'tmp/backups/2026/11/07/coach-20261107T104100Z.pcbk'],
		['another file name', 'backups/2026/11/07/dump-20261107T104100Z.pcbk'],
		['a wrong extension', 'backups/2026/11/07/coach-20261107T104100Z.json'],
		['a double extension', 'backups/2026/11/07/coach-20261107T104100Z.pcbk.gz'],
		['an upper-case extension', 'backups/2026/11/07/coach-20261107T104100Z.PCBK'],
		["a lower-case 'z'", 'backups/2026/11/07/coach-20261107T104100z.pcbk'],
		["a lower-case 't'", 'backups/2026/11/07/coach-20261107t104100Z.pcbk'],
		['milliseconds', 'backups/2026/11/07/coach-20261107T104100.123Z.pcbk'],
		['a folder for another day', 'backups/2026/11/06/coach-20261107T104100Z.pcbk'],
		['a folder for another month', 'backups/2026/10/07/coach-20261107T104100Z.pcbk'],
		['Feb 29 in a common year', 'backups/2026/02/29/coach-20260229T104100Z.pcbk'],
		['month 13', 'backups/2026/13/01/coach-20261301T104100Z.pcbk'],
		['day 00', 'backups/2026/11/00/coach-20261100T104100Z.pcbk'],
		['hour 24', 'backups/2026/11/07/coach-20261107T240000Z.pcbk'],
		['second 60', 'backups/2026/11/07/coach-20261107T104160Z.pcbk'],
		['a three-digit year', 'backups/0999/11/07/coach-09991107T104100Z.pcbk'],
		['a newline after it', 'backups/2026/11/07/coach-20261107T104100Z.pcbk\n'],
		['the bare prefix', 'backups/'],
		['the empty string', '']
	])('refuses %s', (_, name) => {
		expect(parseBackupPathname(name)).toBeNull();
	});
});
