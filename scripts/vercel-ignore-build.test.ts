/**
 * The "no production before auth" rule is enforced by committed config, not by a dashboard
 * setting (docs/deployment.md): Vercel never deploys `main` from Git, and the ignored build step
 * skips every production build Vercel starts by itself.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as {
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
		expect(result.stdout).toContain('deploy.yml');
	});

	it('lets preview builds through', () => {
		expect(ignoreStep({ VERCEL_ENV: 'preview' }).status).toBe(1); // 1 = build
		expect(ignoreStep({}).status).toBe(1);
	});
});
