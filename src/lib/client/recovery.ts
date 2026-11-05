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
 */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;
export const PROBE_TIMEOUT_MS = 5_000;
export const OFFLINE_PATH = '/offline';
const MEMORY_KEY = 'pc:offline-recovery';
const MEMORY_MS = 120_000;

export interface RecoveryOptions {
	/** Called with navigator.onLine whenever it is (re)checked. */
	onDeviceStatus: (online: boolean) => void;
	/** Defaults: GET /api/health with a timeout; location.reload(). */
	probe?: () => Promise<boolean>;
	reload?: () => void;
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
	const reload = options.reload ?? (() => location.reload());
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
		probing = false;
		if (stopped) return;
		if (ok) {
			stopped = true;
			remember(path, attempt);
			reload();
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
