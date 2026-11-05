import { currentContext, type RequestContext } from './context';

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
