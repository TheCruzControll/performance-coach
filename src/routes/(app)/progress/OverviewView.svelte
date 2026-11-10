<!--
  @component
  Progress → Overview: 'am I improving?' at a glance, every number in context (M6).

  - A card per discipline with its verdict in words, the sentence behind it, the weeks it read
    and each piece of evidence with its VerdictBadge.
  - The KPI TrendTiles, each with its change on the previous period and the week so far, then
    what each figure is and what counts as good.
  - The headline ChartFrames (load by discipline, each key lift's estimated 1RM), server-rendered
    with their table twins; only the plot waits for its body after hydration.
  - A new owner, or one in their first week, sees what appears and when (the dated timeline),
    never a ghost chart.
  - A container-query grid: cards and charts pair up once the column is wide enough.
-->
<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import type { OverviewData, VerdictCard } from './load';

	interface Props {
		overview: OverviewData;
	}

	let { overview }: Props = $props();

	const context = $derived(
		[overview.context.period, overview.context.comparison, overview.context.trend].filter(
			(part) => part !== null
		)
	);
	const started = $derived(overview.timeline.some((entry) => entry.ready));

	const TONE: Record<VerdictCard['verdict'], 'positive' | 'warning' | 'neutral'> = {
		improving: 'positive',
		holding: 'neutral',
		mixed: 'warning',
		declining: 'warning',
		not_enough_data: 'neutral'
	};
	const ICON: Record<VerdictCard['verdict'], IconName> = {
		improving: 'trend-up',
		holding: 'trend-flat',
		mixed: 'alert',
		declining: 'trend-down',
		not_enough_data: 'clock'
	};
</script>

<div class="pc-overview-view" data-stage={overview.stage} data-testid="overview">
	{#if overview.stage === 'history'}
		<section class="headline" aria-labelledby="overview-headline">
			<p class="eyebrow">Am I improving?</p>
			<h2 id="overview-headline" data-verdict={overview.headline.verdict}>
				{overview.headline.text}
			</h2>
			<p class="context" data-testid="overview-context">{context.join(' · ')}</p>
		</section>
		<ul class="cards">
			{#each overview.cards as card (card.area)}
				<li
					class="card"
					data-area={card.area}
					data-verdict={card.verdict}
					data-testid="verdict-card"
				>
					<div class="card-head">
						<h3>{card.title}</h3>
						<span class="word" data-tone={TONE[card.verdict]}
							><Icon name={ICON[card.verdict]} size={16} strokeWidth={2} />{card.word}</span
						>
					</div>
					<p class="sentence">{card.sentence}</p>
					<p class="window">{card.window}</p>
					{#if card.evidence.length}
						<ul class="evidence">
							{#each card.evidence as item, i (i)}
								<li>
									<span class="subject">{item.subject}</span>
									<VerdictBadge verdict={item.verdict} />
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<EmptyState
			icon={overview.stage === 'first_week' ? 'sparkle' : 'progress'}
			tone="accent"
			title={overview.stage === 'first_week'
				? 'Your first week is under way'
				: started
					? `Nothing logged in the ${overview.context.period.toLowerCase()}`
					: 'Your progress starts with your first session'}
			description={overview.stage === 'first_week'
				? 'Totals, comparisons and trends count complete weeks, so they start after Sunday. This week so far is below.'
				: 'Log a workout and this page fills in. Here is what appears, and when.'}
			data-testid="overview-intro"
		/>
	{/if}

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
</div>

<style>
	.pc-overview-view {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.headline {
		display: grid;
		gap: var(--space-1);
	}

	.eyebrow {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.headline h2 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
	}

	.context {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.cards,
	.tiles,
	.evidence,
	.timeline {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.cards,
	.charts {
		display: grid;
		gap: var(--space-3);
	}

	.card {
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.card h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.word {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--word-color, var(--color-text-secondary));
	}

	/* As VerdictBadge: status text darkened in the light theme to keep ≥ 4.5:1. */
	.word[data-tone='positive'] {
		--word-color: light-dark(
			color-mix(in srgb, var(--color-positive) 82%, #000),
			var(--color-positive)
		);
	}

	.word[data-tone='warning'] {
		--word-color: light-dark(
			color-mix(in srgb, var(--color-warning) 82%, #000),
			var(--color-warning)
		);
	}

	.sentence {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text);
	}

	.window {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.evidence {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-hairline);
	}

	.evidence li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-1) var(--space-2);
	}

	.subject {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* Two tiles a row on a phone; all five in one row once the column is wide enough. */
	.tiles {
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

	/* A wide column (a desktop window): the cards and charts pair up. */
	@container (width >= 44rem) {
		.cards,
		.charts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
