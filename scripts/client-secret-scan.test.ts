import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICING } from '../src/lib/domain/coach/pricing.ts';
import {
	coachIsolation,
	COACH_MODULE,
	type ManifestChunk,
	missingSignatures,
	scanForSecrets,
	scanForServerOnly,
	SDK_SIGNATURES,
	SERVER_ONLY_VARIABLES
} from './client-secret-scan.ts';
import { chains, filesUnder, ROOT } from './import-graph.ts';

const CANARY = 'ci-canary-anthropic-key-never-in-a-bundle';
const KEY = 'sk-ant-api03-Zx9_yW8-vU7tS6rQ5pO4nM3lK2';
/** The module a browser bundle of the pinned SDK resolves `new Anthropic()` to. */
const SDK_CLIENT = readFileSync(
	path.join(ROOT, 'node_modules/@anthropic-ai/sdk/client.mjs'),
	'utf8'
);

describe('scanForSecrets', () => {
	it('recognises the pinned SDK by literals its dist ships', () => {
		for (const sig of SDK_SIGNATURES) expect(SDK_CLIENT, sig).toContain(sig);
		expect(SDK_SIGNATURES).not.toContainEqual(
			expect.stringMatching(/x-api-key|claude-|Anthropic|Claude/)
		);
	});

	it('flags a planted SDK chunk, a key and the canary, without repeating the key', () => {
		expect(scanForSecrets(SDK_CLIENT)).toEqual(
			SDK_SIGNATURES.map((sig) => `Anthropic SDK code ("${sig}")`)
		);
		expect(scanForSecrets(`const h={"x-api-key":"${KEY}"};`)).toEqual(['an sk-ant- API key']);
		const found = scanForSecrets(`fetch(u,{headers:{k:"${CANARY}"}})`, CANARY);
		expect(found).toEqual(['the build-time ANTHROPIC_API_KEY']);
		expect(found.join()).not.toContain(CANARY);
	});

	it('does not scan for a build-time key too short to be told from text', () => {
		expect(scanForSecrets('a coach', 'coach')).toEqual([]);
		expect(scanForSecrets('a coach', '   ')).toEqual([]);
	});

	it('flags none of the app’s copy or its pricing table', () => {
		const clientSide = (file: string) =>
			/\.(ts|svelte|js|json|html|css)$/.test(file) &&
			!/\.test\.ts$|\+(page|layout)\.server\.ts$|\+server\.ts$/.test(file);
		const files = [
			...filesUnder(path.join(ROOT, 'src/lib/domain'), clientSide),
			...filesUnder(path.join(ROOT, 'src/lib/ui'), clientSide),
			...filesUnder(path.join(ROOT, 'src/lib/client'), clientSide),
			...filesUnder(path.join(ROOT, 'src/routes'), clientSide),
			path.join(ROOT, 'src/app.html')
		];
		expect(files.length).toBeGreaterThan(100);
		const flagged = files.filter((f) => scanForSecrets(readFileSync(f, 'utf8'), CANARY).length);
		expect(flagged).toEqual([]);
		expect(Object.keys(PRICING)).toContain('claude-opus-5-5');
		expect(scanForSecrets(JSON.stringify(PRICING), CANARY)).toEqual([]);
	});
});

describe('scanForSecrets with the shared provider formats', () => {
	it('flags every provider format in a chunk, placeholders included', () => {
		const resend = ['re_', 'Ab12Cd34', '_', 'Xy98Wv76Ut54Sr32Qp10Mn'].join('');
		const blob = ['vercel_blob_', 'rw_', 'St0re1d', '_', 'S3cr3tV4lu3xyz'].join('');
		const chunk = `const a="${resend}",b="${blob}",c="postgres://coach:coach@db/x";`;
		expect(scanForSecrets(chunk)).toEqual([
			'a Resend re_ API key',
			'a Vercel Blob read-write token',
			'a Postgres URL with a password'
		]);
		expect(scanForSecrets(chunk).join()).not.toContain(resend);
	});
});

