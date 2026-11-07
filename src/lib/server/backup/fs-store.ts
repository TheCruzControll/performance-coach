/**
 * A BackupStore in a local folder, for development and tests only (production keeps backups in
 * the private Blob store; the caller that reads BACKUP_DIR refuses this store on Vercel).
 *
 * A put writes a hidden temp file beside the target, syncs it, then publishes it with a hard link,
 * which is an atomic rename that refuses an existing name. The temp file is removed whether or not
 * that worked, so a reader never sees half a backup and a failed write leaves nothing behind.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
	BackupStoreError,
	MAX_OBJECT_BYTES,
	assertStorePathname,
	assertStorePrefix,
	assertWithinCap,
	type BackupStore,
	type StoredObject
} from './store.ts';

export interface FileStoreOptions {
	/** The folder that holds backups/ and probes/; created on the first put. */
	dir: string;
	/** The cap on put() and get(); MAX_OBJECT_BYTES by default. */
	maxBytes?: number;
}

const TEMP_PREFIX = '.tmp-';

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

export function fileStore({ dir, maxBytes = MAX_OBJECT_BYTES }: FileStoreOptions): BackupStore {
	const root = path.resolve(dir);
	/** Names are checked first, so the joined path always stays under root. */
	const fileOf = (pathname: string) => path.join(root, ...pathname.split('/'));

	return {
		kind: 'file',

		async put(pathname, body) {
			assertStorePathname(pathname);
			assertWithinCap(body.byteLength, maxBytes, pathname);
			const target = fileOf(pathname);
			await mkdir(path.dirname(target), { recursive: true });
			const temp = path.join(path.dirname(target), `${TEMP_PREFIX}${randomUUID()}`);
			try {
				const handle = await open(temp, 'wx');
				try {
					await handle.writeFile(body);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await link(temp, target);
			} catch (error) {
				if (errorCode(error) === 'EEXIST') {
					throw new BackupStoreError('already_exists', `${pathname} already exists`);
				}
				throw error;
			} finally {
				await unlink(temp).catch(() => undefined);
			}
			return { pathname, size: body.byteLength };
		},

		async list(prefix) {
			assertStorePrefix(prefix);
			let entries;
			try {
				entries = await readdir(root, { recursive: true, withFileTypes: true });
			} catch (error) {
				if (errorCode(error) === 'ENOENT') return [];
				throw error;
			}
			const found: StoredObject[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || entry.name.startsWith(TEMP_PREFIX)) continue;
				const file = path.join(entry.parentPath, entry.name);
				const pathname = path.relative(root, file).split(path.sep).join('/');
				if (!pathname.startsWith(prefix)) continue;
				found.push({ pathname, size: (await stat(file)).size });
			}
			return found.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
		},

		async get(pathname) {
			assertStorePathname(pathname);
			const file = fileOf(pathname);
			try {
				assertWithinCap((await stat(file)).size, maxBytes, pathname);
				return await readFile(file);
			} catch (error) {
				if (errorCode(error) === 'ENOENT') {
					throw new BackupStoreError('not_found', `${pathname} does not exist`);
				}
				throw error;
			}
		},

		async del(pathnames) {
			for (const pathname of pathnames) assertStorePathname(pathname);
			for (const pathname of pathnames) {
				await unlink(fileOf(pathname)).catch((error: unknown) => {
					if (errorCode(error) !== 'ENOENT') throw error;
				});
			}
		}
	};
}
