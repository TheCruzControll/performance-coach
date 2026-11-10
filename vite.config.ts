import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv, type Plugin } from 'vite';
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

/**
 * Writes .vite/chunk-modules.json into the client build: each chunk's file and the src/ modules
 * bundled into it, which Vite's manifest does not list. scripts/check-budgets.ts reads it to
 * prove no coach module reaches a /workout route (scripts/client-secret-scan.ts). Adapters skip
 * `.vite`, so it is never served.
 */
function chunkModules(): Plugin {
	return {
		name: 'chunk-modules',
		apply: 'build',
		applyToEnvironment: (environment) => environment.name === 'client',
		generateBundle(_, bundle) {
			const src = `${this.environment.config.root}/src/`;
			const modules: Record<string, string[]> = {};
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== 'chunk') continue;
				modules[chunk.fileName] = chunk.moduleIds
					.map((id) => id.split('?')[0]!)
					.filter((id) => id.startsWith(src))
					.map((id) => id.slice(src.length - 'src/'.length));
			}
			this.emitFile({
				type: 'asset',
				fileName: '.vite/chunk-modules.json',
				source: JSON.stringify(modules)
			});
		}
	};
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
			chunkModules(),
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
				// The root layout registers the service worker once the app has started and gone idle
				// (src/lib/client/service-worker.ts); SvelteKit's registration runs on `load`, before it.
				serviceWorker: { register: false },
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
			rolldownOptions: {
				output: {
					codeSplitting: {
						groups: [
							/**
							 * The client's error reporting and its leaving state, which every page loads first
							 * (hooks.client.ts), stay one chunk when lazy code imports only one of them: the
							 * workout sync engine imports leaving.ts. Apart, every route would pay for another
							 * chunk (about 0.1 KB gzip).
							 */
							{ name: 'errors', test: /src[\\/]lib[\\/]client[\\/](errors|leaving)\.ts$/ },
							/**
							 * The workout pages' projection (the M4 plan's runway lever 2): project.ts, its
							 * reducers, the mutations and the timers, which every workout page loads while it
							 * restores (active.svelte.ts), and its lazy logger and store share. Left to itself,
							 * Rolldown splits them by importer set into several chunks, each another request. Only
							 * modules every workout page needs belong here: a module another route imports would
							 * bring the whole chunk with it. Not the strength view's (selectors, groups, set
							 * words), which load with that view, nor the flow (flow.ts), nor the run and other
							 * families (reducers/run.ts and reducers/other.ts, with their routes' tables): in the
							 * group, /workout would load them.
							 */
							{
								name: 'workout',
								test: /src[\\/]lib[\\/]domain[\\/]workout[\\/](mutations|timers|project|reducers[\\/](?!(run|other)\.)\w+)\.ts$/
							}
						]
					}
				}
			},
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
						exclude: ['src/**/*.svelte.{test,spec}.ts'],
						// An observed lifecycle throws on a move its table does not allow, so a test
						// catches drift between a table and the code (services/lifecycle-guard.ts).
						env: { LIFECYCLE_STRICT: '1' }
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
						// LIFECYCLE_STRICT: an observed lifecycle throws on an illegal move, as in `unit`.
						env: { LOG_LEVEL: process.env.LOG_LEVEL || 'silent', LIFECYCLE_STRICT: '1' },
						// One shared Postgres test database: run files serially for determinism.
						fileParallelism: false,
						testTimeout: 15_000,
						hookTimeout: 30_000
					}
				},
				{
					// `pnpm test:live`: the coach against the real model, opt-in (tests/live/gate.ts).
					// Never in CI: no workflow runs this project (scripts/vite-config.test.ts).
					extends: './vite.config.ts',
					test: {
						name: 'live',
						environment: 'node',
						include: ['tests/live/**/*.live.test.ts'],
						globalSetup: ['tests/live/setup.ts'],
						setupFiles: [
							'tests/integration/setup-env.ts',
							'tests/integration/one-query-per-client.ts'
						],
						env: { LOG_LEVEL: process.env.LOG_LEVEL || 'silent' },
						fileParallelism: false,
						// A real turn can draft for over a minute; a conversation is up to two turns.
						testTimeout: 600_000,
						hookTimeout: 60_000
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
