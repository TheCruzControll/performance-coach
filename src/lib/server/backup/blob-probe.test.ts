import { describe, expect, it, vi } from 'vitest';
import { FAKE_TOKEN, fakeBlob, type FakeBlob } from '../../../../tests/fixtures/blob-fake.ts';
import { PROBE_BYTES, probeBlobStore } from './blob-probe.ts';
import type { BlobSdk } from './blob-store.ts';

const HOST = 'abcdef0123456789.private.blob.vercel-storage.com';

/** A fetch that answers `status` and records what it was asked. */
function fetchAnswering(status: number) {
	return vi.fn<typeof fetch>(async () => new Response('denied', { status }));
}

function clock() {
	let t = 0;
	return () => (t += 5);
}

const methods = (fake: FakeBlob) => fake.calls.map(([method]) => method);

describe('probeBlobStore', () => {
	it('puts, reads back, lists, is refused without the token, and deletes', async () => {
		const fake = fakeBlob();
		const fetch = fetchAnswering(403);
		const result = await probeBlobStore(FAKE_TOKEN, { fetch, sdk: fake.sdk, now: clock() });

		expect(result).toEqual({
			ok: true,
			operations: ['put', 'get', 'list', 'unauthenticated-get', 'del'],
			durations: { put: 5, get: 5, list: 5, 'unauthenticated-get': 5, del: 5 }
		});
		expect(result.operations).toHaveLength(5);
		expect(methods(fake)).toEqual(['put', 'get', 'list', 'del']);

		const [, pathname, options] = fake.calls[0]!;
		expect(pathname).toMatch(/^probes\/[0-9a-f]{32}\.bin$/);
		expect(options).toMatchObject({ access: 'private', token: FAKE_TOKEN });
		expect(fake.objects.size).toBe(0);

		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(`https://${HOST}/${pathname as string}`);
		expect(init).toEqual({ cache: 'no-store', credentials: 'omit', redirect: 'manual' });
	});

	it('writes 1 KB of fresh random bytes each time', async () => {
		const fake = fakeBlob();
		const bodies: Buffer[] = [];
		const put: BlobSdk['put'] = async (pathname, body, options) => {
			bodies.push(Buffer.from(body));
			return fake.sdk.put(pathname, body, options);
		};
		const sdk = { ...fake.sdk, put };
		await probeBlobStore(FAKE_TOKEN, { fetch: fetchAnswering(401), sdk });
		await probeBlobStore(FAKE_TOKEN, { fetch: fetchAnswering(401), sdk });
		expect(bodies.map((b) => b.byteLength)).toEqual([PROBE_BYTES, PROBE_BYTES]);
		expect(bodies[0]!.equals(bodies[1]!)).toBe(false);
	});

	it.each([200, 206, 302, 404, 500])(
		'fails as store_not_private when a GET without the token answers %i, and still deletes',
		async (status) => {
			const fake = fakeBlob();
			const result = await probeBlobStore(FAKE_TOKEN, {
				fetch: fetchAnswering(status),
				sdk: fake.sdk
			});
			expect(result).toMatchObject({
				ok: false,
				code: 'store_not_private',
				failedAt: 'unauthenticated-get'
			});
			expect(result.operations.at(-1)).toBe('del');
			expect(fake.objects.size).toBe(0);
		}
	);

	it('deletes the object when the read-back differs', async () => {
		const fake = fakeBlob();
		const get: BlobSdk['get'] = async (pathname, options) => {
			fake.objects.set(pathname, Buffer.alloc(PROBE_BYTES));
			return fake.sdk.get(pathname, options);
		};
		const fetch = fetchAnswering(403);
		const result = await probeBlobStore(FAKE_TOKEN, { fetch, sdk: { ...fake.sdk, get } });

		expect(result).toMatchObject({ ok: false, code: 'probe_mismatch', failedAt: 'get' });
		expect(result.operations).toEqual(['put', 'get', 'del']);
		expect(fetch).not.toHaveBeenCalled();
		expect(fake.objects.size).toBe(0);
	});

	it('deletes the object when it is missing from the listing', async () => {
		const fake = fakeBlob();
		const list: BlobSdk['list'] = async () => ({ blobs: [], hasMore: false });
		const result = await probeBlobStore(FAKE_TOKEN, {
			fetch: fetchAnswering(403),
			sdk: { ...fake.sdk, list }
		});
		expect(result).toMatchObject({ ok: false, code: 'probe_mismatch', failedAt: 'list' });
		expect(fake.objects.size).toBe(0);
	});

	it('still tries the delete when the upload itself fails', async () => {
		const fake = fakeBlob();
		const put: BlobSdk['put'] = async () => {
			throw new Error('network down');
		};
		const result = await probeBlobStore(FAKE_TOKEN, {
			fetch: fetchAnswering(403),
			sdk: { ...fake.sdk, put }
		});
		expect(result).toMatchObject({ ok: false, code: 'store_error', failedAt: 'put' });
		expect(result.operations).toEqual(['put', 'del']);
	});

	it('reports a failed delete after every step passed', async () => {
		const fake = fakeBlob();
		const del: BlobSdk['del'] = async () => {
			throw new Error('gone');
		};
		const result = await probeBlobStore(FAKE_TOKEN, {
			fetch: fetchAnswering(403),
			sdk: { ...fake.sdk, del }
		});
		expect(result).toMatchObject({ ok: false, code: 'store_error', failedAt: 'del' });
		expect(result.operations).toHaveLength(5);
	});

	it.each([undefined, ''])('refuses to run without a token (%j)', async (token) => {
		const fetch = fetchAnswering(403);
		await expect(probeBlobStore(token, { fetch })).rejects.toMatchObject({ code: 'missing_token' });
		expect(fetch).not.toHaveBeenCalled();
	});
});
