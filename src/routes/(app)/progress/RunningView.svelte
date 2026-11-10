<!--
  @component
  Progress → Running: mileage against the plan, whether each kind of run is getting faster, the
  long run building and race performances, in the owner's distance unit (M6, PRD §10).
  Server-rendered from running-data.ts; only each plot waits for its chart body.

  - Weekly mileage as a tile and a bar chart, the plan outlined and the week so far marked.
  - Pace by run type as small multiples on one axis, lower faster, each with its verdict.
  - The long run's progression with every jump over 10 % named; best efforts and reported races.
  - Runs per week, and heart rate by type when tracked, otherwise a one-line hint.
  - A new owner, or one in the first week, is told what appears and when, never a ghost chart.
-->
<script lang="ts">
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { RunningData } from './running-data';

	let { running: r }: { running: RunningData } = $props();
</script>

{#snippet efforts()}
	<Section title="Best efforts and races" data-testid="running-efforts">
		{#if r.efforts.length}
			<ol class="grid">
				{#each r.efforts as effort (effort.key)}
					<li data-value={effort.seconds} data-label={effort.label} data-testid="effort">
						<ListRow
							title={effort.title}
							subtitle={effort.subtitle}
							icon={effort.label === 'Reported' ? 'target' : 'timer'}
							tone="running"
						>
							{#snippet trailing()}<span class="numeric">{effort.time}</span>{/snippet}
						</ListRow>
					</li>
				{/each}
			</ol>
		{:else}
			<EmptyState
				compact
				icon="timer"
				tone="running"
				title="No race distance in these weeks"
				description="A 5 km, 10 km, half or marathon, logged or reported, shows here with its date."
			/>
		{/if}
	</Section>
{/snippet}

<div class="grid pc-running-view" data-stage={r.stage} data-testid="running">
	{#if r.stage !== 'history'}
		<EmptyState
			icon={r.stage === 'first_week' ? 'sparkle' : 'progress'}
			tone="running"
			title={r.stage === 'first_week'
				? 'Your first week of running is under way'
				: 'Your running trends start with your first run'}
			description={r.stage === 'first_week'
				? 'Totals, paces and trends count complete weeks, so they start after Sunday. This week so far is below.'
				: 'Log a run and your weekly mileage, pace by run type, long runs and best efforts appear here.'}
			data-testid="running-intro"
		/>
	{/if}

	{#if r.stage !== 'new'}
		<Section title="Mileage" gap="md" data-testid="running-mileage">
			<div class="grid cols">
				<TrendTile tile={r.mileage.tile} data-testid="tile-mileage" />
				{#if r.stage === 'history'}
					<ChartFrame
						{...r.mileage.chart}
						body={CHART_BODIES.bar}
						props={{ data: r.mileage.chart.data }}
						data-testid="chart-mileage"
					/>
				{/if}
			</div>
			<MetricContext {...r.mileage.context} />
		</Section>
	{/if}

	<!-- A race or best effort is listed whenever it happens, a reported race before any run. -->
	{#if r.stage !== 'history' && r.efforts.length}{@render efforts()}{/if}

	{#if r.stage === 'history'}
		<Section title="Pace by run type" gap="md" data-testid="running-pace">
			<MetricContext {...r.pace.context} />
			<ul class="grid cols">
				{#each r.pace.types as type (type.id)}
					<li class="grid" data-testid="pace-type" data-type={type.id}>
						<ListRow title={type.label} subtitle="Pace" icon="timer" tone="running">
							{#snippet trailing()}<span
									class="numeric"
									data-value={type.pace?.value}
									data-testid="pace">{type.pace?.text ?? '—'}</span
								>{/snippet}
						</ListRow>
						{#if type.verdict}<VerdictBadge verdict={type.verdict} window={r.window} />{/if}
						<ChartFrame
							{...type.chart}
							body={CHART_BODIES.line}
							props={{ data: type.chart.data }}
							height="9rem"
						/>
					</li>
				{/each}
			</ul>
		</Section>

		<div class="grid cols">
			<Section title="Long run" gap="md" data-testid="running-long">
				<ListRow title="Longest run" subtitle="In these weeks" icon="trend-up" tone="running">
					{#snippet trailing()}<span
							class="numeric"
							data-value={r.longRuns.longest?.value}
							data-testid="longest-run">{r.longRuns.longest?.text ?? '—'}</span
						>{/snippet}
				</ListRow>
				<VerdictBadge verdict={r.longRuns.verdict} window={r.window} />
				<ChartFrame
					{...r.longRuns.chart}
					body={CHART_BODIES.line}
					props={{ data: r.longRuns.chart.data }}
					data-testid="chart-long-run"
				/>
				{#if r.longRuns.jumps.length}
					<Notice tone="warning" title="Long-run jumps" data-testid="long-run-jumps">
						{#each r.longRuns.jumps as jump (jump)}<p>{jump}</p>{/each}
					</Notice>
				{/if}
				<MetricContext {...r.longRuns.context} />
			</Section>

			{@render efforts()}
		</div>

		<div class="grid cols">
			<Section title={r.frequency.title} gap="md" data-testid="running-frequency">
				<TrendTile tile={r.frequency.tile} data-testid="tile-runs" />
				<ChartFrame
					{...r.frequency.chart}
					body={CHART_BODIES.bar}
					props={{ data: r.frequency.chart.data }}
					height="9rem"
					data-testid="chart-runs"
				/>
				<MetricContext {...r.frequency.context} />
			</Section>

			<Section title="Heart rate" gap="md" data-testid="running-hr">
				{#if r.heartRate.tracked}
					<ul class="grid">
						{#each r.heartRate.rows as row (row.label)}
							<li>
								<ListRow
									title={row.label}
									subtitle="Average heart rate"
									icon="pulse"
									tone="running"
								>
									{#snippet trailing()}<span class="numeric">{row.value}</span>{/snippet}
								</ListRow>
							</li>
						{/each}
					</ul>
				{:else}
					<Notice tone="neutral" icon="pulse" data-testid="hr-hint">{r.heartRate.text}</Notice>
				{/if}
			</Section>
		</div>
	{/if}
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pc-running-view,
	.cols {
		gap: var(--space-6);
	}

	/* Columns by the room there is, with no container query: paces and paired sections sit two a
	   row from about 38 rem and paces three from about 57 rem (desktop). */
	.cols {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18.5rem), 1fr));
		align-items: start;
	}
</style>
