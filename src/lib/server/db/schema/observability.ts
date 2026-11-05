/**
 * Operational tables (M1): server error records and real-user Web Vitals.
 * Product tables (profile, goals, programs, workouts, ...) arrive from M2/M3 in sibling files.
 */
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'TTFB', 'FCP'] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type WebVitalRating = (typeof WEB_VITAL_RATINGS)[number];

export const appErrors = pgTable(
	'app_errors',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		/** Correlates with the `x-request-id` response header and JSON log lines. */
		requestId: text('request_id'),
		/**
		 * unknown | framework | app | validation (SvelteKit's error kind), `streamed` (a load's
		 * streamed promise failed) or `client` (reported by the browser; status is null).
		 */
		kind: text('kind').notNull(),
		status: integer('status'),
		method: text('method'),
		path: text('path'),
		routeId: text('route_id'),
		message: text('message').notNull(),
		stack: text('stack'),
		appVersion: text('app_version'),
		context: jsonb('context').$type<Record<string, unknown>>()
	},
	(t) => [
		index('app_errors_occurred_at_idx').on(t.occurredAt.desc()),
		index('app_errors_request_id_idx').on(t.requestId)
	]
);

export const webVitals = pgTable(
	'web_vitals',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
		/** web-vitals' unique id for this metric instance; used to de-duplicate re-reports. */
		metricId: text('metric_id').notNull(),
		name: text('name').$type<WebVitalName>().notNull(),
		value: doublePrecision('value').notNull(),
		delta: doublePrecision('delta'),
		rating: text('rating').$type<WebVitalRating>().notNull(),
		navigationType: text('navigation_type'),
		/** Pathname where the metric happened (INP/CLS: at the interaction/shift; others: landing). */
		path: text('path').notNull(),
		/** SvelteKit route id for that path, e.g. `/(app)/train`: groups dynamic URLs per screen. */
		routeId: text('route_id'),
		appVersion: text('app_version'),
		effectiveConnectionType: text('effective_connection_type'),
		userAgent: text('user_agent')
	},
	(t) => [
		uniqueIndex('web_vitals_metric_uq').on(t.metricId, t.name),
		index('web_vitals_name_recorded_at_idx').on(t.name, t.recordedAt.desc()),
		index('web_vitals_route_name_idx').on(t.routeId, t.name, t.recordedAt.desc()),
		check(
			'web_vitals_name_ck',
			sql.raw(`${t.name.name} in (${WEB_VITAL_NAMES.map((n) => `'${n}'`).join(', ')})`)
		),
		check(
			'web_vitals_rating_ck',
			sql.raw(`${t.rating.name} in (${WEB_VITAL_RATINGS.map((n) => `'${n}'`).join(', ')})`)
		),
		check('web_vitals_value_ck', sql`${t.value} >= 0`)
	]
);
