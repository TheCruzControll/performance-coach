/**
 * Whether the live coach suite runs, and against what (tests/live/coach.live.test.ts):
 * - live: LIVE_LLM=1 and a non-empty ANTHROPIC_API_KEY. Real calls to claude-opus-5-5, billed.
 * - dry: LIVE_LLM_DRY=1 (and not live). The same six conversations against the MockProvider, to
 *   check the suite itself without a key or a bill.
 * - off: anything else. Every test is skipped and the test database is left alone.
 *
 * CI never sets either flag and never runs the `live` project (scripts/vite-config.test.ts).
 */
export type LiveMode = 'live' | 'dry' | 'off';

export function liveMode(env: Readonly<Record<string, string | undefined>>): LiveMode {
	if (env.LIVE_LLM === '1' && env.ANTHROPIC_API_KEY?.trim()) return 'live';
	if (env.LIVE_LLM_DRY === '1') return 'dry';
	return 'off';
}

/**
 * Decision (owner can change it): the most one run of the suite may spend, in micro-dollars,
 * summed from every run's cap_cost_micros. Over it, the suite fails.
 */
export const LIVE_COST_CAP_MICROS = 1_000_000;
