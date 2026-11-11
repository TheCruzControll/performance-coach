/**
 * The Lighthouse lab's front door (scripts/lighthouse.ts): https://localhost:<port> in front of the
 * production Node server on http://127.0.0.1:<internal>, so the audited page arrives as production
 * sends it rather than as adapter-node sends it on localhost.
 *
 * - **TLS and HTTP/2.** A throwaway self-signed certificate for localhost (openssl), served with
 *   ALPN h2 (HTTP/1.1 still accepted). Chromium trusts it by its public key hash
 *   (--ignore-certificate-errors-spki-list), so the page has no certificate error and its service
 *   worker registers. Lighthouse's simulation then models one multiplexed connection and the TLS
 *   handshake, as it would against Vercel.
 * - **Compression.** Text the server sends uncompressed (SSR HTML, __data.json, API JSON) is
 *   compressed as Vercel does: brotli when the browser accepts it, else gzip. Each chunk is flushed
 *   as it arrives, so a streamed page still streams. Files adapter-node serves precompressed
 *   (`precompress: true`) pass through untouched.
 * - **Server delay.** Every function response (one with Server-Timing: src/hooks.server.ts sets it
 *   on every response SvelteKit renders, never on a static file) is held SERVER_DELAY_MS before
 *   its headers go out, on top of the app's own time; static files, which Vercel's CDN serves in
 *   production, get none.
 *
 * Nothing is cached. It mirrors the transport only, not vercel.json's headers or a cold start.
 */
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Production's warm time to first byte, less the app's own time. Production measured 104–158 ms
 * TTFB on warm requests whose server total was about 3 ms (curl, x-vercel-id sfo1::pdx1, 2026-11
 * performance review): about 100 ms is the edge-to-function hop and the invocation. The low end,
 * since curl's figure also holds the client's own round trips, which Lighthouse simulates itself.
 *
 * It shows in the server-response-time audit, but barely in the gated metrics: simulated
 * throttling (Lantern) gives each origin one server time, the median over all its requests, and
 * the undelayed static files keep that median near zero (its 30 ms default then applies). The
 * same happens against production, whose static files share the page's origin.
 */
export const SERVER_DELAY_MS = 100;

export interface LabCertificate {
	cert: string;
	key: string;
	/** base64 SHA-256 of the certificate's DER SubjectPublicKeyInfo, as Chromium's flag takes it. */
	spki: string;
}

/** The SPKI SHA-256 (base64) of a PEM certificate. */
export function spkiHash(certPem: string): string {
	const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('base64');
}

/** A new P-256 key and one-day self-signed certificate for localhost; nothing stays on disk. */
export function labCertificate(openssl = 'openssl'): LabCertificate {
	const dir = mkdtempSync(path.join(tmpdir(), 'pc-lighthouse-tls-'));
	try {
		const keyPath = path.join(dir, 'key.pem');
		const certPath = path.join(dir, 'cert.pem');
		const run = spawnSync(
			openssl,
			[
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-keyout',
				keyPath,
				'-out',
				certPath,
				'-days',
				'1',
				'-subj',
				'/CN=localhost',
				'-addext',
				'subjectAltName=DNS:localhost,IP:127.0.0.1'
			],
			{ encoding: 'utf8' }
		);
		if (run.error || run.status !== 0) {
			throw new Error(
				`lighthouse: openssl could not make the lab's localhost certificate: ${run.error?.message ?? run.stderr}`
			);
		}
		const cert = readFileSync(certPath, 'utf8');
		return { cert, key: readFileSync(keyPath, 'utf8'), spki: spkiHash(cert) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The encoding Vercel answers an Accept-Encoding with: brotli first, then gzip, else none. */
export function encodingFor(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
	const accepted = new Map(
		(acceptEncoding ?? '').split(',').map((part) => {
			const [name, ...params] = part.trim().toLowerCase().split(';');
			const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
			return [name!, q === undefined ? 1 : Number(q)] as const;
		})
	);
	if ((accepted.get('br') ?? 0) > 0) return 'br';
	if ((accepted.get('gzip') ?? 0) > 0) return 'gzip';
	return null;
}

/** Text worth compressing: HTML, CSS, JS, JSON, SVG, manifests and plain text. */
export function compressible(contentType: string | undefined): boolean {
	const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	return (
		type.startsWith('text/') ||
		/^application\/(?:javascript|json|manifest\+json|[\w.+-]+\+json|xml)$/.test(type) ||
		type === 'image/svg+xml'
	);
}

/** Headers that describe one connection, not the message; HTTP/2 refuses them (RFC 9113 §8.2.2). */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'http2-settings'
]);

function forwardable(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !name.startsWith(':') && !HOP_BY_HOP.has(name)) out[name] = value;
	}
	return out;
}

