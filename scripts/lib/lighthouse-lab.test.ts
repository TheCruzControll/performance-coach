/**
 * The Lighthouse lab's front door (scripts/lib/lighthouse-lab.ts): the audited page arrives over
 * TLS and HTTP/2, compressed, with a function response held for the production server delay,
 * while static files, streams, cookies and request bodies pass as the server sent them.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	compressible,
	encodingFor,
	labCertificate,
	spkiHash,
	startLabProxy,
	type LabCertificate,
	type LabProxy
} from './lighthouse-lab.ts';

const PAGE = `<!doctype html><html><body>${'<p>Bench press 3 × 5 at 100 kg</p>'.repeat(400)}</body></html>`;
/** A long hold, so a delayed and an undelayed answer cannot be confused on a busy runner. */
const DELAY_MS = 400;

let certificate: LabCertificate;
let upstream: http.Server;
let proxy: LabProxy;
/** Lets the streamed route send its second half; set by each streaming test. */
let releaseStream: () => void = () => {};
let streamEnded = false;
let lastRequest: { method?: string; host?: string; cookie?: string; body: string } | undefined;

beforeAll(async () => {
	certificate = labCertificate();
	upstream = http.createServer((req, res) => {
		const url = req.url ?? '/';
		if (url === '/page') {
			// What SvelteKit renders: uncompressed HTML with Server-Timing.
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'content-length': Buffer.byteLength(PAGE),
				'server-timing': 'total;dur=1.2'
			});
			res.end(PAGE);
		} else if (url === '/_app/immutable/chunk.js') {
			// What sirv sends for a precompressed static file: already encoded, no Server-Timing.
			res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'br' });
			res.end(zlib.brotliCompressSync('export const a = 1;'));
		} else if (url === '/icon.png') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		} else if (url === '/stream') {
			streamEnded = false;
			res.writeHead(200, { 'content-type': 'text/html', 'server-timing': 'total;dur=1' });
			res.write('<p>first</p>');
			const release = new Promise<void>((resolve) => {
				releaseStream = resolve;
				setTimeout(resolve, 3000);
			});
			void release.then(() => {
				streamEnded = true;
				res.end('<p>second</p>');
			});
		} else if (url === '/drop') {
			// The server dies mid-response: headers and half the page, then the connection goes.
			res.writeHead(200, { 'content-type': 'text/html', 'server-timing': 'total;dur=1' });
			res.write('<p>first</p>', () => setTimeout(() => res.socket?.destroy(), 20));
		} else if (url === '/echo') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				lastRequest = {
					method: req.method,
					host: req.headers.host,
					cookie: req.headers.cookie,
					body
				};
				res.writeHead(201, {
					'content-type': 'application/json',
					'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
					'server-timing': 'total;dur=1'
				});
				res.end('{"ok":true}');
			});
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const { port } = upstream.address() as AddressInfo;
	proxy = await startLabProxy({
		target: `http://127.0.0.1:${port}`,
		port: 0,
		certificate,
		delayMs: DELAY_MS
	});
});

afterAll(async () => {
	await proxy?.close();
	await new Promise((resolve) => upstream?.close(resolve));
});

interface Answer {
	headers: http2.IncomingHttpHeaders;
	body: Buffer;
	/** Milliseconds from the request to its response headers. */
	ttfb: number;
	/** Whether the upstream had ended its response when the first body bytes arrived. */
	endedAtFirstByte?: boolean;
}

