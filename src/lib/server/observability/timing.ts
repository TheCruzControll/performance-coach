import { currentContext, type RequestContext } from './context';
import { logger } from './logger';

/**
 * Measure an async operation and attribute its duration to `metric` in the current request's
 * Server-Timing header. Outside a request it simply runs `fn`.
 */
export async function measure<T>(metric: string, fn: () => Promise<T>): Promise<T> {
	const ctx = currentContext();
	if (!ctx) return fn();
	const start = performance.now();
	try {
		return await fn();
	} finally {
		const entry = ctx.timings.get(metric) ?? { dur: 0, count: 0 };
		entry.dur += performance.now() - start;
		entry.count += 1;
		ctx.timings.set(metric, entry);
	}
}

const TOKEN = /^[a-z0-9_-]+$/i;

/** Build a `Server-Timing` header value: `db;dur=1.2;desc="2 ops", total;dur=8.4`. */
export function serverTimingHeader(ctx: RequestContext, totalMs: number): string {
	const parts: string[] = [];
	for (const [name, { dur, count }] of ctx.timings) {
		if (!TOKEN.test(name)) continue;
		parts.push(`${name};dur=${dur.toFixed(1)};desc="${count} op${count === 1 ? '' : 's'}"`);
	}
	parts.push(`total;dur=${totalMs.toFixed(1)}`);
	return parts.join(', ');
}

/**
 * Server-Timing and the access log are written when the response *starts*. Work a load streams
 * afterwards (promises resolved into the page) is not in them, so log one line when it settles
 * with the request's full duration and its accumulated timings (db included).
 */
export function logWhenSettled(label: string, promises: Promise<unknown>[]): void {
	const ctx = currentContext();
	if (!ctx) return;
	void Promise.allSettled(promises).then((results) => {
		logger.info('streamed work settled', {
			label,
			durationMs: Math.round((performance.now() - ctx.startedAt) * 10) / 10,
			rejected: results.filter((r) => r.status === 'rejected').length,
			timings: Object.fromEntries(
				[...ctx.timings].map(([name, t]) => [
					name,
					{ durMs: Math.round(t.dur * 10) / 10, count: t.count }
				])
			)
		});
	});
}
