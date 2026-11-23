/**
 * Every cookie the app writes goes through one of two files, auth/http.ts or auth/guard.ts, with
 * the options sessionCookie() or expiredSessionCookie() returned (cookies.ts). The session cookie's
 * name and its Secure, HttpOnly, SameSite and Path flags then have exactly one definition: a route
 * that calls `cookies.set` itself could set a cookie without them.
 *
 * Outside those two files, a cookie write is any of:
 * - a call to `set`, `delete` or `serialize` on a cookies object: `cookies` itself, `event.cookies`,
 *   or a name bound to one by destructuring (`const { cookies: jar } = event`, a parameter too) or
 *   by assignment (`const jar = event.cookies`);
 * - a call on `cookieStore` (or `window.cookieStore`), or an assignment to `document.cookie`;
 * - a string or template literal whose text is `set-cookie`, in any position: a header tuple, an
 *   object key, a computed key, an index, a constant. Its read, as the first argument of `get` or
 *   `has` (`headers.get('set-cookie')`), is not a write.
 *
 * Inside those two files, a `set-cookie` header set with `set`, `append` or an object key must take
 * a cookies.serialize() result.
 *
 * The scan reads the TypeScript syntax tree, so a write in a comment does not count. It is not
 * complete: a cookies object passed in under another name (`(jar) => jar.set(…)`) and a header name
 * held in a variable (`headers.set(name, …)`, with `name` not a literal) are not seen. Every .ts,
 * .js and .svelte file under src/ is scanned, tests included. The fixture trees below plant the
 * violations this must catch.
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
/** Calls whose first argument is a header name they only read. */
const READ_METHODS = new Set(['get', 'has']);
/** The index of the options argument: `set(name, value, options)`, `delete(name, options)`. */
const OPTIONS_ARG = { set: 2, serialize: 2, delete: 1 } as const;
const SET_COOKIE = 'set-cookie';
const OUTSIDE = 'outside auth/http.ts and auth/guard.ts';

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

/** The text of a string literal or a template with no substitutions, else null. */
const literalText = (node: ts.Node): string | null =>
	ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

/** The name of a property or binding: an identifier or a string literal, else null. */
const nameText = (node: ts.Node | undefined): string | null =>
	node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;

const isSetCookie = (node: ts.Node | undefined): boolean =>
	!!node && literalText(node)?.toLowerCase() === SET_COOKIE;

/** A global named `name`, as `cookieStore` or `window.cookieStore` names it. */
const isGlobal = (node: ts.Expression, name: string): boolean =>
	(ts.isIdentifier(node) && node.text === name) ||
	(ts.isPropertyAccessExpression(node) && node.name.text === name);

const isAssignment = (kind: ts.SyntaxKind): boolean =>
	kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** A literal that is the first argument of `get` or `has`: a read of a header, not a write. */
function isReadName(node: ts.Node): boolean {
	const call = node.parent;
	return (
		!!call &&
		ts.isCallExpression(call) &&
		call.arguments[0] === node &&
		ts.isPropertyAccessExpression(call.expression) &&
		READ_METHODS.has(call.expression.name.text)
	);
}

