/**
 * The local TLS proxy (E2E_TLS=1): https://localhost:<port> in front of the production Node server
 * on http://127.0.0.1:<internal>, so a local run is served over HTTPS (__Host-session, Secure
 * cookies) with vercel.json's headers on the paths they match, as Vercel serves them.
 *
 * - Bodies stream both ways without buffering (server-sent events, uploads); the status, its
 *   message and every header pass through unchanged, each Set-Cookie included, apart from the
 *   hop-by-hop headers a proxy must not forward.
 * - The matching vercel.json headers are set on the response (a later rule wins for one header,
 *   and a rule's header replaces the app's own of that name).
 * - Nothing is cached: every request goes to the server.
 *
 * It mirrors Vercel's header rules only, not its CDN or function runtime.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { HeaderRules } from './vercel-headers';

export interface TlsProxyOptions {
	/** The server behind the proxy, e.g. http://127.0.0.1:41234. */
	target: string;
	/** The port to listen on (0 picks a free one). */
	port: number;
	cert: string;
	key: string;
	rules: HeaderRules;
}

export interface TlsProxy {
	port: number;
	close(): Promise<void>;
}

/** Headers that describe one connection, not the message (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer'
]);

function forwardable(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
	}
	return out;
}

export async function startTlsProxy(options: TlsProxyOptions): Promise<TlsProxy> {
	const target = new URL(options.target);
	const server = https.createServer({ cert: options.cert, key: options.key }, (req, res) => {
		const upstream = http.request(
			{
				hostname: target.hostname,
				port: target.port,
				method: req.method,
				path: req.url,
				headers: forwardable(req.headers)
			},
			(response) => {
				const headers = forwardable(response.headers);
				const pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
				for (const [key, value] of options.rules.headersFor(pathname)) headers[key] = value;
				res.writeHead(response.statusCode ?? 502, response.statusMessage, headers);
				// Each chunk is written as it arrives: an event stream reaches the browser event by event.
				response.pipe(res);
			}
		);
		upstream.on('error', () => {
			// Mid-body, a truncated response must not look complete: drop the connection instead.
			if (res.headersSent) res.destroy();
			else res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway');
		});
		// The browser hung up (a closed event stream): stop the server's response too.
		res.on('close', () => {
			if (!res.writableFinished) upstream.destroy();
		});
		req.pipe(upstream);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', (error: NodeJS.ErrnoException) => {
			reject(
				error.code === 'EADDRINUSE'
					? new Error(
							`[e2e] something is already listening on port ${options.port}; stop it or set E2E_PORT.`
						)
					: error
			);
		});
		// Every local address, IPv4 and IPv6, as the browser may resolve localhost to either.
		server.listen(options.port, () => resolve());
	});
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	};
}
