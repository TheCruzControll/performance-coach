<!--
  @component
  Progress → Running: mileage against the plan, whether each kind of run is getting faster, the
  long run building and race performances, in the owner's distance unit (M6, PRD §10).
  Server-rendered from running-data.ts.

  - A new owner, or one in the first week, is told what appears and when, never a ghost chart.
  - Under that the trends (RunningTrends): mileage, pace by run type, the long run, best efforts
    and races, runs per week and heart rate, in a chunk of their own that loads after hydration,
    served as static markup until it has (trends.ts, SectionLoader), so only this intro's code
    counts towards initial JS. A reported race shows even before a first run.

  No stylesheet of its own: each CSS file counts towards Progress's render-blocking CSS, so the
  layout is inline.
-->
<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import type { RunningData } from './running-data';
	import SectionLoader from './SectionLoader.svelte';
	import { runningTrends } from './trends';

	interface Props {
		running: RunningData;
		/** The trends as the server rendered them (+page.ts, trends.ts). */
		served?: string;
	}

	let { running: r, served }: Props = $props();
</script>

<div
	style="display: grid; gap: var(--space-6); min-width: 0"
	data-stage={r.stage}
	data-testid="running"
>
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
		<SectionLoader section={runningTrends} props={{ running: r }} name="running" {served} />
	{/if}
</div>
