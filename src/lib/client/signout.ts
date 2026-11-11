/**
 * Signing out clears everything this device holds for the account:
 *
 * - the session cookie (deleted by the server; HttpOnly, so script cannot touch it),
 * - every Cache Storage entry except the current versioned app shell (`pc-shell-<version>`,
 *   which holds only the public build and the offline screen, never personal data),
 * - every IndexedDB database (the offline workout store from M4 onwards),
 * - session storage (scratch state of the tab),
 * - /workout's prepainted card in localStorage (workout/prepaint.ts: the current exercise's words),
 *   and the launch flag (workout/active-flag.ts: the workout in progress, for a launch offline).
 *
 * Device preferences in localStorage (theme, units) are kept on purpose: they are not account
 * data and the next sign-in should look the same. See docs/security.md.
 *
 * Unsynced workout changes are never deleted without the owner's choice (the offline workout sync
 * ADR, 'Losing the session'). The sign-out screens go through signOutIfSynced, which flushes first,
 * for at most 5 s (workout/shutdown.ts), and ask before signOutDeleting deletes what is left. Both
 * screens share this flow; they only hold the sheet that asks. signOut tells the other tabs
 * ('signed-out'), clears the device, and leaves a one-shot marker in session storage for the
 * sign-in page. A signed-out URL without the marker (typed, from history, or the no-JavaScript
 * sign-out) keeps only unsynced workout changes until the owner deletes them or signs in.
 */
import { broadcast } from './workout/channel.ts';
import { version } from '$app/env';

/**
 * Account data this device keeps in localStorage: /workout's prepainted card (workout/prepaint.ts's
 * PREPAINT_KEY) and the launch flag (workout/active-flag.ts's ACTIVE_WORKOUT_KEY), by value so
 * the sign-in screen loads neither module; signout.test.ts checks.
 */
const ACCOUNT_KEYS: readonly string[] = ['pc:workout-prepaint:v1', 'pc:active-workout:v1'];

export const SHELL_CACHE = `pc-shell-${version}`;

/** Session storage's one-shot note that this tab just signed out through signOut. */
export const SIGNED_OUT_MARKER = 'pc:signed-out';

/**
 * Remove account data from this browser. Never throws: each store is cleared independently.
 * `keepWorkouts` leaves IndexedDB alone: the unsynced workout changes the owner has not let go of.
 */
export async function clearDeviceAccountData(
	options: { keepWorkouts?: boolean } = {}
): Promise<void> {
	clearAccountKeys();
	await Promise.allSettled([
		clearCaches(),
		options.keepWorkouts ? Promise.resolve() : clearIndexedDb(),
		clearSessionStorage()
	]);
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

function clearAccountKeys(): void {
	try {
		for (const key of ACCOUNT_KEYS) localStorage.removeItem(key);
	} catch {
		// storage disabled
	}
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
 * deleted by the server, so "signed out" offline would be a false promise. The caller has
 * already flushed and asked about unsynced workout changes: this deletes them.
 */
export async function signOut(): Promise<void> {
	const res = await fetch('/api/auth/signout', {
		method: 'POST',
		headers: { accept: 'application/json' },
		credentials: 'same-origin'
	});
	if (!res.ok) throw new Error(`sign-out failed (${res.status})`);
	// The other tabs let go of 'pc-offline' before it is deleted.
	broadcast({ type: 'signed-out' });
	await clearDeviceAccountData();
	// After the clear, which empties session storage.
	try {
		sessionStorage.setItem(SIGNED_OUT_MARKER, '1');
	} catch {
		// storage disabled: the sign-in page then keeps what is unsynced, which is nothing now
	}
	location.replace('/?signedOut=1');
}

/**
 * The screens' sign-out: flushes the unsynced workout changes first, then signs out when none are
 * left. Answers how many are left, for the screen to ask about; 0 means it signed out. Throws, as
 * signOut does, when the server cannot be reached.
 */
export async function signOutIfSynced(): Promise<number> {
	const { unsyncedAfterFlush } = await import('./workout/shutdown.ts');
	const left = await unsyncedAfterFlush();
	if (left === 0) await signOut();
	return left;
}

/**
 * "Sign out and delete", after the screen asked about `asked` unsynced changes. When more are
 * pending now (one arrived while it asked), it signs nothing out and answers the new count, for the
 * screen to ask again. Otherwise it calls `leaving` (the screen closes its sheet), signs out, and
 * answers 0. Throws, as signOut does, when the server cannot be reached.
 */
export async function signOutDeleting(
	asked: number,
	leaving: () => void = () => {}
): Promise<number> {
	const { pendingCount } = await import('./workout/probe.ts');
	const pending = await pendingCount();
	if (pending > asked) return pending;
	leaving();
	await signOut();
	return 0;
}

/** Whether signOut left its marker in this tab; it is removed either way. */
function takeMarker(): boolean {
	try {
		const marked = sessionStorage.getItem(SIGNED_OUT_MARKER) !== null;
		sessionStorage.removeItem(SIGNED_OUT_MARKER);
		return marked;
	} catch {
		return false;
	}
}

/**
 * The sign-in page on a signed-out URL. After signOut (its marker): clears the device again,
 * which also covers what SvelteKit wrote into session storage on the way out. Without the marker:
 * clears everything unless workout changes are unsynced; those are kept, with nothing the server
 * holds, until the owner deletes them or signs in. `kept` is how many.
 */
export async function clearAfterSignedOutUrl(): Promise<{ kept: number }> {
	if (takeMarker()) {
		await clearDeviceAccountData();
		return { kept: 0 };
	}
	const { pendingCount } = await import('./workout/probe.ts');
	const kept = await pendingCount();
	if (kept === 0) {
		await clearDeviceAccountData();
		return { kept: 0 };
	}
	const { keepOnlyUnsynced } = await import('./workout/shutdown.ts');
	// A purge that fails still deletes nothing unsynced.
	await keepOnlyUnsynced().catch(() => {});
	await clearDeviceAccountData({ keepWorkouts: true });
	return { kept };
}
