/**
 * Committed Vercel configuration (docs/deployment.md). Production is on: every merge to `main`
 * deploys through the Vercel Git integration, with no committed step that skips it. The build
 * command migrates the deployment's own database before building.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_ACCESS } from '../src/lib/server/auth/routes';

const root = new URL('../', import.meta.url);
interface VercelConfig {
	buildCommand?: string;
	git?: { deploymentEnabled?: Record<string, boolean> | boolean };
	ignoreCommand?: string;
	crons?: { path: string; schedule: string }[];
}
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as VercelConfig;

describe('Vercel deployments', () => {
	it('deploys main from Git, and no other branch', () => {
		// A branch matching several rules deploys if any matching rule is true, so `main` needs its
		// own `true` next to `"**": false`. Hobby caps an account at 100 deployments a day; a
		// preview for every push to every PR branch used that up (CI runs the Vercel build).
		expect(config.git?.deploymentEnabled).toEqual({ main: true, '**': false });
	});

	it('has no ignored build step that could skip a production build', () => {
		expect(config.ignoreCommand).toBeUndefined();
		expect(existsSync(new URL('scripts/vercel-ignore-build.sh', root))).toBe(false);
	});
});

/**
 * The longest a function may run on Hobby without Fluid compute (and valid with it): the cron's
 * maxDuration stays at or under it, so the config deploys either way.
 */
const HOBBY_MAX_DURATION_S = 60;

/** `export const config: Config = { maxDuration: N };` in a route module. */
const MAX_DURATION = /^export const config(?:: Config)? = \{ maxDuration: (\d+) \};$/m;

/**
 * Every way vercel.json's crons break Hobby or the cron access class: exactly one entry, firing
 * at most daily (a fixed minute and hour), on a route classified `cron`, whose module sets a
 * maxDuration of at most HOBBY_MAX_DURATION_S. `routeSource` reads a route's +server.ts.
 */
function cronProblems(crons: VercelConfig['crons'], routeSource: (path: string) => string) {
	const problems: string[] = [];
	if (crons?.length !== 1) problems.push(`expected exactly one cron, found ${crons?.length ?? 0}`);
	for (const { path: route, schedule } of crons ?? []) {
		const [minute, hour, ...rest] = schedule.trim().split(/\s+/);
		if (rest.length !== 3 || !/^\d{1,2}$/.test(minute ?? '') || !/^\d{1,2}$/.test(hour ?? '')) {
			problems.push(`${route}: '${schedule}' may fire more than once a day`);
		}
		if ((ROUTE_ACCESS as Record<string, string>)[route] !== 'cron') {
			problems.push(`${route}: not classified 'cron' in ROUTE_ACCESS`);
		}
		const maxDuration = MAX_DURATION.exec(routeSource(route))?.[1];
		if (maxDuration === undefined) problems.push(`${route}: no maxDuration`);
		else if (Number(maxDuration) > HOBBY_MAX_DURATION_S) {
			problems.push(`${route}: maxDuration ${maxDuration} is over ${HOBBY_MAX_DURATION_S}`);
		}
	}
	return problems;
}

const routeSource = (route: string) =>
	readFileSync(new URL(`src/routes${route}/+server.ts`, root), 'utf8');

describe('Vercel Cron', () => {
	it('runs the one backup cron at most daily, on a cron route that fits Hobby', () => {
		expect(config.crons).toEqual([{ path: '/api/cron/backup', schedule: expect.any(String) }]);
		expect(cronProblems(config.crons, routeSource)).toEqual([]);
	});

	it('fails a maxDuration over 60, a second cron, an hourly schedule or a session route', () => {
		const planted = (route: string) =>
			routeSource(route).replace('maxDuration: 60', 'maxDuration: 120');
		expect(cronProblems(config.crons, planted)).toEqual([
			'/api/cron/backup: maxDuration 120 is over 60'
		]);
		const crons = config.crons!;
		expect(cronProblems([...crons, ...crons], routeSource)).toEqual([
			'expected exactly one cron, found 2'
		]);
		for (const schedule of ['41 * * * *', '*/30 10 * * *', '41 10,22 * * *', '41 10 * *']) {
			expect(cronProblems([{ ...crons[0]!, schedule }], routeSource), schedule).toEqual([
				`/api/cron/backup: '${schedule}' may fire more than once a day`
			]);
		}
		expect(cronProblems([{ ...crons[0]!, path: '/api/vitals' }], routeSource)).toEqual([
			"/api/vitals: not classified 'cron' in ROUTE_ACCESS",
			'/api/vitals: no maxDuration'
		]);
	});
});

/** A fake `pnpm` on PATH that records its arguments instead of running anything. */
function buildStep(env: Record<string, string>) {
	const dir = mkdtempSync(path.join(tmpdir(), 'vercel-build-'));
	const log = path.join(dir, 'calls.log');
	writeFileSync(path.join(dir, 'pnpm'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
	const [command, ...args] = config.buildCommand!.split(' ');
	const result = spawnSync(command!, args, {
		cwd: root,
		env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
		encoding: 'utf8'
	});
	const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
	rmSync(dir, { recursive: true, force: true });
	return { ...result, calls };
}

describe('Vercel build command', () => {
	const url = 'postgres://u:p@ep-x.us-west-2.aws.neon.tech/neondb?sslmode=require';

	it('migrates preview and production databases before building', () => {
		for (const VERCEL_ENV of ['preview', 'production']) {
			const result = buildStep({ VERCEL_ENV, DATABASE_URL_UNPOOLED: url });
			expect(result.status, result.stderr).toBe(0);
			expect(result.calls).toEqual(['db:migrate', 'build']);
		}
	});

	it('refuses to build a deployed environment without a direct database URL', () => {
		for (const VERCEL_ENV of ['preview', 'production']) {
			const result = buildStep({ VERCEL_ENV });
			expect(result.status, VERCEL_ENV).not.toBe(0);
			expect(result.stderr).toContain('DATABASE_URL_UNPOOLED');
			expect(result.calls).toEqual([]);
		}
	});

	it('only builds outside Vercel deployments (no database to migrate)', () => {
		const result = buildStep({ VERCEL_ENV: 'development' });
		expect(result.status).toBe(0);
		expect(result.calls).toEqual(['build']);
	});
});
