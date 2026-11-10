/**
 * e2e/global-setup.ts in each target mode (e2e/projects.ts e2eMode), with the database, build and
 * server faked: a deployed run touches no database and keeps the setup token it was given; an
 * external-local run resets and mints but starts nothing; a local-deployed run migrates without a
 * reset, refuses a database with no owner, and starts the build with test routes off. With
 * E2E_TLS=1 the server listens on a free internal port behind the TLS proxy, which serves E2E_PORT.
 */
import { EventEmitter, once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
	AUTH_DIR,
	E2E_BACKUP_DIR,
	E2E_DATABASE_URL,
	portTaken,
	runGlobalSetup,
	type SetupEffects
} from '../e2e/global-setup.ts';

const BASE_URL = 'http://localhost:5999';
const TLS_URL = 'https://localhost:5999';
const INTERNAL_PORT = 41234;

/** Fakes that record every call; the server becomes healthy once spawned. */
function fakes({
	owner = true,
	proxyFails = false,
	portBusy = false
}: { owner?: boolean; proxyFails?: boolean; portBusy?: boolean } = {}) {
	const calls: string[] = [];
	const polled: string[] = [];
	let spawned: NodeJS.ProcessEnv | undefined;
	const server = Object.assign(new EventEmitter(), {
		exitCode: null as number | null,
		kill: vi.fn(() => {
			// As a real child: the exit event comes after kill() returns.
			setImmediate(() => {
				server.exitCode = 0;
				server.emit('exit', 0);
			});
			return true;
		})
	});
	const io: SetupEffects = {
		reset: vi.fn(async (url: string) => calls.push(`reset ${url}`)),
		migrate: vi.fn(async (url: string) => calls.push(`migrate ${url}`)),
		hasOwner: vi.fn(async (url: string) => {
			calls.push(`hasOwner ${url}`);
			return owner;
		}),
		build: vi.fn((url: string) => void calls.push(`build ${url}`)),
		spawnServer: vi.fn((env: NodeJS.ProcessEnv) => {
			calls.push('spawn');
			spawned = env;
			return server as unknown as ChildProcess;
		}),
		isUp: vi.fn(async (url: string) => {
			polled.push(url);
			return spawned !== undefined;
		}),
		freshDir: vi.fn((dir: string) => void calls.push(`fresh ${dir}`)),
		portTaken: vi.fn(async (port: number) => {
			calls.push(`portTaken ${port}`);
			return portBusy;
		}),
		freePort: vi.fn(async () => INTERNAL_PORT),
		startTlsProxy: vi.fn(async (port: number, target: string) => {
			calls.push(`proxy ${port} → ${target}`);
			if (proxyFails) throw new Error('port in use');
			return async () => void calls.push('proxy closed');
		})
	};
	return { io, calls, polled, server, spawnedEnv: () => spawned };
}

