<!--
  @component
  General's trends (trends.ts), loaded after hydration under GeneralView's intro
  (ViewTrendsLoader): the server sends them as static markup, so first paint and no-JS never wait
  for this chunk, and only the view's own code counts towards initial JS. From general-data.ts.

  - Adherence as a tile, the period's counts, each week's rate against the good band, and this
    week so far.
  - Sessions, training time and session-RPE load by week, stacked by discipline in STACK_ORDER.
  - The acute:chronic ratio over its typical band, its caveat always in words beside it, then the
    monotony and strain tiles.
  - Muay Thai's load, sessions, minutes and rounds; recovery as small multiples, and the latest
    notes printed as text.
  - A schedule with no plan is told adherence starts with one.
-->
<script lang="ts">
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { GeneralData } from './general-data';
	import type { GeneralTrendsProps } from './trends';
	import { COLS, GRID, LINE, WIDE } from './view-layout';

	let { general: g }: GeneralTrendsProps = $props();

	const history = $derived(g.stage === 'history');
</script>

{#snippet charted(v: GeneralData['sessions'], id: string)}
	<TrendTile tile={v.tile} data-testid="tile-{id}" />
	{#if history}
		<ChartFrame
			{...v.chart}
			body={CHART_BODIES.bar}
			props={{ data: v.chart.data }}
			data-testid="chart-{id}"
		/>
	{/if}
{/snippet}

{#snippet missing(text: string | null, id: string)}
	{#if text}<Notice tone="neutral" data-testid="{id}-missing">{text}</Notice>{/if}
{/snippet}

{#snippet ratio(r: NonNullable<GeneralData['acwr']>)}
	<ListRow title="Today" subtitle={r.current?.zone ?? r.waiting} icon="pulse">
		{#snippet trailing()}<span
				class="numeric"
				data-value={r.current?.value}
				data-testid="acwr-current">{r.current?.text ?? '—'}</span
			>{/snippet}
	</ListRow>
	<Notice tone="neutral" data-testid="acwr-caveat">{r.caveat}</Notice>
	<ChartFrame
		{...r.chart}
		body={CHART_BODIES.line}
		props={{ data: r.chart.data }}
		data-testid="chart-acwr"
	/>
{/snippet}

<div style={WIDE}>
	<Section title="Adherence" gap="md" data-testid="general-adherence">
		{#if g.noPlan}
			<Notice tone="neutral" icon="target" data-testid="general-no-plan">{g.noPlan}</Notice>
		{:else}
			<div style={COLS}>
				{@render charted(g.adherence, 'adherence')}
			</div>
			<p style={LINE} data-testid="adherence-counts">
				{#each g.adherence.counts as c, i (c.key)}{#if i}<span aria-hidden="true">
							·
						</span>{/if}<span data-key={c.key} data-value={c.value}
						>{c.label} <strong class="numeric">{c.text}</strong></span
					>{/each}
			</p>
			<p style={LINE} data-testid="adherence-so-far">{g.adherence.soFar}</p>
			<MetricContext {...g.adherence.context} />
		{/if}
	</Section>

	{#if g.stage !== 'new'}
		<div style={COLS}>
			<Section title="Sessions" gap="md" data-testid="general-sessions">
				{@render charted(g.sessions, 'sessions')}
				<MetricContext {...g.sessions.context} />
			</Section>
			<Section title="Training time" gap="md" data-testid="general-time">
				{@render charted(g.time, 'time')}
				{@render missing(g.time.missing, 'time')}
				<MetricContext {...g.time.context} />
			</Section>
		</div>

		<Section title="Training load" gap="md" data-testid="general-load">
			<div style={COLS}>
				{@render charted(g.load, 'load')}
			</div>
			{@render missing(g.load.missing, 'load')}
			<MetricContext {...g.load.context} />
		</Section>
	{/if}

	{#if history}
		<Section title="Is load rising fast?" gap="md" data-testid="general-trend">
			<div style={COLS}>
				{#if g.acwr?.more}
					<details>
						<summary
							style="display:flex;align-items:center;min-height:var(--touch-target);cursor:pointer"
							>Acute:chronic load</summary
						>
						{@render ratio(g.acwr)}
					</details>
				{:else if g.acwr}
					<div style={GRID}>{@render ratio(g.acwr)}</div>
				{/if}
				<div style={GRID}>
					<TrendTile tile={g.monotony.tile} data-testid="tile-monotony" />
					<TrendTile tile={g.strain.tile} data-testid="tile-strain" />
					<MetricContext {...g.monotony.context} />
				</div>
			</div>
		</Section>
	{/if}

	{#if g.muayThai.trained}
		<Section title="Muay Thai" gap="md" data-testid="general-muay-thai">
			<div style={COLS}>
				<TrendTile tile={g.muayThai.tile} data-testid="tile-muay-thai" />
				<ul style={GRID}>
					{#each g.muayThai.counts as c (c.key)}
						<li data-key={c.key} data-value={c.value} data-testid="mt-count">
							<ListRow title={c.label} icon="flame" tone="combat">
								{#snippet trailing()}<span class="numeric">{c.text}</span>{/snippet}
							</ListRow>
						</li>
					{/each}
				</ul>
			</div>
			<MetricContext {...g.muayThai.context} />
		</Section>
	{/if}

	{#if g.stage !== 'new'}
		<Section title="Recovery" gap="md" data-testid="general-recovery">
			{#if g.recovery.logged}
				{#if history}
					<ul style={COLS}>
						{#each g.recovery.multiples as m (m.id)}
							<li>
								<ChartFrame
									{...m.chart}
									body={CHART_BODIES.line}
									props={{ data: m.chart.data }}
									height="9rem"
									data-testid="chart-{m.chart.id}"
								/>
							</li>
						{/each}
					</ul>
					<MetricContext {...g.recovery.context} />
				{/if}
				{#each g.recovery.notes as note (note.id)}
					<Notice tone="neutral" icon="pencil" title={note.on} data-testid="recovery-note"
						>{note.text}</Notice
					>
				{/each}
			{:else}
				<EmptyState compact icon="moon" {...g.recovery.empty} />
			{/if}
		</Section>
	{/if}
</div>
