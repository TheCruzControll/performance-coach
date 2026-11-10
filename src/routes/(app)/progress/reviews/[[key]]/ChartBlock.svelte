<!--
  @component
  A review section's chart in its ChartFrame (ReviewSections loads this after hydration): the body
  CHART_BODIES names, drawn into the room the server reserved, with its context, keys and table.
-->
<script lang="ts">
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import type { ChartView } from './sections';

	let { chart }: { chart: ChartView } = $props();
</script>

{#if chart.body === 'diverging'}
	<ChartFrame {...chart} body={CHART_BODIES.diverging} props={chart} />
{:else}
	<ChartFrame {...chart} body={CHART_BODIES.range} props={chart} />
{/if}
