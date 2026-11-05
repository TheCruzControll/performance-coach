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
 * - Each metric is attributed to the screen where it happened, not to the landing page: the
 *   root layout records every client-side navigation (`noteNavigation`), INP is attributed to
 *   the screen at the time of its interaction and CLS to the screen of its largest shift.
 *   Load metrics (TTFB, FCP, LCP) belong to the landing page.
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
	route: string | null;
	effectiveConnectionType?: string;
}

interface Visit {
	/** performance.now() when the screen was shown (0 for the landing page). */
	at: number;
	path: string;
	route: string | null;
}

const MAX_VISITS = 100;
let started = false;
const queue: VitalPayload[] = [];
const visits: Visit[] = [];

/**
 * Record the screen now shown. Called by the root layout's `afterNavigate` (with `at = 0` for
 * the landing page, so load metrics resolve to it).
 */
export function noteNavigation(path: string, route: string | null, at = performance.now()): void {
	visits.push({ at, path, route });
	// Keep the landing visit plus the most recent ones; a long session must not grow unbounded.
	if (visits.length > MAX_VISITS) visits.splice(1, visits.length - MAX_VISITS);
}

/** The screen that was showing at `time` (a performance.now() timestamp). */
function visitAt(time: number): Visit {
	for (let i = visits.length - 1; i >= 0; i--) {
		const visit = visits[i]!;
		if (visit.at <= time) return visit;
	}
	return visits[0] ?? { at: 0, path: location.pathname, route: null };
}

/** When the metric happened: the interaction (INP), the largest shift (CLS), else page load. */
function metricTime(metric: Pick<Metric, 'name' | 'entries'>): number {
	const entries = metric.entries as (PerformanceEntry & { value?: number })[];
	if (metric.name === 'INP') return entries[0]?.startTime ?? performance.now();
	if (metric.name === 'CLS' && entries.length > 0) {
		let largest = entries[0]!;
		for (const entry of entries) if ((entry.value ?? 0) > (largest.value ?? 0)) largest = entry;
		return largest.startTime;
	}
	return 0;
}

/** The screen a metric belongs to. */
export function attributeMetric(metric: Pick<Metric, 'name' | 'entries'>): Visit {
	return visitAt(metricTime(metric));
}

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

	const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
		.connection;
	const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import('web-vitals');

	const report = (metric: Metric) => {
		const { path, route } = attributeMetric(metric);
		queue.push({
			id: metric.id,
			name: metric.name,
			value: metric.value,
			delta: metric.delta,
			rating: metric.rating,
			navigationType: metric.navigationType,
			path,
			route,
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
