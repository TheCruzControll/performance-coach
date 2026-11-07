/**
 * What the docs guards read out of markdown (pure: text in, data out). The guards are the unit
 * tests next to this folder (docs-env, adr-index, docs-citations, milestones); docs-prs.ts uses
 * the PR references.
 *
 * - Fenced code blocks are not prose: links and code spans are read outside them only. Commands
 *   (`pnpm <script>`) are read from both, since a fenced block is where most commands live.
 * - A gap is one finding, `{ test, doc, item }`. The item names what is missing and carries no
 *   line number, so an entry in scripts/docs-known-gaps.json survives edits around it.
 */

export interface Gap {
	/** The guard that found it: 'docs-env', 'adr-index', 'docs-citations' or 'milestones'. */
	test: string;
	/** The doc it is in, relative to the repository root. */
	doc: string;
	/** What is missing, e.g. `path src/lib/gone.ts`. */
	item: string;
}

/**
 * Lenient (the default until docs-m9): a gap fails only when scripts/docs-known-gaps.json does
 * not list it, and a listed gap that no longer reproduces fails too, so the list only shrinks.
 * Strict (`STRICT=1`, or this constant set to true): every gap fails, and the milestone guard
 * also checks what only a finished project has (PR links, M9 evidence).
 */
export const STRICT_BY_DEFAULT = false;

export function isStrict(env: Record<string, string | undefined>): boolean {
	return STRICT_BY_DEFAULT || env.STRICT === '1';
}

/** The failures a guard reports: every gap when strict, else unlisted and stale ones. */
export function reconcile(test: string, found: Gap[], known: Gap[], strict: boolean): string[] {
	const key = (gap: Gap) => `${gap.doc}\0${gap.item}`;
	const show = (gap: Gap) => `${gap.doc}: ${gap.item}`;
	if (strict) return found.map((gap) => `${show(gap)} (strict: no gap is allowed)`);
	const listed = new Set(known.filter((gap) => gap.test === test).map(key));
	const seen = new Set(found.map(key));
	return [
		...found
			.filter((gap) => !listed.has(key(gap)))
			.map((gap) => `${show(gap)} (new gap: fix the doc; never add it to the known-gaps list)`),
		...known
			.filter((gap) => gap.test === test && !seen.has(key(gap)))
			.map((gap) => `${show(gap)} (fixed: remove it from scripts/docs-known-gaps.json)`)
	];
}

/** The markdown with every fenced block blanked (line numbers kept), and the blocks' text. */
export function splitFences(markdown: string): { prose: string; fenced: string[] } {
	const prose: string[] = [];
	const fenced: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split('\n')) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === null && marker) {
			fence = marker;
			fenced.push('');
			prose.push('');
		} else if (fence !== null) {
			if (
				marker !== undefined &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				!/\S/.test(line.replace(marker, ''))
			) {
				fence = null;
			} else {
				fenced[fenced.length - 1] += `${line}\n`;
			}
			prose.push('');
		} else {
			prose.push(line);
		}
	}
	return { prose: prose.join('\n'), fenced };
}

