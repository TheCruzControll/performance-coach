<!--
  @component
  Progress → Overview's trends, everything under the verdicts, loaded after them (trends.ts,
  TrendsLoader):

  - Once anything is logged, the KPI TrendTiles, each with its change on the previous period and
    the week so far, then what each figure is and what counts as good.
  - Once there is history, the headline ChartFrames (load by discipline, each key lift's
    estimated 1RM), server-rendered with their table twins; only the plot waits for its body.
  - Until then, what appears and when (the dated timeline), never a ghost chart.
  - Then the row to the weekly reviews: here rather than in the view, so its code is not initial
    JS (Progress is at its budget).

  Its sections are rows of the view's grid, as if the view rendered them itself.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import type { TrendsProps } from './trends';

	let { overview }: TrendsProps = $props();

	const context = $derived(
		[overview.context.period, overview.context.comparison, overview.context.trend].filter(
			(part) => part !== null
		)
	);
</script>

{#if overview.stage !== 'new'}
	<Section title="Key figures" gap="md" data-testid="overview-kpis">
		<ul class="tiles">
			{#each overview.tiles as { id, tile } (id)}
				<TrendTile as="li" {tile} data-testid="kpi-{id}" />
			{/each}
		</ul>
		<details class="method">
			<summary
				><Icon name="chevron-right" size={16} strokeWidth={2} />What these are, and what counts as
				good</summary
			>
			<p class="context">{context.join(' · ')}</p>
			<dl>
				{#each overview.metrics as metric (metric.id)}
					<div>
						<dt>{metric.label}</dt>
						<dd>
							{[`${metric.good}.`, metric.method, metric.caveat].filter(Boolean).join(' ')}
						</dd>
					</div>
				{/each}
			</dl>
		</details>
	</Section>
{/if}

{#if overview.stage === 'history'}
	<Section title="Trends" gap="md">
		<div class="charts">
			{#if overview.charts.load}
				{@const chart = overview.charts.load}
				<ChartFrame
					{...chart}
					body={CHART_BODIES.bar}
					props={{ data: chart.data }}
					height="16rem"
					data-testid="chart-load"
				/>
			{/if}
			{#each overview.charts.lifts as chart (chart.id)}
				<ChartFrame
					{...chart}
					body={CHART_BODIES.line}
					props={{ data: chart.data }}
					data-testid="chart-lift"
				/>
			{/each}
		</div>
	</Section>
{:else}
	<Section title="What appears, and when" data-testid="overview-timeline">
		<ol class="timeline">
			{#each overview.timeline as entry (entry.section)}
				<li data-section={entry.section} data-ready={entry.ready}>
					<span class="dot" aria-hidden="true"></span>
					<div>
						<p class="label">{entry.label}</p>
						<p class="rule">{entry.rule}</p>
					</div>
					<p class="when numeric">
						{entry.ready ? 'Ready' : entry.on ? `From ${entry.on}` : 'Not dated yet'}
					</p>
				</li>
			{/each}
		</ol>
	</Section>
{/if}

<ListRow
	title="Reviews"
	icon="sparkle"
	href={resolve('/(app)/progress/reviews/[[key]]', {})}
	data-testid="reviews-row"
/>

<style>
	.context {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.charts {
		display: grid;
		gap: var(--space-3);
	}

	/* Two tiles a row on a phone; all five in one row once the column is wide enough. */
	.tiles {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
		gap: var(--space-3);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: var(--touch-target);
		width: fit-content;
		padding: 0 var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.method[open] summary :global(.icon) {
		transform: rotate(90deg);
	}

	summary:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		summary:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	dl {
		display: grid;
		gap: var(--space-3);
		max-width: 60ch;
		margin: var(--space-3) 0 0;
	}

	dt {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	dd {
		margin: 0;
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.timeline {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	.timeline li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
	}

	.timeline li + li {
		border-top: 1px solid var(--color-hairline);
	}

	.dot {
		inline-size: 10px;
		block-size: 10px;
		margin-top: 0.4em;
		border-radius: 50%;
		border: 2px solid var(--color-border-strong);
	}

	[data-ready='true'] .dot {
		border-color: var(--color-positive);
		background: var(--color-positive);
	}

	.label {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.rule,
	.when {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.when {
		white-space: nowrap;
	}

	/* A wide column (a desktop window): the charts pair up. */
	@container (width >= 44rem) {
		.charts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
