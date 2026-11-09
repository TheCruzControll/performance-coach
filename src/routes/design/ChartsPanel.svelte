<!--
  @component
  /design → Charts: ChartFrame on the fixture chart, whose body is a chunk of its own loaded after
  hydration as every chart body is, and a frame with nothing to draw yet showing its availability;
  then the line chart (CHART_BODIES.line) on each of its fixtures and an empty one, the bar
  chart (CHART_BODIES.bar) on each of its fixtures, the range bars (CHART_BODIES.range) and the
  diverging bars (CHART_BODIES.diverging); then the trend tiles (src/lib/ui/analytics) under a
  period picker that reads ?period, the context line of the first, and the loading frame.
  Loaded only in the browser, like the component groups, so none of its CSS blocks /design.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { parsePeriod } from '#lib/domain/analytics/periods.ts';
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import PeriodPicker from '#lib/ui/analytics/PeriodPicker.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import { BAR_FIXTURES, barFrame, DIVERGING_FIXTURE, RANGE_FIXTURE } from './bar-fixture.ts';
	import { CHART_FIXTURE, FIXTURE_FRAME, UNAVAILABLE_FRAME } from './chart-fixture.ts';
	import { EMPTY_LINE, LINE_FIXTURES, lineFrame } from './line-fixture.ts';

	import { tileFixtures } from './tile-fixture.ts';

	const body = () => import('./ChartsFixtureBody.svelte');

	const period = $derived(parsePeriod(page.url.searchParams.get('period')));
	const tiles = $derived(tileFixtures(period));
</script>

<div class="charts" data-testid="design-charts">
	<ChartFrame
		{...FIXTURE_FRAME}
		{body}
		props={{ data: CHART_FIXTURE }}
		data-testid="chart-fixture"
	/>
	<ChartFrame {...UNAVAILABLE_FRAME} {body} props={{ data: CHART_FIXTURE }} height="8rem">
		{#snippet availability()}
			<p class="availability">Shows once you log a run: distance a week, against your plan.</p>
		{/snippet}
	</ChartFrame>
	{#each LINE_FIXTURES as fixture (fixture.id)}
		<ChartFrame
			{...lineFrame(fixture)}
			body={CHART_BODIES.line}
			props={{ data: fixture.data }}
			height={fixture.height}
			data-testid={fixture.id}
		/>
	{/each}
	<ChartFrame
		{...EMPTY_LINE}
		body={CHART_BODIES.line}
		props={{ data: LINE_FIXTURES[0]!.data }}
		height="8rem"
		data-testid="line-empty"
	>
		{#snippet availability()}
			<p class="availability">Shows once you log a bench press: your estimated best a week.</p>
		{/snippet}
	</ChartFrame>
	{#each BAR_FIXTURES as fixture (fixture.id)}
		<ChartFrame
			{...barFrame(fixture)}
			body={CHART_BODIES.bar}
			props={{ data: fixture.data }}
			height={fixture.height}
			data-testid={fixture.id}
		/>
	{/each}
	<ChartFrame
		{...RANGE_FIXTURE.frame}
		body={CHART_BODIES.range}
		props={{ data: RANGE_FIXTURE.data }}
		height={RANGE_FIXTURE.height}
		data-testid={RANGE_FIXTURE.id}
	/>
	<ChartFrame
		{...DIVERGING_FIXTURE.frame}
		body={CHART_BODIES.diverging}
		props={{ data: DIVERGING_FIXTURE.data }}
		height={DIVERGING_FIXTURE.height}
		data-testid={DIVERGING_FIXTURE.id}
	/>
	<section class="tiles-section" aria-labelledby="design-tiles-title" data-testid="design-tiles">
		<h3 class="tiles-title" id="design-tiles-title">Trend tiles</h3>
		<PeriodPicker current={period} data-testid="tiles-period">
			<div class="tiles-body">
				<ul class="tiles">
					{#each tiles.tiles as { id, tile } (id)}
						<TrendTile as="li" {tile} data-testid={id} />
					{/each}
				</ul>
				<MetricContext {...tiles.context} data-testid="tiles-context" />
			</div>
		</PeriodPicker>
		<PeriodPicker current={period} label="Period, loading" busy data-testid="tiles-busy">
			<ul class="tiles">
				<TrendTile as="li" tile={tiles.tiles[0]!.tile} />
			</ul>
		</PeriodPicker>
	</section>
</div>

<style>
	.charts {
		display: grid;
		gap: var(--space-4);
	}

	.tiles-section {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-4);
	}

	.tiles-title {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.tiles-body {
		display: grid;
		gap: var(--space-3);
	}

	/* One tile a row on a phone, two from a wide enough column (the desktop gallery's included). */
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.availability {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}
</style>
