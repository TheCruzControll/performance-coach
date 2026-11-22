<!--
  @component
  Every chart's frame (docs/adr/NNNN-hand-built-charts.md). The server renders the title, a
  context caption (period · comparison · estimated or measured · trend window), the one-sentence
  summary and the table twin, and reserves the plot box at its full height, x-axis band included,
  with a hairline grid. After hydration the body, a CHART_BODIES loader, draws into that box and
  fades in (not under reduced motion), so nothing moves. A body that fails to load is a Notice with
  Retry, which imports it again in place (WebKit fetches anew); if that fails too while online the
  page reloads, because Chromium keeps a failed module fetch for the document's lifetime. Without
  JavaScript the plot says so beside the table. `availability` takes the plot's place when there is
  nothing to draw yet ('Available after 6 weeks'), and then no body loads.
-->
<!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -- any body's props -->
<script lang="ts" generics="P extends Record<string, any>">
	import { onMount, type Component, type Snippet } from 'svelte';
	import Button from '../components/Button.svelte';
	import Notice from '../components/Notice.svelte';
	import type { ChartBodyLoader } from './bodies.ts';
	import ChartTable from './ChartTable.svelte';
	import type { ChartTableData } from './table.ts';

	interface Props {
		title: string;
		/** Period · comparison · estimated or measured · trend window, joined with ' · '. */
		context: readonly string[];
		/** The server's one sentence: what the chart shows. */
		summary: string;
		table: ChartTableData;
		body: ChartBodyLoader<P>;
		props: P;
		/** The plot box's height, its x-axis band included: the room the server reserves. */
		height?: string;
		availability?: Snippet;
		'data-testid'?: string;
	}

	let {
		title,
		context,
		summary,
		table,
		body,
		props,
		height = '13rem',
		availability,
		'data-testid': testId
	}: Props = $props();

	let Body = $state.raw<Component<P>>();
	let failed = $state(false);
	let failures = 0;

	async function load() {
		failed = false;
		try {
			Body = (await body()).default;
		} catch {
			if (failures++ && navigator.onLine) return location.reload();
			failed = true;
		}
	}

	onMount(() => {
		if (!availability) load();
	});
</script>

<figure class="frame" data-testid={testId}>
	<figcaption class="caption">
		<h3 class="title">{title}</h3>
		{#if context.length}<p class="context">{context.join(' · ')}</p>{/if}
		<p class="summary">{summary}</p>
	</figcaption>
	<div
		class="plot"
		style:block-size={height}
		aria-busy={!availability && !Body && !failed}
		data-testid="chart-plot"
	>
		{#if availability}
			<div class="state">{@render availability()}</div>
		{:else if Body}
			<div class="body"><Body {...props} /></div>
		{:else if failed}
			<div class="state" data-testid="chart-failed">
				<Notice tone="danger" title="Couldn’t load this chart">
					The numbers are in the table below.
				</Notice>
				<Button variant="secondary" icon="refresh" onclick={load}>Try again</Button>
			</div>
		{:else}
			<div class="grid" aria-hidden="true"></div>
			<span class="visually-hidden">Loading chart…</span>
			<noscript><p class="note" data-testid="chart-no-js">Chart needs JavaScript</p></noscript>
		{/if}
	</div>
	<ChartTable {title} {...table} />
</figure>

<style>
	.frame {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
		margin: 0;
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--chart-surface);
	}

	.caption {
		display: grid;
		gap: var(--space-1);
	}

	.title {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	.context {
		color: var(--color-text-tertiary);
		font-size: var(--text-xs);
	}

	.summary {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	/* The room every body draws in: the axis band and the value gutter are the bodies' to use. */
	.plot {
		--chart-axis-band: 1.75rem;
		--chart-value-gutter: 2.25rem;
		position: relative;
		min-width: 0;
	}

	.grid {
		position: absolute;
		inset: 0 0 var(--chart-axis-band) var(--chart-value-gutter);
		border-bottom: 1px solid var(--chart-baseline);
		background-image: linear-gradient(to bottom, var(--chart-grid) 1px, transparent 1px);
		background-size: 100% 25%;
	}

	.body {
		position: absolute;
		inset: 0;
		animation: chart-in var(--duration-base) var(--ease-standard);
	}

	@keyframes chart-in {
		from {
			opacity: 0;
		}
	}

	.state {
		position: absolute;
		inset: 0;
		display: grid;
		align-content: center;
		justify-items: start;
		gap: var(--space-3);
	}

	.note {
		position: absolute;
		inset: 0 0 var(--chart-axis-band) var(--chart-value-gutter);
		display: grid;
		place-items: center;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	@media (prefers-reduced-motion: reduce) {
		.body {
			animation: none;
		}
	}
</style>
