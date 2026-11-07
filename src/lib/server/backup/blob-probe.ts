/**
 * Proves the real private Blob store end to end (`pnpm backup:list --probe`): a random 1 KB
 * object under probes/ is written, read back byte-equal, found in the listing, refused to a GET
 * without the token, and deleted. The object is deleted whichever step fails, and the result
 * counts the operations so the drill can record what a run costs.
 */
import { randomBytes } from 'node:crypto';
import { privateObjectUrl, vercelBlobStore, type BlobSdk } from './blob-store.ts';
import {
	BackupStoreError,
	PROBE_PREFIX,
	isBackupStoreError,
	type BackupStoreErrorCode
} from './store.ts';

export const PROBE_BYTES = 1024;

export type ProbeOperation = 'put' | 'get' | 'list' | 'unauthenticated-get' | 'del';

export interface ProbeResult {
	ok: boolean;
	/** The failure's code when ok is false. */
	code?: BackupStoreErrorCode;
	/** The operation that failed, when one did. */
	failedAt?: ProbeOperation;
	/** Every operation sent to the store or the network, in order. */
	operations: ProbeOperation[];
	/** Milliseconds per operation. */
	durations: Partial<Record<ProbeOperation, number>>;
}

export interface ProbeOptions {
	/** Sends the unauthenticated GET; it must carry no credentials. */
	fetch: typeof fetch;
	sdk?: BlobSdk;
	now?: () => number;
}

export async function probeBlobStore(
	token: string | undefined,
	{ fetch, sdk, now = () => performance.now() }: ProbeOptions
): Promise<ProbeResult> {
	if (!token)
		throw new BackupStoreError('missing_token', 'The probe needs a Blob read-write token');
	const store = vercelBlobStore({ token, sdk });
	const pathname = `${PROBE_PREFIX}${randomBytes(16).toString('hex')}.bin`;
	const body = randomBytes(PROBE_BYTES);
	const result: ProbeResult = { ok: true, operations: [], durations: {} };

	const step = async <T>(operation: ProbeOperation, run: () => Promise<T>): Promise<T> => {
		result.operations.push(operation);
		const started = now();
		try {
			return await run();
		} finally {
			result.durations[operation] = now() - started;
		}
	};

	try {
		await step('put', () => store.put(pathname, body));
		const back = await step('get', () => store.get(pathname));
		if (!back.equals(body)) throw new BackupStoreError('probe_mismatch', 'Read back other bytes');
		const listed = await step('list', () => store.list(PROBE_PREFIX));
		if (!listed.some((object) => object.pathname === pathname && object.size === PROBE_BYTES)) {
			throw new BackupStoreError('probe_mismatch', 'The probe object is not in the listing');
		}
		const status = await step('unauthenticated-get', async () => {
			const response = await fetch(privateObjectUrl(token, pathname), {
				cache: 'no-store',
				credentials: 'omit',
				redirect: 'manual'
			});
			await response.body?.cancel();
			return response.status;
		});
		if (status !== 401 && status !== 403) {
			throw new BackupStoreError(
				'store_not_private',
				`A GET without the token answered ${status}, not 401 or 403`
			);
		}
	} catch (error) {
		// The last operation sent is the one that failed or whose answer was wrong.
		result.ok = false;
		result.failedAt = result.operations.at(-1);
		result.code = isBackupStoreError(error) ? error.code : 'store_error';
	} finally {
		try {
			await step('del', () => store.del([pathname]));
		} catch (error) {
			if (result.ok) {
				result.ok = false;
				result.failedAt = 'del';
				result.code = isBackupStoreError(error) ? error.code : 'store_error';
			}
		}
	}
	return result;
}
