/**
 * Every public POST route is rate-limited. Three checks, all unit-level and without a database:
 *
 * 1. The public POST routes on disk (a `+server.ts` exporting POST, or a `+page.server.ts` with
 *    form actions) that routes.ts classifies `public` are exactly the keys of PUBLIC_POST_BUCKETS.
 *    A new public POST route without a bucket fails here.
 * 2. Each bucket names a real policy (policy.ts).
 * 3. Each route's handler reaches enforceRateLimit with its own bucket, before anything else, and
 *    answers the refusal as 429 with Retry-After. enforceRateLimit is replaced with a spy that
 *    refuses, so no query runs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RateLimit from './rate-limit';
import { closeDb } from '../db';
import { resetEnvCache } from '../env';
import { AuthError } from './errors';
import { ROUTE_ACCESS } from './routes';
import { PUBLIC_POST_BUCKETS, type PublicPostRoute } from './rate-limit';
import { RATE_LIMITS } from './policy';

const enforce = vi.hoisted(() => vi.fn());
vi.mock('./rate-limit', async (importOriginal) => ({
	...(await importOriginal<typeof RateLimit>()),
	enforceRateLimit: enforce
}));

// Imported after the mock, so the routes and services see the spy.
const { POST: signinOptions } = await import('../../../routes/api/auth/signin/options/+server.ts');
const { POST: signinVerify } = await import('../../../routes/api/auth/signin/verify/+server.ts');
const { POST: setupOptions } = await import('../../../routes/api/auth/setup/options/+server.ts');
const { POST: setupVerify } = await import('../../../routes/api/auth/setup/verify/+server.ts');
const { POST: signout } = await import('../../../routes/api/auth/signout/+server.ts');
const { POST: testSession } = await import('../../../routes/api/test-support/session/+server.ts');
const { actions: recover } = await import('../../../routes/recover/+page.server.ts');

const ROUTES_DIR = path.resolve(import.meta.dirname, '../../../routes');
const FORM_ACTIONS = /export\s+const\s+actions\b/;
/** The names a +server file exports to answer POST: POST, or fallback (SvelteKit's for any method). */
const POST_HANDLERS = new Set(['POST', 'fallback']);

const isExported = (node: ts.Node): boolean =>
	(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
		(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
	) ?? false;

/**
 * Whether a +server file answers POST: it exports POST or fallback, declared (`export const`,
 * `export function`) or re-exported under that name (`export { handler as POST }`,
 * `export { POST } from './x'`). It is read as TypeScript, so a name in a comment or a string does
 * not count. `export * from` is not followed.
 */
function answersPost(text: string): boolean {
	const sf = ts.createSourceFile('+server.ts', text, ts.ScriptTarget.Latest, true);
	return sf.statements.some((statement) => {
		if (ts.isVariableStatement(statement) && isExported(statement)) {
			return statement.declarationList.declarations.some(
				(declaration) =>
					ts.isIdentifier(declaration.name) && POST_HANDLERS.has(declaration.name.text)
			);
		}
		if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
			return POST_HANDLERS.has(statement.name?.text ?? '');
		}
		const clause = ts.isExportDeclaration(statement) ? statement.exportClause : undefined;
		if (
			ts.isExportDeclaration(statement) &&
			!statement.isTypeOnly &&
			clause &&
			ts.isNamedExports(clause)
		) {
			return clause.elements.some(
				(element) => !element.isTypeOnly && POST_HANDLERS.has(element.name.text)
			);
		}
		return false;
	});
}

/** Route ids (SvelteKit's, e.g. `/(app)/today`) of every endpoint or page with a POST handler. */
function postRoutes(dir = ROUTES_DIR): string[] {
	const ids = new Set<string>();
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			postRoutes(full).forEach((id) => ids.add(id));
			continue;
		}
		const text = /^\+server\.(ts|js)$/.test(entry)
			? answersPost(readFileSync(full, 'utf8'))
			: /^\+page\.server\.(ts|js)$/.test(entry) && FORM_ACTIONS.test(readFileSync(full, 'utf8'));
		if (text) {
			const rel = path.relative(ROUTES_DIR, dir).split(path.sep).filter(Boolean).join('/');
			ids.add(`/${rel}`);
		}
	}
	return [...ids].sort();
}

const publicPost = postRoutes().filter(
	(id) => ROUTE_ACCESS[id as keyof typeof ROUTE_ACCESS] === 'public'
);

