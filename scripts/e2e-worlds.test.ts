/**
 * e2e/worlds.ts and e2e/world-copy.ts deriveBuild: which owner worlds a run serves, where each
 * world's server and database are, how a worker is pointed at its own, and the build copy each
 * other world's server runs. (copyDatabase has its integration test:
 * tests/integration/e2e-world-copy.test.ts.)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveBuild } from '../e2e/world-copy.ts';
import { SERIAL_WORKERS, serialWorkers } from '../e2e/serial-workers.ts';
import { routeWorker, world, worldCount, worlds } from '../e2e/worlds.ts';

const DB = 'postgres://coach:coach@localhost:5432/coach_e2e';
const serialLeg = {
	CI: '1',
	E2E_GROUP: 'serial',
	E2E_ENGINE: 'chromium',
	E2E_PORT: '4173',
	E2E_DATABASE_URL: DB
};

describe('worldCount', () => {
	it('gives a serial CI leg one world per worker of its engine, and every other run one', () => {
		// e2e/serial-workers.ts: two workers on Chromium, one on WebKit (its heavy tests outgrew
		// their timeout sharing the runner)
		expect(SERIAL_WORKERS).toEqual({ chromium: 2, webkit: 1 });
		expect(worldCount(serialLeg)).toBe(2);
		expect(worldCount({ ...serialLeg, E2E_ENGINE: 'webkit' })).toBe(1);
		expect(worldCount({ ...serialLeg, E2E_ENGINE: undefined })).toBe(1);
		expect(worldCount({ ...serialLeg, CI: '' })).toBe(1);
		for (const group of [undefined, 'main', 'alone', 'exclusive', 'sweeps']) {
			expect(worldCount({ ...serialLeg, E2E_GROUP: group }), String(group)).toBe(1);
		}
	});

	it('takes a serial leg’s workers for its engine, and 1 for no or an unknown engine', () => {
		expect(serialWorkers('chromium')).toBe(SERIAL_WORKERS.chromium);
		expect(serialWorkers('webkit')).toBe(SERIAL_WORKERS.webkit);
		for (const engine of [undefined, '', 'firefox']) expect(serialWorkers(engine)).toBe(1);
	});
});

describe('world', () => {
	it('keeps world 0 the run’s own and gives the others the next ports and databases', () => {
		expect(worlds(serialLeg)).toEqual([
			{ index: 0, port: 4173, origin: 'http://localhost:4173', databaseUrl: DB },
			{
				index: 1,
				port: 4174,
				origin: 'http://localhost:4174',
				databaseUrl: 'postgres://coach:coach@localhost:5432/coach_w1_e2e'
			}
		]);
	});

	it('is the run’s own origin and database with one world, whatever serves it', () => {
		expect(world(0, { E2E_PORT: '5000', E2E_DATABASE_URL: DB })).toEqual({
			index: 0,
			port: 5000,
			origin: 'http://localhost:5000',
			databaseUrl: DB
		});
		expect(world(0, { E2E_BASE_URL: 'https://coach.example.com' }).origin).toBe(
			'https://coach.example.com'
		);
		expect(world(0, { E2E_TLS: '1', E2E_PORT: '5000' }).origin).toBe('https://localhost:5000');
	});

	it('refuses a world the run does not have, and a database a reset would refuse', () => {
		expect(() => world(SERIAL_WORKERS.chromium, serialLeg)).toThrow(/worlds 0 to/);
		expect(() => world(1, { E2E_PORT: '4173' })).toThrow(/worlds 0 to 0/);
		expect(() =>
			world(1, { ...serialLeg, E2E_DATABASE_URL: 'postgres://localhost/coach_dev' })
		).toThrow(/ending in _e2e/);
	});
});

describe('routeWorker', () => {
	it('points a worker at the world of its parallel index, and keeps world 0 findable', () => {
		const env: NodeJS.ProcessEnv = { ...serialLeg, TEST_PARALLEL_INDEX: '1' };
		routeWorker(env);
		expect(env).toMatchObject({
			E2E_WORLD: '1',
			E2E_PORT: '4174',
			E2E_DATABASE_URL: 'postgres://coach:coach@localhost:5432/coach_w1_e2e'
		});
		expect(worlds(env)).toEqual(worlds(serialLeg));
		// Once is enough: a second call changes nothing.
		const routed = { ...env };
		routeWorker(env);
		expect(env).toEqual(routed);
	});

	it('routes a worker that inherits a setup worker’s world to its own', () => {
		// Playwright gives dependent projects' workers the environment their setup's worker left.
		const setupWorker: NodeJS.ProcessEnv = { ...serialLeg, TEST_PARALLEL_INDEX: '0' };
		routeWorker(setupWorker);
		const serialWorker: NodeJS.ProcessEnv = { ...setupWorker, TEST_PARALLEL_INDEX: '1' };
		routeWorker(serialWorker);
		expect(serialWorker).toMatchObject({ E2E_WORLD: '1', E2E_PORT: '4174' });
		expect(serialWorker.E2E_DATABASE_URL).toMatch(/coach_w1_e2e$/);
		const back: NodeJS.ProcessEnv = { ...serialWorker, TEST_PARALLEL_INDEX: '0' };
		routeWorker(back);
		expect(back).toMatchObject({ E2E_WORLD: '0', E2E_PORT: '4173', E2E_DATABASE_URL: DB });
	});

	it('leaves world 0’s worker, the runner and one-world runs as they are', () => {
		const zero: NodeJS.ProcessEnv = { ...serialLeg, TEST_PARALLEL_INDEX: '0' };
		routeWorker(zero);
		expect(zero).toMatchObject({ E2E_PORT: '4173', E2E_DATABASE_URL: DB, E2E_WORLD: '0' });
		for (const env of [
			{ ...serialLeg },
			{ ...serialLeg, E2E_GROUP: 'main', TEST_PARALLEL_INDEX: '1' },
			{ ...serialLeg, E2E_ENGINE: 'webkit', TEST_PARALLEL_INDEX: '0' }
		] as NodeJS.ProcessEnv[]) {
			const before = { ...env };
			routeWorker(env);
			expect(env).toEqual(before);
		}
	});

	it('refuses a worker past the run’s worlds', () => {
		expect(() =>
			routeWorker({ ...serialLeg, TEST_PARALLEL_INDEX: String(SERIAL_WORKERS.chromium) })
		).toThrow(/worlds 0 to/);
	});
});

describe('deriveBuild', () => {
	const scratch = mkdtempSync(path.join(tmpdir(), 'e2e-worlds-'));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const FROM = 'http://localhost:4173';
	const TO = 'http://localhost:4174';

	/** A build as adapter-node lays it out, its origin in the two places it bakes it into. */
	function build(name: string, extra: Record<string, string> = {}): string {
		const dir = path.join(scratch, name);
		const files: Record<string, string> = {
			'adapter-node.js': `export const origin = ${JSON.stringify(FROM)};\n`,
			'index.js': `export * from './server/adapter-index.js';\n`,
			'server/chunks/framework.js': `get_self_origin(${JSON.stringify(FROM)}, url.origin); // ${FROM}0\n`,
			'client/_app/immutable/app.js': 'console.log("no origin here")\n',
			...extra
		};
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), text);
		}
		return dir;
	}

	it('copies the build with the other origin wherever the first was baked in', () => {
		const from = build('ok');
		const to = path.join(scratch, 'ok-w1');
		deriveBuild(from, to, FROM, TO);
		const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');
		expect(read(to, 'adapter-node.js')).toBe(`export const origin = ${JSON.stringify(TO)};\n`);
		// Only the origin itself: a longer port that starts with it stays.
		expect(read(to, 'server/chunks/framework.js')).toBe(
			`get_self_origin(${JSON.stringify(TO)}, url.origin); // ${FROM}0\n`
		);
		expect(read(to, 'client/_app/immutable/app.js')).toBe(
			read(from, 'client/_app/immutable/app.js')
		);
		expect(read(from, 'adapter-node.js')).toContain(FROM);
	});

	it('refuses a build made for another origin', () => {
		expect(() => deriveBuild(build('other'), path.join(scratch, 'other-w1'), TO, FROM)).toThrow(
			/not an adapter-node build for/
		);
	});

	it('refuses an origin baked into a file it cannot rewrite', () => {
		const precompressed = build('compressed', {
			'prerendered/offline.html': `<a href="${FROM}/">`,
			'prerendered/offline.html.br': 'brotli'
		});
		expect(() => deriveBuild(precompressed, path.join(scratch, 'compressed-w1'), FROM, TO)).toThrow(
			/cannot be replaced/
		);
		const binary = build('binary', { 'client/icon.png': `PNG${FROM}` });
		expect(() => deriveBuild(binary, path.join(scratch, 'binary-w1'), FROM, TO)).toThrow(
			/cannot be replaced/
		);
	});
});