/** Every cookie write in one file, with the reason it is not allowed (null when it is). */
function cookieWrites(name: string, text: string): Write[] {
	const body = scriptText(name, text);
	const sf = ts.createSourceFile(name, body, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	const writer = WRITERS.includes(name);

	// Names that hold a cookies object: `{ cookies: jar }` destructured, or `const jar = event.cookies`.
	const jars = new Set<string>();
	/** A `cookies` object: `cookies` itself, a name from the destructuring above, or `x.cookies`. */
	const isCookieJar = (node: ts.Expression): boolean =>
		(ts.isIdentifier(node) && (node.text === 'cookies' || jars.has(node.text))) ||
		(ts.isPropertyAccessExpression(node) && node.name.text === 'cookies');

	// Names bound from sessionCookie(...) or expiredSessionCookie(...), e.g. `const { options } = …`.
	const optionNames = new Set<string>();
	const collect = (node: ts.Node): void => {
		if (
			ts.isBindingElement(node) &&
			ts.isObjectBindingPattern(node.parent) &&
			ts.isIdentifier(node.name) &&
			nameText(node.propertyName ?? node.name) === 'cookies'
		) {
			jars.add(node.name.text);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			isCookieJar(node.initializer)
		) {
			jars.add(node.name.text);
		}
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
	const record = (node: ts.Node, reason: string | null) =>
		writes.push({ file: name, line: line(node), reason });

	/** A header write in a writer is allowed only with a cookies.serialize() result. */
	const headerWrite = (node: ts.Node, value: ts.Node | undefined): void => {
		const serialized =
			!!value &&
			ts.isCallExpression(value) &&
			ts.isPropertyAccessExpression(value.expression) &&
			value.expression.name.text === 'serialize' &&
			isCookieJar(value.expression.expression);
		record(node, serialized ? null : 'set-cookie header is not a cookies.serialize() result');
	};

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const receiver = node.expression.expression;
			if (isCookieJar(receiver) && WRITE_METHODS.has(method)) {
				if (!writer) {
					record(node, `written ${OUTSIDE}`);
				} else {
					const options = node.arguments[OPTIONS_ARG[method as keyof typeof OPTIONS_ARG]];
					const ok = !!options && ts.isIdentifier(options) && optionNames.has(options.text);
					record(
						node,
						ok ? null : 'options are not those sessionCookie() or expiredSessionCookie() return'
					);
				}
			} else if (isGlobal(receiver, 'cookieStore') && !writer) {
				record(node, `cookieStore is called ${OUTSIDE}`);
			} else if (
				writer &&
				(method === 'set' || method === 'append') &&
				isSetCookie(node.arguments[0])
			) {
				headerWrite(node, node.arguments[1]);
			}
		} else if (
			ts.isBinaryExpression(node) &&
			isAssignment(node.operatorToken.kind) &&
			ts.isPropertyAccessExpression(node.left) &&
			node.left.name.text === 'cookie' &&
			isGlobal(node.left.expression, 'document') &&
			!writer
		) {
			record(node, `document.cookie is assigned ${OUTSIDE}`);
		} else if (writer && ts.isPropertyAssignment(node) && isSetCookie(node.name)) {
			// `{ headers: { 'set-cookie': … } }`, a Response's init object.
			headerWrite(node, node.initializer);
		} else if (!writer && isSetCookie(node) && !isReadName(node)) {
			record(node, `'set-cookie' named ${OUTSIDE}`);
		}
		ts.forEachChild(node, visit);
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
				'a set-cookie header tuple',
				'src/routes/api/y/+server.ts',
				`export const GET = () => new Response(null, { headers: [['set-cookie', 'session=1']] });\n`
			],
			[
				'a set-cookie computed key',
				'src/routes/api/y/+server.ts',
				`export const GET = () => new Response(null, { headers: { ['set-cookie']: 'session=1' } });\n`
			],
			[
				'a set-cookie index assignment',
				'src/routes/api/y/+server.ts',
				`export function GET(headers: any) { headers['set-cookie'] = 'session=1'; }\n`
			],
			[
				'a set-cookie template literal',
				'src/routes/api/y/+server.ts',
				'export const GET = (headers: any) => headers.append(`set-cookie`, "session=1");\n'
			],
			[
				'a set-cookie constant',
				'src/routes/api/y/+server.ts',
				`const HEADER = 'set-cookie';\nexport const GET = (headers: any) => headers.set(HEADER, 'session=1');\n`
			],
			[
				'document.cookie assigned',
				'src/lib/client/x.ts',
				`export const f = () => { document.cookie = 'session=1; Path=/'; };\n`
			],
			[
				'a cookieStore call',
				'src/lib/client/x.ts',
				`export const f = () => cookieStore.set('session', 'x');\n`
			],
			[
				'a cookies object renamed by destructuring',
				'src/lib/server/services/x.ts',
				`export function f(event: any) { const { cookies: jar } = event; jar.delete('session', { path: '/' }); }\n`
			],
			[
				'a cookies object assigned to another name',
				'src/lib/server/services/x.ts',
				`export function f(event: any) { const jar = event.cookies; jar.set('session', 'x', { path: '/' }); }\n`
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

		it('passes a writer that appends a set-cookie header from cookies.serialize()', () => {
			dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-writes-'));
			try {
				plant('src/lib/server/auth/http.ts', CLEAN_WRITER);
				plant(
					'src/lib/server/auth/guard.ts',
					`import { expiredSessionCookie } from './cookies';\nexport function deny(event: any, url: URL) {\n\tconst { name, options } = expiredSessionCookie(url);\n\tevent.headers.append('set-cookie', event.cookies.serialize(name, '', options));\n}\n`
				);
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

		it('ignores a read of set-cookie, which is the first argument of get or has', () => {
			dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-writes-'));
			try {
				plant(
					'src/routes/z/+page.server.ts',
					`export const f = (r: Response) => [r.headers.get('set-cookie'), r.headers.has('Set-Cookie')];\n`
				);
				expect(violations(scan(dir))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
