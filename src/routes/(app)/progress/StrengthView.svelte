<!--
  @component
  Progress → Strength: what is improving, and whether volume and effort are where they should be
  (M6, PRD §10). Server-rendered from strength-data.ts; only each plot waits for its chart body.

  - Key lifts as e1RM small multiples, each with its best estimate, its verdict and a link to its
    page; any other lift of the period is listed with a link.
  - Tonnage and hard sets as two tiles and two bar charts (never one dual axis), the week so far
    outlined.
  - Muscle groups against the shown week's range, the plan ticked and the range's source named,
    then each recent week's range (a deload's scaled one included).
  - RPE tiles and each lift's RPE against target as diverging bars; the period's PRs.
  - Each section carries its context (MetricContext) and says when a figure is not ready yet.
  - A new owner, or one in the first week, is told what appears and when, never a ghost chart.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { StrengthData } from './strength-data';

	let { strength: s }: { strength: StrengthData } = $props();

	const exercise = (id: string) => resolve('/(app)/progress/exercises/[id]', { id });
</script>

{#snippet unplotted()}<p class="muted">No estimate in these weeks yet</p>{/snippet}

<div class="pc-strength-view" data-stage={s.stage} data-testid="strength">
	{#if s.stage !== 'history'}
		<EmptyState
			icon={s.stage === 'first_week' ? 'sparkle' : 'progress'}
			tone="strength"
			title={s.stage === 'first_week'
				? 'Your first week of lifting is under way'
				: 'Your strength trends start with your first lift'}
			description={s.stage === 'first_week'
				? 'Totals, ranges and trends count complete weeks, so they start after Sunday. This week so far is below.'
				: 'Log a strength session and your estimated 1RMs, weekly volume, muscle groups, RPE and records appear here.'}
			data-testid="strength-intro"
		/>
	{:else}
		<Section title="Key lifts" gap="md" data-testid="strength-lifts">
			<MetricContext {...s.liftsContext} />
			<ul class="grid multiples">
				{#each s.lifts as lift (lift.id)}
					<li class="lift" data-testid="key-lift" data-exercise={lift.id}>
						<a class="name" href={exercise(lift.id)}>{lift.name}</a>
						<p>
							<span class="best numeric" data-value={lift.best?.value} data-testid="best-e1rm"
								>{lift.best?.text ?? '—'}</span
							>
							<span class="muted">Estimated</span>
						</p>
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
				<h3 class="muted">Other lifts</h3>
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
					<div class="stack">
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
				<table class="weeks">
					<caption class="muted">Each week’s range, scaled by its volume</caption>
					<thead
						><tr><th scope="col">Week</th><th scope="col">Range</th><th scope="col">Within</th></tr
						></thead
					>
					<tbody>
						{#each g.weeks as week (week.weekStart)}
							<tr data-week={week.weekStart} data-testid="range-week">
								<th scope="row">{week.label}<span class="muted">{week.source}</span></th>
								<td class="numeric">{week.range ?? '—'}</td>
								<td>{week.judged ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
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
</div>

<style>
	.pc-strength-view {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.grid {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pair {
		gap: var(--space-6);
	}

	.lift,
	.stack {
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-width: 0;
	}

	.name {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: var(--touch-target);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
		text-underline-offset: 3px;
	}

	@media (hover: hover) and (pointer: fine) {
		.name:hover {
			color: var(--color-accent-text);
		}
	}

	.best {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
	}

	.muted,
	.weeks th span {
		font-size: var(--text-sm);
		font-weight: var(--weight-regular);
		color: var(--color-text-secondary);
	}

	.tiles {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
	}

	.weeks {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}

	.weeks caption {
		text-align: start;
		padding-bottom: var(--space-2);
	}

	.weeks th,
	.weeks td {
		padding: var(--space-2) var(--space-2) var(--space-2) 0;
		border-bottom: 1px solid var(--color-hairline);
		text-align: start;
		vertical-align: baseline;
	}

	.weeks th span {
		display: block;
		font-size: var(--text-xs);
	}

	/* A wide column (a desktop window): lifts three a row, sections in pairs. */
	@container (width >= 36rem) {
		.multiples {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@container (width >= 44rem) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}
	}

	@container (width >= 60rem) {
		.multiples {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
