<!--
  @component
  The coach's usage (owner-only diagnostics, PRD §12, §15), read from stored runs through
  GET /api/coach/runs each time the sheet opens: the totals (an estimated cost, runs, tokens with
  cache reads and writes, latency, tools), how runs ended, each tool's calls, then every run newest
  first, as cards on a phone and a table on a wide sheet. Costs are estimates at the caption's
  rates; a run whose model has no price is 'Not priced'. Loading rows while it loads; a failed
  read offers Retry; with no run yet, 'No coach runs yet'. UsageButton fetches this on intent.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { formatCost } from '#lib/domain/coach/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import {
		costWords,
		latencyWords,
		pricingCaption,
		ratioWords,
		statusCounts,
		statusWords,
		stopWords,
		tokenWords,
		UNPRICED_CAPTION,
		type UsagePage,
		type UsageRunView,
		type UsageTotals
	} from './usage';

	let { open = $bindable() }: { open: boolean } = $props();

	let phase = $state<'loading' | 'failed' | 'ready'>('loading');
	let summary = $state.raw<UsageTotals | null>(null);
	let runs = $state.raw<UsageRunView[]>([]);
	let next = $state<string | null>(null);
	let older = $state<'idle' | 'loading' | 'failed'>('idle');

	async function page(before?: string): Promise<UsagePage> {
		const response = await fetch(`/api/coach/runs${before ? `?before=${before}` : ''}`);
		if (!response.ok) throw new Error(`usage ${response.status}`);
		return response.json();
	}

	async function load() {
		phase = 'loading';
		older = 'idle';
		try {
			const first = await page();
			summary = first.summary;
			runs = first.runs;
			next = first.nextBefore;
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	async function showOlder() {
		if (next === null || older === 'loading') return;
		older = 'loading';
		try {
			const more = await page(next);
			runs = [...runs, ...more.runs];
			next = more.nextBefore;
			older = 'idle';
		} catch {
			older = 'failed';
		}
	}

	// Read afresh on every open: a turn since the last one has added a run.
	$effect(() => {
		if (open) untrack(load);
	});

	const started = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const when = (run: UsageRunView) => started.format(new Date(run.startedAt));
	const plural = (n: number, one: string) => `${tokenWords(n)} ${one}${n === 1 ? '' : 's'}`;
</script>

<BottomSheet
	bind:open
	wide
	title="Coach usage"
	description="Estimated from the coach’s stored runs."
	data-testid="usage-sheet"
>
	<div class="usage">
		{#if phase === 'loading'}
			<LoadingRows label="Loading usage…" data-testid="usage-loading" />
		{:else if phase === 'failed'}
			<Notice tone="danger" icon="alert" title="Couldn’t load usage" data-testid="usage-failed">
				<p>Check your connection, then try again.</p>
				<div class="action">
					<Button variant="secondary" size="sm" icon="refresh" onclick={load}>Try again</Button>
				</div>
			</Notice>
		{:else if !summary || summary.runs === 0}
			<EmptyState
				compact
				icon="pulse"
				tone="neutral"
				title="No coach runs yet"
				description="Ask the coach something, and what each answer used and cost shows here."
				data-testid="usage-empty"
			/>
		{:else}
			<ul class="stats" data-testid="usage-totals">
				<Stat
					as="li"
					level={2}
					label="Estimated cost"
					value={formatCost(summary.costMicros)}
					caption={summary.unpricedRuns > 0
						? `${plural(summary.unpricedRuns, 'run')} not priced`
						: undefined}
					data-testid="usage-total-cost"
				/>
				<Stat
					as="li"
					level={2}
					label="Runs"
					value={tokenWords(summary.runs)}
					caption={plural(summary.modelCalls, 'model call')}
				/>
				<Stat
					as="li"
					level={2}
					label="Tokens in"
					value={tokenWords(summary.tokens.inputTokens)}
					caption={`${tokenWords(summary.tokens.outputTokens)} out`}
				/>
				<Stat
					as="li"
					level={2}
					label="Cache reads"
					value={tokenWords(summary.tokens.cacheReadTokens)}
					caption={`${tokenWords(summary.tokens.cacheWriteTokens)} written · ${ratioWords(summary.cacheHitRatio)} of prompts`}
				/>
				<Stat
					as="li"
					level={2}
					label="Latency, median"
					value={latencyWords(summary.latencyMs.p50)}
					caption={`${latencyWords(summary.latencyMs.p95)} at p95`}
				/>
				<Stat
					as="li"
					level={2}
					label="Tool calls"
					value={tokenWords(summary.toolCalls)}
					caption={plural(summary.tools.length, 'tool')}
				/>
			</ul>
			<p class="caption">{pricingCaption()}</p>
			{#if summary.unpricedRuns > 0}
				<p class="caption" data-testid="usage-unpriced">
					{UNPRICED_CAPTION} It counted {formatCost(summary.capCostMicros)} in all.
				</p>
			{/if}

			<div class="lists">
				<Section title="How runs ended" gap="sm">
					<ul class="counts" data-testid="usage-statuses">
						{#each statusCounts(summary.statuses) as each (each.status)}
							<li><span>{each.label}</span><span class="tabular">{each.runs}</span></li>
						{/each}
					</ul>
				</Section>
				<Section title="Tools" gap="sm">
					<ul class="counts" data-testid="usage-tools">
						{#each summary.tools as tool (tool.name)}
							<li>
								<span class="name">{tool.name}</span><span class="tabular">{tool.calls}</span>
							</li>
						{:else}
							<li class="none">No tool called yet</li>
						{/each}
					</ul>
				</Section>
			</div>

			<Section title="Runs" gap="sm">
				<!-- A tab stop in the sheet's scrolling body, as the table is on a wide sheet: the arrow
				     keys scroll the runs on a phone with a keyboard. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul class="cards" aria-label="Runs" tabindex="0" data-testid="usage-run-cards">
					{#each runs as run (run.id)}
						<li class="card" data-testid="usage-run">
							<div class="line">
								<span class="strong">{when(run)}</span>
								<span class="strong tabular" data-testid="usage-run-cost">
									{costWords(run.costMicros)}
								</span>
							</div>
							<div class="line secondary">
								<span>{statusWords(run.status)} · {stopWords(run)}</span>
								<span class="tabular">{latencyWords(run.latencyMs)}</span>
							</div>
							<div class="line secondary tabular">
								{tokenWords(run.inputTokens)} in · {tokenWords(run.outputTokens)} out · cache
								{tokenWords(run.cacheReadTokens)} read, {tokenWords(run.cacheWriteTokens)} written
							</div>
							<div class="line secondary">
								<span>{plural(run.toolCalls, 'tool call')}</span><span class="name"
									>{run.model}</span
								>
							</div>
						</li>
					{/each}
				</ul>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table" role="region" aria-label="Runs, table" tabindex="0">
					<table data-testid="usage-run-table">
						<thead>
							<tr>
								<th scope="col">Started</th>
								<th scope="col">Status</th>
								<th scope="col" class="num">In</th>
								<th scope="col" class="num">Out</th>
								<th scope="col" class="num">Cache read</th>
								<th scope="col" class="num">Cache write</th>
								<th scope="col" class="num">Latency</th>
								<th scope="col" class="num">Tools</th>
								<th scope="col" class="num">Cost</th>
							</tr>
						</thead>
						<tbody>
							{#each runs as run (run.id)}
								<tr data-testid="usage-row">
									<th scope="row">{when(run)}<span class="name model">{run.model}</span></th>
									<td>{statusWords(run.status)}<span class="stop">{stopWords(run)}</span></td>
									<td class="num">{tokenWords(run.inputTokens)}</td>
									<td class="num">{tokenWords(run.outputTokens)}</td>
									<td class="num">{tokenWords(run.cacheReadTokens)}</td>
									<td class="num">{tokenWords(run.cacheWriteTokens)}</td>
									<td class="num">{latencyWords(run.latencyMs)}</td>
									<td class="num">{run.toolCalls}</td>
									<td class="num" data-testid="usage-row-cost">{costWords(run.costMicros)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if next !== null}
					<Button
						variant="secondary"
						size="sm"
						loading={older === 'loading'}
						onclick={showOlder}
						data-testid="usage-older">Show older runs</Button
					>
				{/if}
				{#if older === 'failed'}
					<Notice tone="danger" title="Couldn’t load older runs" data-testid="usage-older-failed">
						<p>Check your connection, then try Show older runs again.</p>
					</Notice>
				{/if}
			</Section>
		{/if}
	</div>
</BottomSheet>

<style>
	.usage {
		display: grid;
		gap: var(--space-5);
		container-type: inline-size;
	}

	.action {
		margin-top: var(--space-2);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-4) var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.caption {
		margin: calc(var(--space-3) * -1) 0 0;
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.lists {
		display: grid;
		gap: var(--space-5);
	}

	.counts,
	.cards {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.counts li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: var(--text-sm);
	}

	.none {
		color: var(--color-text-secondary);
	}

	.name {
		overflow-wrap: anywhere;
	}

	.card {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-lg);
	}

	.line {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: var(--text-sm);
	}

	.strong {
		font-weight: var(--weight-semibold);
	}

	.secondary {
		color: var(--color-text-secondary);
	}

	.table {
		display: none;
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: var(--space-2);
		border-bottom: 1px solid var(--color-hairline);
		text-align: left;
		vertical-align: top;
	}

	thead th {
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	tbody th {
		font-weight: var(--weight-medium);
	}

	.num {
		text-align: right;
		white-space: nowrap;
	}

	.model,
	.stop {
		display: block;
		color: var(--color-text-secondary);
	}

	.stop {
		font-size: var(--text-xs);
	}

	.cards:focus-visible,
	.table:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		tbody tr:hover {
			background: var(--color-hairline);
		}
	}

	/* A sheet wide enough for the table: a desktop window's. */
	@container (width >= 40rem) {
		.stats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.lists {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.cards {
			display: none;
		}

		.table {
			display: block;
		}
	}
</style>
