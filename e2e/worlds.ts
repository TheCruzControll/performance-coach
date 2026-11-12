/**
 * Owner worlds: how a serial CI leg runs its specs on more than one worker.
 *
 * The app has one owner (owners_singleton_uq), and the serial specs reset and change that owner's
 * training profile, so two of them never share a database and a server. A world is one of each:
 * world 0 is the run's own (E2E_PORT, E2E_DATABASE_URL); world w ≥ 1 serves on E2E_PORT + w from
 * a database of its own, `<name>_w<w>_e2e`.
 *
 * - Global setup (e2e/global-setup.ts) resets every world's database and starts one production
 *   server per world, from copies of the one build made for each origin (e2e/world-copy.ts).
 * - Each worker serves the world of its TEST_PARALLEL_INDEX (routeWorker, which
 *   playwright.config.ts calls before anything reads E2E_PORT or E2E_DATABASE_URL). Workers that
 *   run at the same time have different indexes, and a restarted worker keeps its index, so a
 *   world never has two workers at once.
 * - The owner setup runs once, in the world of the worker it lands on; setup-webkit mints its
 *   session in that same world (ownerWorld), and setup-worlds (e2e/worlds.setup.ts) then copies
 *   that world's database into every other one. Every world starts from the same owner, passkeys
 *   and sessions, as one serial leg's specs always have.
 *
 * Only a serial CI leg (E2E_GROUP=serial) on an engine whose SERIAL_WORKERS is above 1 (Chromium;
 * WebKit keeps one, e2e/serial-workers.ts says why) runs more than one world; every other run
 * keeps one, where all of this is a no-op: the main group's specs share the one owner by design.
 */
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';
import { DEFAULT_E2E_PORT, e2eBaseURL, type E2EEnv } from './projects';
import { serialWorkers } from './serial-workers';

/**
 * How many worlds this run serves: one per worker of a serial CI leg (serialWorkers, the one place
 * they are set per engine), else 1.
 */
export function worldCount(env: E2EEnv): number {
	return env.CI && env.E2E_GROUP === 'serial' ? serialWorkers(env.E2E_ENGINE) : 1;
}

export interface World {
	index: number;
	port: number;
	origin: string;
	databaseUrl: string;
}

/**
 * World 0's port and database: routeWorker keeps them in E2E_WORLD0_* before it points E2E_PORT
 * and E2E_DATABASE_URL at the worker's own world.
 */
function worldZero(env: E2EEnv): { port: number; databaseUrl: string } {
	return {
		port: Number(env.E2E_WORLD0_PORT || env.E2E_PORT || DEFAULT_E2E_PORT),
		databaseUrl: env.E2E_WORLD0_DATABASE_URL || env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e
	};
}

/** `url` with its database named `name`. */
export function onDatabase(url: string, name: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${encodeURIComponent(name)}`;
	return parsed.toString();
}

/** World `index` of this run. World 0's origin is the run's (e2eBaseURL); the others are http. */
export function world(index: number, env: E2EEnv): World {
	const count = worldCount(env);
	if (!Number.isInteger(index) || index < 0 || index >= count) {
		throw new Error(`world ${index}: this run has worlds 0 to ${count - 1}`);
	}
	const zero = worldZero(env);
	if (count === 1) {
		return { index, port: zero.port, origin: e2eBaseURL(env), databaseUrl: zero.databaseUrl };
	}
	const port = zero.port + index;
	const name = decodeURIComponent(new URL(zero.databaseUrl).pathname.slice(1));
	if (!name.endsWith('_e2e')) {
		throw new Error(`E2E_DATABASE_URL names ${name}: worlds need a database ending in _e2e`);
	}
	const databaseUrl =
		index === 0
			? zero.databaseUrl
			: onDatabase(zero.databaseUrl, `${name.slice(0, -4)}_w${index}_e2e`);
	return { index, port, origin: `http://localhost:${port}`, databaseUrl };
}

/** Every world of this run, world 0 first. */
export function worlds(env: E2EEnv): World[] {
	return Array.from({ length: worldCount(env) }, (_, index) => world(index, env));
}

/**
 * In a worker of a run with more than one world, points E2E_PORT and E2E_DATABASE_URL at the
 * world of the worker's TEST_PARALLEL_INDEX (and records it as E2E_WORLD); anywhere else it
 * changes nothing. The specs read both (e2eBaseURL, support.ts query), so they reach only their
 * own world's server and database.
 *
 * It routes from E2E_WORLD0_* whenever they are set, never from what it finds in E2E_PORT or
 * E2E_WORLD: Playwright hands the environment a setup project's worker changed to the workers
 * of the projects that depend on it, so a serial worker starts with the setup worker's world.
 */
export function routeWorker(env: NodeJS.ProcessEnv): void {
	if (worldCount(env) === 1 || env.TEST_PARALLEL_INDEX === undefined) return;
	const zero = worldZero(env);
	const own = world(Number(env.TEST_PARALLEL_INDEX), env);
	env.E2E_WORLD0_PORT = String(zero.port);
	env.E2E_WORLD0_DATABASE_URL = zero.databaseUrl;
	env.E2E_WORLD = String(own.index);
	env.E2E_PORT = String(own.port);
	env.E2E_DATABASE_URL = own.databaseUrl;
}
