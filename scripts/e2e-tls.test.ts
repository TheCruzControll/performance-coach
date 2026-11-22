/**
 * scripts/e2e-tls: the local TLS proxy E2E_TLS=1 puts in front of the production build, over real
 * sockets. Through it, server-sent events arrive one at a time (the server sends the next only
 * once the client has the last, so a buffering proxy would hang), a 304 and a 303 with two
 * Set-Cookie headers pass unchanged, a request body streams through, and vercel.json's headers
 * reach /offline and not an unmatched path. The header-rule compiler refuses a source it cannot
 * read, and the throwaway certificate's SPKI hash is its key's.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	CERT_DAYS,
	ensureCertificate,
	generateCertificate,
	spkiHash,
	type TlsCertificate
} from './e2e-tls/cert.ts';
import { startTlsProxy, type TlsProxy } from './e2e-tls/proxy.ts';
import { compileHeaderRules, compileSource } from './e2e-tls/vercel-headers.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const vercelJson = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));

let dir: string;
let certificate: TlsCertificate;
let upstream: http.Server;
let proxy: TlsProxy;
/** Resolves when the client has read event `n`: the upstream waits for it before event n + 1. */
const received: (() => void)[] = [];
const receivedEvent: Promise<void>[] = [0, 1, 2].map(
	(n) => new Promise<void>((resolve) => (received[n] = resolve))
);

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'e2e-tls-'));
	certificate = generateCertificate(dir);
	upstream = http.createServer(async (req, res) => {
		switch (req.url) {
			case '/events': {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
				for (const n of [0, 1, 2]) {
					res.write(`data: event ${n}\n\n`);
					await receivedEvent[n];
				}
				res.end();
				return;
			}
			case '/not-modified':
				res.writeHead(304, { etag: '"v1"' }).end();
				return;
			case '/signin':
				res.writeHead(303, 'See Other', [
					['location', '/today'],
					['set-cookie', '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax'],
					['set-cookie', 'pc-theme=dark; Path=/']
				]);
				res.end();
				return;
			case '/upload': {
				let bytes = 0;
				for await (const chunk of req) bytes += (chunk as Buffer).length;
				res.writeHead(200, { 'content-type': 'text/plain' }).end(String(bytes));
				return;
			}
			default:
				res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
		}
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	proxy = await startTlsProxy({
		target,
		port: 0,
		cert: certificate.cert,
		key: certificate.key,
		rules: compileHeaderRules(vercelJson)
	});
});

