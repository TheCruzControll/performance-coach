/**
 * The "no production before auth" rule is enforced by committed config, not by a dashboard
 * setting (docs/deployment.md): Vercel never deploys `main` from Git, and the ignored build step
 * skips every production build Vercel starts by itself. The build command migrates the
 * deployment's own database before building.
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

function ignoreStep(env: Record<string, string>) {
	const [command, ...args] = config.ignoreCommand!.split(' ');
	return spawnSync(command!, args, {
		cwd: root,
		env: { PATH: process.env.PATH ?? '', ...env },
		encoding: 'utf8'
	});
}

describe('Vercel production guard', () => {
	it('never deploys main from Git', () => {
		expect(config.git?.deploymentEnabled).toEqual({ main: false });
	});

	it('skips every production build Vercel starts itself', () => {
		const result = ignoreStep({ VERCEL_ENV: 'production' });
		expect(result.status).toBe(0); // 0 = ignore the build
		expect(result.stdout).toContain('until passkey auth ships');
	});

	it('lets preview builds through', () => {
		expect(ignoreStep({ VERCEL_ENV: 'preview' }).status).toBe(1); // 1 = build
		expect(ignoreStep({}).status).toBe(1);
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
		const result = buildStep({ VERCEL_ENV: 'preview' });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('DATABASE_URL_UNPOOLED');
		expect(result.calls).toEqual([]);
	});

	it('only builds outside Vercel deployments (no database to migrate)', () => {
		const result = buildStep({ VERCEL_ENV: 'development' });
		expect(result.status).toBe(0);
		expect(result.calls).toEqual(['build']);
	});
});
