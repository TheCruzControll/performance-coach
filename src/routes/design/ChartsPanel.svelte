<!--
  @component
  /design → Charts: ChartFrame on the fixture chart, whose body is a chunk of its own loaded after
  hydration as every chart body is, and a frame with nothing to draw yet showing its availability;
  then the line chart (CHART_BODIES.line) on each of its fixtures and an empty one, and the bar
  chart (CHART_BODIES.bar) on each of its fixtures.
  Loaded only in the browser, like the component groups, so none of its CSS blocks /design.
-->
<script lang="ts">
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import { BAR_FIXTURES, barFrame } from './bar-fixture.ts';
	import { CHART_FIXTURE, FIXTURE_FRAME, UNAVAILABLE_FRAME } from './chart-fixture.ts';
	import { EMPTY_LINE, LINE_FIXTURES, lineFrame } from './line-fixture.ts';

	const body = () => import('./ChartsFixtureBody.svelte');
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
</div>

<style>
	.charts {
		display: grid;
		gap: var(--space-4);
	}

	.availability {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}
</style>
