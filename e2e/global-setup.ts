/**
 * Playwright global setup:
 *   1. recreate the disposable e2e database and apply all committed migrations,
 *   2. mint this run's one-time owner setup token (the server gets only its hash, as in
 *      production; the `setup` project opens /setup?token=… with it),
 *   3. build the app with the Node adapter (skip with E2E_SKIP_BUILD=1 when CI already built),
 *   4. start the production server (`node build/index.js`) and wait until /api/health is up,
 *      with this run's random CRON_SECRET and BACKUP_ENCRYPTION_KEY (workers read them as
 *      E2E_CRON_SECRET and E2E_BACKUP_KEY) and backups going to E2E_BACKUP_DIR.
 * Returns a teardown that stops the server. Server output goes to .e2e-server.log.
 */
import { execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { mintSetupToken } from '../scripts/auth-setup-token';
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../src/lib/server/db/migrate';

export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e;
/** Signed-in browser states written by the setup projects (git-ignored). */
export const AUTH_DIR = 'e2e/.auth';
/** Where the server under test writes its backups (BACKUP_DIR): a local folder store. */
export const E2E_BACKUP_DIR = path.resolve(import.meta.dirname, '../test-results/backups');

async function isUp(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
		return res.ok;
	} catch {
		return false;
	}
}

export default async function globalSetup(config: FullConfig) {
	const baseURL = config.projects[0]?.use.baseURL;
	if (!baseURL) throw new Error('baseURL is not configured');

	await resetDatabase(E2E_DATABASE_URL);
	console.log(`[e2e] database ready: ${redactUrl(E2E_DATABASE_URL)}`);

	rmSync(AUTH_DIR, { recursive: true, force: true });
	mkdirSync(AUTH_DIR, { recursive: true });
	// Workers inherit process.env from here: the setup project reads the token. Minted exactly as
	// `pnpm auth:setup-token` mints it, so it carries the default 24-hour expiry.
	const { token: setupToken, hash: setupTokenHash } = mintSetupToken();
	process.env.E2E_SETUP_TOKEN = setupToken;

	if (process.env.E2E_BASE_URL) return; // testing an externally managed server

	if (await isUp(`${baseURL}/api/health`)) {
		throw new Error(`[e2e] something is already serving ${baseURL}; stop it or set E2E_PORT.`);
	}

	if (process.env.E2E_SKIP_BUILD !== '1') {
		console.log('[e2e] building (ADAPTER=node)…');
		// The public origin is baked into a Node build (vite.config.ts → paths.origin).
		execSync('pnpm build:node', {
			stdio: 'inherit',
			env: { ...process.env, ADAPTER: 'node', ORIGIN: baseURL }
		});
	}

	// The backup cron's secret and key, for this run only; workers inherit them from here.
	process.env.E2E_CRON_SECRET = randomBytes(32).toString('base64url');
	process.env.E2E_BACKUP_KEY = randomBytes(32).toString('base64');
	rmSync(E2E_BACKUP_DIR, { recursive: true, force: true });

	const port = new URL(baseURL).port || '80';
	const log = openSync('.e2e-server.log', 'w');
	const server = spawn(process.execPath, ['build/index.js'], {
		stdio: ['ignore', log, log],
		env: {
			...process.env,
			NODE_ENV: 'production',
			APP_ENV: 'test',
			PORT: port,
			ORIGIN: baseURL,
			DATABASE_URL: E2E_DATABASE_URL,
			DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
			ENABLE_TEST_ROUTES: 'true',
			OWNER_SETUP_TOKEN_HASH: setupTokenHash,
			CRON_SECRET: process.env.E2E_CRON_SECRET,
			BACKUP_ENCRYPTION_KEY: process.env.E2E_BACKUP_KEY,
			BACKUP_DIR: E2E_BACKUP_DIR,
			LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
			// An observed lifecycle throws on a move its table does not allow (lifecycle-guard.ts).
			LIFECYCLE_STRICT: '1'
		}
	});

	const deadline = Date.now() + 30_000;
	while (!(await isUp(`${baseURL}/api/health`))) {
		if (server.exitCode !== null) {
			throw new Error(`[e2e] server exited with code ${server.exitCode}; see .e2e-server.log`);
		}
		if (Date.now() > deadline) {
			server.kill('SIGKILL');
			throw new Error('[e2e] server did not become healthy within 30s; see .e2e-server.log');
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log(`[e2e] production server ready at ${baseURL}`);

	return async () => {
		if (server.exitCode === null) {
			server.kill('SIGTERM');
			await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 5_000))]);
		}
	};
}
