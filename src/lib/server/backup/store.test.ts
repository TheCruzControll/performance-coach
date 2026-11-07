/**
 * One contract for every BackupStore: the folder store (development and tests) and the Blob
 * store over an in-memory fake with Blob's semantics (production's adapter, without the network).
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, fakeBlob } from '../../../../tests/fixtures/blob-fake.ts';
import { backupPathname } from '../../domain/backup/pathnames.ts';
import { vercelBlobStore } from './blob-store.ts';
import { fileStore } from './fs-store.ts';
import { isBackupStoreError, type BackupStore } from './store.ts';

interface Harness {
	store: BackupStore;
	/** Writes an object behind the store's back, as another writer would. */
	plant(pathname: string, bytes: Buffer): Promise<void>;
	cleanup(): Promise<void>;
}

const CAP = 4096;

const HARNESSES: [name: string, make: () => Promise<Harness>][] = [
	[
		'fileStore',
		async () => {
			const dir = await mkdtemp(path.join(tmpdir(), 'backup-store-'));
			return {
				store: fileStore({ dir, maxBytes: CAP }),
				async plant(pathname, bytes) {
					const file = path.join(dir, ...pathname.split('/'));
					await mkdir(path.dirname(file), { recursive: true });
					await writeFile(file, bytes);
				},
				cleanup: () => rm(dir, { recursive: true, force: true })
			};
		}
	],
	[
		'vercelBlobStore over a fake Blob',
		async () => {
			const fake = fakeBlob();
			return {
				store: vercelBlobStore({ token: FAKE_TOKEN, maxBytes: CAP, sdk: fake.sdk }),
				async plant(pathname, bytes) {
					fake.objects.set(pathname, bytes);
				},
				cleanup: async () => undefined
			};
		}
	]
];

const at = (iso: string) => backupPathname(new Date(iso));
const A = at('2026-11-07T10:41:07Z');
const B = at('2026-11-08T10:41:07Z');
const PROBE = `probes/${'ab'.repeat(16)}.bin`;

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (isBackupStoreError(error)) return error.code;
		throw error;
	}
	throw new Error('Expected a refusal');
}

for (const [name, make] of HARNESSES) {
	describe(`the ${name} contract`, () => {
		let harness: Harness;
		const setup = async () => {
			harness = await make();
			return harness.store;
		};
		afterEach(() => harness?.cleanup());

		it('round-trips bytes and reports each object once', async () => {
			const store = await setup();
			const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
			expect(await store.put(A, bytes)).toEqual({ pathname: A, size: 6 });
			await store.put(B, Buffer.alloc(0));
			await store.put(PROBE, Buffer.from('probe'));

			expect(await store.get(A)).toEqual(bytes);
			expect(await store.get(B)).toEqual(Buffer.alloc(0));
			expect(await store.list('backups/')).toEqual([
				{ pathname: A, size: 6 },
				{ pathname: B, size: 0 }
			]);
			expect(await store.list('probes/')).toEqual([{ pathname: PROBE, size: 5 }]);
			expect(await store.list('backups/2026/11/08/')).toEqual([{ pathname: B, size: 0 }]);
		});

		it('lists all 1,050 objects across pages', async () => {
			const store = await setup();
			const start = Date.parse('2024-01-01T00:00:00Z');
			const names = Array.from({ length: 1050 }, (_, i) =>
				backupPathname(new Date(start + i * 3_600_000))
			);
			for (const pathname of names) await harness.plant(pathname, Buffer.from('x'));

			const listed = await store.list('backups/');
			expect(listed).toHaveLength(1050);
			expect(listed.map((o) => o.pathname)).toEqual([...names].sort());
		});

		it('refuses to overwrite and keeps the first bytes', async () => {
			const store = await setup();
			await store.put(A, Buffer.from('first'));
			expect(await refusal(store.put(A, Buffer.from('second')))).toBe('already_exists');
			expect((await store.get(A)).toString()).toBe('first');
			expect(await store.list('backups/')).toEqual([{ pathname: A, size: 5 }]);
		});

		it.each([
			'',
			'backups/../../etc/passwd',
			'../outside.pcbk',
			'/backups/2026/11/07/coach-20261107T104107Z.pcbk',
			'backups/2026/11/07/coach-20261107T104107Z.pcbk.tmp',
			'backups/2026/11/08/coach-20261107T104107Z.pcbk',
			'backups\\2026\\11\\07\\coach-20261107T104107Z.pcbk',
			'probes/../backups/x.bin',
			'probes/abc.bin',
			'notes.txt'
		])('refuses the name %j on every call', async (pathname) => {
			const store = await setup();
			expect(await refusal(store.put(pathname, Buffer.from('x')))).toBe('invalid_pathname');
			expect(await refusal(store.get(pathname))).toBe('invalid_pathname');
			expect(await refusal(store.del([pathname]))).toBe('invalid_pathname');
		});

		it.each(['../', '/backups/', 'backups/..', 'Backups/', 'backups//'])(
			'refuses the listing prefix %j',
			async (prefix) => {
				const store = await setup();
				expect(await refusal(store.list(prefix))).toBe('invalid_prefix');
			}
		);

		it('caps get() and put() at the store cap', async () => {
			const store = await setup();
			await harness.plant(A, Buffer.alloc(CAP + 1, 7));
			expect(await refusal(store.get(A))).toBe('too_large');
			expect(await refusal(store.put(B, Buffer.alloc(CAP + 1)))).toBe('too_large');

			await store.put(B, Buffer.alloc(CAP, 1));
			expect((await store.get(B)).byteLength).toBe(CAP);
		});

		it('answers not_found for a missing object, and deleting one is fine', async () => {
			const store = await setup();
			expect(await refusal(store.get(A))).toBe('not_found');
			await store.put(A, Buffer.from('a'));
			await store.put(B, Buffer.from('b'));
			await store.del([A, PROBE]);
			expect(await store.list('backups/')).toEqual([{ pathname: B, size: 1 }]);
			await store.del([]);
		});
	});
}

describe('fileStore', () => {
	it('leaves no temp file behind, whether the write lands or is refused', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'backup-store-'));
		try {
			const store = fileStore({ dir });
			await store.put(A, Buffer.from('first'));
			await expect(store.put(A, Buffer.from('second'))).rejects.toMatchObject({
				code: 'already_exists'
			});
			expect(await readdir(path.join(dir, 'backups/2026/11/07'))).toEqual([path.basename(A)]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('lists nothing before the folder exists', async () => {
		const store = fileStore({ dir: path.join(tmpdir(), `backup-store-missing-${Date.now()}`) });
		expect(await store.list('backups/')).toEqual([]);
	});
});
