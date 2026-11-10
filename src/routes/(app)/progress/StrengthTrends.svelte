<!--
  @component
  Strength's trends (trends.ts), loaded after hydration under StrengthView's intro
  (StrengthTrendsLoader): the server sends them as static markup, so first paint and no-JS never
  wait for this chunk, and only the view's own code counts towards initial JS.

  - Key lifts as e1RM small multiples, each with its best estimate, its verdict and a link to its
    page; any other lift of the period is listed with a link.
  - Tonnage and hard sets as two tiles and two bar charts (never one dual axis), the week so far
    outlined.
  - Muscle groups against the shown week's range, the plan ticked and the range's source named,
    then each recent week's range (a deload's scaled one included).
  - RPE tiles and each lift's RPE against target as diverging bars; the period's PRs.
  - Each section carries its context (MetricContext) and says when a figure is not ready yet.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import ChartTable from '#lib/ui/charts/ChartTable.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { StrengthTrendsProps } from './trends';

	let { strength: s }: StrengthTrendsProps = $props();

	const exercise = (id: string) => resolve('/(app)/progress/exercises/[id]', { id });
</script>

{#snippet unplotted()}<p class="muted">No estimate in these weeks yet</p>{/snippet}

{#if s.stage === 'history'}
	<Section title="Key lifts" gap="md" data-testid="strength-lifts">
		<MetricContext {...s.liftsContext} />
		<ul class="grid multiples">
			{#each s.lifts as lift (lift.id)}
				<li class="grid tight" data-testid="key-lift" data-exercise={lift.id}>
					<ListRow
						title={lift.name}
						subtitle="Estimated 1RM"
						icon="trend-up"
						tone="strength"
						href={exercise(lift.id)}
					>
						{#snippet trailing()}<span
								class="numeric"
								data-value={lift.best?.value}
								data-testid="best-e1rm">{lift.best?.text ?? '—'}</span
							>{/snippet}
					</ListRow>
					<VerdictBadge verdict={lift.verdict} window={s.window} />
					<ChartFrame
						{...lift.chart}
						body={CHART_BODIES.line}
						props={{ data: lift.chart.data }}
						height="9rem"
						availability={lift.chart.plotted ? undefined : unplotted}
					/>
				</li>
			{/each}
		</ul>
		{#if s.others.length}
			<h3 class="eyebrow">Other lifts</h3>
			<ul class="grid">
				{#each s.others as other (other.id)}
					<li>
						<ListRow
							title={other.name}
							icon="train"
							tone="strength"
							href={exercise(other.id)}
							data-testid="other-lift"
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</Section>
{/if}

{#if s.stage !== 'new'}
	<Section title="Weekly volume" gap="md" data-testid="strength-volume">
		<div class="grid pair">
			{#each [s.tonnage, s.hardSets] as v (v.chart.id)}
				<div class="grid tight">
					<TrendTile tile={v.tile} data-testid="tile-{v.chart.id}" />
					{#if s.stage === 'history'}
						<ChartFrame
							{...v.chart}
							body={CHART_BODIES.bar}
							props={{ data: v.chart.data }}
							data-testid="chart-{v.chart.id}"
						/>
					{/if}
					<MetricContext {...v.context} />
				</div>
			{/each}
		</div>
	</Section>
{/if}

{#if s.stage === 'history'}
	{@const g = s.groups}
	<Section title="Muscle groups" gap="md" data-testid="strength-groups">
		<MetricContext {...g.context} />
		{#if g.waiting}<p class="muted">{g.waiting}</p>{/if}
		{#if g.shown?.chart}
			<ChartFrame
				{...g.shown.chart}
				body={CHART_BODIES.range}
				props={{ data: g.shown.chart.data }}
				height={g.shown.chart.height}
				data-testid="chart-groups"
			/>
		{:else if g.shown}
			<p class="muted">{g.shown.label} · {g.shown.source}</p>
		{/if}
		{#if g.shown?.unjudged}<p class="muted">No range: {g.shown.unjudged}</p>{/if}
		{#if g.weeks.length}
			<div data-testid="range-weeks">
				<h3 class="eyebrow">Each week’s range, scaled by its volume</h3>
				<ChartTable
					title="Each week’s range"
					rowHeader="Week"
					columns={[{ label: 'Range' }, { label: 'Within' }, { label: 'Source' }]}
					rows={g.weeks.map((w) => ({ label: w.label, values: [w.range, w.judged, w.source] }))}
				/>
			</div>
		{/if}
	</Section>

	<div class="grid pair">
		<Section title="Effort" gap="md" data-testid="strength-rpe">
			<ul class="grid tiles">
				<TrendTile as="li" tile={s.rpe.average} data-testid="tile-avg-rpe" />
				<TrendTile as="li" tile={s.rpe.deviation} data-testid="tile-rpe-deviation" />
			</ul>
			<MetricContext {...s.rpe.context} />
			{#if s.rpe.waiting}<p class="muted">{s.rpe.waiting}</p>{/if}
			{#if s.rpe.chart}
				<ChartFrame
					{...s.rpe.chart}
					body={CHART_BODIES.diverging}
					props={{ data: s.rpe.chart.data }}
					height={s.rpe.chart.height}
					data-testid="chart-rpe"
				/>
			{/if}
		</Section>

		<Section title="Personal records" data-testid="strength-prs">
			{#if s.prs.items.length}
				<ol class="grid">
					{#each s.prs.items as pr (pr.key)}
						<li data-value={pr.value} data-testid="strength-pr">
							<ListRow
								title="{pr.name} · {pr.label}"
								subtitle="{pr.on} · {pr.previous}{pr.estimated ? ' · Estimated' : ''}"
								icon="trend-up"
								tone="strength"
								href={exercise(pr.exerciseId)}
							>
								{#snippet trailing()}<span class="numeric">{pr.text}</span>{/snippet}
							</ListRow>
						</li>
					{/each}
				</ol>
				{#if s.prs.total > s.prs.items.length}
					<p class="muted" data-testid="strength-pr-total">
						The latest {s.prs.items.length} of {s.prs.total} records in these weeks
					</p>
				{/if}
			{:else}
				<p class="muted">No record broken in these weeks: each one shows here with its date.</p>
			{/if}
		</Section>
	</div>
{/if}

<style>
	.grid {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tight {
		align-content: start;
		gap: var(--space-2);
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/*
	 * Columns by the room there is, with no container query: tiles as many as fit, lifts two a
	 * row from about 38 rem and three from about 57 rem (desktop; a lone lift keeps one column's
	 * width), sections in pairs from about 44 rem.
	 */
	.tiles {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
	}

	.multiples {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18.5rem), 1fr));
	}

	.pair {
		gap: var(--space-6);
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr));
		align-items: start;
	}
</style>