const CODE_SPAN = /`([^`\n]+)`/g;

/** Inline code spans outside fenced blocks, trimmed. */
export function codeSpans(markdown: string): string[] {
	return [...splitFences(markdown).prose.matchAll(CODE_SPAN)].map((match) => match[1]!.trim());
}

/** Link targets that point into the repository (no scheme, not a bare `#anchor`). */
export function relativeLinks(markdown: string): string[] {
	const prose = splitFences(markdown).prose.replace(CODE_SPAN, '');
	const inline = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)];
	const reference = [...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)];
	return [...inline, ...reference]
		.map((match) => match[1]!)
		.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
		.map((target) => decodeURI(target.replace(/[?#].*$/, '')));
}

/** The top-level folders a cited repository path starts with. */
export const PATH_ROOTS = ['src', 'tests', 'e2e', 'scripts', 'docs', 'drizzle', '.github'];
const PATH_START = new RegExp(
	`^(?:${PATH_ROOTS.map((r) => r.replace('.', '\\.')).join('|')})(?:/|$)`
);

/** Code spans that are one repository path (a trailing `:line` is dropped). */
export function repoPaths(markdown: string): string[] {
	return codeSpans(markdown)
		.filter((span) => PATH_START.test(span) && !/\s/.test(span))
		.map((span) => span.replace(/:\d+(?::\d+)?$/, ''));
}

/** Characters that make a cited path a pattern rather than one file. */
export const PATTERN = /[*?{}<>…]/;

/** A cited pattern as a regular expression over repository paths (`<n>` is any one segment). */
export function patternToRegExp(pattern: string): RegExp {
	let source = '';
	let braces = 0;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (pattern.startsWith('**/', i)) {
			source += '(?:.*/)?';
			i += 2;
		} else if (char === '*' && pattern[i + 1] === '*') {
			source += '.*';
			i += 1;
		} else if (char === '*' || char === '…') source += '[^/]*';
		else if (char === '?') source += '[^/]';
		else if (char === '<') {
			const end = pattern.indexOf('>', i);
			source += '[^/]+';
			i = end === -1 ? pattern.length : end;
		} else if (char === '{') {
			source += '(?:';
			braces++;
		} else if (char === '}' && braces > 0) {
			source += ')';
			braces--;
		} else if (char === ',' && braces > 0) source += '|';
		else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${source}(?:/.*)?$`);
}

/** pnpm's own commands, which are not package.json scripts. */
export const PNPM_COMMANDS = new Set([
	'add',
	'approve-builds',
	'audit',
	'dedupe',
	'dlx',
	'exec',
	'i',
	'install',
	'licenses',
	'list',
	'ls',
	'outdated',
	'prune',
	'rebuild',
	'remove',
	'store',
	'up',
	'update',
	'why'
]);

/** The script (or command) each `pnpm …` names, in code spans and fenced blocks. */
export function pnpmCommands(markdown: string): string[] {
	const { fenced } = splitFences(markdown);
	const found: string[] = [];
	for (const text of [...codeSpans(markdown), ...fenced]) {
		for (const match of text.matchAll(
			/(?:^|[\s;&|(])pnpm((?:\s+-{1,2}[\w-]+(?:=\S+)?)*)\s+([\w:.@/-]+)(?:\s+([\w:.-]+))?/gm
		)) {
			const name = match[2] === 'run' && match[3] ? match[3] : match[2]!;
			if (!/^\d/.test(name)) found.push(name);
		}
	}
	return found;
}

export interface Table {
	/** The nearest heading above the table, without its `#`s. */
	heading: string;
	header: string[];
	rows: string[][];
}

const cells = (line: string) =>
	line
		.trim()
		.replace(/^\|/, '')
		.replace(/(?<!\\)\|$/, '')
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());

/** Every pipe table outside fenced blocks, with the heading it sits under. */
export function tables(markdown: string): Table[] {
	const lines = splitFences(markdown).prose.split('\n');
	const found: Table[] = [];
	let heading = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const title = /^#{1,6}\s+(.*)$/.exec(line);
		if (title) heading = title[1]!.trim();
		if (!line.trim().startsWith('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) continue;
		const table: Table = { heading, header: cells(line), rows: [] };
		for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
			table.rows.push(cells(lines[i]!));
		}
		found.push(table);
	}
	return found;
}

/** Backticked environment-variable names in a piece of text (`DATABASE_URL`). */
export function envNames(text: string): string[] {
	return [...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((match) => match[1]!);
}

/** `#NNN` references in prose (outside code), with their 1-based line. */
export function prReferences(markdown: string): { number: number; line: number }[] {
	const found: { number: number; line: number }[] = [];
	splitFences(markdown)
		.prose.split('\n')
		.forEach((text, index) => {
			for (const match of text
				.replace(CODE_SPAN, '')
				.matchAll(/(?<![\w&#/])#([1-9]\d{0,5})(?![\w-])/g)) {
				found.push({ number: Number(match[1]), line: index + 1 });
			}
		});
	return found;
}
