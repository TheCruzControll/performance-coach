import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
	median,
	parseArgs,
	parseServerTiming,
	probe,
	summarise,
	timeRequest,
	type Sample
} from './production-probe';

const SCRIPT = fileURLToPath(new URL('./production-probe.ts', import.meta.url));
const run = promisify(execFile);

/**
 * A stand-in for the deployed app, answering as production does signed out: /today redirects to
 * sign-in from the function, /workout is a CDN file, /api/health reaches the database. Its first
 * function request is cold (the app's instance flag), every later one warm.
 */
function fakeProduction(health = 200) {
	let served = 0;
	const seen: string[] = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url ?? '');
		const instance = () => `instance;desc="${++served === 1 ? 'cold' : 'warm'}"`;
		if (req.url === '/today') {
			res.writeHead(303, {
				location: '/?next=%2Ftoday',
				'server-timing': `total;dur=2.0, ${instance()}`,
				'x-vercel-id': 'sfo1::pdx1::abc12-1730000000000-0123456789ab'
			});
		} else if (req.url === '/workout') {
			res.writeHead(200, { 'content-type': 'text/html', 'x-vercel-cache': 'HIT' });
			res.write('<!doctype html><title>Workout</title>');
		} else if (req.url === '/api/health') {
			res.writeHead(health, {
				'content-type': 'application/json',
				'server-timing': `db;dur=601.8;desc="1 op", total;dur=623.7, ${instance()}`
			});
			res.write('{"ok":true,"db":"up"}');
		} else {
			res.writeHead(404);
		}
		res.end();
	});
	let connections = 0;
	server.on('connection', () => connections++);
	return { server, seen, connections: () => connections };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

async function listen(health = 200) {
	const fake = fakeProduction(health);
	await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
	close = () => new Promise((resolve) => fake.server.close(() => resolve()));
	const { port } = fake.server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, seen: fake.seen, connections: fake.connections };
}

describe('parseServerTiming', () => {
	it('reads durations, descriptions and bare metrics', () => {
		expect(
			parseServerTiming('db;dur=601.8;desc="1 op", total;dur=623.7, instance;desc="cold", cache')
		).toEqual([
			{ name: 'db', dur: 601.8, desc: '1 op' },
			{ name: 'total', dur: 623.7 },
			{ name: 'instance', desc: 'cold' },
			{ name: 'cache' }
		]);
	});

	it('is empty without a header and ignores a malformed duration', () => {
		expect(parseServerTiming(undefined)).toEqual([]);
		expect(parseServerTiming('total;dur=abc')).toEqual([{ name: 'total' }]);
	});
});

