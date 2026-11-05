import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Deployment target. Production runs on Vercel (Node runtime, Fluid compute); local e2e,
 * Lighthouse and CI run the identical app on a real Node server via `ADAPTER=node`.
 */
const target = process.env.ADAPTER === 'node' ? 'node' : 'vercel';

function appVersion(): string {
	const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
		version: string;
	};
	let sha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '';
	if (!sha) {
		try {
			sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
				.toString()
				.trim();
		} catch {
			sha = 'local';
		}
	}
	return `${pkg.version}+${sha.slice(0, 7)}`;
}

export default defineConfig(({ mode }) => {
	// Make `.env` values visible to server code that reads `process.env` during `vite dev`.
	// Production servers receive real environment variables from the platform instead.
	if (mode === 'development') {
		for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
			process.env[key] ??= value;
		}
	}

	return {
		plugins: [
			sveltekit({
				compilerOptions: {
					// Runes everywhere in our own code; libraries decide for themselves.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter:
					target === 'node'
						? adapterNode({ out: 'build', precompress: true })
						: adapterVercel({ runtime: 'nodejs22.x' }),
				version: { name: appVersion(), pollInterval: 0 },
				// Small, render-critical CSS is inlined into the HTML to save a blocking round-trip.
				inlineStyleThreshold: 4096,
				output: { bundleStrategy: 'split' }
			})
		],
		build: {
			target: 'es2022',
			// Report gzip sizes in build output; budgets are enforced by scripts/check-budgets.ts.
			reportCompressedSize: true
		},
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'unit',
						environment: 'node',
						include: ['src/**/*.{test,spec}.ts'],
						exclude: ['src/**/*.svelte.{test,spec}.ts']
					}
				},
				{
					extends: './vite.config.ts',
					test: {
						name: 'integration',
						environment: 'node',
						include: ['tests/integration/**/*.test.ts'],
						globalSetup: ['tests/integration/global-setup.ts'],
						setupFiles: ['tests/integration/setup-env.ts'],
						// One shared Postgres test database: run files serially for determinism.
						fileParallelism: false,
						testTimeout: 15_000,
						hookTimeout: 30_000
					}
				}
			]
		}
	};
});