afterAll(async () => {
	await proxy?.close();
	await new Promise((resolve) => upstream?.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

/** A request through the proxy that verifies its certificate as valid for localhost. */
function request(pathname: string, options: https.RequestOptions = {}, body?: string) {
	return new Promise<http.IncomingMessage>((resolve, reject) => {
		const req = https.request(
			{
				host: 'localhost',
				port: proxy.port,
				path: pathname,
				ca: certificate.cert,
				agent: false,
				...options
			},
			resolve
		);
		req.on('error', reject);
		req.end(body);
	});
}

const text = async (res: http.IncomingMessage) => {
	let out = '';
	for await (const chunk of res) out += chunk;
	return out;
};

describe('the TLS proxy', () => {
	it('streams server-sent events one at a time', async () => {
		const res = await request('/events');
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('text/event-stream');
		const events: string[] = [];
		let buffer = '';
		for await (const chunk of res) {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf('\n\n')) >= 0) {
				events.push(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				// Only now may the server send the next event.
				received[events.length - 1]!();
			}
		}
		expect(events).toEqual(['data: event 0', 'data: event 1', 'data: event 2']);
	}, 5_000);

	it('passes a 304 unchanged', async () => {
		const res = await request('/not-modified', { headers: { 'if-none-match': '"v1"' } });
		expect(res.statusCode).toBe(304);
		expect(res.headers.etag).toBe('"v1"');
		expect(await text(res)).toBe('');
	});

	it('passes a 303 with its Location and both Set-Cookie headers unchanged', async () => {
		const res = await request('/signin', { method: 'POST' });
		expect(res.statusCode).toBe(303);
		expect(res.statusMessage).toBe('See Other');
		expect(res.headers.location).toBe('/today');
		expect(res.headers['set-cookie']).toEqual([
			'__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
			'pc-theme=dark; Path=/'
		]);
	});

	it('streams a request body to the server', async () => {
		const body = 'x'.repeat(256 * 1024);
		const res = await request('/upload', { method: 'POST' }, body);
		expect(await text(res)).toBe(String(body.length));
	});

	it('adds vercel.json’s headers to /offline, and none to a path no rule matches', async () => {
		const offline = await request('/offline');
		const expected = vercelJson.headers.find(
			(rule: { source: string }) => rule.source === '/offline'
		);
		expect(expected.headers.length).toBeGreaterThan(0);
		for (const { key, value } of expected.headers) {
			expect(offline.headers[key.toLowerCase()], key).toBe(value);
		}
		const elsewhere = await request('/today');
		for (const { key } of expected.headers) {
			expect(elsewhere.headers[key.toLowerCase()], key).toBeUndefined();
		}
	});

	it('answers 502 when the server behind it is down', async () => {
		const dead = await startTlsProxy({
			target: 'http://127.0.0.1:1',
			port: 0,
			cert: certificate.cert,
			key: certificate.key,
			rules: compileHeaderRules({})
		});
		try {
			const res = await new Promise<http.IncomingMessage>((resolve, reject) =>
				https
					.get({ host: 'localhost', port: dead.port, ca: certificate.cert, agent: false }, resolve)
					.on('error', reject)
			);
			expect(res.statusCode).toBe(502);
		} finally {
			await dead.close();
		}
	});
});

describe('vercel.json header rules', () => {
	const rule = (source: string) => ({ source, headers: [{ key: 'X-Rule', value: source }] });

	it('reads literals, :param, :param* and (.*), anchored to the whole path', () => {
		const rules = compileHeaderRules({
			headers: [rule('/offline'), rule('/train/:id'), rule('/assets/:path*'), rule('/(.*)')]
		});
		const values = (pathname: string) => rules.headersFor(pathname).map(([, value]) => value);
		expect(values('/offline')).toEqual(['/offline', '/(.*)']);
		expect(values('/offline/x')).toEqual(['/(.*)']);
		expect(values('/train/42')).toEqual(['/train/:id', '/(.*)']);
		expect(values('/train/42/edit')).toEqual(['/(.*)']);
		expect(values('/assets')).toEqual(['/assets/:path*', '/(.*)']);
		expect(values('/assets/a/b.js')).toEqual(['/assets/:path*', '/(.*)']);
		expect(compileSource('/a.b').test('/aXb')).toBe(false);
		expect(rules.headersFor('/offline')[0]).toEqual(['x-rule', '/offline']);
	});

	it('compiles every rule in vercel.json', () => {
		expect(() => compileHeaderRules(vercelJson)).not.toThrow();
		expect(compileHeaderRules(vercelJson).headersFor('/workout/run').length).toBeGreaterThan(0);
	});

	it('throws on a source it cannot read, rather than skip the rule', () => {
		for (const source of ['/train/:id(\\d+)', '/a?', '/a+', '/{a}', '/[a]', 'offline', '/a/b*']) {
			expect(() => compileHeaderRules({ headers: [rule(source)] }), source).toThrow(
				/vercel\.json source/
			);
		}
	});
});

describe('the throwaway certificate', () => {
	it('is a P-256 localhost certificate, private to its owner, whose SPKI hash is its key’s', () => {
		expect(certificate.spki).toBe(spkiHash(certificate.key));
		// The same hash as openssl computes from the certificate, as Chromium's docs show.
		const pub = execFileSync('openssl', ['x509', '-pubkey', '-noout', '-in', certificate.certPath]);
		const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
		const digest = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der });
		expect(certificate.spki).toBe(digest.toString('base64'));
		const details = execFileSync(
			'openssl',
			['x509', '-noout', '-text', '-in', certificate.certPath],
			{
				encoding: 'utf8'
			}
		);
		expect(details).toMatch(/prime256v1|P-256/);
		expect(details).toMatch(/DNS:localhost/);
		for (const file of [certificate.certPath, certificate.keyPath]) {
			expect(statSync(file).mode & 0o777, file).toBe(0o600);
		}
	});

	it('is reused while valid, and replaced near its expiry', () => {
		expect(ensureCertificate(dir).spki).toBe(certificate.spki);
		const later = Date.now() + CERT_DAYS * 24 * 60 * 60 * 1000;
		const scratch = mkdtempSync(path.join(tmpdir(), 'e2e-tls-'));
		try {
			const first = generateCertificate(scratch);
			expect(ensureCertificate(scratch, later).spki).not.toBe(first.spki);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it('fails with an install hint when openssl is missing', () => {
		expect(() => generateCertificate(dir, 'openssl-that-is-not-installed')).toThrow(
			/needs openssl.*Install it/
		);
	});
});
