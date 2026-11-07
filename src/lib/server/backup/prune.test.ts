import { describe, expect, it, vi } from 'vitest';
import { FAKE_TOKEN, fakeBlob } from '../../../../tests/fixtures/blob-fake.ts';
import { backupPathname } from '../../domain/backup/pathnames.ts';
import { selectForDeletion } from '../../domain/backup/retention.ts';
import { vercelBlobStore, type BlobSdk } from './blob-store.ts';
import { pruneBackups } from './prune.ts';

const NOW = new Date('2026-11-07T10:41:07Z');
const HOUR = 3_600_000;

/**
 * 400 backups: 397 taken every 31 hours back from NOW, so some days have none, plus three that
 * double up a day (today, yesterday and one in a month only the monthly rule reaches).
 */
const NAMES = [
	...Array.from({ length: 397 }, (_, i) => new Date(NOW.getTime() - i * 31 * HOUR)),
	new Date(NOW.getTime() - HOUR),
	new Date(NOW.getTime() - 32 * HOUR),
	new Date('2026-03-31T23:59:59Z')
]
	.map(backupPathname)
	.sort();
const NEWEST = backupPathname(NOW);

/**
 * The rule worked out from the names alone: the newest backup of each of the 30 UTC days up to
 * today, and the earliest of each of the 12 UTC months up to this one.
 */
function oracle(names: readonly string[]): Set<string> {
	const day = (name: string) => name.slice('backups/'.length, 'backups/YYYY/MM/DD'.length);
	const month = (name: string) => name.slice('backups/'.length, 'backups/YYYY/MM'.length);
	const days = Array.from({ length: 30 }, (_, i) =>
		new Date(NOW.getTime() - i * 24 * HOUR).toISOString().slice(0, 10).replaceAll('-', '/')
	);
	const months = Array.from({ length: 12 }, (_, i) =>
		new Date(Date.UTC(2026, 10 - i, 1)).toISOString().slice(0, 7).replaceAll('-', '/')
	);
	const keep = new Set<string>();
	for (const d of days) {
		const newest = names.filter((name) => day(name) === d).at(-1);
		if (newest) keep.add(newest);
	}
	for (const m of months) {
		const earliest = names.find((name) => month(name) === m);
		if (earliest) keep.add(earliest);
	}
	return keep;
}
const UNPARSEABLE = [
	'backups/2026/11/07/coach-20261107T104107Z.pcbk.partial',
	'backups/notes.txt',
	'backups/2026/02/30/coach-20260230T000000Z.pcbk'
];

function seeded(pageSize = 1000) {
	const fake = fakeBlob({ pageSize });
	for (const name of [...NAMES, ...UNPARSEABLE]) fake.objects.set(name, Buffer.from('x'));
	fake.calls.length = 0;
	return fake;
}

describe('pruneBackups', () => {
	it('deletes exactly what retention selects from 400 backups, and nothing else', async () => {
		const fake = seeded(150);
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		const keep = oracle(NAMES);

		const result = await pruneBackups(store, NOW, [NEWEST]);

		expect(result.kept).toEqual(NAMES.filter((name) => keep.has(name)));
		expect(result.deleted).toEqual(NAMES.filter((name) => !keep.has(name)));
		expect(result.unparseable).toEqual([...UNPARSEABLE].sort());
		expect(new Set(fake.objects.keys())).toEqual(new Set([...keep, ...UNPARSEABLE]));
		// 23 of the last 30 days have a backup, and the 11 months before this one add their
		// earliest (this month's earliest is already a day's newest).
		expect(result.kept).toHaveLength(34);
		expect(result.kept).toContain(NEWEST);
		// Today's earlier backup and the last of March go: only the day's newest and the
		// month's earliest are kept.
		expect(result.deleted).toContain(backupPathname(new Date(NOW.getTime() - HOUR)));
		expect(result.deleted).toContain(backupPathname(new Date('2026-03-31T23:59:59Z')));
		// Every page was read before the first delete.
		const methods = fake.calls.map(([method]) => method);
		expect(methods.indexOf('del')).toBe(methods.lastIndexOf('list') + 1);
		expect(methods.filter((m) => m === 'list')).toHaveLength(3);
	});

	it('deletes nothing when the listing fails on page 2', async () => {
		const fake = seeded(150);
		let pages = 0;
		const list: BlobSdk['list'] = async (options) => {
			if (++pages === 2) throw new Error('connection reset');
			return fake.sdk.list(options);
		};
		const del = vi.fn<BlobSdk['del']>(fake.sdk.del);
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...fake.sdk, list, del } });

		await expect(pruneBackups(store, NOW, [NEWEST])).rejects.toMatchObject({ code: 'store_error' });
		expect(del).not.toHaveBeenCalled();
		expect(fake.objects.size).toBe(NAMES.length + UNPARSEABLE.length);
	});

	it('deletes nothing when the backup it must keep is missing from the listing', async () => {
		const fake = seeded();
		fake.objects.delete(NEWEST);
		const del = vi.fn<BlobSdk['del']>(fake.sdk.del);
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...fake.sdk, del } });

		await expect(pruneBackups(store, NOW, [NEWEST])).rejects.toMatchObject({ code: 'store_error' });
		expect(del).not.toHaveBeenCalled();
	});

	it('keeps a mustKeep backup that retention alone would delete', async () => {
		const fake = seeded();
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		const old = NAMES[0]!;
		expect(selectForDeletion(NAMES, NOW).delete).toContain(old);

		const result = await pruneBackups(store, NOW, [NEWEST, old]);
		expect(result.kept).toContain(old);
		expect(fake.objects.has(old)).toBe(true);
	});

	it('sends no delete when nothing is due', async () => {
		const fake = fakeBlob();
		fake.objects.set(NEWEST, Buffer.from('x'));
		const del = vi.fn<BlobSdk['del']>(fake.sdk.del);
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...fake.sdk, del } });

		expect(await pruneBackups(store, NOW, [NEWEST])).toEqual({
			kept: [NEWEST],
			deleted: [],
			unparseable: []
		});
		expect(del).not.toHaveBeenCalled();
	});
});
