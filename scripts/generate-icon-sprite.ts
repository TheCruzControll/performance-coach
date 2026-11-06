/**
 * Write the icon sprite and the icon names array from src/lib/ui/icons/icons.ts:
 *
 *   pnpm icons:sprite
 *
 * <Icon> draws `<use href="sprite.svg#name">`, so path data reaches the browser once, in one
 * hashed, immutable, precached SVG file, and never in a route's JavaScript (`pnpm budgets` fails
 * if it does). icons.ts stays the single source of path data; app code imports only its types.
 * Both outputs are committed, and scripts/icon-sprite.test.ts fails when they are stale.
 *
 * - sprite.svg: one <symbol id="name"> per icon on the 24 × 24 grid. `fill:` paths are filled
 *   with currentColor and not stroked; the rest set nothing and inherit the outer <svg>'s
 *   stroke, stroke width and caps, as inline paths did.
 * - names.ts: every icon name in icons.ts order, for /design's gallery.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { icons } from '../src/lib/ui/icons/icons.ts';

export const SPRITE_FILE = 'src/lib/ui/icons/sprite.svg';
export const NAMES_FILE = 'src/lib/ui/icons/names.ts';

type IconSet = Readonly<Record<string, readonly string[]>>;

const FILL = 'fill:';
/** A symbol id is also the URL fragment <use> asks for. */
const NAME = /^[a-z][a-z0-9-]*$/;
/** SVG path commands and numbers only, so nothing in path data can break out of `d="…"`. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;

const GENERATED =
	'Generated from icons.ts by `pnpm icons:sprite` (scripts/generate-icon-sprite.ts)';

export function renderSprite(set: IconSet): string {
	const symbols = Object.entries(set).map(([name, paths]) => {
		if (!NAME.test(name)) throw new Error(`icons: "${name}" is not a valid icon name`);
		const body = paths.map((source) => {
			const filled = source.startsWith(FILL);
			const d = filled ? source.slice(FILL.length) : source;
			if (!PATH_DATA.test(d)) throw new Error(`icons: "${name}" has invalid path data: ${d}`);
			return filled ? `<path d="${d}" fill="currentColor" stroke="none"/>` : `<path d="${d}"/>`;
		});
		return `<symbol id="${name}" viewBox="0 0 24 24">${body.join('')}</symbol>`;
	});
	return [
		'<svg xmlns="http://www.w3.org/2000/svg">',
		`<!-- ${GENERATED}: do not edit. -->`,
		...symbols,
		'</svg>',
		''
	].join('\n');
}

/** A repository-relative path, resolved from this script (whatever the working directory). */
const absolute = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

export async function renderNames(set: IconSet): Promise<string> {
	const file = absolute(NAMES_FILE);
	const source = [
		`// ${GENERATED}: do not edit.`,
		`import type { IconName } from './icons';`,
		'',
		'/** Every icon name, in icons.ts order. Each one is a <symbol> in sprite.svg. */',
		`export const ICON_NAMES: readonly IconName[] = ${JSON.stringify(Object.keys(set))};`
	].join('\n');
	return format(source, { ...(await resolveConfig(file)), filepath: file });
}

async function main() {
	const sprite = renderSprite(icons);
	writeFileSync(absolute(SPRITE_FILE), sprite);
	writeFileSync(absolute(NAMES_FILE), await renderNames(icons));
	const gzip = gzipSync(sprite, { level: 9 }).length;
	console.log(
		`icons:sprite: wrote ${SPRITE_FILE} (${Object.keys(icons).length} icons, ${sprite.length} B, ${gzip} B gzip) and ${NAMES_FILE}`
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
