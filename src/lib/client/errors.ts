/**
 * Browser error reporting: uncaught exceptions, unhandled promise rejections and errors from the
 * client `handleError` hook are beaconed to POST /api/client-errors (→ `app_errors`, kind
 * `client`). Console output is kept for local debugging.
 *
 * Cheap by design (it is in every page's initial JS): no dependencies, nothing runs until an
 * error happens, at most MAX_REPORTS per page load, and the same error is sent once.
 * Same-origin JSON beacon: no CORS preflight and not subject to SvelteKit's form CSRF check.
 */
const ENDPOINT = '/api/client-errors';
export const MAX_REPORTS = 5;

export type ClientErrorSource = 'error' | 'unhandledrejection' | 'handleError';

export interface ClientErrorReport {
	source: ClientErrorSource;
	name: string;
	message: string;
	stack?: string;
	path: string;
	route: string | null;
	version?: string;
}

let sent = 0;
const seen = new Set<string>();
let context: { route: string | null; version?: string } = { route: null };

/** Remember the current route id (and the build), so reports say where they happened. */
export function setErrorContext(route: string | null, version?: string): void {
	context = { route, version: version ?? context.version };
}

/** Normalise anything thrown into a bounded, serialisable report (null for empty values). */
export function toReport(
	error: unknown,
	source: ClientErrorSource,
	where: { path: string; route: string | null; version?: string }
): ClientErrorReport | null {
	if (error == null) return null;
	const isError = error instanceof Error;
	const name = isError ? error.name || 'Error' : 'NonError';
	const raw = isError ? error.message : typeof error === 'string' ? error : safeJson(error);
	const message = (raw || '(no message)').slice(0, 1_000);
	return {
		source,
		name: name.slice(0, 200),
		message,
		...(isError && error.stack ? { stack: error.stack.slice(0, 8_000) } : {}),
		path: where.path.slice(0, 512) || '/',
		route: where.route,
		...(where.version ? { version: where.version.slice(0, 64) } : {})
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Send one error report; never throws. */
export function reportClientError(error: unknown, source: ClientErrorSource): void {
	try {
		if (sent >= MAX_REPORTS) return;
		const report = toReport(error, source, { path: location.pathname, ...context });
		if (!report) return;
		const key = `${report.name}\u0000${report.message}`;
		if (seen.has(key)) return;
		seen.add(key);
		sent += 1;
		const body = new Blob([JSON.stringify(report)], { type: 'application/json' });
		if (!navigator.sendBeacon?.(ENDPOINT, body)) {
			void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
		}
	} catch {
		// Reporting must never become a second failure.
	}
}

/** Listen for uncaught errors and unhandled rejections (once, at app start). */
export function startErrorReporting(): void {
	addEventListener('error', (event) => reportClientError(event.error ?? event.message, 'error'));
	addEventListener('unhandledrejection', (event) =>
		reportClientError(event.reason, 'unhandledrejection')
	);
}
