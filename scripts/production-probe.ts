/**
 * `node scripts/production-probe.ts [--origin URL] [--warm N]`: time to first byte and
 * Server-Timing of the deployed app from outside, cold and then warm, written to the log.
 *
 * Run on a schedule by .github/workflows/production-probe.yml (never in PR CI), hours apart, so
 * the first round follows a long idle period. It needs no credentials: signed out, so it sees
 * only what the public sees.
 * - `/today`: server-rendered by the function; signed out, the guard answers 303 to sign-in
 *   without touching the database, so this is the function's own start and render cost.
 * - `/workout`: prerendered, served from the CDN; no function, so no Server-Timing.
 * - `/api/health`: the function plus one real database round trip (`db` in Server-Timing), so a
 *   database waking from scale-to-zero shows here.
 *
 * Every request opens its own connection (no keep-alive), so each TTFB includes DNS, TCP and
 * TLS as a launch from a phone does; `waitMs` is the part after the request was sent. The
 * server reports `instance;desc="cold"` on a function process's first request (hooks.server.ts),
 * so "cold" in the output is the server's word, not a guess from the idle time.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ORIGIN = 'https://coach.nikocruz.com';
export const PATHS = ['/today', '/workout', '/api/health'] as const;
export const DEFAULT_WARM_ROUNDS = 5;
const TIMEOUT_MS = 20_000;

export interface ServerTimingMetric {
	name: string;
	dur?: number;
	desc?: string;
}

/** Parse a `Server-Timing` header value (RFC: metric;dur=1.2;desc="x", …). */
export function parseServerTiming(header: string | null | undefined): ServerTimingMetric[] {
	if (!header) return [];
	const metrics: ServerTimingMetric[] = [];
	for (const part of header.split(',')) {
		const [name, ...params] = part.split(';').map((s) => s.trim());
		if (!name) continue;
		const metric: ServerTimingMetric = { name };
		for (const param of params) {
			const eq = param.indexOf('=');
			if (eq < 0) continue;
			const key = param.slice(0, eq).trim().toLowerCase();
			const value = param
				.slice(eq + 1)
				.trim()
				.replace(/^"(.*)"$/, '$1');
			if (key === 'dur' && Number.isFinite(Number(value))) metric.dur = Number(value);
			if (key === 'desc') metric.desc = value;
		}
		metrics.push(metric);
	}
	return metrics;
}

export interface Sample {
	path: string;
	round: 'cold' | 'warm';
	status: number;
	/** Request start to the first response byte, connection setup included. */
	ttfbMs: number;
	/** Request sent (connection ready) to the first response byte. */
	waitMs: number;
	/** Server-Timing `total` (the function's own time), when the function answered. */
	serverTotalMs?: number;
	/** Server-Timing `db`. */
	dbMs?: number;
	/** The server's own flag (instance.ts); absent for prerendered files. */
	instance?: string;
	/** Vercel's `x-vercel-id` (edge::function region and request id): who answered. */
	vercelId?: string;
	/** Vercel's `x-vercel-cache` (HIT for a CDN file). */
	cache?: string;
	error?: string;
}

