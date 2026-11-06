/**
 * vite.config.ts bakes one build-time fact into the server: whether it was built for Vercel.
 * `VERCEL`/`VERCEL_ENV` exist only at runtime, so src/lib/server/env.ts relies on this constant
 * to refuse test-only routes in a Vercel build whatever its runtime environment says. It must
 * be set for every Vercel build, and only for builds: `vite dev` and Vitest behave like a local
 * run, and Node builds (e2e, Lighthouse) can still enable test routes.
 */
import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The `__VERCEL_BUILD__` replacement vite.config.ts gives for this adapter and command. */
async function vercelBuildFlag(adapter: string | undefined, command: ConfigEnv['command']) {
	vi.resetModules(); // vite.config.ts reads ADAPTER when it loads
	vi.stubEnv('ADAPTER', adapter);
	const { default: config } = await import('../vite.config.ts');
	const resolved: UserConfig = await config({ command, mode: 'production' });
	return resolved.define?.['__VERCEL_BUILD__'];
}

describe('vite.config.ts build target', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('marks every build for Vercel', async () => {
		expect(await vercelBuildFlag(undefined, 'build')).toBe('true');
		expect(await vercelBuildFlag('vercel', 'build')).toBe('true');
	});

	it('marks a Node build as not for Vercel', async () => {
		expect(await vercelBuildFlag('node', 'build')).toBe('false');
	});

	it('leaves it undefined outside a build (vite dev, Vitest)', async () => {
		expect(await vercelBuildFlag(undefined, 'serve')).toBeUndefined();
		expect(await vercelBuildFlag('node', 'serve')).toBeUndefined();
	});
});
