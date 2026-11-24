/**
 * The shape of the real-user vitals summary (src/lib/server/services/vitals.ts), here so the
 * screens can read it: the UI layer may not import from the server, not even a type. Types only.
 */

/** The web vitals the app records (WEB_VITAL_NAMES in src/lib/server/db/schema/observability.ts). */
export type VitalName = 'LCP' | 'INP' | 'CLS' | 'TTFB' | 'FCP';

/** One vital at p75 over a window, and on the start route alone where it is a start metric. */
export interface VitalSummary {
	name: VitalName;
	p75: number;
	samples: number;
	/** p75 on the start route alone, for START_METRICS; null otherwise or without samples. */
	start: { p75: number; samples: number } | null;
}
