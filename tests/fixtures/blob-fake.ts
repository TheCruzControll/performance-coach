/**
 * An in-memory stand-in for the four @vercel/blob calls the backup store makes, with Blob's
 * semantics: a taken name is refused unless allowOverwrite, listings come in pages of at most
 * 1,000 with a cursor, a missing object reads as null, deleting a missing URL is fine, and every
 * URL is on <store id>.<access>.blob.vercel-storage.com. Errors are the SDK's own classes.
 */
import { BlobAccessError, BlobError, type GetBlobResult, type PutBlobResult } from '@vercel/blob';
import type { BlobSdk } from '../../src/lib/server/backup/blob-store.ts';

export const FAKE_STORE_ID = 'AbCdEf0123456789';
export const FAKE_TOKEN = `vercel_blob_rw_${FAKE_STORE_ID}_s3cretPart0123456789`;

export interface FakeBlob {
	sdk: BlobSdk;
	/** pathname → bytes, written by the fake or planted by a test. */
	objects: Map<string, Buffer>;
	/** Every call, in order, as [method, ...args]. */
	calls: [string, ...unknown[]][];
}

export interface FakeBlobOptions {
	access?: 'private' | 'public';
	pageSize?: number;
	storeId?: string;
	token?: string;
}

export function fakeBlob({
	access = 'private',
	pageSize = 1000,
	storeId = FAKE_STORE_ID,
	token = FAKE_TOKEN
}: FakeBlobOptions = {}): FakeBlob {
	const objects = new Map<string, Buffer>();
	const calls: FakeBlob['calls'] = [];
	const base = `https://${storeId.toLowerCase()}.${access}.blob.vercel-storage.com/`;
	const urlOf = (pathname: string) => `${base}${pathname}`;
	const authorise = (options: { token?: string }) => {
		if (options.token !== token) throw new BlobAccessError();
	};

	const sdk: BlobSdk = {
		async put(pathname, body, options) {
			calls.push(['put', pathname, options]);
			authorise(options);
			if (objects.has(pathname) && !options.allowOverwrite) {
				throw new BlobError('This blob already exists, use `allowOverwrite: true` to overwrite.');
			}
			objects.set(pathname, Buffer.from(body));
			const url = urlOf(pathname);
			const result: PutBlobResult = {
				url,
				downloadUrl: `${url}?download=1`,
				pathname,
				contentType: options.contentType ?? 'application/octet-stream',
				contentDisposition: 'attachment',
				etag: '"1"'
			};
			return result;
		},

		async list(options) {
			calls.push(['list', options]);
			authorise(options);
			const names = [...objects.keys()]
				.filter((name) => name.startsWith(options.prefix ?? ''))
				.sort();
			const start = options.cursor ? Number(options.cursor) : 0;
			const limit = Math.min(options.limit ?? 1000, pageSize);
			const page = names.slice(start, start + limit);
			const hasMore = start + limit < names.length;
			return {
				blobs: page.map((pathname) => ({
					url: urlOf(pathname),
					downloadUrl: `${urlOf(pathname)}?download=1`,
					pathname,
					size: objects.get(pathname)!.byteLength,
					uploadedAt: new Date(0),
					etag: '"1"'
				})),
				hasMore,
				cursor: hasMore ? String(start + limit) : undefined
			};
		},

		async get(pathname, options) {
			calls.push(['get', pathname, options]);
			authorise(options);
			const bytes = objects.get(pathname);
			if (!bytes) return null;
			const url = urlOf(pathname);
			const result = {
				statusCode: 200,
				stream: new Blob([new Uint8Array(bytes)]).stream(),
				headers: new Headers() as unknown as GetBlobResult['headers'],
				blob: {
					url,
					downloadUrl: `${url}?download=1`,
					pathname,
					contentDisposition: 'attachment',
					cacheControl: 'private',
					uploadedAt: new Date(0),
					etag: '"1"',
					contentType: 'application/octet-stream',
					size: bytes.byteLength
				}
			} satisfies GetBlobResult;
			return result;
		},

		async del(urls, options) {
			calls.push(['del', urls, options]);
			authorise(options);
			for (const url of urls) {
				if (url.startsWith(base)) objects.delete(url.slice(base.length));
			}
		}
	};

	return { sdk, objects, calls };
}
