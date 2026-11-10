<!--
  @component
  Progress → one exercise's trends, everything under the header's verdict, loaded after it
  (trends.ts, TrendsLoader): the best estimated 1RM with its context and the profile's maxes, the
  e1RM chart (estimates as rings, the profile's maxes as their own marks, server-rendered with its
  table twin) beside the 1–10 rep-max table on a desktop window, every PR with its date, top sets,
  RPE against target and the recent sessions, each linking to its workout. Before trends, only
  the rep maxes, top sets and recent sessions show.

  Its rows are rows of the page's grid, as if the page rendered them itself.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { TrendsProps } from './trends';

	let { detail }: TrendsProps = $props();
</script>

{#snippet unplotted()}<p class="muted">No estimate in these weeks yet</p>{/snippet}

{#if !detail.waiting}
	<Section title="Estimated 1RM" gap="md">
		<div class="lead">
			<TrendTile tile={detail.e1rm} data-testid="exercise-e1rm" />
			<div class="about">
				<MetricContext {...detail.context} data-testid="exercise-context" />
				{#if detail.markers.length}
					<ul class="markers" aria-label="Your profile’s 1RMs">
						{#each detail.markers as marker, i (i)}
							<li data-kind={marker.kind} data-value={marker.kg} data-testid="max-marker">
								<span class="shape" data-kind={marker.kind} aria-hidden="true"></span>
								<span class="numeric">{marker.text}</span>
								<span class="muted">{marker.label}{marker.on ? ` · ${marker.on}` : ''}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</Section>
{/if}

<div class="pair">
	{#if !detail.waiting}
		<ChartFrame
			{...detail.chart}
			body={CHART_BODIES.line}
			props={{ data: detail.chart.data }}
			height="15rem"
			availability={detail.chart.plotted ? undefined : unplotted}
			data-testid="chart-e1rm"
		/>
	{/if}
	<Section title="Rep maxes" data-testid="rep-maxes">
		<table class="records">
			<caption class="visually-hidden">The heaviest load for each rep count</caption>
			<thead>
				<tr><th scope="col">Reps</th><th scope="col">Best</th><th scope="col">Set on</th></tr>
			</thead>
			<tbody>
				{#each detail.repMaxes as row (row.reps)}
					<tr data-reps={row.reps} data-value={row.kg ?? undefined} data-testid="rep-max">
						<th scope="row" class="numeric">{row.reps}</th>
						<td class="numeric">
							{row.text ?? '—'}
							{#if row.previous}<span class="muted">{row.previous}</span>{/if}
						</td>
						<td class="muted">{row.on ?? 'Not lifted yet'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Section>
</div>

<div class="pair">
	{#if !detail.waiting}
		<Section title="Personal records">
			{#if detail.prs.e1rm.length + detail.prs.volume.length === 0}
				<p class="muted">No record broken yet: each one shows here with its date.</p>
			{/if}
			{#each [{ kind: 'e1rm', title: 'Estimated 1RM', items: detail.prs.e1rm }, { kind: 'volume', title: 'Session volume', items: detail.prs.volume }] as group (group.kind)}
				{#if group.items.length}
					<h3 class="sub">{group.title}</h3>
					<ol class="list timeline">
						{#each group.items as pr (pr.key)}
							<li data-value={pr.value} data-testid="pr-{group.kind}">
								<span class="numeric">{pr.text}</span>
								<span class="muted">{pr.on} · {pr.previous}</span>
							</li>
						{/each}
					</ol>
				{/if}
			{/each}
		</Section>
	{/if}
	<div class="stack">
		{#if detail.topSets.length}
			<Section title="Top sets">
				<ul class="list">
					{#each detail.topSets as top (top.key)}
						<li data-testid="top-set">
							<span class="numeric">{top.text}</span>
							<span class="muted">{top.on}{top.inProgress ? ' · this week' : ''}</span>
						</li>
					{/each}
				</ul>
			</Section>
		{/if}

		{#if !detail.waiting}
			<Section title="RPE against target">
				<TrendTile tile={detail.rpe} data-testid="exercise-rpe" />
			</Section>
		{/if}
	</div>
</div>

{#if detail.recent.length}
	<Section title="Recent sessions" data-testid="recent-sessions">
		<ul class="rows">
			{#each detail.recent as session (session.id)}
				<li>
					<ListRow
						title={session.title}
						subtitle="{session.on} · {session.summary}"
						icon="train"
						tone="strength"
						href={resolve('/(app)/progress/workouts/[[id]]', { id: session.id })}
						data-testid="recent-session"
					/>
				</li>
			{/each}
		</ul>
	</Section>
{/if}

<style>
	.markers,
	.list,
	.rows {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pair {
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.muted {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.markers li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* As the chart's marks: a square diamond for a measured max, a hollow ring for an estimate. */
	.shape {
		inline-size: 8px;
		block-size: 8px;
		border: 2px solid var(--chart-muted);
		border-radius: 50%;
	}

	.shape[data-kind='measured'] {
		border-radius: 1px;
		background: var(--chart-muted);
		transform: rotate(45deg);
	}

	.records {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}

	.records th,
	.records td {
		padding: var(--space-2) var(--space-2) var(--space-2) 0;
		border-bottom: 1px solid var(--color-hairline);
		text-align: start;
		vertical-align: baseline;
	}

	.records thead th {
		color: var(--color-text-tertiary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.records td .muted {
		display: block;
		font-size: var(--text-xs);
	}

	.list {
		display: grid;
		gap: 0;
	}

	.list li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-hairline);
	}

	.sub {
		margin-top: var(--space-2);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.rows {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
	}

	.lead,
	.stack {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}

	.stack {
		gap: var(--space-6);
	}

	.about {
		display: grid;
		align-content: start;
		gap: var(--space-3);
		min-width: 0;
	}

	/* A desktop column: the tile beside its context, the chart beside the rep-max table, the
	   records beside the top sets. */
	@container (width >= 44rem) {
		.pair {
			grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
			align-items: start;
		}

		.lead {
			grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
			column-gap: var(--space-6);
		}
	}
</style>
