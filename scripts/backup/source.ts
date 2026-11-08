/**
 * Where backup:restore reads a sealed backup from: a local file, or one object of the private
 * Vercel Blob store, fetched over HTTPS with the store's read-write token.
 *
 * The token is a credential for every backup the store holds, so a URL is refused before any
 * request unless it is https:// on exactly this token's private host
 * (<store-id>.private.blob.vercel-storage.com, as blob-store.ts derives it), with no port and no
 * credentials of its own. The request never follows a redirect, so the bearer reaches that host
 * only. Nothing over the envelope's cap is read into memory.
 *
 * Imported by path with relative .ts specifiers, so plain Node runs it.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { privateHost } from '../../src/lib/server/backup/blob-store.ts';
import { MAX_ENVELOPE_BYTES } from '../../src/lib/server/backup/envelope.ts';
import { Refusal } from './cli-support.ts';

/** The largest sealed file read, the cap openEnvelope applies: 512 MB. */
export const MAX_SOURCE_BYTES = MAX_ENVELOPE_BYTES;

export type BackupSource =
	{ kind: 'file'; path: string } | { kind: 'blob'; url: string; host: string; token: string };

/** Why a source that passed parseSource could not be read. Never names the token. */
export class SourceError extends Error {
	readonly code: 'unreadable' | 'download_failed' | 'redirected' | 'too_large';

	constructor(code: SourceError['code'], message: string) {
		super(message);
		this.name = 'SourceError';
		this.code = code;
	}
}

/**
 * The source an argument names: anything with '://' is a URL, anything else a file path. A URL
 * that is not the private store's, or that comes without its token, is a Refusal.
 */
export function parseSource(arg: string, token: string | undefined): BackupSource {
	if (!arg.includes('://')) return { kind: 'file', path: path.resolve(arg) };
	let url: URL;
	try {
		url = new URL(arg);
	} catch {
		throw new Refusal('Refusing to download: the source is not a valid URL.');
	}
	if (url.protocol !== 'https:') {
		throw new Refusal(`Refusing to download over ${url.protocol}: only https:// is allowed.`);
	}
	if (!token) {
		throw new Refusal(
			"Refusing to download: set BLOB_READ_WRITE_TOKEN, copied from the store's page\n" +
				'(Vercel → Storage → performance-coach-backups). Nothing was sent.'
		);
	}
	let host: string;
	try {
		host = privateHost(token);
	} catch {
		throw new Refusal('Refusing to download: BLOB_READ_WRITE_TOKEN is not a read-write token.');
	}
	if (url.hostname !== host || url.port || url.username || url.password) {
		throw new Refusal(
			`Refusing to download from ${url.host}: only ${host}, the token's private store, is allowed.`
		);
	}
	return { kind: 'blob', url: url.toString(), host, token };
}

export interface ReadSourceOptions {
	fetch?: typeof globalThis.fetch;
	/** MAX_SOURCE_BYTES by default. */
	maxBytes?: number;
}

/** The sealed bytes `source` holds, up to `maxBytes`. */
export async function readSource(
	source: BackupSource,
	{ fetch = globalThis.fetch, maxBytes = MAX_SOURCE_BYTES }: ReadSourceOptions = {}
): Promise<Buffer> {
	const tooLarge = () =>
		new SourceError('too_large', `The backup is over the ${maxBytes}-byte cap`);
	if (source.kind === 'file') {
		let size: number;
		try {
			size = (await stat(source.path)).size;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? 'error';
			throw new SourceError('unreadable', `Cannot read ${source.path} (${code})`);
		}
		if (size > maxBytes) throw tooLarge();
		return readFile(source.path);
	}

	let response: Response;
	try {
		response = await fetch(source.url, {
			headers: { authorization: `Bearer ${source.token}` },
			redirect: 'error'
		});
	} catch (error) {
		const redirect = /redirect/i.test(String((error as Error).cause ?? ''));
		throw new SourceError(
			redirect ? 'redirected' : 'download_failed',
			redirect
				? `${source.host} answered with a redirect, which is never followed`
				: `The download from ${source.host} failed (${(error as Error).name})`
		);
	}
	// redirect 'error' already refuses one; a fetch that ignored it must not hand back its body.
	if (response.redirected || (response.status >= 300 && response.status < 400)) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceError(
			'redirected',
			`${source.host} answered with a redirect, which is never followed`
		);
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceError('download_failed', `${source.host} answered ${response.status}`);
	}
	if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
		await response.body.cancel().catch(() => undefined);
		throw tooLarge();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw tooLarge();
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error instanceof SourceError) throw error;
		throw new SourceError(
			'download_failed',
			`The download from ${source.host} broke off (${(error as Error).name})`
		);
	}
	return Buffer.concat(chunks, size);
}
