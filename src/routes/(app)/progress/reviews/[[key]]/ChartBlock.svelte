<!--
  @component
  A review section's chart in its ChartFrame (ReviewSections loads this after hydration): the body
  CHART_BODIES names, drawn into the room the server reserved, with its context, keys and table.
-->
<script lang="ts">
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	// With ChartFrame, as every other screen with charts imports them, so the two stay one chunk
	// and one stylesheet. Alone here, ChartFrame would split from TrendTile, and /progress would
	// link both stylesheets: about 0.26 KB gzip more render-blocking CSS, over its budget.
	import '#lib/ui/analytics/TrendTile.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import type { ChartView, LineChartView } from './sections';

	let { chart }: { chart: ChartView | LineChartView } = $props();
</script>

{#if chart.body === 'diverging'}
	<ChartFrame {...chart} body={CHART_BODIES.diverging} props={chart} />
{:else if chart.body === 'line'}
	<ChartFrame {...chart} body={CHART_BODIES.line} props={chart} />
{:else}
	<ChartFrame {...chart} body={CHART_BODIES.range} props={chart} />
{/if}