export interface LabProxyOptions {
	/** The server behind the proxy, e.g. http://127.0.0.1:41234. */
	target: string;
	/** The port to listen on (0 picks a free one). */
	port: number;
	certificate: LabCertificate;
	/** How long a function response is held before its headers go out. */
	delayMs: number;
}

export interface LabProxy {
	port: number;
	close(): Promise<void>;
}

export async function startLabProxy(options: LabProxyOptions): Promise<LabProxy> {
	const target = new URL(options.target);
	// HTTP/1.1 requests (allowHTTP1) arrive as http's request and response, whose members used here
	// match the HTTP/2 compatibility API's.
	const handle = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
		const headers = forwardable(req.headers);
		const authority = req.headers[':authority'] ?? req.headers.host;
		if (authority) headers.host = String(authority);
		const upstream = http.request(
			{
				hostname: target.hostname,
				port: target.port,
				method: req.method,
				path: req.url,
				headers
			},
			async (response) => {
				// The server died mid-response: drop the browser's stream too, never leave it open.
				response.on('error', () => res.destroy());
				const out = forwardable(response.headers);
				if (response.headers['server-timing'] && options.delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, options.delayMs));
				}
				const status = response.statusCode ?? 502;
				const encoding = encodingFor(req.headers['accept-encoding'] as string | undefined);
				const compress =
					encoding !== null &&
					req.method !== 'HEAD' &&
					status !== 204 &&
					status !== 304 &&
					!response.headers['content-encoding'] &&
					compressible(response.headers['content-type']);
				if (!compress) {
					res.writeHead(status, out);
					response.pipe(res);
					return;
				}
				delete out['content-length'];
				out['content-encoding'] = encoding;
				const vary = response.headers.vary;
				out.vary = vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding';
				res.writeHead(status, out);
				// Flushed per write: a streamed page's chunks reach the browser as the server sends them.
				const compressor =
					encoding === 'br'
						? zlib.createBrotliCompress({
								flush: zlib.constants.BROTLI_OPERATION_FLUSH,
								params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }
							})
						: zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH, level: 6 });
				response.pipe(compressor).pipe(res);
			}
		);
		upstream.on('error', () => {
			// Mid-body, a truncated response must not look complete: drop the stream instead.
			if (res.headersSent) res.destroy();
			else res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway');
		});
		// The browser hung up (a closed event stream): stop the server's response too.
		res.on('close', () => {
			if (!res.writableFinished) upstream.destroy();
		});
		req.pipe(upstream);
	};
	const server = http2.createSecureServer(
		{ cert: options.certificate.cert, key: options.certificate.key, allowHTTP1: true },
		handle
	);
	// Every connection, HTTP/2 or HTTP/1.1, so close() need not wait for idle keep-alives.
	const sockets = new Set<Socket>();
	server.on('secureConnection', (socket: Socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		// Every local address, IPv4 and IPv6, as the browser may resolve localhost to either.
		server.listen(options.port, () => resolve());
	});
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			})
	};
}
