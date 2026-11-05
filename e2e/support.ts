import { expect, type Page, type TestInfo } from '@playwright/test';
import pg from 'pg';
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';

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
