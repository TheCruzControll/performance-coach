/**
 * When scripts/lighthouse.ts --assert may stop auditing a route early. --assert compares each
 * asserted metric's median over the planned runs with its threshold, and a median meets a
 * threshold exactly when a strict majority of the runs do (for an odd count; for an even count
 * the median averages two runs, so a strict majority is still what decides it). Once every
 * threshold has that majority of passes or of misses, no remaining run can change the verdict,
 * so they are skipped.
 */

/** The thresholds --assert checks (performance ≥, LCP ≤, CLS ≤, TBT ≤). */
export interface Thresholds {
	performance: number;
	lcpMs: number;
	cls: number;
	tbtMs: number;
}

/** One run's asserted metrics. */
export interface RunScores {
	performance: number;
	lcp: number;
	cls: number;
	tbt: number;
}

/** Each threshold's check on one run, written as --assert writes its check on the median. */
const CHECKS: ((run: RunScores, t: Thresholds) => boolean)[] = [
	(run, t) => !(run.performance < t.performance),
	(run, t) => !(run.lcp > t.lcpMs),
	(run, t) => !(run.cls > t.cls),
	(run, t) => !(run.tbt > t.tbtMs)
];

/**
 * True when the runs so far decide the median-of-`planned` verdict for every threshold: each has
 * at least ⌊planned / 2⌋ + 1 passes or that many misses (3 of 5, 2 of 3). A run with a missing
 * metric (NaN) never lets the route stop, since a median over NaN depends on the run order.
 */
export function verdictDecided(
	done: RunScores[],
	planned: number,
	thresholds: Thresholds
): boolean {
	if (done.some((r) => ![r.performance, r.lcp, r.cls, r.tbt].every(Number.isFinite))) return false;
	const majority = Math.floor(planned / 2) + 1;
	return CHECKS.every((check) => {
		const passes = done.filter((run) => check(run, thresholds)).length;
		return passes >= majority || done.length - passes >= majority;
	});
}
