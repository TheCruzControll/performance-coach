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
 *
 * The target mode (e2e/projects.ts e2eMode) changes that:
 * - `deployed` returns before touching any database, keeping an E2E_SETUP_TOKEN it was given;
 * - `external-local` resets and mints, but builds and starts nothing;
 * - `local-deployed` migrates E2E_DATABASE_URL without a reset, refuses a database with no owner
 *   (it runs after the main suite, on the database that left behind), and starts the build with
 *   no test routes and no setup token hash.
 *
 * With E2E_TLS=1 (local and local-deployed), the server listens on a free internal port with
 * ORIGIN=https://localhost:<E2E_PORT>, and a TLS proxy that applies vercel.json's headers
 * (scripts/e2e-tls) listens on E2E_PORT in front of it.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import pg from 'pg';
import { mintSetupToken } from '../scripts/auth-setup-token';
import { ensureCertificate } from '../scripts/e2e-tls/cert';
import { startTlsProxy } from '../scripts/e2e-tls/proxy';
import { compileHeaderRules } from '../scripts/e2e-tls/vercel-headers';
import { connectionConfig } from '../src/lib/server/db/connection';
import {
	LOCAL_DATABASE_URLS,
	redactUrl,
	resetDatabase,
	runMigrations
} from '../src/lib/server/db/migrate';
import { e2eMode, tlsEnabled, type Mode } from './projects';

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

/** Whether the database at `url` has its owner (the main run's `setup` project created it). */
async function hasOwner(url: string): Promise<boolean> {
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	try {
		const res = await client.query<{ found: boolean }>(
			'select exists (select 1 from owners) as found'
		);
		return res.rows[0]?.found === true;
	} finally {
		await client.end();
	}
}

/** What global setup does to the outside world; scripts/global-setup-modes.test.ts fakes it. */
export interface SetupEffects {
	reset(url: string): Promise<unknown>;
	migrate(url: string): Promise<unknown>;
	hasOwner(url: string): Promise<boolean>;
	build(baseURL: string): void;
	spawnServer(env: NodeJS.ProcessEnv): ChildProcess;
	isUp(url: string): Promise<boolean>;
	/** Empties (or creates) a folder the run owns. */
	freshDir(dir: string): void;
	/** Whether something accepts TCP connections on localhost:`port` (no HTTP, so no TLS). */
	portTaken(port: number): Promise<boolean>;
	/** A port nothing listens on now: the server's, behind the TLS proxy. */
	freePort(): Promise<number>;
	/** Starts the TLS proxy on `port` in front of `target`; resolves to its close. */
	startTlsProxy(port: number, target: string): Promise<() => Promise<void>>;
}

const effects: SetupEffects = {
	reset: resetDatabase,
	migrate: runMigrations,
	hasOwner,
	build(baseURL) {
		console.log('[e2e] building (ADAPTER=node)…');
		// The public origin is baked into a Node build (vite.config.ts → paths.origin).
		execSync('pnpm build:node', {
			stdio: 'inherit',
			env: { ...process.env, ADAPTER: 'node', ORIGIN: baseURL }
		});
	},
	spawnServer(env) {
		const log = openSync('.e2e-server.log', 'w');
		return spawn(process.execPath, ['build/index.js'], { stdio: ['ignore', log, log], env });
	},
	isUp,
	freshDir(dir) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	},
	portTaken(port) {
		return new Promise((resolve) => {
			const socket = connect({ port, host: 'localhost' });
			socket.setTimeout(1_000);
			const done = (taken: boolean) => {
				socket.destroy();
				resolve(taken);
			};
			socket.once('connect', () => done(true));
			socket.once('error', () => done(false));
			socket.once('timeout', () => done(false));
		});
	},
	freePort() {
		return new Promise((resolve, reject) => {
			const probe = createServer();
			probe.once('error', reject);
			probe.listen(0, '127.0.0.1', () => {
				const { port } = probe.address() as AddressInfo;
				probe.close(() => resolve(port));
			});
		});
	},
	async startTlsProxy(port, target) {
		// The certificate playwright.config.ts already made (and pinned for Chromium) is reused.
		const { cert, key } = ensureCertificate();
		const vercelJson = JSON.parse(
			readFileSync(path.resolve(import.meta.dirname, '../vercel.json'), 'utf8')
		);
		const proxy = await startTlsProxy({
			target,
			port,
			cert,
			key,
			rules: compileHeaderRules(vercelJson)
		});
		return proxy.close;
	}
};

