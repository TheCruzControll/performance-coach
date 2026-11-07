/**
 * The production BackupStore: a private Vercel Blob store, and the only importer of @vercel/blob
 * (eslint.config.js). Every call passes the read-write token explicitly, so the SDK never falls
 * back to whatever the environment holds.
 *
 * A backup must never be readable without the token. Each upload is checked against the store's
 * private host, <store-id>.private.blob.vercel-storage.com; an object that landed anywhere else
 * (a public store) is deleted at once and the upload is refused with `store_not_private`. The
 * probe (blob-probe.ts) proves the same end to end with an unauthenticated GET.
 */
import {
	BlobAccessError,
	BlobClientTokenExpiredError,
	BlobError,
	BlobNotFoundError,
	BlobServiceNotAvailable,
	BlobServiceRateLimited,
	BlobStoreNotFoundError,
	BlobStoreSuspendedError,
	del,
	get,
	list,
	put,
	type DeleteCommandOptions,
	type GetBlobResult,
	type GetCommandOptions,
	type ListBlobResult,
	type ListCommandOptions,
	type PutBlobResult,
	type PutCommandOptions
} from '@vercel/blob';
import {
	BackupStoreError,
	MAX_OBJECT_BYTES,
	assertStorePathname,
	assertStorePrefix,
	assertWithinCap,
	type BackupStore,
	type BackupStoreErrorCode,
	type StoredObject
} from './store.ts';

/** The four SDK calls the store makes; tests pass a fake with Blob's semantics. */
export interface BlobSdk {
	put(pathname: string, body: Buffer, options: PutCommandOptions): Promise<PutBlobResult>;
	list(options: ListCommandOptions): Promise<ListBlobResult>;
	get(pathname: string, options: GetCommandOptions): Promise<GetBlobResult | null>;
	del(urls: string[], options: DeleteCommandOptions): Promise<void>;
}

const SDK: BlobSdk = { put, list: (options) => list(options), get, del };

/** Above this, put() uploads in parts, which the SDK retries one by one. */
export const MULTIPART_ABOVE_BYTES = 8 * 1024 * 1024;
/** The most names one delete request carries. */
export const DELETE_BATCH = 100;
/** Blob's largest listing page. */
const PAGE_LIMIT = 1000;

/** A read-write token is vercel_blob_rw_<store id>_<secret>. */
const TOKEN = /^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/;

export interface VercelBlobStoreOptions {
	/** BLOB_READ_WRITE_TOKEN of the private store. */
	token: string;
	/** The cap on put() and get(); MAX_OBJECT_BYTES by default. */
	maxBytes?: number;
	sdk?: BlobSdk;
}

/** The store's private host, from its read-write token. */
export function privateHost(token: string): string {
	const storeId = TOKEN.exec(token)?.[1];
	if (!storeId) {
		throw new BackupStoreError('invalid_token', 'The Blob token is not a read-write token');
	}
	return `${storeId.toLowerCase()}.private.blob.vercel-storage.com`;
}

/** The URL of an object in the private store; it answers only with the token. */
export function privateObjectUrl(token: string, pathname: string): string {
	return `https://${privateHost(token)}/${pathname}`;
}

function isOnHost(url: string, host: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.hostname === host;
	} catch {
		return false;
	}
}

const SDK_CODES: [new (...args: never[]) => BlobError, BackupStoreErrorCode][] = [
	[BlobNotFoundError, 'not_found'],
	[BlobAccessError, 'access_denied'],
	[BlobClientTokenExpiredError, 'access_denied'],
	[BlobServiceNotAvailable, 'store_unavailable'],
	[BlobServiceRateLimited, 'store_unavailable'],
	[BlobStoreSuspendedError, 'store_unavailable'],
	[BlobStoreNotFoundError, 'store_unavailable']
];