/** One HTTP/2 request to the proxy, trusting only the lab certificate. */
async function h2(
	path: string,
	headers: http2.OutgoingHttpHeaders = {},
	body?: string,
	onFirstData?: () => void
): Promise<Answer> {
	const client = http2.connect(`https://localhost:${proxy.port}`, { ca: certificate.cert });
	try {
		return await new Promise<Answer>((resolve, reject) => {
			const started = performance.now();
			const req = client.request({ ':path': path, ...headers });
			const chunks: Buffer[] = [];
			let answer: Partial<Answer> = {};
			req.on('response', (h) => {
				answer = { headers: h, ttfb: performance.now() - started };
			});
			req.on('data', (chunk: Buffer) => {
				if (!chunks.length) {
					answer.endedAtFirstByte = streamEnded;
					onFirstData?.();
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve({ ...(answer as Answer), body: Buffer.concat(chunks) }));
			req.on('error', reject);
			req.end(body);
		});
	} finally {
		client.close();
	}
}

describe('labCertificate', () => {
	it('is a localhost certificate whose public key hash is the one Chromium is told to trust', () => {
		const x509 = new X509Certificate(certificate.cert);
		expect(x509.subjectAltName).toContain('DNS:localhost');
		expect(x509.checkPrivateKey(createPrivateKey(certificate.key))).toBe(true);
		expect(certificate.spki).toBe(spkiHash(certificate.cert));
		expect(Buffer.from(certificate.spki, 'base64')).toHaveLength(32);
	});
});

describe('encodingFor', () => {
	it('prefers brotli, as Vercel does, then gzip, else nothing', () => {
		expect(encodingFor('gzip, deflate, br, zstd')).toBe('br');
		expect(encodingFor('gzip, deflate')).toBe('gzip');
		expect(encodingFor('br;q=0, gzip;q=0.5')).toBe('gzip');
		expect(encodingFor('identity')).toBeNull();
		expect(encodingFor(undefined)).toBeNull();
	});
});

describe('compressible', () => {
	it('compresses text and JSON, never images or fonts', () => {
		for (const type of [
			'text/html; charset=utf-8',
			'text/css',
			'text/javascript',
			'application/json',
			'application/manifest+json',
			'image/svg+xml'
		]) {
			expect(compressible(type), type).toBe(true);
		}
		for (const type of ['image/png', 'font/woff2', 'application/octet-stream', undefined]) {
			expect(compressible(type), String(type)).toBe(false);
		}
	});
});

describe('startLabProxy', () => {
	it('serves HTTP/2 over TLS', async () => {
		const client = http2.connect(`https://localhost:${proxy.port}`, { ca: certificate.cert });
		try {
			await new Promise<void>((resolve, reject) => {
				client.once('connect', () => resolve());
				client.once('error', reject);
			});
			expect(client.alpnProtocol).toBe('h2');
			expect(client.encrypted).toBe(true);
		} finally {
			client.close();
		}
	});

	it('sends the server’s uncompressed HTML as brotli, which decodes to the same page', async () => {
		const { headers, body } = await h2('/page', { 'accept-encoding': 'gzip, deflate, br, zstd' });
		expect(headers[':status']).toBe(200);
		expect(headers['content-encoding']).toBe('br');
		expect(headers['content-length']).toBeUndefined();
		expect(headers.vary).toMatch(/Accept-Encoding/);
		expect(zlib.brotliDecompressSync(body).toString()).toBe(PAGE);
		expect(body.length).toBeLessThan(Buffer.byteLength(PAGE) / 4);
	});

	it('falls back to gzip, and sends the page as it is to a client that accepts neither', async () => {
		const gzip = await h2('/page', { 'accept-encoding': 'gzip' });
		expect(gzip.headers['content-encoding']).toBe('gzip');
		expect(zlib.gunzipSync(gzip.body).toString()).toBe(PAGE);
		const plain = await h2('/page');
		expect(plain.headers['content-encoding']).toBeUndefined();
		expect(plain.body.toString()).toBe(PAGE);
	});

	it('passes precompressed static files and binary files through untouched', async () => {
		const chunk = await h2('/_app/immutable/chunk.js', { 'accept-encoding': 'gzip, br' });
		expect(chunk.headers['content-encoding']).toBe('br');
		expect(zlib.brotliDecompressSync(chunk.body).toString()).toBe('export const a = 1;');
		const png = await h2('/icon.png', { 'accept-encoding': 'gzip, br' });
		expect(png.headers['content-encoding']).toBeUndefined();
		expect([...png.body]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it('holds a function response for the delay, and a static file not at all', async () => {
		const page = await h2('/page', { 'accept-encoding': 'br' });
		expect(page.ttfb).toBeGreaterThanOrEqual(DELAY_MS - 5);
		const file = await h2('/icon.png');
		expect(file.ttfb).toBeLessThan(DELAY_MS / 2);
	});

	it('keeps a streamed page streaming: compressed bytes arrive before the server ends it', async () => {
		const answer = await h2('/stream', { 'accept-encoding': 'br' }, undefined, () =>
			releaseStream()
		);
		expect(answer.headers['content-encoding']).toBe('br');
		expect(answer.endedAtFirstByte).toBe(false);
		expect(zlib.brotliDecompressSync(answer.body).toString()).toBe('<p>first</p><p>second</p>');
	});

	it('drops the browser’s stream, and keeps serving, when the server dies mid-response', async () => {
		// It dies inside the delay, so the browser's stream ends (or errors) with no response at all.
		const dropped = await h2('/drop', { 'accept-encoding': 'br' }).catch(() => undefined);
		expect(dropped?.headers?.[':status']).toBeUndefined();
		const after = await h2('/icon.png');
		expect(after.headers[':status']).toBe(200);
	});

	it('forwards the method, host, cookie and body, and every Set-Cookie back', async () => {
		const answer = await h2(
			'/echo',
			{ ':method': 'POST', cookie: '__Host-session=abc', 'content-type': 'application/json' },
			'{"v":1}'
		);
		expect(answer.headers[':status']).toBe(201);
		expect(answer.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		expect(lastRequest).toEqual({
			method: 'POST',
			host: `localhost:${proxy.port}`,
			cookie: '__Host-session=abc',
			body: '{"v":1}'
		});
	});
});