describe('which +server files answer POST', () => {
	it.each([
		['export const POST', 'export const POST = async () => new Response(null);', true],
		['export function POST', 'export function POST() { return new Response(null); }', true],
		[
			'export async function POST',
			'export async function POST() { return new Response(null); }',
			true
		],
		[
			'export const POST with a type',
			`import type { RequestHandler } from './$types';\nexport const POST: RequestHandler = () => new Response(null);`,
			true
		],
		['export const fallback', 'export const fallback = async () => new Response(null);', true],
		[
			'export { handler as POST }',
			'const handler = async () => new Response(null);\nexport { handler as POST };',
			true
		],
		['export { POST } from another file', "export { POST } from './handlers';", true],
		[
			'export { POST } of a local binding',
			'const POST = async () => new Response(null);\nexport { POST };',
			true
		],
		[
			'export { POST as GET }, which exports GET',
			'const POST = async () => new Response(null);\nexport { POST as GET };',
			false
		],
		['export const GET only', 'export const GET = async () => new Response(null);', false],
		[
			'POST named in a comment or a string',
			"// export const POST = 1\nexport const GET = () => new Response('export const POST');",
			false
		],
		['a type-only export of POST', "export type { POST } from './types';", false]
	])('%s', (_, source, answers) => {
		expect(answersPost(source)).toBe(answers);
	});
});

describe('public POST routes are rate-limited', () => {
	it('finds the public POST routes on disk', () => {
		expect(publicPost).toEqual(
			[
				'/api/auth/setup/options',
				'/api/auth/setup/verify',
				'/api/auth/signin/options',
				'/api/auth/signin/verify',
				'/api/auth/signout',
				'/api/test-support/session',
				'/recover'
			].sort()
		);
	});

	it('gives every public POST route a bucket, and no other route one', () => {
		expect(Object.keys(PUBLIC_POST_BUCKETS).sort(), 'routes without a bucket').toEqual(publicPost);
	});

	it('names only buckets that exist in the policy', () => {
		for (const [route, bucket] of Object.entries(PUBLIC_POST_BUCKETS)) {
			expect(RATE_LIMITS, route).toHaveProperty([bucket]);
		}
	});
});

describe('each public POST handler applies its bucket', () => {
	const IP = '198.51.100.44';
	const ORIGIN = 'http://localhost:4173';

	beforeAll(() => {
		// The handlers read the environment through getEnv(): a local dev origin, the test app
		// environment and test routes on, and a database URL that is never connected to.
		vi.stubEnv('APP_ENV', 'test');
		vi.stubEnv('ENABLE_TEST_ROUTES', 'true');
		vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/coach_unit');
		resetEnvCache();
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		resetEnvCache();
		await closeDb();
	});

	/** A SvelteKit-shaped event for a POST from `IP` to `ORIGIN + pathname`. */
	function eventFor(pathname: string, body?: string, form = false) {
		const url = new URL(pathname, ORIGIN);
		const headers: Record<string, string> = { origin: ORIGIN };
		if (body !== undefined && !form) headers['content-type'] = 'application/json';
		const request = new Request(url, {
			method: 'POST',
			headers,
			body: body === undefined ? undefined : form ? new URLSearchParams(body) : body
		});
		return {
			url,
			request,
			cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
			getClientAddress: () => IP,
			locals: { requestId: 'req-rate-limit-test', session: null },
			setHeaders: () => {},
			params: {},
			route: { id: pathname }
		};
	}

	const refusal = () =>
		new AuthError('rate_limited', 'Too many attempts. Wait a moment and try again.', {
			retryAfter: 60
		});

	/** The bucket each handler passed to enforceRateLimit, in call order. */
	const buckets = () => enforce.mock.calls.map((call) => call[0]);

	it.each([
		[
			'/api/auth/signin/options',
			() => signinOptions(eventFor('/api/auth/signin/options') as never)
		],
		[
			'/api/auth/signin/verify',
			() => signinVerify(eventFor('/api/auth/signin/verify', '{}') as never)
		],
		[
			'/api/auth/setup/options',
			() =>
				setupOptions(eventFor('/api/auth/setup/options', '{"token":"t","name":"Owner"}') as never)
		],
		[
			'/api/auth/setup/verify',
			() => setupVerify(eventFor('/api/auth/setup/verify', '{}') as never)
		],
		['/api/auth/signout', () => signout(eventFor('/api/auth/signout') as never)],
		['/api/test-support/session', () => testSession(eventFor('/api/test-support/session') as never)]
	] as const)('%s counts its own bucket and answers 429 with Retry-After', async (route, call) => {
		enforce.mockReset();
		enforce.mockRejectedValueOnce(refusal());
		const response = (await call()) as Response;
		expect(buckets()).toEqual([PUBLIC_POST_BUCKETS[route as PublicPostRoute]]);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
	});

	it('/recover (the recovery-code form action) counts the recovery bucket and fails with 429', async () => {
		enforce.mockReset();
		enforce.mockRejectedValueOnce(refusal());
		const result = (await recover.default!(
			eventFor('/recover', 'code=abcd-efgh', true) as never
		)) as { status?: number };
		expect(buckets()).toEqual([PUBLIC_POST_BUCKETS['/recover']]);
		expect(result.status).toBe(429);
	});
});
