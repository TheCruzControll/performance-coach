/**
 * The `setup-worlds` project of a run with more than one owner world (a serial CI leg,
 * e2e/worlds.ts), after the owner setups: the world they ran in is copied into every other
 * world, database and browser state, so each worker's serial specs start from the same owner,
 * passkeys and sessions, as a one-worker leg's always have. Then every world's server must know
 * every saved session: its sign-in screen sends a signed-in browser straight on (a redirect that
 * writes nothing).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, request as requests, test as setup } from '@playwright/test';
import { copyDatabase, ownerWorld } from './world-copy';
import { worlds } from './worlds';

/** The signed-in states the setup projects write (playwright.config.ts). */
const STATES = ['e2e/.auth/chromium.json', 'e2e/.auth/webkit.json'];

interface StorageState {
	cookies: unknown[];
	origins: { origin: string; localStorage: unknown[] }[];
}

setup('every owner world starts from the one the owner setup made', async () => {
	const all = worlds(process.env);
	expect(all.length, 'setup-worlds runs only with more than one world').toBeGreaterThan(1);
	const source = await ownerWorld(process.env);
	for (const target of all) {
		if (target.index !== source.index) {
			await copyDatabase(process.env, source.databaseUrl, target.databaseUrl);
		}
	}

	const states = STATES.filter((path) => existsSync(path));
	expect(states, 'the Chromium setup saved its state').toContain(STATES[0]);
	for (const path of states) {
		// Cookies name no port, so they sign in at every world's origin already; local storage is
		// per origin, so the source world's moves to every world.
		const state = JSON.parse(readFileSync(path, 'utf8')) as StorageState;
		const own = state.origins.find((entry) => entry.origin === source.origin);
		const others = state.origins.filter((entry) => !all.some((w) => w.origin === entry.origin));
		state.origins = [...others, ...(own ? all.map((w) => ({ ...own, origin: w.origin })) : [])];
		writeFileSync(path, JSON.stringify(state));

		for (const target of all) {
			const context = await requests.newContext({ baseURL: target.origin, storageState: path });
			try {
				const signIn = await context.get('/', { maxRedirects: 0 });
				expect(signIn.status(), `${path} is signed in at ${target.origin}`).toBe(303);
				expect(signIn.headers().location).toBe('/today');
			} finally {
				await context.dispose();
			}
		}
	}
});