/** One GET on a fresh connection, timed. Never throws: a failure is a sample with `error`. */
export function timeRequest(url: URL, round: Sample['round']): Promise<Sample> {
	const client = url.protocol === 'https:' ? https : http;
	const started = performance.now();
	let sentAt = started;
	return new Promise((resolve) => {
		const base = { path: url.pathname, round, status: 0, ttfbMs: 0, waitMs: 0 };
		const req = client.request(
			url,
			{
				method: 'GET',
				agent: false,
				headers: { 'user-agent': 'performance-coach-probe', accept: 'text/html,*/*' },
				timeout: TIMEOUT_MS
			},
			(res) => {
				const firstByte = performance.now();
				res.resume(); // the body is not measured; drain it so the socket closes
				const header = (name: string) => {
					const value = res.headers[name];
					return Array.isArray(value) ? value.join(', ') : value;
				};
				const timing = parseServerTiming(header('server-timing'));
				const metric = (name: string) => timing.find((m) => m.name === name);
				resolve({
					...base,
					status: res.statusCode ?? 0,
					ttfbMs: round1(firstByte - started),
					waitMs: round1(firstByte - sentAt),
					serverTotalMs: metric('total')?.dur,
					dbMs: metric('db')?.dur,
					instance: metric('instance')?.desc,
					vercelId: header('x-vercel-id'),
					cache: header('x-vercel-cache')
				});
			}
		);
		// The connection is ready (DNS, TCP, and TLS for https): the request goes out now.
		req.on('socket', (socket) => {
			socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
				sentAt = performance.now();
			});
		});
		req.on('timeout', () => req.destroy(new Error(`no response in ${TIMEOUT_MS} ms`)));
		req.on('error', (error) => resolve({ ...base, error: error.message }));
		req.end();
	});
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A cold round (each path once, /today first, so it meets the function first), then warm ones. */
export async function probe(
	origin: string,
	warmRounds = DEFAULT_WARM_ROUNDS,
	request: typeof timeRequest = timeRequest
): Promise<Sample[]> {
	const samples: Sample[] = [];
	// One request at a time: concurrent ones would start several function instances.
	for (const p of PATHS) samples.push(await request(new URL(p, origin), 'cold'));
	for (let i = 0; i < warmRounds; i++) {
		for (const p of PATHS) samples.push(await request(new URL(p, origin), 'warm'));
	}
	return samples;
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const ms = (n: number | undefined) => (n === undefined ? '-' : `${n} ms`);

/** The table written to the log and the job summary: the cold sample, then warm medians. */
export function summarise(origin: string, samples: Sample[]): string {
	const lines = [
		`Production probe of ${origin}`,
		'',
		'| Path | Round | Status | TTFB | Wait | Server total | DB | Instance | Answered by |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const p of PATHS) {
		const cold = samples.find((s) => s.path === p && s.round === 'cold');
		if (cold) lines.push(row(p, 'first (after idle)', cold));
		const warm = samples.filter((s) => s.path === p && s.round === 'warm' && !s.error);
		if (warm.length === 0) continue;
		const of = (pick: (s: Sample) => number | undefined) =>
			median(warm.map(pick).filter((v): v is number => v !== undefined));
		const instances = [...new Set(warm.map((s) => s.instance).filter(Boolean))].join('/');
		lines.push(
			`| ${p} | warm (median of ${warm.length}) | ${warm[warm.length - 1]!.status} | ` +
				`${ms(of((s) => s.ttfbMs))} | ${ms(of((s) => s.waitMs))} | ` +
				`${ms(of((s) => s.serverTotalMs))} | ${ms(of((s) => s.dbMs))} | ${instances || '-'} | ` +
				`${answeredBy(warm[warm.length - 1]!)} |`
		);
	}
	const failed = samples.filter((s) => s.error);
	if (failed.length > 0) {
		lines.push('', ...failed.map((s) => `FAILED ${s.round} ${s.path}: ${s.error}`));
	}
	return lines.join('\n');
}

function row(p: string, round: string, s: Sample): string {
	if (s.error) return `| ${p} | ${round} | failed | - | - | - | - | - | ${s.error} |`;
	return (
		`| ${p} | ${round} | ${s.status} | ${ms(s.ttfbMs)} | ${ms(s.waitMs)} | ` +
		`${ms(s.serverTotalMs)} | ${ms(s.dbMs)} | ${s.instance ?? '-'} | ${answeredBy(s)} |`
	);
}

/** Vercel's region pair (e.g. `sfo1::pdx1`) without the request id, and the CDN cache state. */
function answeredBy(s: Sample): string {
	const regions = s.vercelId?.split('::').slice(0, -1).join('::');
	return [regions, s.cache && `cache ${s.cache}`].filter(Boolean).join(', ') || '-';
}

export function parseArgs(argv: string[]): { origin: string; warmRounds: number } {
	let origin = process.env.PROBE_ORIGIN || DEFAULT_ORIGIN;
	let warmRounds = DEFAULT_WARM_ROUNDS;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--origin') origin = argv[++i] ?? origin;
		else if (argv[i] === '--warm') warmRounds = Number(argv[++i]);
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (!Number.isInteger(warmRounds) || warmRounds < 1 || warmRounds > 50) {
		throw new Error('--warm takes a whole number from 1 to 50');
	}
	return { origin: new URL(origin).origin, warmRounds };
}

async function main(): Promise<void> {
	const { origin, warmRounds } = parseArgs(process.argv.slice(2));
	const samples = await probe(origin, warmRounds);
	const table = summarise(origin, samples);
	console.log(table);
	// One machine-readable line, for comparing runs from their logs.
	console.log(`PROBE_JSON ${JSON.stringify({ origin, at: new Date().toISOString(), samples })}`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const { appendFileSync } = await import('node:fs');
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${table}\n`);
	}
	// Slowness is reported, never failed on (no threshold here); an unreachable path fails.
	if (samples.some((s) => s.error || s.status >= 500)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
