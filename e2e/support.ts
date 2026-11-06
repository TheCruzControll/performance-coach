import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';
import * as profileSchema from '../src/lib/server/db/schema/profile';

/** The app's origin: state-changing requests must send it (`Origin`), as browsers do. */
export const ORIGIN =
	process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 4173}`;
export const SAME_ORIGIN = { origin: ORIGIN } as const;

/** A browser state with no session: for signed-out specs (`test.use({ storageState: signedOut })`). */
export const signedOut = { cookies: [], origins: [] };

export const TABS = [
	{ label: 'Today', path: '/today', heading: 'Today' },
	{ label: 'Train', path: '/train', heading: 'Train' },
	{ label: 'Progress', path: '/progress', heading: 'Progress' },
	{ label: 'Coach', path: '/coach', heading: 'Coach' },
	{ label: 'Profile', path: '/profile', heading: 'Profile' }
] as const;

/** Run a query against the e2e database (the same one the server under test uses). */
export async function query<T extends pg.QueryResultRow>(
	sql: string,
	params: unknown[] = []
): Promise<T[]> {
	const client = new pg.Client({
		connectionString: process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e
	});
	await client.connect();
	try {
		return (await client.query<T>(sql, params)).rows;
	} finally {
		await client.end();
	}
}

/** Every training-profile table (src/lib/server/db/schema/profile.ts); none references another. */
const TRAINING_PROFILE_TABLES = Object.values(profileSchema)
	.filter((table) => is(table, PgTable))
	.map((table) => getTableName(table));

/**
 * Start from a blank training profile: delete the owner's rows from every training-profile
 * table, in one transaction. For serial specs (`*.serial.e2e.ts`), which run one at a time.
 */
export async function resetTrainingProfile(): Promise<void> {
	await query(
		TRAINING_PROFILE_TABLES.map(
			(table) => `delete from ${table} where owner_id in (select id from owners)`
		).join(';\n')
	);
}

/**
 * Save a training-profile section through its form action, as the screen's Save does (a JSON
 * `payload`, the app's Origin, SvelteKit's action headers): to seed what a serial spec starts
 * from. Fails the test unless the action saved.
 */
export async function profileAction(
	request: APIRequestContext,
	action: string,
	payload: unknown
): Promise<void> {
	const response = await request.post(action, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: JSON.stringify(payload) }
	});
	expect(response.status(), `${action} answered`).toBe(200);
	expect(await response.json(), action).toMatchObject({ type: 'success' });
}

/** Open a page and wait until it has hydrated: once the network settles, its code has run. */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** Poll until `fn` returns a truthy value (or time out). */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value || Date.now() > deadline) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Collect console errors and uncaught exceptions for the lifetime of a page. */
export function trackConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
	});
	page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
	return errors;
}

/** Save a named full-viewport screenshot of a key screen for review (uploaded by CI). */
export async function captureScreen(page: Page, testInfo: TestInfo, name: string) {
	await page.evaluate(() => document.fonts.ready);
	await expect(page.locator('body')).toBeVisible();
	await page.screenshot({
		path: `test-results/screens/${testInfo.project.name}/${name}.png`,
		animations: 'disabled'
	});
}

export interface AppRoute {
	/** SvelteKit route id, e.g. `/(app)/profile/security`. */
	id: string;
	/** A URL path for it (groups removed, params filled with sample values). */
	path: string;
	page: boolean;
	/** HTTP methods an endpoint exports (+server.ts). */
	methods: string[];
}

const ROUTES_DIR = path.resolve(import.meta.dirname, '../src/routes');

/** Every page and endpoint under src/routes, read from the file system (nothing hard-coded). */
export function appRoutes(dir = ROUTES_DIR): AppRoute[] {
	const routes: AppRoute[] = [];
	const files = readdirSync(dir);
	// `+page@.svelte` / `+page@(group).svelte` reset the layout: still a page.
	const page = files.some((f) => /^\+(page(@[^.]*)?\.svelte|page(\.server)?\.(ts|js))$/.test(f));
	const endpoint = files.find((f) => /^\+server\.(ts|js)$/.test(f));
	if (page || endpoint) {
		const segments = path.relative(ROUTES_DIR, dir).split(path.sep).filter(Boolean);
		const id = `/${segments.join('/')}`;
		const urlPath = `/${segments
			.filter((s) => !/^\(.*\)$/.test(s))
			.map((s) => s.replace(/^\[+\.{0,3}([\w-]+)(=[\w-]+)?\]+$/, 'sample'))
			.join('/')}`;
		const methods = endpoint
			? [
					...readFileSync(path.join(dir, endpoint), 'utf8').matchAll(
						/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
					)
				].map((m) => m[1]!)
			: [];
		routes.push({ id, path: urlPath, page, methods });
	}
	for (const entry of files) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) routes.push(...appRoutes(full));
	}
	return routes;
}

/** A toast notification with this text (not the same words elsewhere on the screen). */
export function toastWith(page: Page, text: string | RegExp) {
	return page.locator('.toaster .toast').filter({ hasText: text });
}
