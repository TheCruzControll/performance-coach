import { describe, expect, it } from 'vitest';
import { verdictDecided, type RunScores, type Thresholds } from './lighthouse-verdict.ts';

/** CI's thresholds: --min-perf 0.9, --max-tbt 300 and the LCP and CLS defaults. */
const CI: Thresholds = { performance: 0.9, lcpMs: 2500, cls: 0.1, tbtMs: 300 };
const GOOD: RunScores = { performance: 0.98, lcp: 900, cls: 0, tbt: 80 };
const SLOW_TBT: RunScores = { ...GOOD, performance: 0.85, tbt: 420 };

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** What --assert decides from the medians of every run: true when every threshold is met. */
const medianVerdict = (runs: RunScores[], t: Thresholds) =>
	median(runs.map((r) => r.performance)) >= t.performance &&
	median(runs.map((r) => r.lcp)) <= t.lcpMs &&
	median(runs.map((r) => r.cls)) <= t.cls &&
	median(runs.map((r) => r.tbt)) <= t.tbtMs;

/** Every sequence of `length` runs drawn from `choices`. */
function* sequences(choices: RunScores[], length: number): Generator<RunScores[]> {
	if (length === 0) return yield [];
	for (const head of sequences(choices, length - 1)) {
		for (const choice of choices) yield [...head, choice];
	}
}

describe('verdictDecided', () => {
	it('stops a route of 5 after 3 runs that all meet every threshold', () => {
		expect(verdictDecided([GOOD, GOOD], 5, CI)).toBe(false);
		expect(verdictDecided([GOOD, GOOD, GOOD], 5, CI)).toBe(true);
	});

	it('stops after 3 runs that all miss the same threshold', () => {
		expect(verdictDecided([SLOW_TBT, SLOW_TBT, SLOW_TBT], 5, CI)).toBe(true);
	});

	it('keeps going while any one threshold is still open', () => {
		// Performance and TBT are 2–1 after 3 runs; LCP and CLS are decided.
		expect(verdictDecided([GOOD, SLOW_TBT, GOOD], 5, CI)).toBe(false);
		expect(verdictDecided([GOOD, SLOW_TBT, GOOD, GOOD], 5, CI)).toBe(true);
		expect(verdictDecided([GOOD, SLOW_TBT, GOOD, SLOW_TBT], 5, CI)).toBe(false);
		// Only LCP is open: 2 passes and 1 miss.
		const slowLcp = { ...GOOD, lcp: 2600 };
		expect(verdictDecided([GOOD, slowLcp, GOOD], 5, CI)).toBe(false);
	});

	it('counts a run exactly at a threshold as meeting it, as the median check does', () => {
		const edge: RunScores = { performance: 0.9, lcp: 2500, cls: 0.1, tbt: 300 };
		expect(verdictDecided([edge, edge, edge], 5, CI)).toBe(true);
		expect(medianVerdict([edge, edge, edge, SLOW_TBT, SLOW_TBT], CI)).toBe(true);
	});

	it('needs a strict majority for an even run count, whose median averages two runs', () => {
		expect(verdictDecided([GOOD, GOOD], 4, CI)).toBe(false);
		expect(verdictDecided([GOOD, GOOD, GOOD], 4, CI)).toBe(true);
	});

	it('never stops on a run with a missing metric, whose median would be order-dependent', () => {
		expect(verdictDecided([GOOD, GOOD, { ...GOOD, tbt: Number.NaN }], 5, CI)).toBe(false);
		expect(verdictDecided([GOOD, GOOD, { ...GOOD, tbt: Number.NaN }, GOOD], 5, CI)).toBe(false);
	});

	it("decides on the asserted metrics alone when passed the script's per-run summaries", () => {
		// scripts/lighthouse.ts passes its Summary rows: a route string and unasserted metrics too.
		const row = { route: '/today', runs: 1, accessibility: 1, bestPractices: 1, fcp: NaN, si: NaN };
		const rows = [0, 1, 2].map(() => ({ ...row, ...GOOD }));
		expect(verdictDecided(rows, 5, CI)).toBe(true);
	});

	it('only ever stops when no remaining run could change the median verdict', () => {
		// Runs on either side of every threshold, and exactly on it, one metric at a time.
		const choices: RunScores[] = [
			GOOD,
			{ ...GOOD, performance: 0.9 },
			{ ...GOOD, performance: 0.89 },
			{ ...GOOD, lcp: 2501 },
			{ ...GOOD, cls: 0.11 },
			{ ...GOOD, tbt: 301 },
			SLOW_TBT
		];
		let stops = 0;
		for (const planned of [3, 4, 5]) {
			for (const full of sequences(choices, planned)) {
				const verdict = medianVerdict(full, CI);
				for (let done = 1; done < planned; done++) {
					const prefix = full.slice(0, done);
					if (!verdictDecided(prefix, planned, CI)) continue;
					stops++;
					// The median of the runs done, which --assert checks after a stop, agrees too.
					expect(medianVerdict(prefix, CI)).toBe(verdict);
					// Every other ending of the same prefix reaches this full run's verdict.
					for (const rest of sequences(
						[GOOD, SLOW_TBT, { ...GOOD, lcp: 4000, cls: 0.3 }],
						planned - done
					)) {
						expect(medianVerdict([...prefix, ...rest], CI)).toBe(verdict);
					}
				}
			}
		}
		expect(stops).toBeGreaterThan(0);
	});
});
