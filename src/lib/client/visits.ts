/**
 * The screens shown in this page, for RUM attribution (vitals.ts). The root layout records each
 * one as it is shown, so this part of RUM is in every page's initial JS; the rest of vitals.ts
 * loads once the page is idle.
 */
export interface Visit {
	/** performance.now() when the screen was shown (0 for the landing page). */
	at: number;
	path: string;
	route: string | null;
}

const MAX_VISITS = 100;
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
export function visitAt(time: number): Visit {
	for (let i = visits.length - 1; i >= 0; i--) {
		const visit = visits[i]!;
		if (visit.at <= time) return visit;
	}
	return visits[0] ?? { at: 0, path: location.pathname, route: null };
}
