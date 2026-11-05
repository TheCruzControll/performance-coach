/**
 * Real-user monitoring (RUM) use-cases: ingest Core Web Vitals reported by the browser and
 * summarise them at p75 (the percentile Core Web Vitals are assessed at).
 */
import { z } from 'zod';
import {
	createWebVitalsRepository,
	getDb,
	WEB_VITAL_NAMES,
	WEB_VITAL_RATINGS,
	type Executor,
	type NewWebVital,
	type VitalSummaryRow
} from '../db';
import { measure } from '../observability/timing';

export const MAX_VITALS_PER_REQUEST = 20;

export const vitalSchema = z.object({
	id: z.string().min(1).max(128),
	name: z.enum(WEB_VITAL_NAMES),
	value: z.number().finite().min(0).max(600_000),
	delta: z.number().finite().optional(),
	rating: z.enum(WEB_VITAL_RATINGS),
	navigationType: z.string().max(32).optional(),
	path: z
		.string()
		.max(512)
		.refine((p) => p.startsWith('/'), 'path must be absolute'),
	/** SvelteKit route id where the metric happened (null for an unmatched route). */
	route: z
		.string()
		.max(256)
		.refine((r) => r.startsWith('/'), 'route must be a route id')
		.nullish(),
	effectiveConnectionType: z.string().max(16).optional()
});

export type VitalInput = z.input<typeof vitalSchema>;

export interface VitalsMeta {
	appVersion?: string;
	userAgent?: string | null;
}

export class InvalidVitalsError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super('invalid web-vitals payload');
		this.name = 'InvalidVitalsError';
		this.issues = issues;
	}
}

/** Validate and store a payload (one metric or a batch). Returns the number of rows written. */
export async function recordVitals(
	payload: unknown,
	meta: VitalsMeta = {},
	deps: { db?: Executor } = {}
): Promise<number> {
	// Parse each shape with its own schema: a union would collapse field errors on a single
	// metric into an uninformative "(root): Invalid input".
	const parsed = Array.isArray(payload)
		? z.array(vitalSchema).min(1).max(MAX_VITALS_PER_REQUEST).safeParse(payload)
		: vitalSchema.transform((v) => [v]).safeParse(payload);
	if (!parsed.success) {
		throw new InvalidVitalsError(
			parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
		);
	}
	// A batch may repeat a metric instance (web-vitals re-reports CLS/INP as they grow). One
	// INSERT ... ON CONFLICT cannot touch the same row twice, so keep only the last report.
	const latest = new Map<string, (typeof parsed.data)[number]>();
	for (const v of parsed.data) {
		const key = `${v.id}\u0000${v.name}`;
		latest.delete(key);
		latest.set(key, v);
	}
	const rows: NewWebVital[] = [...latest.values()].map((v) => ({
		metricId: v.id,
		name: v.name,
		value: v.value,
		delta: v.delta ?? null,
		rating: v.rating,
		navigationType: v.navigationType ?? null,
		path: v.path,
		routeId: v.route ?? null,
		effectiveConnectionType: v.effectiveConnectionType ?? null,
		appVersion: meta.appVersion ?? null,
		userAgent: meta.userAgent?.slice(0, 512) ?? null
	}));
	const repo = createWebVitalsRepository(deps.db ?? getDb());
	return measure('db', () => repo.upsertMany(rows));
}

export async function getVitalsSummary(
	days = 7,
	deps: { db?: Executor; now?: Date } = {}
): Promise<VitalSummaryRow[]> {
	const since = new Date((deps.now ?? new Date()).getTime() - days * 86_400_000);
	const repo = createWebVitalsRepository(deps.db ?? getDb());
	const rows = await measure('db', () => repo.p75Since(since));
	const order = new Map(WEB_VITAL_NAMES.map((name, i) => [name, i]));
	return rows.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
}