describe('scanForServerOnly', () => {
	it('fails a chunk naming the Blob SDK, a src/lib/server/ path or a server-only variable', () => {
		expect(scanForServerOnly('import{put}from"@vercel/blob";')).toEqual([
			'server-only code ("@vercel/blob")'
		]);
		expect(scanForServerOnly('new Error("at src/lib/server/backup/run.ts")')).toEqual([
			'server-only code ("src/lib/server/")'
		]);
		expect(scanForServerOnly('const k=env.BACKUP_ENCRYPTION_KEY;')).toEqual([
			'server-only code ("BACKUP_ENCRYPTION_KEY")'
		]);
		for (const name of SERVER_ONLY_VARIABLES) {
			expect(scanForServerOnly(`x.${name}`)).toEqual([`server-only code ("${name}")`]);
		}
	});

	it('passes a chunk of ordinary client code', () => {
		expect(scanForServerOnly('import{goto}from"$app/navigation";fetch("/api/sync")')).toEqual([]);
		expect(scanForServerOnly(SDK_CLIENT.slice(0, 2000))).toEqual([]);
	});
});

describe('missingSignatures (the positive control)', () => {
	it('finds every signature in a server build that bundles the SDK', () => {
		expect(missingSignatures(SDK_CLIENT, '')).toEqual([]);
	});

	it('follows an external import of the SDK to its installed dist', () => {
		const server = 'const { default: Anthropic } = await import("@anthropic-ai/sdk");';
		expect(missingSignatures(server, SDK_CLIENT)).toEqual([]);
	});

	it('fails a server build without the SDK, and a signature the SDK no longer ships', () => {
		expect(missingSignatures('export const x = 1;', SDK_CLIENT)).toEqual([...SDK_SIGNATURES]);
		const rotted = SDK_CLIENT.replaceAll('api.anthropic.com', 'api.example.com');
		expect(missingSignatures(rotted, '')).toEqual(['api.anthropic.com']);
	});
});

/** A manifest shaped like SvelteKit's: the router entry imports every node dynamically. */
const NODES = {
	root: 'nodes/0.js',
	workout: 'nodes/5.js',
	run: 'nodes/6.js',
	coach: 'nodes/9.js'
};
function manifest(runImports: string[] = []): Record<string, ManifestChunk> {
	return {
		'app.js': {
			file: '_app/immutable/entry/app.js',
			dynamicImports: Object.values(NODES)
		},
		[NODES.root]: { file: '_app/immutable/nodes/0.js', imports: ['_shared.js'] },
		[NODES.workout]: {
			file: '_app/immutable/nodes/5.js',
			imports: ['_shared.js', 'app.js'],
			dynamicImports: ['src/routes/workout/lazy.ts']
		},
		[NODES.run]: {
			file: '_app/immutable/nodes/6.js',
			imports: ['_shared.js'],
			dynamicImports: runImports
		},
		[NODES.coach]: {
			file: '_app/immutable/nodes/9.js',
			imports: ['src/lib/domain/coach/index.ts']
		},
		'_shared.js': { file: '_app/immutable/chunks/shared.js' },
		'src/routes/workout/lazy.ts': {
			file: '_app/immutable/chunks/lazy.js',
			imports: ['_shared.js']
		},
		'src/lib/ui/workout/Sheet.svelte': {
			file: '_app/immutable/chunks/Sheet.js',
			imports: ['src/lib/domain/coach/index.ts']
		},
		'src/lib/ui/workout/Notes.svelte': { file: '_app/immutable/chunks/Notes.js' },
		'src/lib/domain/coach/index.ts': { file: '_app/immutable/chunks/coach.js' }
	};
}
/** The src/ modules each chunk bundles; the coach node's own chunk may bundle coach helpers. */
const MODULES = {
	'_app/immutable/nodes/0.js': ['src/routes/+layout.svelte'],
	'_app/immutable/nodes/9.js': [
		'src/routes/(app)/coach/+page.svelte',
		'src/lib/client/coach-stream.ts'
	],
	'_app/immutable/chunks/Notes.js': ['src/lib/ui/workout/Notes.svelte']
};
const route = (id: string, ...keys: string[]) => ({ id, keys: [NODES.root, ...keys] });
const ROUTES = [
	route('/workout', NODES.workout),
	route('/workout/run', NODES.run),
	route('/(app)/coach', NODES.coach)
];