describe('median', () => {
	it('takes the middle value, or the mean of the middle two', () => {
		expect(median([])).toBeUndefined();
		expect(median([30, 10, 20])).toBe(20);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});

describe('parseArgs', () => {
	it('defaults to production and five warm rounds', () => {
		expect(parseArgs([])).toEqual({ origin: 'https://coach.nikocruz.com', warmRounds: 5 });
	});

	it('takes an origin and a round count, and refuses anything else', () => {
		expect(parseArgs(['--origin', 'http://127.0.0.1:3000/x', '--warm', '2'])).toEqual({
			origin: 'http://127.0.0.1:3000',
			warmRounds: 2
		});
		expect(() => parseArgs(['--warm', '0'])).toThrow(/whole number/);
		expect(() => parseArgs(['--token', 'x'])).toThrow(/unknown argument/);
	});
});

describe('probe against a local server', () => {
	it('times each path on its own connection and reads its Server-Timing', async () => {
		const { origin } = await listen();
		const sample = await timeRequest(new URL('/api/health', origin), 'cold');
		expect(sample).toMatchObject({
			path: '/api/health',
			round: 'cold',
			status: 200,
			serverTotalMs: 623.7,
			dbMs: 601.8,
			instance: 'cold'
		});
		expect(sample.ttfbMs).toBeGreaterThan(0);
		expect(sample.waitMs).toBeGreaterThan(0);
		expect(sample.waitMs).toBeLessThanOrEqual(sample.ttfbMs);
	});

	it('runs a cold round with /today first, then the warm rounds, one request at a time', async () => {
		const { origin, seen, connections } = await listen();
		const samples = await probe(origin, 2);
		// No keep-alive: each request pays for its own connection, as a launch does.
		expect(connections()).toBe(9);
		expect(seen).toEqual([
			...['/today', '/workout', '/api/health'],
			...['/today', '/workout', '/api/health'],
			...['/today', '/workout', '/api/health']
		]);
		expect(samples.map((s) => `${s.round} ${s.path} ${s.status} ${s.instance ?? '-'}`)).toEqual([
			'cold /today 303 cold',
			'cold /workout 200 -',
			'cold /api/health 200 warm',
			'warm /today 303 warm',
			'warm /workout 200 -',
			'warm /api/health 200 warm',
			'warm /today 303 warm',
			'warm /workout 200 -',
			'warm /api/health 200 warm'
		]);
		expect(samples[1]).toMatchObject({ cache: 'HIT', serverTotalMs: undefined });
	});

	it('records an unreachable origin as a failed sample, never a throw', async () => {
		const { origin } = await listen();
		await close!();
		close = undefined;
		const sample = await timeRequest(new URL('/today', origin), 'cold');
		expect(sample.status).toBe(0);
		expect(sample.error).toMatch(/ECONNREFUSED/);
	});
});

describe('summarise', () => {
	const sample = (over: Partial<Sample>): Sample => ({
		path: '/today',
		round: 'warm',
		status: 303,
		ttfbMs: 100,
		waitMs: 60,
		...over
	});

	it('shows the cold sample, then the warm medians, per path', () => {
		const table = summarise('https://coach.example', [
			sample({
				round: 'cold',
				ttfbMs: 2383,
				waitMs: 2200,
				serverTotalMs: 623.7,
				instance: 'cold',
				vercelId: 'sfo1::pdx1::abc'
			}),
			sample({ ttfbMs: 104, waitMs: 50, serverTotalMs: 3, instance: 'warm' }),
			sample({ ttfbMs: 158, waitMs: 70, serverTotalMs: 5, instance: 'warm' }),
			sample({ ttfbMs: 120, waitMs: 60, serverTotalMs: 4, instance: 'warm' }),
			sample({ path: '/workout', round: 'cold', status: 200, ttfbMs: 40, cache: 'HIT' })
		]);
		expect(table).toContain(
			'| /today | first (after idle) | 303 | 2383 ms | 2200 ms | 623.7 ms | - | cold | sfo1::pdx1 |'
		);
		expect(table).toContain(
			'| /today | warm (median of 3) | 303 | 120 ms | 60 ms | 4 ms | - | warm | - |'
		);
		expect(table).toContain(
			'| /workout | first (after idle) | 200 | 40 ms | 60 ms | - | - | - | cache HIT |'
		);
	});

	it('lists failures under the table', () => {
		const table = summarise('https://coach.example', [
			sample({ round: 'cold', status: 0, error: 'connect ETIMEDOUT' })
		]);
		expect(table).toContain('| /today | first (after idle) | failed |');
		expect(table).toContain('FAILED cold /today: connect ETIMEDOUT');
	});
});

describe('the command the workflow runs', () => {
	it('prints the table and a JSON line, and exits 0 while every path answers', async () => {
		const { origin } = await listen();
		const { stdout } = await run(process.execPath, [SCRIPT, '--origin', origin, '--warm', '1'], {
			env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
		});
		expect(stdout).toContain(`Production probe of ${origin}`);
		expect(stdout).toMatch(
			/\| \/today \| first \(after idle\) \| 303 \| [\d.]+ ms \| .* \| cold \|/
		);
		expect(stdout).toMatch(/\| \/api\/health \| warm \(median of 1\) \| 200 \| .* \| 601\.8 ms \|/);
		const json = JSON.parse(stdout.split('PROBE_JSON ')[1]!) as { samples: Sample[] };
		expect(json.samples).toHaveLength(6);
	});

	it('exits non-zero when a path answers 5xx', async () => {
		const { origin } = await listen(503);
		await expect(
			run(process.execPath, [SCRIPT, '--origin', origin, '--warm', '1'], {
				env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
			})
		).rejects.toMatchObject({ code: 1 });
	});
});

describe('the workflow', () => {
	const workflow = readFileSync(
		new URL('../.github/workflows/production-probe.yml', import.meta.url),
		'utf8'
	);

	it('runs on a schedule and on demand, never on a pull request or push', () => {
		expect(workflow).toMatch(/^on:\n {2}schedule:\n {4}- cron: '[^']+'/m);
		expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
		expect(workflow).not.toMatch(/^ {2}(pull_request|pull_request_target|push|merge_group):/m);
	});

	it('uses no credentials and runs this script without installing anything', () => {
		expect(workflow).not.toMatch(/secrets\.|environment:/);
		expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
		expect(workflow).toContain('run: node scripts/production-probe.ts');
		expect(workflow).not.toMatch(/pnpm|npm (ci|install)/);
		// So the script may import Node's built-ins only.
		const imports = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(
			(m) => m[1]
		);
		expect(imports.length).toBeGreaterThan(0);
		expect(imports.filter((name) => !name!.startsWith('node:'))).toEqual([]);
	});
});