/** The server's environment: production-like, with the test-only switches in `local` mode only. */
function serverEnv(
	mode: Mode,
	env: NodeJS.ProcessEnv,
	baseURL: string,
	setupTokenHash: string | undefined,
	port: string
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {
		...env,
		NODE_ENV: 'production',
		PORT: port,
		ORIGIN: baseURL,
		DATABASE_URL: E2E_DATABASE_URL,
		DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
		LOG_LEVEL: env.LOG_LEVEL ?? 'info'
	};
	if (mode === 'local-deployed') {
		// As deployed: no test routes, no setup token, no cron or backups, whatever the shell sets.
		const {
			ENABLE_TEST_ROUTES: _routes,
			OWNER_SETUP_TOKEN_HASH: _hash,
			CRON_SECRET: _cron,
			BACKUP_ENCRYPTION_KEY: _key,
			BACKUP_DIR: _dir,
			LIFECYCLE_STRICT: _strict,
			...deployed
		} = base;
		return { ...deployed, APP_ENV: 'production' };
	}
	return {
		...base,
		APP_ENV: 'test',
		ENABLE_TEST_ROUTES: 'true',
		OWNER_SETUP_TOKEN_HASH: setupTokenHash,
		CRON_SECRET: env.E2E_CRON_SECRET,
		BACKUP_ENCRYPTION_KEY: env.E2E_BACKUP_KEY,
		BACKUP_DIR: E2E_BACKUP_DIR,
		// An observed lifecycle throws on a move its table does not allow (lifecycle-guard.ts).
		LIFECYCLE_STRICT: '1'
	};
}

/**
 * Global setup for `baseURL` in the mode `env` selects. Workers inherit `env` (process.env in a
 * real run): the setup project reads E2E_SETUP_TOKEN from it.
 */
export async function runGlobalSetup(
	baseURL: string,
	env: NodeJS.ProcessEnv = process.env,
	io: SetupEffects = effects
): Promise<(() => Promise<void>) | undefined> {
	const mode = e2eMode(env);
	// A deployment's database is not ours: no reset, no minting, nothing started.
	if (mode === 'deployed') return undefined;

	let setupTokenHash: string | undefined;
	if (mode === 'local-deployed') {
		await io.migrate(E2E_DATABASE_URL);
		if (!(await io.hasOwner(E2E_DATABASE_URL))) {
			throw new Error(
				`[e2e] ${redactUrl(E2E_DATABASE_URL)} has no owner: E2E_DEPLOYED_LOCAL=1 runs after the main suite, on the database it set up.`
			);
		}
	} else {
		await io.reset(E2E_DATABASE_URL);
		console.log(`[e2e] database ready: ${redactUrl(E2E_DATABASE_URL)}`);

		io.freshDir(AUTH_DIR);
		// Workers inherit process.env from here: the setup project reads the token. Minted exactly as
		// `pnpm auth:setup-token` mints it, so it carries the default 24-hour expiry.
		const minted = mintSetupToken();
		env.E2E_SETUP_TOKEN = minted.token;
		setupTokenHash = minted.hash;

		if (mode === 'external-local') return undefined; // testing an externally managed server
	}

	// With E2E_TLS=1 the server is reached through the proxy; it listens on a free port of its own.
	// An https health check would fail on the self-signed certificate, so the proxy's port is probed.
	const tls = tlsEnabled(env);
	const busy = tls
		? await io.portTaken(Number(new URL(baseURL).port))
		: await io.isUp(`${baseURL}/api/health`);
	if (busy) {
		throw new Error(`[e2e] something is already serving ${baseURL}; stop it or set E2E_PORT.`);
	}

	if (env.E2E_SKIP_BUILD !== '1') io.build(baseURL);

	if (mode === 'local') {
		// The backup cron's secret and key, for this run only; workers inherit them from here.
		env.E2E_CRON_SECRET = randomBytes(32).toString('base64url');
		env.E2E_BACKUP_KEY = randomBytes(32).toString('base64');
		io.freshDir(E2E_BACKUP_DIR);
	}

	const port = tls ? String(await io.freePort()) : new URL(baseURL).port || '80';
	const serverURL = tls ? `http://127.0.0.1:${port}` : baseURL;
	const server = io.spawnServer(serverEnv(mode, env, baseURL, setupTokenHash, port));

	const deadline = Date.now() + 30_000;
	while (!(await io.isUp(`${serverURL}/api/health`))) {
		if (server.exitCode !== null) {
			throw new Error(`[e2e] server exited with code ${server.exitCode}; see .e2e-server.log`);
		}
		if (Date.now() > deadline) {
			server.kill('SIGKILL');
			throw new Error('[e2e] server did not become healthy within 30s; see .e2e-server.log');
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	let closeProxy: (() => Promise<void>) | undefined;
	if (tls) {
		try {
			closeProxy = await io.startTlsProxy(Number(new URL(baseURL).port), serverURL);
		} catch (error) {
			server.kill('SIGKILL');
			throw error;
		}
	}
	console.log(`[e2e] production server ready at ${baseURL} (${mode}${tls ? ', TLS proxy' : ''})`);

	return async () => {
		await closeProxy?.();
		if (server.exitCode === null) {
			server.kill('SIGTERM');
			await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 5_000))]);
		}
	};
}

export default async function globalSetup(config: FullConfig) {
	const baseURL = config.projects[0]?.use.baseURL;
	if (!baseURL) throw new Error('baseURL is not configured');
	return runGlobalSetup(baseURL);
}
