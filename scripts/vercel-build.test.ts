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

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as {
	buildCommand?: string;
	git?: { deploymentEnabled?: Record<string, boolean> | boolean };
	ignoreCommand?: string;
};

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
