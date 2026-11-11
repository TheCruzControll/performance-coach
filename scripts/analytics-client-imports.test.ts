/**
 * src/lib/domain/analytics is server-only at runtime except CLIENT_SAFE: the period definitions a
 * screen needs to parse ?period and label its switcher, and the shared types. Every other module
 * (series statistics, trends, the metric definitions) runs on the server, which sends the page the
 * numbers. A browser import of one would ship it in a route's JavaScript and let two copies of a
 * definition drift.
 *
 * The check walks every runtime import (scripts/import-graph.ts, the walker the other import
 * tests share) from every file the browser can load, and fails, printing the chain, when one
 * reaches an analytics module outside CLIENT_SAFE. `import type` is erased and passes;
 * `import { type X }` and `import()` count. It lives in scripts/ because the domain lint block
 * forbids node:fs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chains, filesUnder, ROOT } from './import-graph.ts';

/**
 * The analytics modules a browser may load at runtime. Adding one is a decision: say why here.
 * period-names.ts is periods.ts's names, labels and ?period parsing on their own, for a route's
 * period switcher without the windows and the calendar.
 */
const CLIENT_SAFE = ['periods.ts', 'period-names.ts', 'types.ts'];
const ANALYTICS = 'src/lib/domain/analytics';

const isCode = (file: string) => /\.(ts|svelte)$/.test(file) && !/\.(test|spec)\.ts$/.test(file);

/**
 * Every file the browser can load, routes first so a chain is reported from the route that
 * starts it: route components and universal loads, the client hooks, client code, UI and the
 * service worker. Server loads, endpoints and src/lib/server are not entries.
 */
function browserEntries(root: string): string[] {
	const at = (dir: string) => path.join(root, dir);
	const routes = filesUnder(at('src/routes'), (file) =>
		/(\.svelte|[/\\]\+(page|layout)\.ts)$/.test(file)
	);
	const hooks = at('src/hooks.client.ts');
	return [
		...routes,
		...(existsSync(hooks) ? [hooks] : []),
		...filesUnder(at('src/lib/client'), isCode),
		...filesUnder(at('src/lib/ui'), isCode),
		...filesUnder(at('src/service-worker'), isCode)
	];
}

/** Every chain from a browser file to an analytics module outside CLIENT_SAFE, and the walk. */
function analyticsChains(root = ROOT) {
	const dir = path.join(root, ANALYTICS) + path.sep;
	const allowed = CLIENT_SAFE.map((file) => path.join(dir, file));
	const entries = browserEntries(root);
	const walk = chains(
		entries,
		({ file }) => file !== null && file.startsWith(dir) && !allowed.includes(file),
		{ root }
	);
	return { ...walk, entries: entries.map((file) => path.relative(root, file)) };
}

describe('the real tree', () => {
	it('loads no server-only analytics module in the browser', () => {
		const { chains, entries, visited } = analyticsChains();
		expect(chains).toEqual([]);
		// The walk starts from every kind of browser file and follows lazy imports.
		expect(entries).toContain('src/routes/+layout.svelte');
		expect(entries).toContain('src/routes/(app)/offline/+page.ts');
		expect(entries).toContain('src/hooks.client.ts');
		expect(entries).toContain('src/lib/client/errors.ts');
		expect(entries).toContain('src/lib/ui/time.ts');
		expect(entries.filter((file) => /\.(test|spec)\.ts$/.test(file))).toEqual([]);
		expect(entries.filter((file) => file.includes('.server.'))).toEqual([]);
		expect(visited).toContain('src/lib/domain/training/describe.ts');
		expect(visited).toContain('src/lib/ui/profile/ExperienceEditor.svelte');
	});
});

