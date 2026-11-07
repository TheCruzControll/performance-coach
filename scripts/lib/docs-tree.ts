/**
 * The files a docs guard looks at: the repository on disk, or an in-memory fixture tree that
 * plants a gap. Paths are POSIX and relative to the tree's root.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Gap, PATTERN, patternToRegExp } from './docs-scan.ts';

export interface DocsTree {
	/** A file's text, or undefined when there is no such file. */
	read(file: string): string | undefined;
	/** Whether a file or folder exists. */
	exists(target: string): boolean;
	/** Every file under a folder, recursively. */
	files(folder: string): string[];
}

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function clean(target: string): string {
	const normal = path.posix.normalize(target).replace(/\/+$/, '');
	return normal === '.' ? '' : normal;
}

export function fsTree(root = REPO_ROOT): DocsTree {
	const at = (target: string) => path.join(root, clean(target));
	return {
		read: (file) => (existsSync(at(file)) ? readFileSync(at(file), 'utf8') : undefined),
		exists: (target) => existsSync(at(target)),
		files: (folder) =>
			existsSync(at(folder))
				? readdirSync(at(folder), { recursive: true, withFileTypes: true })
						.filter((entry) => entry.isFile())
						.map((entry) =>
							path.posix.join(
								clean(folder),
								path
									.relative(at(folder), path.join(entry.parentPath, entry.name))
									.split(path.sep)
									.join('/')
							)
						)
				: []
	};
}

export function memoryTree(contents: Record<string, string>): DocsTree {
	const names = Object.keys(contents).map(clean);
	const under = (folder: string) => (name: string) =>
		clean(folder) === '' || name.startsWith(`${clean(folder)}/`);
	return {
		read: (file) => contents[clean(file)],
		exists: (target) => names.includes(clean(target)) || names.some(under(target)),
		files: (folder) => names.filter(under(folder))
	};
}

/** Whether a cited path exists, or, for a pattern (`scripts/auth-*.ts`), matches a file. */
export function citedPathExists(tree: DocsTree, cited: string): boolean {
	if (!PATTERN.test(cited)) return tree.exists(cited);
	const fixed = cited.slice(0, cited.search(PATTERN));
	const folder = fixed.slice(0, fixed.lastIndexOf('/') + 1);
	const pattern = patternToRegExp(clean(cited));
	return tree.files(folder).some((file) => pattern.test(file));
}

/** The gaps recorded in scripts/docs-known-gaps.json: today's, never a new one. */
export function knownGaps(tree: DocsTree = fsTree()): Gap[] {
	return JSON.parse(tree.read('scripts/docs-known-gaps.json') ?? '[]') as Gap[];
}
