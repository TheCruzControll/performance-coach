/**
 * vite.config.ts bakes one build-time fact into the server: whether it was built for Vercel.
 * `VERCEL`/`VERCEL_ENV` exist only at runtime, so src/lib/server/env.ts relies on this constant
 * to refuse test-only routes in a Vercel build whatever its runtime environment says. It must
 * be set for every Vercel build, and only for builds: `vite dev` and Vitest behave like a local
 * run, and Node builds (e2e, Lighthouse) can still enable test routes.
 *
 * It also declares the opt-in live coach suite's Vitest project, which CI must never run: it calls
 * the real model with a key and is billed (tests/live/coach.live.test.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveMode } from '../tests/live/gate.ts';

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

/** The Vitest projects vite.config.ts declares, as Vitest reads them. */
interface Project {
	name: string;
	include: string[];
	globalSetup?: string[];
}
async function testProjects(): Promise<Record<string, Project>> {
	vi.resetModules();
	const { default: config } = await import('../vite.config.ts');
	const resolved = await config({ command: 'serve', mode: 'test' });
	const projects = (resolved.test?.projects ?? []) as unknown as { test: Project }[];
	return Object.fromEntries(projects.map((p) => [p.test.name, p.test]));
}

describe('the live coach suite (tests/live)', () => {
	it('is its own Vitest project, which no other project includes', async () => {
		const projects = await testProjects();
		expect(projects.live?.include).toEqual(['tests/live/**/*.live.test.ts']);
		expect(projects.live?.globalSetup).toEqual(['tests/live/setup.ts']);
		for (const name of ['unit', 'integration', 'explain'])
			for (const glob of projects[name]!.include)
				expect(
					glob.startsWith('tests/live') || glob.startsWith('tests/**'),
					`${name}: ${glob}`
				).toBe(false);
		expect(projects.integration?.include).toEqual(['tests/integration/**/*.test.ts']);
	});

	it('never runs in CI: no workflow runs the live project, a bare vitest run, or pnpm test', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		expect(pkg.scripts['test:live']).toBe('vitest run --project live');
		expect(pkg.scripts['test:unit']).toBe('vitest run --project unit');
		expect(pkg.scripts['test:integration']).toBe('vitest run --project integration');
		expect(pkg.scripts.test).not.toMatch(/test:live|vitest run(?! --project (unit|integration))/);
		const dir = new URL('../.github/workflows/', import.meta.url);
		const workflows = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
		expect(workflows.length).toBeGreaterThan(0);
		for (const file of workflows) {
			const text = readFileSync(new URL(file, dir), 'utf8');
			expect(text, file).not.toMatch(/test:live|--project[ =]live|LIVE_LLM/);
			expect(text, file).not.toMatch(/vitest run(?! --project (unit|integration|explain)\b)/);
			expect(text, file).not.toMatch(/pnpm (run )?test(\s|$)/m);
		}
	});

	it('runs only with LIVE_LLM=1 and a key, or LIVE_LLM_DRY=1 on the mock', () => {
		expect(liveMode({})).toBe('off');
		expect(liveMode({ LIVE_LLM: '1' })).toBe('off');
		expect(liveMode({ LIVE_LLM: '1', ANTHROPIC_API_KEY: '  ' })).toBe('off');
		expect(liveMode({ ANTHROPIC_API_KEY: 'sk-ant-example' })).toBe('off');
		expect(liveMode({ LIVE_LLM: 'true', ANTHROPIC_API_KEY: 'sk-ant-example' })).toBe('off');
		expect(liveMode({ LIVE_LLM: '1', ANTHROPIC_API_KEY: 'sk-ant-example' })).toBe('live');
		expect(liveMode({ LIVE_LLM_DRY: '1' })).toBe('dry');
		expect(liveMode({ LIVE_LLM: '1', LIVE_LLM_DRY: '1', ANTHROPIC_API_KEY: 'k' })).toBe('live');
	});
});

/**
 * The client's chunk groups merge the code every page starts with into a few chunks, so each
 * page's start-up needs fewer round trips. They hold code (nearly) every page loads: each module
 * in them ships to every route.
 */