describe('the check, on fixture trees', () => {
	const roots: string[] = [];
	afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

	/** A fixture tree laid out like the repository, with every analytics module present. */
	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(path.join(tmpdir(), 'analytics-client-'));
		roots.push(root);
		const analytics = Object.fromEntries(
			['periods', 'types', 'series', 'trend', 'strength'].map((name) => [
				`${ANALYTICS}/${name}.ts`,
				`export const ${name} = 1;\nexport type ${name}Type = number;\n`
			])
		);
		for (const [name, text] of Object.entries({ ...analytics, ...files })) {
			const at = path.join(root, name);
			mkdirSync(path.dirname(at), { recursive: true });
			writeFileSync(at, text);
		}
		return root;
	}
	const svelte = (script: string) => `<script lang="ts">\n\t${script}\n</script>\n\n<p>page</p>\n`;

	it('fails a +page.ts that imports trend.ts, naming the chain', () => {
		const root = tree({
			'src/routes/progress/+page.ts': `import { trend } from '#lib/domain/analytics/trend.ts';\nexport const load = () => ({ trend });`
		});
		expect(analyticsChains(root).chains).toEqual([
			'src/routes/progress/+page.ts → src/lib/domain/analytics/trend.ts'
		]);
	});

	it('fails a .svelte file that imports strength.ts dynamically', () => {
		const root = tree({
			'src/routes/progress/+page.svelte': svelte(
				`const load = () => import('$lib/domain/analytics/strength.ts');`
			)
		});
		expect(analyticsChains(root).chains).toEqual([
			'src/routes/progress/+page.svelte → src/lib/domain/analytics/strength.ts'
		]);
	});

	it('passes a params.ts that imports periods.ts and types.ts', () => {
		const root = tree({
			'src/routes/progress/+page.ts': `import { period } from './params.ts';\nexport const load = () => ({ period });`,
			'src/routes/progress/params.ts': `export { periods as period } from '#lib/domain/analytics/periods.ts';\nimport { types } from '../../lib/domain/analytics/types';\nexport const t = types;`
		});
		const { chains, visited } = analyticsChains(root);
		expect(chains).toEqual([]);
		expect(visited).toContain('src/routes/progress/params.ts');
		expect(visited).toContain(`${ANALYTICS}/periods.ts`);
		expect(visited).toContain(`${ANALYTICS}/types.ts`);
	});

	it('passes `import type` from strength.ts, and fails `import { type X }` from it', () => {
		const typeOnly = tree({
			'src/lib/ui/analytics/Tile.svelte': svelte(
				`import type { strengthType } from '#lib/domain/analytics/strength.ts';\n\tlet { v }: { v: strengthType } = $props();`
			)
		});
		expect(analyticsChains(typeOnly).chains).toEqual([]);
		const inline = tree({
			'src/lib/ui/analytics/Tile.svelte': svelte(
				`import { type strengthType } from '#lib/domain/analytics/strength.ts';`
			)
		});
		expect(analyticsChains(inline).chains).toEqual([
			'src/lib/ui/analytics/Tile.svelte → src/lib/domain/analytics/strength.ts'
		]);
	});

	it('fails a two-hop chain through a UI helper, reported from the route', () => {
		const root = tree({
			'src/routes/progress/+page.svelte': svelte(
				`import { label } from '#lib/ui/analytics/format.ts';`
			),
			'src/lib/ui/analytics/format.ts': `import { series } from '#lib/domain/analytics/series.ts';\nexport const label = String(series);`
		});
		expect(analyticsChains(root).chains).toEqual([
			'src/routes/progress/+page.svelte → src/lib/ui/analytics/format.ts → src/lib/domain/analytics/series.ts'
		]);
	});

	it('walks through a client-safe module, so periods.ts cannot carry series.ts in', () => {
		const root = tree({
			'src/routes/progress/+page.ts': `export { periods } from '#lib/domain/analytics/periods.ts';`,
			[`${ANALYTICS}/periods.ts`]: `export { series as periods } from './series.ts';`
		});
		expect(analyticsChains(root).chains).toEqual([
			'src/routes/progress/+page.ts → src/lib/domain/analytics/periods.ts → src/lib/domain/analytics/series.ts'
		]);
	});

	it('checks the client hooks, client code and the service worker as entries', () => {
		const trend = `import '#lib/domain/analytics/trend.ts';`;
		const root = tree({
			'src/hooks.client.ts': trend,
			'src/lib/client/sync.ts': trend,
			'src/service-worker/index.ts': trend
		});
		expect(analyticsChains(root).chains).toEqual([
			'src/hooks.client.ts → src/lib/domain/analytics/trend.ts',
			'src/lib/client/sync.ts → src/lib/domain/analytics/trend.ts',
			'src/service-worker/index.ts → src/lib/domain/analytics/trend.ts'
		]);
	});

	it('leaves server code and tests alone: they may import any analytics module', () => {
		const trend = `import { trend } from '#lib/domain/analytics/trend.ts';\nexport const t = trend;`;
		const root = tree({
			'src/routes/progress/+page.server.ts': trend,
			'src/routes/api/trend/+server.ts': trend,
			'src/lib/server/services/analytics/overview.ts': trend,
			'src/lib/ui/analytics/format.test.ts': trend
		});
		const { chains, entries } = analyticsChains(root);
		expect(chains).toEqual([]);
		expect(entries).toEqual([]);
	});
});
