/**
 * Signing out clears everything this device holds for the account:
 *
 * - the session cookie (deleted by the server; HttpOnly, so script cannot touch it),
 * - every Cache Storage entry except the current versioned app shell (`pc-shell-<version>`,
 *   which holds only the public build and the offline screen, never personal data),
 * - every IndexedDB database (the offline workout store from M4 onwards),
 * - session storage (scratch state of the tab).
 *
 * Device preferences in localStorage (theme, units) are kept on purpose: they are not account
 * data and the next sign-in should look the same. See docs/security.md.
 */
import { version } from '$app/env';

export const SHELL_CACHE = `pc-shell-${version}`;

/** Remove account data from this browser. Never throws: each store is cleared independently. */
export async function clearDeviceAccountData(): Promise<void> {
	await Promise.allSettled([clearCaches(), clearIndexedDb(), clearSessionStorage()]);
}

async function clearCaches(): Promise<void> {
	if (!('caches' in globalThis)) return;
	const keys = await caches.keys();
	await Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)));
}

/** Known database names, for browsers without `indexedDB.databases()`. */
const KNOWN_DATABASES: string[] = ['pc-offline'];

async function clearIndexedDb(): Promise<void> {
	if (!('indexedDB' in globalThis)) return;
	const listed =
		typeof indexedDB.databases === 'function'
			? (await indexedDB.databases()).flatMap((db) => (db.name ? [db.name] : []))
			: [];
	const names = new Set([...listed, ...KNOWN_DATABASES]);
	await Promise.all(
		[...names].map(
			(name) =>
				new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase(name);
					request.onsuccess = request.onerror = request.onblocked = () => resolve();
				})
		)
	);
}

async function clearSessionStorage(): Promise<void> {
	try {
		sessionStorage.clear();
	} catch {
		// storage disabled
	}
}

/**
 * Sign out on the server, clear this device, and land on the sign-in screen. Throws (and
 * changes nothing) when the server cannot be reached: the HttpOnly session cookie can only be
 * deleted by the server, so "signed out" offline would be a false promise.
 */
export async function signOut(): Promise<void> {
	const res = await fetch('/api/auth/signout', {
		method: 'POST',
		headers: { accept: 'application/json' },
		credentials: 'same-origin'
	});
	if (!res.ok) throw new Error(`sign-out failed (${res.status})`);
	await clearDeviceAccountData();
	location.replace('/?signedOut=1');
}
