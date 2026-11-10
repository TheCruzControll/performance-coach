/**
 * The coach's usage view (PRD §12, §15): what GET /api/coach/runs answers, and the words the
 * usage sheet shows for it. Every cost is an estimate at domain/coach/pricing.ts's rates; a run
 * served by a model with no price is 'Not priced', never a guess. Loaded with the sheet only, so
 * none of it weighs on the Coach screen's initial JavaScript.
 */
import {
	formatCost,
	PRICING,
	RUN_STATUS_LABEL,
	type RunStatus,
	type TokenUsage
} from '#lib/domain/coach/index.ts';

/** The model the coach asks for, whose rates the caption states. */
export const PRICED_MODEL = 'claude-opus-5-5';

/** One run as the usage view lists it. */
export interface UsageRunView extends TokenUsage {
	id: string;
	startedAt: string;
	status: RunStatus;
	/** 'direct' for a lookup answered with no model call. */
	provider: string;
	/** The model that answered (a refusal fallback's when one did), else the one asked for. */
	model: string;
	stopReason: string | null;
	refusalCategory: string | null;
	modelCalls: number;
	toolCalls: number;
	/** Null when a model that ran has no price. */
	costMicros: number | null;
	latencyMs: number | null;
}

/** Every run's totals (services/coach/runs.ts usageSummary). */
export interface UsageTotals {
	runs: number;
	modelCalls: number;
	toolCalls: number;
	tokens: TokenUsage;
	/** The priced runs' cost; unpriced runs are counted in unpricedRuns instead. */
	costMicros: number;
	/** What the daily cap counted: unpriced runs at the highest known rate. */
	capCostMicros: number;
	unpricedRuns: number;
	cacheHitRatio: number | null;
	latencyMs: { p50: number | null; p95: number | null };
	statuses: Record<RunStatus, number>;
	tools: { name: string; calls: number }[];
}

/** A page of runs, newest first; the totals come with the first page only. */
export interface UsagePage {
	summary: UsageTotals | null;
	runs: UsageRunView[];
	nextBefore: string | null;
}

/** What 'Not priced' means, said wherever it shows. */
export const UNPRICED_CAPTION =
	'Not priced: a model with no known price answered. The daily cap counts it at the highest known rate.';

const dollars = (rate: number) => `$${rate < 1 ? rate.toFixed(2) : rate}`;

/** The rates every estimate uses: '$4 / $20 per MTok in and out, $0.20 cache reads, …'. */
export function pricingCaption(): string {
	const p = PRICING[PRICED_MODEL]!;
	return `Estimates at ${dollars(p.input)} / ${dollars(p.output)} per million tokens in and out, ${dollars(p.cacheRead)} for cache reads and ${dollars(p.cacheWrite5m)} for cache writes.`;
}

/** A cost, or 'Not priced' for a run whose model has no price. */
export const costWords = (micros: number | null): string =>
	micros === null ? 'Not priced' : formatCost(micros);

const STOP_REASON_LABEL: Record<string, string> = {
	end_turn: 'Finished',
	tool_use: 'Called tools',
	max_tokens: 'Hit the length limit',
	stop_sequence: 'Stop sequence',
	pause_turn: 'Paused',
	refusal: 'Declined',
	model_context_window_exceeded: 'Context full'
};

/**
 * Why the run's last model call stopped, its refusal category with it ('Declined · cyber'); a
 * lookup made none ('No model call'); an unknown reason is shown as stored.
 */
export function stopWords(run: Pick<UsageRunView, 'provider' | 'stopReason' | 'refusalCategory'>) {
	if (run.stopReason === null) return run.provider === 'direct' ? 'No model call' : '—';
	const reason = STOP_REASON_LABEL[run.stopReason] ?? run.stopReason;
	return run.refusalCategory ? `${reason} · ${run.refusalCategory}` : reason;
}

export const statusWords = (status: RunStatus): string => RUN_STATUS_LABEL[status] ?? status;

const count = new Intl.NumberFormat('en-US');

/** A token count: '12,400', or '1.2M' from a million. */
export function tokenWords(n: number): string {
	if (n < 1_000_000) return count.format(n);
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A latency: '840 ms', '2.4 s'; '—' before a run has one. */
export function latencyWords(ms: number | null): string {
	if (ms === null) return '—';
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A share of the prompt read from cache: '75%'; '—' before any prompt. */
export const ratioWords = (ratio: number | null): string =>
	ratio === null ? '—' : `${Math.round(ratio * 100)}%`;

/** The statuses runs ended in, most first, without the empty ones: 'Completed 3'. */
export function statusCounts(statuses: Record<RunStatus, number>) {
	return (Object.entries(statuses) as [RunStatus, number][])
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([status, n]) => ({ status, label: statusWords(status), runs: n }));
}