/** An SDK failure as a code; the SDK's message and the error itself are dropped. */
function storeError(error: unknown, operation: string, pathname = ''): BackupStoreError {
	if (error instanceof BackupStoreError) return error;
	let code: BackupStoreErrorCode = 'store_error';
	for (const [type, mapped] of SDK_CODES) if (error instanceof type) code = mapped;
	// Blob answers a taken name with a plain bad_request ("This blob already exists ...").
	if (
		code === 'store_error' &&
		error instanceof BlobError &&
		/already exists/i.test(error.message)
	) {
		code = 'already_exists';
	}
	const name = error instanceof Error ? error.constructor.name : typeof error;
	const target = pathname ? ` ${pathname}` : '';
	return new BackupStoreError(code, `Blob ${operation}${target} failed: ${code} (${name})`);
}

async function readCapped(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	pathname: string
): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			assertWithinCap(size, maxBytes, pathname);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}
	return Buffer.concat(chunks, size);
}

export function vercelBlobStore({
	token,
	maxBytes = MAX_OBJECT_BYTES,
	sdk = SDK
}: VercelBlobStoreOptions): BackupStore {
	if (!token) throw new BackupStoreError('missing_token', 'No Blob read-write token');
	const host = privateHost(token);
	const urlOf = (pathname: string) => `https://${host}/${pathname}`;

	return {
		kind: 'vercel-blob',

		async put(pathname, body) {
			assertStorePathname(pathname);
			assertWithinCap(body.byteLength, maxBytes, pathname);
			let result: PutBlobResult;
			try {
				result = await sdk.put(pathname, body, {
					access: 'private',
					addRandomSuffix: false,
					allowOverwrite: false,
					multipart: body.byteLength > MULTIPART_ABOVE_BYTES,
					contentType: 'application/octet-stream',
					token
				});
			} catch (error) {
				throw storeError(error, 'put', pathname);
			}
			if (!isOnHost(result.url, host)) {
				try {
					await sdk.del([result.url], { token });
				} catch (error) {
					throw storeError(error, 'delete of a public upload', pathname);
				}
				throw new BackupStoreError(
					'store_not_private',
					`${pathname} was stored off the private host and has been deleted`
				);
			}
			return { pathname, size: body.byteLength };
		},

		async list(prefix) {
			assertStorePrefix(prefix);
			const found: StoredObject[] = [];
			const seen = new Set<string>();
			let cursor: string | undefined;
			do {
				let page: ListBlobResult;
				try {
					page = await sdk.list({ prefix, cursor, limit: PAGE_LIMIT, token });
				} catch (error) {
					throw storeError(error, 'list');
				}
				for (const blob of page.blobs) {
					if (!isOnHost(blob.url, host)) {
						throw new BackupStoreError('store_not_private', 'The listing holds a public object');
					}
					found.push({ pathname: blob.pathname, size: blob.size });
				}
				if (!page.hasMore) break;
				// A page that promises more without a new cursor would loop forever.
				if (!page.cursor || seen.has(page.cursor)) {
					throw new BackupStoreError('store_error', 'Blob list returned no new cursor');
				}
				seen.add(page.cursor);
				cursor = page.cursor;
			} while (cursor);
			return found.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
		},

		async get(pathname) {
			assertStorePathname(pathname);
			let result: GetBlobResult | null;
			try {
				result = await sdk.get(pathname, { access: 'private', useCache: false, token });
			} catch (error) {
				throw storeError(error, 'get', pathname);
			}
			if (!result || result.statusCode !== 200) {
				throw new BackupStoreError('not_found', `${pathname} does not exist`);
			}
			if (result.blob.size > maxBytes) {
				await result.stream.cancel().catch(() => undefined);
				assertWithinCap(result.blob.size, maxBytes, pathname);
			}
			try {
				return await readCapped(result.stream, maxBytes, pathname);
			} catch (error) {
				throw storeError(error, 'get', pathname);
			}
		},

		async del(pathnames) {
			for (const pathname of pathnames) assertStorePathname(pathname);
			const urls = pathnames.map(urlOf);
			// One request at a time, so a failure leaves at most one batch in doubt.
			for (let start = 0; start < urls.length; start += DELETE_BATCH) {
				try {
					await sdk.del(urls.slice(start, start + DELETE_BATCH), { token });
				} catch (error) {
					throw storeError(error, 'delete');
				}
			}
		}
	};
}
