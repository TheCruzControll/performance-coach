/**
 * Real-user monitoring: report Core Web Vitals (LCP, INP, CLS) plus TTFB and FCP to
 * POST /api/vitals. 100% sampled (single user).
 *
 * - This module and `web-vitals` are loaded lazily after hydration, so neither sits on the
 *   critical path; the observers use buffered performance entries, so nothing is missed.
 * - Metrics are batched and flushed with `navigator.sendBeacon` when the page is hidden
 *   (the only reliable moment on iOS Safari), falling back to `fetch(..., { keepalive })`.
 * - The Blob is typed application/json: same-origin, no CORS preflight, and not a "form"
 *   content type, so SvelteKit's CSRF origin check does not apply.
 * - Each metric is attributed to the screen where it happened, not to the landing page: the
 *   root layout records every client-side navigation (`noteNavigation` in visits.ts), INP is
 *   attributed to the screen at the time of its interaction and CLS to the screen of its
 *   largest shift. Load metrics (TTFB, FCP, LCP) belong to the landing page.
 */
import type { Metric } from 'web-vitals';
import { visitAt, type Visit } from './visits.ts';

const ENDPOINT = '/api/vitals';
const MAX_BATCH = 20;

export interface VitalPayload {
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

let started = false;
const queue: VitalPayload[] = [];

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

/**
 * Queue a report, replacing any still-queued one of the same metric: INP and CLS re-report as they
 * grow, and only the latest value (and the screen it belongs to) should leave the page.
 */
export function enqueue(queue: VitalPayload[], vital: VitalPayload): void {
	const queued = queue.findIndex((q) => q.id === vital.id);
	if (queued >= 0) queue[queued] = vital;
	else queue.push(vital);
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
		enqueue(queue, {
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
	// Queued as it changes, so the first beacon at hide carries it: the one sent after web-vitals'
	// own work at hide sometimes never left a page being navigated away (perf-workout.e2e.ts).
	onINP(report, { reportAllChanges: true });
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