describe('global setup modes', () => {
	it('deployed: touches no database, builds and starts nothing, keeps a provided token', async () => {
		const { io, calls } = fakes();
		const env: NodeJS.ProcessEnv = {
			E2E_BASE_URL: 'https://coach.example.com',
			E2E_SETUP_TOKEN: 'given-token'
		};
		expect(await runGlobalSetup('https://coach.example.com', env, io)).toBeUndefined();
		expect(calls).toEqual([]);
		expect(env.E2E_SETUP_TOKEN).toBe('given-token');
	});

	it('external-local: resets the database and mints a token, but starts nothing', async () => {
		const { io, calls } = fakes();
		const env: NodeJS.ProcessEnv = { E2E_BASE_URL: BASE_URL, E2E_TEST_AUTH: '1' };
		expect(await runGlobalSetup(BASE_URL, env, io)).toBeUndefined();
		expect(calls).toEqual([`reset ${E2E_DATABASE_URL}`, `fresh ${AUTH_DIR}`]);
		expect(env.E2E_SETUP_TOKEN).toMatch(/\S{20,}/);
	});

	it('local: resets, mints, builds and starts the server with test routes and the token hash', async () => {
		const { io, calls, spawnedEnv } = fakes();
		const env: NodeJS.ProcessEnv = {};
		const teardown = await runGlobalSetup(BASE_URL, env, io);
		expect(calls).toEqual([
			`reset ${E2E_DATABASE_URL}`,
			`fresh ${AUTH_DIR}`,
			`build ${BASE_URL}`,
			`fresh ${E2E_BACKUP_DIR}`,
			'spawn'
		]);
		expect(spawnedEnv()).toMatchObject({
			NODE_ENV: 'production',
			APP_ENV: 'test',
			ENABLE_TEST_ROUTES: 'true',
			OWNER_SETUP_TOKEN_HASH: expect.stringMatching(/^[0-9a-f]{64}$/),
			PORT: '5999',
			ORIGIN: BASE_URL,
			DATABASE_URL: E2E_DATABASE_URL
		});
		expect(env.E2E_SETUP_TOKEN).toBeTruthy();
		expect(spawnedEnv()!.CRON_SECRET).toBe(env.E2E_CRON_SECRET);
		expect(env.E2E_CRON_SECRET).toBeTruthy();
		await teardown!();
	});

	it('local-deployed: migrates without a reset and starts the build with test routes off', async () => {
		const { io, calls, server, spawnedEnv } = fakes();
		// Inherited switches must not leak into the server either.
		const env: NodeJS.ProcessEnv = {
			E2E_DEPLOYED_LOCAL: '1',
			ENABLE_TEST_ROUTES: 'true',
			OWNER_SETUP_TOKEN_HASH: 'a'.repeat(64),
			APP_ENV: 'test',
			CRON_SECRET: 'shell-cron',
			BACKUP_ENCRYPTION_KEY: 'shell-key',
			BACKUP_DIR: '/tmp/shell-backups',
			LIFECYCLE_STRICT: '1'
		};
		const teardown = await runGlobalSetup(BASE_URL, env, io);
		expect(calls).toEqual([
			`migrate ${E2E_DATABASE_URL}`,
			`hasOwner ${E2E_DATABASE_URL}`,
			`build ${BASE_URL}`,
			'spawn'
		]);
		expect(io.reset).not.toHaveBeenCalled();
		const serverEnv = spawnedEnv()!;
		expect(serverEnv).not.toHaveProperty('ENABLE_TEST_ROUTES');
		expect(serverEnv).not.toHaveProperty('OWNER_SETUP_TOKEN_HASH');
		for (const name of ['CRON_SECRET', 'BACKUP_ENCRYPTION_KEY', 'BACKUP_DIR', 'LIFECYCLE_STRICT']) {
			expect(serverEnv).not.toHaveProperty(name);
		}
		expect(serverEnv).toMatchObject({
			NODE_ENV: 'production',
			APP_ENV: 'production',
			ORIGIN: BASE_URL,
			DATABASE_URL: E2E_DATABASE_URL
		});
		expect(env.E2E_SETUP_TOKEN).toBeUndefined();
		await teardown!();
		expect(server.kill).toHaveBeenCalledWith('SIGTERM');
	});

	it('local-deployed: E2E_SKIP_BUILD=1 starts the existing build', async () => {
		const { io, calls } = fakes();
		const teardown = await runGlobalSetup(
			BASE_URL,
			{ E2E_DEPLOYED_LOCAL: '1', E2E_SKIP_BUILD: '1' },
			io
		);
		expect(calls).not.toContain(`build ${BASE_URL}`);
		expect(calls.at(-1)).toBe('spawn');
		await teardown!();
	});

	it('local-deployed: refuses a database with no owner, before building or starting anything', async () => {
		const { io, calls } = fakes({ owner: false });
		await expect(runGlobalSetup(BASE_URL, { E2E_DEPLOYED_LOCAL: '1' }, io)).rejects.toThrow(
			/has no owner/
		);
		expect(calls).toEqual([`migrate ${E2E_DATABASE_URL}`, `hasOwner ${E2E_DATABASE_URL}`]);
	});

	it('local with E2E_TLS=1: the server on a free port with the https origin, the proxy on E2E_PORT', async () => {
		const { io, calls, polled, server, spawnedEnv } = fakes();
		const teardown = await runGlobalSetup(TLS_URL, { E2E_TLS: '1' }, io);
		expect(calls).toEqual([
			`reset ${E2E_DATABASE_URL}`,
			`fresh ${AUTH_DIR}`,
			'portTaken 5999',
			`build ${TLS_URL}`,
			`fresh ${E2E_BACKUP_DIR}`,
			'spawn',
			`proxy 5999 → http://127.0.0.1:${INTERNAL_PORT}`
		]);
		expect(spawnedEnv()).toMatchObject({
			PORT: String(INTERNAL_PORT),
			ORIGIN: TLS_URL,
			ENABLE_TEST_ROUTES: 'true'
		});
		// Healthy means the server itself answered, before the proxy existed.
		expect(polled.at(-1)).toBe(`http://127.0.0.1:${INTERNAL_PORT}/api/health`);
		await teardown!();
		expect(calls.at(-1)).toBe('proxy closed');
		expect(server.kill).toHaveBeenCalledWith('SIGTERM');
	});

	it('local-deployed with E2E_TLS=1: the same proxy in front of the build with test routes off', async () => {
		const { io, calls, spawnedEnv } = fakes();
		const teardown = await runGlobalSetup(TLS_URL, { E2E_DEPLOYED_LOCAL: '1', E2E_TLS: '1' }, io);
		expect(calls.slice(-2)).toEqual(['spawn', `proxy 5999 → http://127.0.0.1:${INTERNAL_PORT}`]);
		expect(spawnedEnv()).toMatchObject({ PORT: String(INTERNAL_PORT), ORIGIN: TLS_URL });
		expect(spawnedEnv()).not.toHaveProperty('ENABLE_TEST_ROUTES');
		await teardown!();
	});

	it('without E2E_TLS: no proxy, the server on E2E_PORT itself', async () => {
		const { io } = fakes();
		const teardown = await runGlobalSetup(BASE_URL, {}, io);
		expect(io.startTlsProxy).not.toHaveBeenCalled();
		expect(io.freePort).not.toHaveBeenCalled();
		await teardown!();
	});

	it('E2E_TLS=1: a busy E2E_PORT is refused before the build, by a TCP probe', async () => {
		const { io, calls } = fakes({ portBusy: true });
		await expect(runGlobalSetup(TLS_URL, { E2E_TLS: '1' }, io)).rejects.toThrow(/already serving/);
		expect(calls.at(-1)).toBe('portTaken 5999');
		expect(io.build).not.toHaveBeenCalled();
	});

	it('E2E_TLS=1: a proxy that cannot start stops the server it fronts', async () => {
		const { io, server } = fakes({ proxyFails: true });
		await expect(runGlobalSetup(TLS_URL, { E2E_TLS: '1' }, io)).rejects.toThrow(/port in use/);
		expect(server.kill).toHaveBeenCalledWith('SIGKILL');
	});
});

describe('portTaken', () => {
	it('sees a server on either loopback, since the proxy listens on both', async () => {
		for (const host of ['127.0.0.1', '::1']) {
			const server = createServer().listen(0, host);
			await once(server, 'listening');
			const { port } = server.address() as AddressInfo;
			try {
				expect(await portTaken(port), host).toBe(true);
			} finally {
				server.close();
				await once(server, 'close');
			}
			expect(await portTaken(port), `${host} after close`).toBe(false);
		}
	});
});