describe('coachIsolation', () => {
	it('passes when no workout route can load a coach module, not via the router entry either', () => {
		expect(coachIsolation(ROUTES, manifest(), MODULES)).toEqual({
			checked: ['/workout', '/workout/run'],
			problems: []
		});
	});

	it('fails a /workout/run that can load a coach module, naming the chain', () => {
		const { problems } = coachIsolation(
			ROUTES,
			manifest(['src/lib/ui/workout/Sheet.svelte']),
			MODULES
		);
		expect(problems).toEqual([
			`/workout/run: ${NODES.run} → src/lib/ui/workout/Sheet.svelte → src/lib/domain/coach/index.ts`
		]);
	});

	it('fails a coach helper bundled into a lazy workout chunk or an inherited layout', () => {
		const lazy = coachIsolation(ROUTES, manifest(['src/lib/ui/workout/Notes.svelte']), {
			...MODULES,
			'_app/immutable/chunks/Notes.js': [
				'src/lib/ui/workout/Notes.svelte',
				'src/lib/domain/coach/pricing.ts'
			]
		});
		expect(lazy.problems).toEqual([
			`/workout/run: ${NODES.run} → src/lib/ui/workout/Notes.svelte (bundles src/lib/domain/coach/pricing.ts)`
		]);
		const layout = coachIsolation(ROUTES, manifest(), {
			...MODULES,
			'_app/immutable/nodes/0.js': ['src/routes/+layout.svelte', 'src/lib/client/coach-stream.ts']
		});
		expect(layout.problems).toEqual([
			`/workout: ${NODES.root} (bundles src/lib/client/coach-stream.ts)`,
			`/workout/run: ${NODES.root} (bundles src/lib/client/coach-stream.ts)`
		]);
	});

	it('fails a build without /workout, or with no chunk modules listed', () => {
		const { problems } = coachIsolation(ROUTES.slice(1), manifest(), MODULES);
		expect(problems).toEqual(['no /workout route in the build: update this guard']);
		expect(coachIsolation(ROUTES, manifest(), {}).problems).toEqual([
			'no source modules in .vite/chunk-modules.json: update this guard'
		]);
	});

	it('passes a build with only /workout', () => {
		expect(coachIsolation([route('/workout', NODES.workout)], manifest(), MODULES)).toEqual({
			checked: ['/workout'],
			problems: []
		});
	});

	it('knows a coach module by its folder or its name', () => {
		const coach = [
			'src/lib/domain/coach/pricing.ts',
			'src/routes/(app)/coach/+page.svelte',
			'src/lib/client/coach-stream.ts',
			'src/lib/ui/coach.ts'
		];
		const not = ['src/lib/ui/workout/Coaching.svelte', 'src/lib/domain/coaches.ts', '_coach.js'];
		expect(coach.filter((key) => COACH_MODULE.test(key))).toEqual(coach);
		expect(not.filter((key) => COACH_MODULE.test(key))).toEqual([]);
	});

	it('holds in the source too: no /workout module or inherited layout imports a coach module', () => {
		const entries = [
			path.join(ROOT, 'src/routes/+layout.svelte'),
			...filesUnder(
				path.join(ROOT, 'src/routes/workout'),
				(f) => /\.(ts|svelte)$/.test(f) && !f.endsWith('.test.ts')
			)
		];
		expect(entries.length).toBeGreaterThan(0);
		const walk = chains(entries, (edge) =>
			COACH_MODULE.test(edge.file ? path.relative(ROOT, edge.file) : '')
		);
		expect(walk.chains).toEqual([]);
	});
});
