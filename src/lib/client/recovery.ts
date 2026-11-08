/**
 * Self-recovery for the offline screen: probe the server with backoff and reload the screen as
 * soon as it answers; probe at once on `online`, on focus and when the app returns to the
 * foreground. A single reload on `online` is not enough: that one attempt can still fail, and
 * lie-fi, captive portals and outages never fire `online` at all.
 *
 * Guards against reload loops:
 * - The backoff survives reloads (sessionStorage, per path, for two minutes), so a reload that
 *   lands back on the offline screen waits longer instead of restarting at two seconds.
 * - The probe gives up before the service worker's navigation timeout (6 s): a server slow
 *   enough to answer the probe but not the page is treated as unreachable.
 * - The prerendered `/offline` document visited at its own URL never self-reloads: it is the
 *   offline screen by definition, so reloading it would loop forever on a healthy server.
 *
 * The screen loads again in place first (a client-side navigation to its URL), so a tap made
 * meanwhile wins instead of being dropped by a page load. If that lands back here (Chromium keeps
 * a failed dynamic import failed for the document), the next recovery for the path reloads.
 *
 * WebKit keeps a module script that failed to load (offline) as failed for the tab: a reload, or any
 * later navigation in it, gets the failure back without asking the network, so the screen's code
 * never arrives. Once the server answers, each such script is fetched again, which replaces the
 * entry, before the screen loads again.
 */
import { goto } from '$app/navigation';

export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;
export const PROBE_TIMEOUT_MS = 5_000;
export const OFFLINE_PATH = '/offline';
const MEMORY_KEY = 'pc:offline-recovery';
const MEMORY_MS = 120_000;
/** Paths this document has already loaded again in place. */
const triedInPlace = new Set<string>();

export interface RecoveryOptions {
	/** Called with navigator.onLine whenever it is (re)checked. */
	onDeviceStatus: (online: boolean) => void;
	/** Default: GET /api/health with a timeout. */
	probe?: () => Promise<boolean>;
}

/**
 * The page's module scripts that failed to load: a failed load leaves no resource timing entry
 * (WebKit) or one with status 0. Every script the page asked for has a modulepreload link (the
 * server's, or Vite's for code loaded later).
 */
function failedModules(): string[] {
	return [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')]
		.map((link) => link.href)
		.filter((url) => {
			const entry = performance.getEntriesByName(url)[0] as PerformanceResourceTiming | undefined;
			return !entry || entry.responseStatus === 0;
		});
}

/** Fetch the module scripts that failed again (see above), then reload. */
export async function reloadFresh(): Promise<void> {
	await refetchFailedModules();
	location.reload();
}

async function refetchFailedModules(): Promise<void> {
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	await Promise.all(
		failedModules().map((url) => fetch(url, { cache: 'reload', signal }).catch(() => {}))
	);
}

async function probeHealth(): Promise<boolean> {
	try {
		const res = await fetch('/api/health', {
			cache: 'no-store',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		return res.ok;
	} catch {
		return false;
	}
}

function recall(path: string): number {
	try {
		const memory = JSON.parse(sessionStorage.getItem(MEMORY_KEY) ?? 'null') as {
			path?: string;
			attempt?: number;
			at?: number;
		} | null;
		if (memory?.path === path && Date.now() - (memory.at ?? 0) < MEMORY_MS) {
			return Math.max(0, Math.min(memory.attempt ?? 0, RETRY_DELAYS_MS.length - 1));
		}
	} catch {
		// storage unavailable (private mode, blocked): start from the first delay
	}
	return 0;
}

function remember(path: string, attempt: number): void {
	try {
		sessionStorage.setItem(MEMORY_KEY, JSON.stringify({ path, attempt, at: Date.now() }));
	} catch {
		// best effort
	}
}

/** Start recovering; returns a stop function. Does nothing on the `/offline` URL itself. */
export function startOfflineRecovery(options: RecoveryOptions): () => void {
	const path = location.pathname;
	// The canonical offline document keeps its "you're offline" wording and never self-reloads.
	if (path === OFFLINE_PATH) return () => {};
	options.onDeviceStatus(navigator.onLine);

	const probe = options.probe ?? probeHealth;
	let attempt = recall(path);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let probing = false;
	let stopped = false;

	const schedule = () => {
		if (stopped) return;
		clearTimeout(timer);
		const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
		attempt = Math.min(attempt + 1, RETRY_DELAYS_MS.length - 1);
		timer = setTimeout(() => void check(), delay);
	};

	async function check(): Promise<void> {
		if (stopped || probing) return;
		options.onDeviceStatus(navigator.onLine);
		if (!navigator.onLine) return schedule();
		probing = true;
		const ok = await probe();
		// Even when the user has navigated meanwhile: their next screens need the scripts too.
		if (ok) await refetchFailedModules();
		probing = false;
		if (stopped) return;
		if (ok) {
			stopped = true;
			if (!triedInPlace.has(path)) {
				triedInPlace.add(path);
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- this screen's own URL
				void goto(location.href, { replace: true, reset: false, refreshAll: true });
				return;
			}
			remember(path, attempt);
			location.reload();
			return;
		}
		schedule();
	}

	const now = () => void check();
	const onVisible = () => {
		if (document.visibilityState === 'visible') now();
	};
	const onOffline = () => options.onDeviceStatus(false);

	addEventListener('online', now);
	addEventListener('offline', onOffline);
	addEventListener('focus', now);
	document.addEventListener('visibilitychange', onVisible);
	schedule();
	return () => {
		stopped = true;
		clearTimeout(timer);
		removeEventListener('online', now);
		removeEventListener('offline', onOffline);
		removeEventListener('focus', now);
		document.removeEventListener('visibilitychange', onVisible);
	};
}
