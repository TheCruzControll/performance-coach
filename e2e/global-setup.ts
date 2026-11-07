/**
 * Playwright global setup:
 *   1. recreate the disposable e2e database and apply all committed migrations,
 *   2. mint this run's one-time owner setup token (the server gets only its hash, as in
 *      production; the `setup` project opens /setup?token=… with it), and switch the email
 *      sign-in link on: a fixed OWNER_EMAIL and a canary RESEND_API_KEY, in the environment of
 *      the build and of the server (the test provider wins, because test routes are on), so
 *      platform.e2e.ts can prove neither reaches the browser,
 *   3. build the app with the Node adapter (skip with E2E_SKIP_BUILD=1 when CI already built),
 *   4. start the production server (`node build/index.js`) and wait until /api/health is up.
 * Returns a teardown that stops the server. Server output goes to .e2e-server.log.
 */
import { execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import type { FullConfig } from '@playwright/test';
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../src/lib/server/db/migrate';

export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e;
/** The only address the e2e server's sign-in links go to (its recording test outbox). */
export const E2E_OWNER_EMAIL = 'owner@example.test';
/** Signed-in browser states written by the setup projects (git-ignored). */
export const AUTH_DIR = 'e2e/.auth';

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
	// Workers inherit process.env from here: the setup project reads the token.
	const setupToken = randomBytes(32).toString('base64url');
	process.env.E2E_SETUP_TOKEN = setupToken;
	const setupTokenHash = createHash('sha256').update(setupToken).digest('hex');
	process.env.OWNER_EMAIL = E2E_OWNER_EMAIL;
	process.env.RESEND_API_KEY = `re_e2e_canary_${randomBytes(16).toString('hex')}`;

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
			LOG_LEVEL: process.env.LOG_LEVEL ?? 'info'
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
