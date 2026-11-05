/**
 * Real-user monitoring: report Core Web Vitals (LCP, INP, CLS) plus TTFB and FCP to
 * POST /api/vitals. 100% sampled (single user).
 *
 * - `web-vitals` is loaded lazily after hydration, so it never sits on the critical path;
 *   its observers use buffered performance entries, so nothing is missed.
 * - Metrics are batched and flushed with `navigator.sendBeacon` when the page is hidden
 *   (the only reliable moment on iOS Safari), falling back to `fetch(..., { keepalive })`.
 * - The Blob is typed application/json: same-origin, no CORS preflight, and not a "form"
 *   content type, so SvelteKit's CSRF origin check does not apply.
 */
import type { Metric } from 'web-vitals';

const ENDPOINT = '/api/vitals';
const MAX_BATCH = 20;

interface VitalPayload {
	id: string;
	name: Metric['name'];
	value: number;
	delta: number;
	rating: Metric['rating'];
	navigationType: string;
	path: string;
	effectiveConnectionType?: string;
}

let started = false;
const queue: VitalPayload[] = [];

function send(batch: VitalPayload[]): void {
	const body = JSON.stringify(batch);
	const queued =
		typeof navigator.sendBeacon === 'function' &&
		navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
	if (!queued) {
		void fetch(ENDPOINT, {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/json' },
			keepalive: true
		}).catch(() => {});
	}
}

export function flushVitals(): void {
	while (queue.length > 0) send(queue.splice(0, MAX_BATCH));
}

export async function startVitalsReporting(): Promise<void> {
	if (started || typeof window === 'undefined') return;
	started = true;

	const path = location.pathname;
	const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
		.connection;
	const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import('web-vitals');

	const report = (metric: Metric) => {
		queue.push({
			id: metric.id,
			name: metric.name,
			value: metric.value,
			delta: metric.delta,
			rating: metric.rating,
			navigationType: metric.navigationType,
			path,
			effectiveConnectionType: connection?.effectiveType
		});
		if (queue.length >= MAX_BATCH) flushVitals();
	};

	onCLS(report);
	onINP(report);
	onLCP(report);
	onFCP(report);
	onTTFB(report);

	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushVitals();
	});
	addEventListener('pagehide', flushVitals);
	// Observable marker for tests and debugging: RUM observers are registered.
	document.documentElement.dataset.rum = 'ready';
}
