import { count, desc, gte, sql } from 'drizzle-orm';
import { webVitals, type WebVitalName } from '../schema';
import type { Executor } from '../types';

export type WebVitalRow = typeof webVitals.$inferSelect;
export type NewWebVital = typeof webVitals.$inferInsert;

export interface VitalSummaryRow {
	name: WebVitalName;
	p75: number;
	samples: number;
}

export function createWebVitalsRepository(db: Executor) {
	return {
		/**
		 * Insert metrics, de-duplicating on (metric_id, name): web-vitals may re-report a metric
		 * instance (e.g. CLS/INP growing until the page is hidden); the latest report wins,
		 * including where it happened (the worst interaction may move to another screen).
		 */
		async upsertMany(rows: NewWebVital[]): Promise<number> {
			if (rows.length === 0) return 0;
			const written = await db
				.insert(webVitals)
				.values(rows)
				.onConflictDoUpdate({
					target: [webVitals.metricId, webVitals.name],
					set: {
						value: sql`excluded.value`,
						delta: sql`excluded.delta`,
						rating: sql`excluded.rating`,
						path: sql`excluded.path`,
						routeId: sql`excluded.route_id`,
						recordedAt: sql`now()`
					}
				})
				.returning({ id: webVitals.id });
			return written.length;
		},

		/** 75th percentile per metric since `since` (Core Web Vitals are assessed at p75). */
		async p75Since(since: Date): Promise<VitalSummaryRow[]> {
			const rows = await db
				.select({
					name: webVitals.name,
					p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`,
					samples: count()
				})
				.from(webVitals)
				.where(gte(webVitals.recordedAt, since))
				.groupBy(webVitals.name);
			return rows.map((row) => ({ ...row, p75: Number(row.p75), samples: Number(row.samples) }));
		},

		async recent(limit = 50): Promise<WebVitalRow[]> {
			return db.select().from(webVitals).orderBy(desc(webVitals.recordedAt)).limit(limit);
		}
	};
}
