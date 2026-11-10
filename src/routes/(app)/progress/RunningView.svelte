<!--
  @component
  Progress → Running: mileage against the plan, whether each kind of run is getting faster, the
  long run building and race performances, in the owner's distance unit (M6, PRD §10).
  Server-rendered from running-data.ts.

  - A new owner, or one in the first week, is told what appears and when, never a ghost chart.
  - Under that the trends (RunningTrends), in a chunk of their own that loads after hydration,
    served as static markup until it has (trends.ts, ViewTrendsLoader), so only this intro's code
    counts towards initial JS. A new owner's reported race shows there too.
-->
<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import type { RunningData } from './running-data';
	import { preloadRunningTrends, settledRunningTrends } from './trends';
	import { WIDE } from './view-layout';
	import ViewTrendsLoader from './ViewTrendsLoader.svelte';

	interface Props {
		running: RunningData;
		/** The trends as the server rendered them (+page.ts, trends.ts). */
		served?: string;
	}

	let { running: r, served }: Props = $props();

	const section = { preload: preloadRunningTrends, settled: settledRunningTrends };
</script>

<div class="pc-running-view" style={WIDE} data-stage={r.stage} data-testid="running">
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
	{#if r.stage !== 'new' || r.efforts.length}
		<ViewTrendsLoader
			{section}
			props={{ running: r }}
			{served}
			name="running"
			data-testid="running-trends-error"
		/>
	{/if}
</div>
