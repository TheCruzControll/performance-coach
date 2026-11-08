<!--
  @component
  /design → Charts: ChartFrame on the fixture chart, whose body is a chunk of its own loaded after
  hydration as every chart body is, and a frame with nothing to draw yet showing its availability.
  Loaded only in the browser, like the component groups, so none of its CSS blocks /design.
-->
<script lang="ts">
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import { CHART_FIXTURE, FIXTURE_FRAME, UNAVAILABLE_FRAME } from './chart-fixture.ts';

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
