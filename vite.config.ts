import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * CSP hashes for the inline scripts in src/app.html (the pre-paint theme script). SvelteKit
 * adds nonces/hashes for the scripts it generates, but not for scripts in the template.
 */
function templateScriptHashes(): `sha256-${string}`[] {
	const html = readFileSync(new URL('./src/app.html', import.meta.url), 'utf8');
	return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
		([, body]) => `sha256-${createHash('sha256').update(body!).digest('base64')}` as const
	);
}

export default defineConfig(({ command, mode }) => {
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
				output: { bundleStrategy: 'split' },
				// Absolute URLs everywhere (served from the domain root); simpler for the service worker.
				// adapter-node (SvelteKit 3) takes its public origin from here at build time, not from
				// an ORIGIN variable at run time; without it every request looks like https://<host>.
				// Local Node builds served over plain HTTP (e2e, Lighthouse, `pnpm start`) set ORIGIN
				// when building, so CSRF checks, cookies and the WebAuthn origin see the real origin.
				// Vercel builds leave it unset: the platform reports the real origin per request.
				paths: {
					relative: false,
					origin: target === 'node' && process.env.ORIGIN ? process.env.ORIGIN : undefined
				},
				/**
				 * Content-Security-Policy. `auto`: a per-response nonce on server-rendered pages (the
				 * only option that also covers the scripts /profile streams after the headers are
				 * sent) and hashes on prerendered ones (/offline, as a <meta>). Styles allow
				 * 'unsafe-inline' because Svelte's `style:` directives render style attributes;
				 * scripts never do.
				 */
				csp: {
					mode: 'auto',
					directives: {
						'default-src': ['self'],
						'script-src': ['self', ...templateScriptHashes()],
						'style-src': ['self', 'unsafe-inline'],
						'img-src': ['self'],
						'font-src': ['self'],
						'connect-src': ['self'],
						'manifest-src': ['self'],
						'worker-src': ['self'],
						'object-src': ['none'],
						'base-uri': ['self'],
						'form-action': ['self'],
						'frame-ancestors': ['none']
					}
				}
			})
		],
		// A build-time fact for src/lib/server/env.ts: a server built for Vercel can never enable
		// test-only routes, whatever its runtime environment says. Builds only: `vite dev` and
		// Vitest leave it undefined and behave like a local run.
		define: command === 'build' ? { __VERCEL_BUILD__: JSON.stringify(target === 'vercel') } : {},
		build: {
			target: 'es2022',
			// Report gzip sizes in build output; budgets are enforced by scripts/check-budgets.ts.
			reportCompressedSize: true,
			/**
			 * Code a screen loads on demand (an editor, a sheet) gets its JavaScript through its
			 * `import()` alone, never through the `<link rel=modulepreload>` tags Vite adds for a
			 * dynamic import's chunks; its stylesheets still load first. WebKit keeps a
			 * modulepreload that failed in its memory cache, still marked as a preload, until the
			 * page that made it is garbage-collected, and answers every later load of that URL with
			 * the same failure without fetching it, the reload behind a Retry included
			 * (https://bugs.webkit.org/show_bug.cgi?id=270357), while a failed `import()` it fetches
			 * again: a screen that offers Retry for lazy code can then recover on Safari. One rule
			 * covers every lazy import, so new lazy code needs no list. Only the router keeps its
			 * hints: SvelteKit's entry chunks, whose imports are the route nodes (and an HTML entry,
			 * which SvelteKit does not have). The cost is on a fetch from the network (before the
			 * service worker holds the build): a lazy module's chunks arrive in import order, not
			 * all at once.
			 */
			modulePreload: {
				// `deps`: the JavaScript to preload for one dynamic import; Vite adds its stylesheets.
				resolveDependencies: (_url, deps, { hostId, hostType }) =>
					hostType === 'html' || hostId.includes('/immutable/entry/') ? deps : []
			}
		},
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'unit',
						environment: 'node',
						include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.test.ts'],
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
						setupFiles: [
							'tests/integration/setup-env.ts',
							'tests/integration/one-query-per-client.ts'
						],
						// Applied before any module loads (the logger reads LOG_LEVEL at import time).
						// Quiet by default; `LOG_LEVEL=debug pnpm test:integration` to see logs.
						env: { LOG_LEVEL: process.env.LOG_LEVEL || 'silent' },
						// One shared Postgres test database: run files serially for determinism.
						fileParallelism: false,
						testTimeout: 15_000,
						hookTimeout: 30_000
					}
				},
				{
					// `pnpm db:explain`: query plans on a scratch database (scripts/explain/).
					extends: './vite.config.ts',
					test: {
						name: 'explain',
						environment: 'node',
						include: ['scripts/explain/**/*.explain.ts'],
						// Each file resets and loads the one explain database: one file at a time.
						fileParallelism: false,
						testTimeout: 15_000,
						hookTimeout: 120_000
					}
				}
			]
		}
	};
});
