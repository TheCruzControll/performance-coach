/**
 * Every cookie the app writes goes through one of two files, auth/http.ts or auth/guard.ts, with
 * the options sessionCookie() or expiredSessionCookie() returned (cookies.ts). The session cookie's
 * name and its Secure, HttpOnly, SameSite and Path flags then have exactly one definition: a route
 * that calls `cookies.set` itself could set a cookie without them.
 *
 * A write is a call to `set`, `delete` or `serialize` on a `cookies` object, or a `set-cookie`
 * header set or appended by hand. The scan reads the TypeScript syntax tree, so a write in a
 * comment or a string does not count. The fixture trees below plant the violations this must catch.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The only files that may write a cookie. */
const WRITERS = ['src/lib/server/auth/http.ts', 'src/lib/server/auth/guard.ts'];
/** The functions whose result a cookie write must take its options from. */
const OPTION_SOURCES = new Set(['sessionCookie', 'expiredSessionCookie']);
const WRITE_METHODS = new Set(['set', 'delete', 'serialize']);
/** The index of the options argument: `set(name, value, options)`, `delete(name, options)`. */
const OPTIONS_ARG = { set: 2, serialize: 2, delete: 1 } as const;

interface Write {
	file: string;
	line: number;
	reason: string | null;
}

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(file);
		return /\.(ts|js|svelte)$/.test(entry.name) ? [file] : [];
	});

/** A .svelte file's script blocks; the rest of the file holds no code to parse. */
function scriptText(name: string, text: string): string {
	if (!name.endsWith('.svelte')) return text;
	return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
		.map(([, body]) => body)
		.join('\n');
}

/** A `cookies` object: `cookies` itself, or `event.cookies`, `locals.cookies` and the like. */
const isCookieJar = (node: ts.Expression): boolean =>
	(ts.isIdentifier(node) && node.text === 'cookies') ||
	(ts.isPropertyAccessExpression(node) && node.name.text === 'cookies');

/** Every cookie write in one file, with the reason it is not allowed (null when it is). */
function cookieWrites(name: string, text: string): Write[] {
	const body = scriptText(name, text);
	const sf = ts.createSourceFile(name, body, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	const writer = WRITERS.includes(name);

	// Names bound from sessionCookie(...) or expiredSessionCookie(...), e.g. `const { options } = …`.
	const optionNames = new Set<string>();
	const collect = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			OPTION_SOURCES.has(node.initializer.expression.text)
		) {
			for (const element of node.name.elements) {
				if (ts.isIdentifier(element.name)) optionNames.add(element.name.text);
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(sf);

	const writes: Write[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const receiver = node.expression.expression;
			if (isCookieJar(receiver) && WRITE_METHODS.has(method)) {
				const options = node.arguments[OPTIONS_ARG[method as keyof typeof OPTIONS_ARG]];
				let reason: string | null = null;
				if (!writer) reason = 'written outside auth/http.ts and auth/guard.ts';
				else if (!options || !ts.isIdentifier(options) || !optionNames.has(options.text)) {
					reason = 'options are not those sessionCookie() or expiredSessionCookie() return';
				}
				writes.push({ file: name, line: line(node), reason });
			} else if (
				(method === 'set' || method === 'append') &&
				node.arguments[0] &&
				ts.isStringLiteral(node.arguments[0]) &&
				node.arguments[0].text.toLowerCase() === 'set-cookie'
			) {
				headerWrite(node, node.arguments[1]);
			}
		} else if (
			ts.isPropertyAssignment(node) &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
			node.name.text.toLowerCase() === 'set-cookie'
		) {
			// `{ headers: { 'set-cookie': … } }` (a Response's init object).
			headerWrite(node, node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	/** A header write is allowed only in a writer, and only with a cookies.serialize() result. */
	const headerWrite = (node: ts.Node, value: ts.Node | undefined): void => {
		const serialized =
			!!value &&
			ts.isCallExpression(value) &&
			ts.isPropertyAccessExpression(value.expression) &&
			value.expression.name.text === 'serialize' &&
			isCookieJar(value.expression.expression);
		const reason = !writer
			? 'set-cookie header written outside auth/http.ts and auth/guard.ts'
			: serialized
				? null
				: 'set-cookie header is not a cookies.serialize() result';
		if (reason) writes.push({ file: name, line: line(node), reason });
	};
	visit(sf);
	return writes;
}

/** Scan `<dir>/src` and return every cookie write, relative to `dir`. */
function scan(dir: string): Write[] {
	return sources(path.join(dir, 'src')).flatMap((file) => {
		const name = path.relative(dir, file).split(path.sep).join('/');
		return cookieWrites(name, readFileSync(file, 'utf8'));
	});
}

const violations = (writes: Write[]) =>
	writes.filter((w) => w.reason).map((w) => `${w.file}:${w.line} ${w.reason}`);

describe('cookie writes', () => {
	it('all go through auth/http.ts or auth/guard.ts, with sessionCookie()’s options', () => {
		const writes = scan(root);
		expect(violations(writes)).toEqual([]);
		// The scan sees the real writes: a silent parser would make the check above vacuous.
		const writers = new Set(writes.map((w) => w.file));
		for (const file of WRITERS) expect(writers, file).toContain(file);
		expect(writes.length).toBeGreaterThanOrEqual(5);
	});

	describe('catches a violation planted in a fixture tree', () => {
		let dir: string;
		const plant = (file: string, text: string) => {
			const full = path.join(dir, file);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, text);
		};
		const CLEAN_WRITER = `import { sessionCookie, expiredSessionCookie } from './cookies';
export function setIt(cookies: any, url: URL, token: string, expires: Date) {
	const { name, options } = sessionCookie(url, expires);
	cookies.set(name, token, options);
}
export function clearIt(cookies: any, url: URL) {
	const { name, options } = expiredSessionCookie(url);
	cookies.set(name, '', options);
}
`;

		it.each([
			[
				'a route that sets a cookie itself',
				'src/routes/api/x/+server.ts',
				`export const POST = ({ cookies }: any) => { cookies.set('session', 'tok', { path: '/' }); };\n`
			],
			[
				'a helper that deletes outside the writers',
				'src/lib/server/services/x.ts',
				`export const f = (event: any) => event.cookies.delete('session', { path: '/' });\n`
			],
			[
				'a set-cookie header written by hand',
				'src/routes/api/y/+server.ts',
				`export const GET = () => new Response(null, { headers: { 'set-cookie': 'session=1' } });\n`
			],
			[
				'a writer that passes inline options, not sessionCookie()’s',
				'src/lib/server/auth/http.ts',
				`export function bad(cookies: any) { cookies.set('session', 't', { httpOnly: false }); }\n`
			]
		])('flags %s', (_, file, text) => {
			dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-writes-'));
			try {
				// The clean writer first: a planted http.ts replaces it, never the other way round.
				plant('src/lib/server/auth/http.ts', CLEAN_WRITER);
				plant(file, text);
				const found = violations(scan(dir));
				expect(found).toHaveLength(1);
				expect(found[0]).toMatch(new RegExp(`^${file.replace(/[.+/]/g, '\\$&')}:\\d+ `));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it('passes a writer that takes its options from sessionCookie()', () => {
			dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-writes-'));
			try {
				plant('src/lib/server/auth/http.ts', CLEAN_WRITER);
				expect(violations(scan(dir))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it('ignores a write named in a comment or a string', () => {
			dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-writes-'));
			try {
				plant(
					'src/routes/z/+page.server.ts',
					`// cookies.set('session', 'x', { path: '/' })\nexport const s = "cookies.delete('session')";\n`
				);
				expect(violations(scan(dir))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
