/**
 * The local TLS proxy's throwaway certificate (E2E_TLS=1): a P-256 key and a short-lived
 * self-signed certificate for localhost, made with openssl, and the SHA-256 of its public key
 * (SPKI) that Chromium is told to trust (--ignore-certificate-errors-spki-list), so WebAuthn,
 * which refuses a page with certificate errors, still runs.
 *
 * The files live in e2e/.tls/ (git-ignored, mode 0600), not test-results/: playwright.config.ts
 * reads the hash when it loads, and Playwright clears its output folder after that, before global
 * setup starts the proxy. A certificate that still has CERT_MIN_REMAINING_MS left is reused, so
 * the runner, its workers and global setup all see the same key.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TLS_DIR = path.resolve(import.meta.dirname, '../../e2e/.tls');
/** How long a new certificate is valid: a run, with room to spare, and never longer. */
export const CERT_DAYS = 2;
/** A certificate with less than this left is replaced rather than reused. */
export const CERT_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;

export interface TlsCertificate {
	certPath: string;
	keyPath: string;
	cert: string;
	key: string;
	/** base64 SHA-256 of the certificate's DER SubjectPublicKeyInfo, as Chromium's flag takes it. */
	spki: string;
}

/** The SPKI SHA-256 (base64) of a PEM certificate or key: both give the same hash. */
export function spkiHash(pem: string): string {
	const publicKey = pem.includes('CERTIFICATE')
		? new X509Certificate(pem).publicKey
		: createPublicKey(pem);
	const der = publicKey.export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('base64');
}

function read(dir: string): TlsCertificate {
	const certPath = path.join(dir, 'cert.pem');
	const keyPath = path.join(dir, 'key.pem');
	const cert = readFileSync(certPath, 'utf8');
	const key = readFileSync(keyPath, 'utf8');
	return { certPath, keyPath, cert, key, spki: spkiHash(cert) };
}

/** Generates a new key and certificate in `dir`, replacing any there. */
export function generateCertificate(dir = TLS_DIR, openssl = 'openssl'): TlsCertificate {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
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
			String(CERT_DAYS),
			'-subj',
			'/CN=localhost',
			'-addext',
			'subjectAltName=DNS:localhost,IP:127.0.0.1'
		],
		{ encoding: 'utf8' }
	);
	if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') {
		throw new Error(
			`[e2e] E2E_TLS=1 needs openssl to make its localhost certificate, and "${openssl}" was not found. Install it (macOS: brew install openssl; Debian/Ubuntu: apt-get install openssl).`
		);
	}
	if (run.status !== 0) {
		throw new Error(`[e2e] openssl could not make the localhost certificate:\n${run.stderr}`);
	}
	chmodSync(keyPath, 0o600);
	chmodSync(certPath, 0o600);
	return read(dir);
}

/** The certificate in `dir` while it has CERT_MIN_REMAINING_MS left, else a new one. */
export function ensureCertificate(dir = TLS_DIR, now = Date.now()): TlsCertificate {
	if (existsSync(path.join(dir, 'cert.pem')) && existsSync(path.join(dir, 'key.pem'))) {
		try {
			const current = read(dir);
			const validTo = Date.parse(new X509Certificate(current.cert).validTo);
			if (validTo - now > CERT_MIN_REMAINING_MS && spkiHash(current.key) === current.spki) {
				return current;
			}
		} catch {
			// Unreadable or mismatched: replaced below.
		}
	}
	return generateCertificate(dir);
}
