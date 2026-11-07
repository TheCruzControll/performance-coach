import {
	BlobAccessError,
	BlobError,
	BlobNotFoundError,
	BlobServiceNotAvailable,
	BlobServiceRateLimited
} from '@vercel/blob';
import { describe, expect, it, vi } from 'vitest';
import { FAKE_STORE_ID, FAKE_TOKEN, fakeBlob } from '../../../../tests/fixtures/blob-fake.ts';
import { backupPathname } from '../../domain/backup/pathnames.ts';
import { privateHost, vercelBlobStore, type BlobSdk } from './blob-store.ts';
import { BackupStoreError } from './store.ts';

const A = backupPathname(new Date('2026-11-07T10:41:07Z'));
const HOST = `${FAKE_STORE_ID.toLowerCase()}.private.blob.vercel-storage.com`;
const SECRET = FAKE_TOKEN.split('_').at(-1)!;

async function caught(promise: Promise<unknown>): Promise<BackupStoreError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BackupStoreError);
		return error as BackupStoreError;
	}
	throw new Error('Expected a refusal');
}

/** Everything an error carries that a log line could print. */
const printed = (error: Error) =>
	[error.message, error.stack, JSON.stringify(error), String(error), String(error.cause)].join(
		'\n'
	);

describe('vercelBlobStore', () => {
	it('uploads privately, without a suffix or overwrite, as octet-stream, with the token', async () => {
		const fake = fakeBlob();
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		await store.put(A, Buffer.from('sealed'));

		expect(fake.calls).toEqual([
			[
				'put',
				A,
				{
					access: 'private',
					addRandomSuffix: false,
					allowOverwrite: false,
					multipart: false,
					contentType: 'application/octet-stream',
					token: FAKE_TOKEN
				}
			]
		]);
	});

	it('uploads in parts only above 8 MB', async () => {
		const fake = fakeBlob();
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		const eightMb = 8 * 1024 * 1024;
		await store.put(A, Buffer.alloc(eightMb));
		const B = backupPathname(new Date('2026-11-08T10:41:07Z'));
		await store.put(B, Buffer.alloc(eightMb + 1));

		const multipart = fake.calls.map((call) => (call[2] as { multipart: boolean }).multipart);
		expect(multipart).toEqual([false, true]);
	});

	it('reads with the token, from origin, as a private object', async () => {
		const fake = fakeBlob();
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		await store.put(A, Buffer.from('sealed'));
		expect((await store.get(A)).toString()).toBe('sealed');
		expect(fake.calls[1]).toEqual([
			'get',
			A,
			{ access: 'private', useCache: false, token: FAKE_TOKEN }
		]);
	});

	it('follows three cursor pages with the token on each', async () => {
		const fake = fakeBlob({ pageSize: 2 });
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		const names = [1, 2, 3, 4, 5].map((day) =>
			backupPathname(new Date(Date.UTC(2026, 10, day, 10, 41, 7)))
		);
		for (const name of names) fake.objects.set(name, Buffer.from(name));
		fake.calls.length = 0;

		expect((await store.list('backups/')).map((o) => o.pathname)).toEqual(names);
		expect(fake.calls).toEqual([
			['list', { prefix: 'backups/', cursor: undefined, limit: 1000, token: FAKE_TOKEN }],
			['list', { prefix: 'backups/', cursor: '2', limit: 1000, token: FAKE_TOKEN }],
			['list', { prefix: 'backups/', cursor: '4', limit: 1000, token: FAKE_TOKEN }]
		]);
	});

	it('refuses a listing that promises more without a new cursor', async () => {
		const sdk = fakeBlob().sdk;
		const list = vi.fn<BlobSdk['list']>(async () => ({ blobs: [], hasMore: true, cursor: 'same' }));
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...sdk, list } });
		expect((await caught(store.list('backups/'))).code).toBe('store_error');
		expect(list).toHaveBeenCalledTimes(2);
	});

	it('deletes an upload that landed in a public store and refuses it', async () => {
		const fake = fakeBlob({ access: 'public' });
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });

		const error = await caught(store.put(A, Buffer.from('sealed')));
		expect(error.code).toBe('store_not_private');
		const publicUrl = `https://${FAKE_STORE_ID.toLowerCase()}.public.blob.vercel-storage.com/${A}`;
		expect(fake.calls.at(-1)).toEqual(['del', [publicUrl], { token: FAKE_TOKEN }]);
		expect(fake.objects.size).toBe(0);
	});

	it.each([
		`https://${FAKE_STORE_ID.toLowerCase()}.public.blob.vercel-storage.com/${A}`,
		`https://otherstore.private.blob.vercel-storage.com/${A}`,
		`http://${HOST}/${A}`,
		`https://${HOST}.evil.example/${A}`,
		'not a url'
	])('refuses an upload answered with %s', async (url) => {
		const fake = fakeBlob();
		const put = vi.fn<BlobSdk['put']>(async (pathname) => ({
			url,
			downloadUrl: url,
			pathname,
			contentType: 'application/octet-stream',
			contentDisposition: 'attachment',
			etag: '"1"'
		}));
		const del = vi.fn<BlobSdk['del']>(async () => undefined);
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...fake.sdk, put, del } });

		expect((await caught(store.put(A, Buffer.from('x')))).code).toBe('store_not_private');
		expect(del).toHaveBeenCalledExactlyOnceWith([url], { token: FAKE_TOKEN });
	});

	it('refuses a listing that holds a public object', async () => {
		const fake = fakeBlob({ access: 'public' });
		fake.objects.set(A, Buffer.from('x'));
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: fake.sdk });
		expect((await caught(store.list('backups/'))).code).toBe('store_not_private');
	});

	it('sends 250 deletes as 100, 100 and 50 private URLs, one request at a time', async () => {
		const fake = fakeBlob();
		let inFlight = 0;
		const del = vi.fn<BlobSdk['del']>(async () => {
			expect(++inFlight).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
		});
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk: { ...fake.sdk, del } });
		const start = Date.parse('2026-01-01T00:00:00Z');
		const names = Array.from({ length: 250 }, (_, i) =>
			backupPathname(new Date(start + i * 60_000))
		);

		await store.del(names);
		expect(del.mock.calls.map(([urls]) => urls.length)).toEqual([100, 100, 50]);
		expect(del.mock.calls.flatMap(([urls]) => urls)).toEqual(
			names.map((name) => `https://${HOST}/${name}`)
		);
		for (const [, options] of del.mock.calls) expect(options).toEqual({ token: FAKE_TOKEN });
	});

	it.each([
		['not_found', () => new BlobNotFoundError()],
		['access_denied', () => new BlobAccessError()],
		['store_unavailable', () => new BlobServiceNotAvailable()],
		['store_unavailable', () => new BlobServiceRateLimited(3)],
		['already_exists', () => new BlobError('This blob already exists, use `allowOverwrite: true`')],
		['store_error', () => new BlobError(`bad request for ${FAKE_TOKEN}`)],
		['store_error', () => new TypeError(`fetch failed: Bearer ${FAKE_TOKEN}`)],
		['store_error', () => `thrown string ${FAKE_TOKEN}`]
	])('maps an SDK failure to %s without the token', async (code, make) => {
		const thrower = async () => {
			throw make();
		};
		const sdk: BlobSdk = { put: thrower, list: thrower, get: thrower, del: thrower };
		const store = vercelBlobStore({ token: FAKE_TOKEN, sdk });

		for (const call of [
			() => store.put(A, Buffer.from('x')),
			() => store.list('backups/'),
			() => store.get(A),
			() => store.del([A])
		]) {
			const error = await caught(call());
			expect(error.code).toBe(code);
			expect(error.cause).toBeUndefined();
			expect(printed(error)).not.toContain(SECRET);
			expect(printed(error)).not.toContain(FAKE_STORE_ID);
		}
	});

	it('refuses a missing or malformed token without printing it', () => {
		expect(() => vercelBlobStore({ token: '' })).toThrow(
			expect.objectContaining({ code: 'missing_token' })
		);
		const wrong = 'vercel_blob_client_AbC_s3cret';
		try {
			vercelBlobStore({ token: wrong });
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ code: 'invalid_token' });
			expect(printed(error as Error)).not.toContain('s3cret');
		}
		expect(privateHost(FAKE_TOKEN)).toBe(HOST);
	});

	it('stops reading at the cap even when the size header understates the object', async () => {
		const fake = fakeBlob();
		const get: BlobSdk['get'] = async (pathname, options) => {
			const result = await fake.sdk.get(pathname, options);
			if (result?.statusCode === 200) result.blob.size = 1;
			return result;
		};
		fake.objects.set(A, Buffer.alloc(5000));
		const store = vercelBlobStore({ token: FAKE_TOKEN, maxBytes: 4096, sdk: { ...fake.sdk, get } });
		expect((await caught(store.get(A))).code).toBe('too_large');
	});
});
