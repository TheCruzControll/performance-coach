/**
 * Icons draw from one cached SVG sprite (src/lib/ui/icons/sprite.svg) through <use>, so no route
 * ships icon path data in its JavaScript. icons.ts stays the single source of that path data:
 * `pnpm icons:sprite` writes the sprite and the names array /design's gallery lists, and both are
 * committed. These tests keep the committed files in step with icons.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { icons, type IconName } from '../src/lib/ui/icons/icons';
import { ICON_NAMES } from '../src/lib/ui/icons/names';
import { NAMES_FILE, renderNames, renderSprite, SPRITE_FILE } from './generate-icon-sprite';

const root = fileURLToPath(new URL('../', import.meta.url));
const committed = (file: string) => readFileSync(path.join(root, file), 'utf8');
const names = Object.keys(icons) as IconName[];

/** The sprite's symbols, in file order, each with its paths' attributes. */
function symbols(svg: string) {
	return [...svg.matchAll(/<symbol id="([^"]*)" viewBox="([^"]*)">(.*?)<\/symbol>/g)].map(
		([, id, viewBox, body]) => ({
			id: id!,
			viewBox,
			paths: [...body!.matchAll(/<path ([^>]*?)\/>/g)].map(([, attrs]) =>
				Object.fromEntries([...attrs!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))
			)
		})
	);
}

describe('icon sprite', () => {
	it('the committed sprite and names array equal a fresh generation from icons.ts', async () => {
		expect(committed(SPRITE_FILE), 'run `pnpm icons:sprite` and commit the result').toBe(
			renderSprite(icons)
		);
		expect(committed(NAMES_FILE), 'run `pnpm icons:sprite` and commit the result').toBe(
			await renderNames(icons)
		);
		expect(ICON_NAMES).toEqual(names);
	});

	it('has exactly one 24 × 24 symbol for every IconName, and nothing else', () => {
		const svg = committed(SPRITE_FILE);
		const found = symbols(svg);
		expect(found.map((s) => s.id)).toEqual(names);
		expect(new Set(found.map((s) => s.id)).size).toBe(found.length);
		expect(found.every((s) => s.viewBox === '0 0 24 24')).toBe(true);
		// Nothing outside the symbols draws (a stray path would show in no icon, or in every one).
		expect(svg.match(/<path /g)).toHaveLength(found.reduce((n, s) => n + s.paths.length, 0));
	});

	it('fills the `fill:` paths and leaves the rest to the outer svg’s stroke', () => {
		for (const { id, paths } of symbols(committed(SPRITE_FILE))) {
			const source = icons[id as IconName];
			expect(paths, id).toEqual(
				source.map((d) =>
					d.startsWith('fill:')
						? { d: d.slice('fill:'.length), fill: 'currentColor', stroke: 'none' }
						: { d }
				)
			);
		}
		// A fixed point, so the test cannot agree with a generator that inverts the rule.
		expect(symbols(committed(SPRITE_FILE)).find((s) => s.id === 'info')?.paths).toEqual([
			{ d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
			{ d: 'M12 11v5' },
			{
				d: 'M12 8.9a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Z',
				fill: 'currentColor',
				stroke: 'none'
			}
		]);
	});

	it('refuses an icon name or path data that would not survive in the sprite', () => {
		expect(() => renderSprite({ 'Bad Name': ['M5 12h14'] })).toThrow(/icon name/);
		expect(() => renderSprite({ ok: ['M5 12h14"/><script/>'] })).toThrow(/path data/);
	});

	it('is the only reader of icons.ts at run time: app code imports its types alone', () => {
		const iconsModule = path.join(root, 'src/lib/ui/icons/icons');
		const sources = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) => {
				const full = path.join(dir, entry);
				if (statSync(full).isDirectory()) return sources(full);
				return /\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts') ? [full] : [];
			});
		const resolve = (file: string, specifier: string) =>
			(specifier.startsWith('.')
				? path.resolve(path.dirname(file), specifier)
				: specifier.replace(/^#lib\//, path.join(root, 'src/lib/'))
			).replace(/\.ts$/, '');
		const valueImports = sources(path.join(root, 'src')).flatMap((file) =>
			[...readFileSync(file, 'utf8').matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)]
				// `import { type X }` still loads the module; only `import type` erases it.
				.filter(([, what, from]) => resolve(file, from!) === iconsModule && !/^type\b/.test(what!))
				.map(([statement]) => `${path.relative(root, file)}: ${statement}`)
		);
		expect(valueImports).toEqual([]);
	});
});
