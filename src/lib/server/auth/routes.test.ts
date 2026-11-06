/**
 * Deny by default, enforced on the file system: every page and endpoint under src/routes must
 * be classified in ROUTE_ACCESS (a new route without a decision fails this test, and `pnpm
 * check` too). e2e/access.e2e.ts then proves the policy over HTTP.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_ACCESS, routeAccess } from './routes';

const ROUTES_DIR = path.resolve(import.meta.dirname, '../../../routes');
/**
 * Files that make a directory a route: a page (`+page.svelte`, also `+page@.svelte` /
 * `+page@(group).svelte`, which reset the layout), its loads (`+page.ts`, `+page.server.ts`) or
 * an endpoint (`+server.ts`). Layouts and error pages alone are not routes.
 */
const ROUTE_FILE = /^\+(page(@[^.]*)?\.svelte|page(\.server)?\.(ts|js)|server\.(ts|js))$/;

function routeIds(dir = ROUTES_DIR): string[] {
	const ids = new Set<string>();
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) routeIds(full).forEach((id) => ids.add(id));
		else if (ROUTE_FILE.test(entry)) {
			const rel = path.relative(ROUTES_DIR, dir).split(path.sep).filter(Boolean).join('/');
			ids.add(`/${rel}`);
		}
	}
	return [...ids].sort();
}

describe('route access policy', () => {
	const ids = routeIds();

	it('recognises every SvelteKit route file, layout resets included', () => {
		const routeFiles = [
			'+page.svelte',
			'+page@.svelte',
			'+page@(app).svelte',
			'+page.ts',
			'+page.js',
			'+page.server.ts',
			'+page.server.js',
			'+server.ts',
			'+server.js'
		];
		const notRoutes = ['+layout.svelte', '+layout@.svelte', '+layout.server.ts', '+error.svelte'];
		expect(routeFiles.filter((f) => !ROUTE_FILE.test(f))).toEqual([]);
		expect(notRoutes.filter((f) => ROUTE_FILE.test(f))).toEqual([]);
	});

	it('finds the routes on disk', () => {
		expect(ids).toEqual(expect.arrayContaining(['/', '/api/health', '/(app)/today']));
	});

	it('classifies every route under src/routes, and nothing that does not exist', () => {
		const classified = Object.keys(ROUTE_ACCESS).sort();
		expect(
			ids.filter((id) => !classified.includes(id)),
			'unclassified routes'
		).toEqual([]);
		expect(
			classified.filter((id) => !ids.includes(id)),
			'stale entries'
		).toEqual([]);
	});

	it('keeps the public surface to the documented allow-list', () => {
		const pub = Object.entries(ROUTE_ACCESS)
			.filter(([, access]) => access === 'public')
			.map(([id]) => id)
			.sort();
		expect(pub).toEqual(
			[
				'/',
				'/(app)/offline',
				'/api/auth/setup/options',
				'/api/auth/setup/verify',
				'/api/auth/signin/options',
				'/api/auth/signin/verify',
				'/api/auth/signout',
				'/api/health',
				'/api/test-support/session',
				'/recover',
				'/setup'
			].sort()
		);
	});

	it('keeps what a recovery session can reach to the new-passkey screen and its endpoints', () => {
		const anySession = Object.entries(ROUTE_ACCESS)
			.filter(([, access]) => access === 'any-session')
			.map(([id]) => id)
			.sort();
		expect(anySession).toEqual(
			['/api/auth/passkeys/options', '/api/auth/passkeys/verify', '/recover/passkey'].sort()
		);
	});

	it('requires a session for telemetry ingestion and every app screen', () => {
		for (const id of ['/api/vitals', '/api/client-errors', '/(app)/profile', '/design']) {
			expect(routeAccess(id), id).toBe('owner');
		}
	});

	it('treats unknown or unmatched routes as owner-only', () => {
		expect(routeAccess(null)).toBe('owner');
		expect(routeAccess('/api/something-new')).toBe('owner');
	});
});