describe('the start-up chunk groups', () => {
	interface Group {
		name: string;
		test: RegExp | ((id: string) => boolean);
	}
	let loaded: Promise<Record<string, (id: string) => boolean>> | undefined;
	const groups = () => (loaded ??= readGroups());
	async function readGroups(): Promise<Record<string, (id: string) => boolean>> {
		vi.resetModules();
		const { default: config } = await import('../vite.config.ts');
		const resolved: UserConfig = await config({ command: 'build', mode: 'production' });
		const output = resolved.build?.rolldownOptions?.output as {
			codeSplitting: { groups: Group[] };
		};
		return Object.fromEntries(
			output.codeSplitting.groups.map(({ name, test }) => [
				name,
				(id: string) => (typeof test === 'function' ? test(id) : test.test(id))
			])
		);
	}
	const pkg = (name: string, file: string) =>
		`/repo/node_modules/.pnpm/${name.replace('/', '+')}@1.0.0/node_modules/${name}/${file}`;
	const src = (file: string) => `/repo/src/${file}`;

	// start.js runs this chunk before SvelteKit sets the payload: nothing that reads it. First, so
	// the framework group cannot take the payload module along with the client modules.
	it("payload: SvelteKit's payload module and the preload helper alone, first", async () => {
		const { payload } = await groups();
		expect(Object.keys(await groups()).slice(0, 2)).toEqual(['payload', 'framework']);
		for (const id of [
			pkg('@sveltejs/kit', 'src/runtime/client/payload.js'),
			'\0vite/preload-helper.js'
		])
			expect(payload!(id), id).toBe(true);
		for (const id of [
			pkg('@sveltejs/kit', 'src/runtime/client/client.js'),
			pkg('@sveltejs/kit', 'src/runtime/client/entry.js'),
			pkg('@sveltejs/kit', 'src/runtime/app/env/client.js'),
			pkg('svelte', 'src/internal/client/runtime.js')
		])
			expect(payload!(id), id).toBe(false);
	});

	it("framework: Svelte and SvelteKit's client", async () => {
		const { framework } = await groups();
		for (const id of [
			pkg('svelte', 'src/internal/client/runtime.js'),
			pkg('svelte', 'src/index-client.js'),
			pkg('@sveltejs/kit', 'src/runtime/client/client.js'),
			pkg('@sveltejs/kit', 'src/runtime/client/client-entry.js'),
			pkg('@sveltejs/kit', 'src/runtime/app/state/client.svelte.js'),
			pkg('@sveltejs/kit', 'src/runtime/app/paths/index.js'),
			pkg('@sveltejs/kit', 'src/runtime/app/env/client.js'),
			pkg('devalue', 'src/parse.js'),
			pkg('clsx', 'dist/clsx.mjs')
		])
			expect(framework!(id), id).toBe(true);
	});

	it("framework: not $app/forms (screens with a form), SvelteKit's entries or other packages", async () => {
		const { framework } = await groups();
		for (const id of [
			pkg('@sveltejs/kit', 'src/runtime/app/forms/client.js'),
			pkg('@sveltejs/kit', 'src/runtime/client/entry.js'),
			pkg('@sveltejs/kit', 'src/runtime/client/payload.js'),
			pkg('zod', 'v4/core/schemas.js'),
			pkg('idb', 'build/index.js'),
			pkg('web-vitals', 'dist/web-vitals.js'),
			pkg('@simplewebauthn/browser', 'esm/index.js'),
			src('lib/ui/components/Button.svelte')
		])
			expect(framework!(id), id).toBe(false);
	});

	it('boot: the app code every page starts with, and nothing else', async () => {
		const { boot } = await groups();
		for (const id of [
			src('lib/client/errors.ts'),
			src('lib/client/leaving.ts'),
			src('lib/client/visits.ts'),
			src('lib/client/service-worker.ts'),
			src('lib/ui/toast.svelte.ts'),
			src('lib/ui/components/Icon.svelte'),
			src('routes/error-page.ts')
		])
			expect(boot!(id), id).toBe(true);
		for (const id of [
			src('lib/client/vitals.ts'),
			src('lib/client/recovery.ts'),
			src('lib/ui/components/IconButton.svelte'),
			src('lib/ui/components/Button.svelte'),
			src('routes/ErrorPage.svelte'),
			src('routes/ErrorView.svelte'),
			src('routes/(app)/AppShell.svelte')
		])
			expect(boot!(id), id).toBe(false);
	});
});
